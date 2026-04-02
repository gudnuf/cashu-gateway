//! Cashu Gateway library.
//!
//! This crate provides a gateway for Cashu with Lightning backend support.
//!
//! ## Architecture
//!
//! The gateway only needs to interact with the `LightningBackend` trait,
//! which provides a single `pay_invoice` method. All node management
//! (channels, peers, funding) is handled internally by the backend
//! and accessed via the `ldk-cli` tool.
//!
//! ## Usage
//!
//! Create a `Gateway` with `from_ldk_node()` or `new()`, then call `router()`
//! to get axum routes you can merge into your own server.

pub mod config;
pub mod ecash;
pub mod ldk;
pub mod lightning;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use cdk::nuts::{CurrencyUnit, Proof, PublicKey as EcashPublicKey, Token};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

// Public exports for the gateway
pub use config::{GatewayConfig, LdkConfig, StandaloneConfig};
pub use lightning::{LightningBackend, PaymentResult};

// Re-export LDK implementation (gateway can choose which backend to use)
pub use ldk::LdkLightningBackend;

/// Gateway info returned by the public /info endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayInfo {
    pub api_port: u16,
}

/// Request to create a HODL invoice
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MakeInvoiceRequest {
    pub amount_msat: u64,
    pub payment_hash: String,
    pub expiry_secs: u32,
}

/// Response containing the created invoice
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MakeInvoiceResponse {
    pub bolt11: String,
}

/// A pending HTLC awaiting settlement.
///
/// Created when `/request-invoice` issues HTLC-locked ecash.
/// The watcher polls the mint to detect when Alice claims the tokens,
/// then settles the corresponding HODL invoice.
struct PendingHtlc {
    /// The HTLC-locked proofs sent to Alice (used for NUT-07 state check)
    proofs: Vec<Proof>,
    /// Unix timestamp when the HTLC expires (after which gateway can refund)
    expires_at: u64,
}

/// The Cashu Gateway -- bridges ecash and Lightning.
///
/// Embeddable: create with `from_ldk_node()` or `new()`, then call `router()`
/// to get axum routes you can merge into your own server. Call `run_htlc_watcher()`
/// as a background task to auto-settle HODL invoices when Alice claims ecash.
#[derive(Clone)]
pub struct Gateway {
    backend: Arc<dyn LightningBackend>,
    ecash: Arc<ecash::EcashWallet>,
    config: GatewayConfig,
    /// payment_hash → PendingHtlc for active HTLC tokens awaiting settlement
    pending_htlcs: Arc<Mutex<HashMap<String, PendingHtlc>>>,
}

impl Gateway {
    /// Create a gateway wrapping an existing LDK node.
    /// The node must already be started.
    pub async fn from_ldk_node(
        node: Arc<ldk_node::Node>,
        config: GatewayConfig,
    ) -> anyhow::Result<Self> {
        let backend = Arc::new(ldk::LdkLightningBackend::from_node(node));
        let ecash = Arc::new(
            ecash::EcashWallet::new(&config.mint_url, &config.ecash_storage_dir).await?,
        );
        Ok(Self {
            backend,
            ecash,
            config,
            pending_htlcs: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Create a gateway with any LightningBackend implementation.
    pub async fn new(
        backend: Arc<dyn LightningBackend>,
        config: GatewayConfig,
    ) -> anyhow::Result<Self> {
        let ecash = Arc::new(
            ecash::EcashWallet::new(&config.mint_url, &config.ecash_storage_dir).await?,
        );
        Ok(Self {
            backend,
            ecash,
            config,
            pending_htlcs: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Build an axum Router with all gateway routes.
    /// Merge this into your own router or use `serve()` for standalone mode.
    pub fn router(&self) -> Router {
        let api_port = self.config.api_port;
        Router::new()
            .route(
                "/info",
                get(move || async move { Json(GatewayInfo { api_port }) }),
            )
            .route("/pay-invoice", post(pay_invoice_handler))
            .route("/request-invoice", post(request_invoice_handler))
            .with_state(self.clone())
    }

    /// Run the gateway as a standalone HTTP server.
    pub async fn serve(&self, addr: SocketAddr) -> anyhow::Result<()> {
        let app = self.router();
        tracing::info!("Gateway HTTP API listening on {}", addr);
        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(listener, app).await?;
        Ok(())
    }

    /// Access the ecash wallet.
    pub fn ecash(&self) -> &ecash::EcashWallet {
        &self.ecash
    }

    /// Create a HODL invoice for a given payment hash.
    ///
    /// Delegates to the underlying Lightning backend.
    pub fn create_invoice_for_hash(
        &self,
        amount_msat: u64,
        payment_hash: &str,
        expiry_secs: u32,
    ) -> anyhow::Result<String> {
        self.backend
            .create_invoice_for_hash(amount_msat, payment_hash, expiry_secs)
            .map(|invoice| invoice.to_string())
    }

    /// Register HTLC-locked proofs for background settlement watching.
    async fn register_pending_htlc(
        &self,
        payment_hash: String,
        proofs: Vec<Proof>,
        expires_at: u64,
    ) {
        let mut pending = self.pending_htlcs.lock().await;
        tracing::info!(
            payment_hash = %payment_hash,
            num_proofs = proofs.len(),
            expires_at,
            pending_count = pending.len() + 1,
            "Registered pending HTLC for watcher"
        );
        pending.insert(payment_hash, PendingHtlc { proofs, expires_at });
    }

    /// Run the HTLC settlement watcher as a background task.
    ///
    /// Polls the mint (NUT-07) for each pending HTLC to detect when Alice
    /// claims the ecash tokens. When a preimage is discovered, settles the
    /// corresponding HODL invoice on the Lightning backend.
    ///
    /// Also cleans up expired HTLCs that passed their locktime without being claimed.
    ///
    /// This method runs forever — spawn it as a tokio task:
    /// ```ignore
    /// tokio::spawn(gateway.clone().run_htlc_watcher());
    /// ```
    pub async fn run_htlc_watcher(self) {
        let poll_interval = Duration::from_secs(5);
        tracing::info!(
            poll_interval_secs = poll_interval.as_secs(),
            "HTLC watcher started"
        );

        loop {
            tokio::time::sleep(poll_interval).await;

            // Snapshot current pending HTLCs
            let snapshot: Vec<(String, Vec<Proof>, u64)> = {
                let pending = self.pending_htlcs.lock().await;
                if pending.is_empty() {
                    continue;
                }
                pending
                    .iter()
                    .map(|(hash, htlc)| (hash.clone(), htlc.proofs.clone(), htlc.expires_at))
                    .collect()
            };

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();

            let mut to_remove = Vec::new();

            for (payment_hash, proofs, expires_at) in &snapshot {
                // Clean up expired HTLCs
                if now > *expires_at {
                    tracing::warn!(
                        payment_hash = %payment_hash,
                        "HTLC expired without claim, removing from watcher"
                    );
                    to_remove.push(payment_hash.clone());
                    continue;
                }

                // Poll mint for proof state
                match self.ecash.check_htlc_state(proofs).await {
                    Ok(Some(preimage)) => {
                        tracing::info!(
                            payment_hash = %payment_hash,
                            preimage = %preimage,
                            "Preimage discovered — settling HODL invoice"
                        );

                        match self.backend.settle_hodl_invoice(payment_hash, &preimage) {
                            Ok(()) => {
                                tracing::info!(
                                    payment_hash = %payment_hash,
                                    "HODL invoice settled successfully"
                                );
                            }
                            Err(e) => {
                                tracing::error!(
                                    payment_hash = %payment_hash,
                                    error = %e,
                                    "Failed to settle HODL invoice"
                                );
                            }
                        }

                        to_remove.push(payment_hash.clone());
                    }
                    Ok(None) => {
                        // Still pending — no action
                    }
                    Err(e) => {
                        tracing::warn!(
                            payment_hash = %payment_hash,
                            error = %e,
                            "NUT-07 check failed, will retry"
                        );
                    }
                }
            }

            // Remove settled/expired HTLCs
            if !to_remove.is_empty() {
                let mut pending = self.pending_htlcs.lock().await;
                for hash in &to_remove {
                    pending.remove(hash);
                }
                tracing::debug!(
                    removed = to_remove.len(),
                    remaining = pending.len(),
                    "Cleaned up pending HTLCs"
                );
            }
        }
    }
}

// ============================================================================
// Route handlers (internal -- not part of the public API)
// ============================================================================

/// Pay a Lightning invoice using ecash proofs.
///
/// Alice sends ecash proofs covering the invoice amount. The gateway verifies
/// the proofs with the mint, then pays the Lightning invoice and returns the result.
async fn pay_invoice_handler(
    State(gw): State<Gateway>,
    Json(request): Json<cashu_gateway_protocol::PayInvoiceRequest>,
) -> Result<Json<cashu_gateway_protocol::PayInvoiceResponse>, (StatusCode, String)> {
    // 1. Receive and verify ecash proofs
    let received_sats = gw
        .ecash
        .receive_proofs(request.proofs)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid ecash proofs: {}", e),
            )
        })?;

    tracing::info!(received_sats, bolt11 = %request.bolt11, "Ecash received, paying Lightning invoice");

    // 2. Pay the Lightning invoice (blocks until payment completes or timeout)
    let result = gw
        .backend
        .pay_invoice(&request.bolt11)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Lightning payment failed: {}", e),
            )
        })?;

    Ok(Json(cashu_gateway_protocol::PayInvoiceResponse {
        paid: true,
        payment_preimage: Some(result.payment_preimage),
        fee_msat: Some(result.fee_msat),
    }))
}

/// Create a HODL invoice and HTLC-locked ecash for an inbound Lightning payment.
///
/// Alice provides her pubkey and a preimage hash. The gateway:
/// 1. Creates a HODL invoice locked to the preimage hash
/// 2. Creates HTLC-locked ecash tokens that Alice can claim with the preimage
/// 3. Returns both to Alice
async fn request_invoice_handler(
    State(gw): State<Gateway>,
    Json(request): Json<cashu_gateway_protocol::RequestInvoiceRequest>,
) -> Result<Json<cashu_gateway_protocol::RequestInvoiceResponse>, (StatusCode, String)> {
    // 1. Parse Alice's pubkey
    let alice_pubkey = EcashPublicKey::from_str(&request.pubkey)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid pubkey: {}", e)))?;

    // 2. Create HODL invoice locked to Alice's preimage_hash
    let amount_msat = request.amount_sats * 1000;
    let invoice = gw
        .backend
        .create_invoice_for_hash(amount_msat, &request.preimage_hash, 3600)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to create HODL invoice: {}", e),
            )
        })?;

    let payment_hash = request.preimage_hash.clone();

    // 3. Create HTLC-locked ecash tokens
    // locktime: 1 hour from now (matching invoice expiry)
    let locktime = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;

    let htlc_proofs = gw
        .ecash
        .create_htlc_token(
            request.amount_sats,
            &payment_hash,
            alice_pubkey,
            Some(locktime),
        )
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to create HTLC token: {}", e),
            )
        })?;

    // 4. Register proofs with the HTLC watcher for auto-settlement
    gw.register_pending_htlc(payment_hash.clone(), htlc_proofs.clone(), locktime)
        .await;

    // 5. Serialize HTLC proofs as a Cashu V4 token
    let mint_url = gw.ecash.wallet().mint_url.clone();
    let token = Token::new(mint_url, htlc_proofs, None, CurrencyUnit::Sat);

    Ok(Json(cashu_gateway_protocol::RequestInvoiceResponse {
        bolt11: invoice.to_string(),
        payment_hash,
        htlc_token: token.to_string(),
    }))
}

//! Cashu Alice client library.
//!
//! Implements Alice's side of the Cashu gateway protocol — paying Lightning
//! invoices with ecash and receiving ecash via inbound Lightning payments.
//!
//! # Architecture
//!
//! - [`AliceClient`] is the high-level API combining an ecash wallet and gateway HTTP client.
//! - [`wallet::AliceWallet`] wraps CDK for ecash operations (proof management, HTLC claiming).
//! - [`client::GatewayClient`] handles HTTP communication with the gateway server.

pub mod client;
pub mod wallet;

pub use client::GatewayClient;
pub use wallet::AliceWallet;

use anyhow::Result;
use cashu_gateway_protocol::{
    PayInvoiceRequest, PayInvoiceResponse, RequestInvoiceRequest, SettleRequest,
};
use tracing::info;

/// High-level Alice client combining ecash wallet and gateway HTTP client.
///
/// Provides ergonomic methods for the two main protocol flows:
/// - **Pay**: Send ecash proofs to the gateway to pay a Lightning invoice.
/// - **Receive**: Request a HODL invoice from the gateway, then claim HTLC-locked ecash.
pub struct AliceClient {
    pub wallet: AliceWallet,
    pub gateway: GatewayClient,
}

/// Result of requesting an inbound Lightning invoice.
///
/// Contains everything Alice needs to complete the receive flow:
/// the invoice to share with payers, and the preimage/token needed
/// to claim the ecash once the invoice is paid.
pub struct PendingReceive {
    /// Bolt11 HODL invoice to share with the payer.
    pub bolt11: String,
    /// Payment hash identifying this payment.
    pub payment_hash: String,
    /// HTLC-locked ecash token to claim once invoice is paid.
    pub htlc_token: String,
    /// Preimage bytes — Alice knows this, needed to claim the HTLC.
    pub preimage: Vec<u8>,
}

impl AliceClient {
    /// Create a new Alice client.
    ///
    /// # Arguments
    /// * `gateway_url` - Base URL of the gateway HTTP API (e.g. `http://127.0.0.1:3338`)
    /// * `mint_url` - Cashu mint URL
    /// * `storage_dir` - Directory for the ecash wallet SQLite database
    pub async fn new(gateway_url: &str, mint_url: &str, storage_dir: &str) -> Result<Self> {
        let wallet = AliceWallet::new(mint_url, storage_dir).await?;
        let gateway = GatewayClient::new(gateway_url);

        info!(
            gateway_url,
            mint_url,
            alice_pubkey = %wallet.pubkey(),
            "Alice client initialized"
        );

        Ok(Self { wallet, gateway })
    }

    /// Pay a Lightning invoice by sending ecash to the gateway.
    ///
    /// 1. Selects proofs from the wallet covering the invoice amount.
    /// 2. POSTs the proofs + invoice to the gateway's `/pay-invoice` endpoint.
    /// 3. Gateway verifies proofs, pays the Lightning invoice, returns the preimage.
    ///
    /// # Arguments
    /// * `bolt11` - The Bolt11 Lightning invoice to pay
    /// * `amount_sats` - Amount in sats (must match or exceed the invoice amount)
    pub async fn pay(&self, bolt11: &str, amount_sats: u64) -> Result<PayInvoiceResponse> {
        info!(amount_sats, "Paying Lightning invoice via gateway");

        let proofs = self.wallet.get_proofs_for_amount(amount_sats).await?;

        let request = PayInvoiceRequest {
            bolt11: bolt11.to_string(),
            proofs,
        };

        let response = self.gateway.pay_invoice(request).await?;

        if !response.paid {
            anyhow::bail!(
                "Gateway accepted proofs but Lightning payment failed (invoice may be expired or unpayable)"
            );
        }

        info!(
            preimage = response.payment_preimage.as_deref().unwrap_or("none"),
            fee_msat = response.fee_msat.unwrap_or(0),
            "Lightning invoice paid"
        );

        Ok(response)
    }

    /// Request an inbound Lightning invoice to receive ecash.
    ///
    /// 1. Generates a random preimage and its SHA-256 hash.
    /// 2. POSTs the hash, Alice's pubkey, and blinded messages to the gateway.
    /// 3. Gateway creates a HODL invoice locked to the hash + HTLC-locked ecash.
    /// 4. Returns a [`PendingReceive`] with the invoice and claim material.
    ///
    /// After the payer pays the invoice, call [`claim`] to receive the ecash.
    pub async fn receive(
        &self,
        amount_sats: u64,
        blinded_messages: Vec<cashu_gateway_protocol::BlindedMessage>,
    ) -> Result<PendingReceive> {
        let (preimage, preimage_hash) = AliceWallet::generate_preimage();

        info!(
            amount_sats,
            preimage_hash = %preimage_hash,
            "Requesting inbound Lightning invoice"
        );

        let request = RequestInvoiceRequest {
            amount_sats,
            pubkey: self.wallet.pubkey().to_string(),
            blinded_messages,
            preimage_hash,
        };

        let response = self.gateway.request_invoice(request).await?;

        info!(
            payment_hash = %response.payment_hash,
            "HODL invoice received from gateway"
        );

        Ok(PendingReceive {
            bolt11: response.bolt11,
            payment_hash: response.payment_hash,
            htlc_token: response.htlc_token,
            preimage,
        })
    }

    /// Claim HTLC-locked ecash from a pending receive.
    ///
    /// Uses the preimage (which Alice generated) to satisfy the HTLC spending
    /// condition at the mint. Returns the amount received in sats.
    pub async fn claim(&self, pending: &PendingReceive) -> Result<u64> {
        let sats = self
            .wallet
            .claim_htlc_token(&pending.htlc_token, &pending.preimage)
            .await?;

        // Optionally notify the gateway (best-effort)
        let settle_req = SettleRequest {
            payment_hash: pending.payment_hash.clone(),
        };
        match self.gateway.settle(settle_req).await {
            Ok(resp) => {
                info!(settled = resp.settled, "Gateway settle notification sent");
            }
            Err(e) => {
                // Non-fatal: gateway also polls NUT-07 to discover the preimage
                tracing::warn!("Settle notification failed (non-fatal): {e}");
            }
        }

        Ok(sats)
    }

    /// Get Alice's ecash balance in sats.
    pub async fn balance(&self) -> Result<u64> {
        self.wallet.get_balance().await
    }
}

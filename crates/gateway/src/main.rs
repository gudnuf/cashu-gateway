use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use cdk::nuts::{CurrencyUnit, PublicKey as EcashPublicKey, Token};
use clap::{Parser, Subcommand};
use tracing::info;
use tracing_subscriber::EnvFilter;

use cashu_gateway::config::GatewayConfig;
use cashu_gateway::ecash::EcashWallet;
use cashu_gateway::ldk::LdkLightningBackend;
use cashu_gateway::lightning::LightningBackend;
use cashu_gateway::{GatewayInfo, MakeInvoiceRequest, MakeInvoiceResponse};

#[derive(Clone)]
struct AppState {
    backend: Arc<dyn LightningBackend>,
    ecash: Arc<EcashWallet>,
}

#[derive(Parser)]
#[command(name = "cashu-gateway")]
#[command(about = "Cashu Gateway with Lightning backend")]
struct Cli {
    /// Path to config file (default: config.toml in current directory)
    #[arg(short, long)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the gateway server (default)
    Serve,
    /// Print gateway info from running instance
    Info,
    /// Create a HODL invoice for a given payment hash
    MakeInvoice {
        /// Amount in millisatoshis
        #[arg(long)]
        amount_msat: u64,
        /// Payment hash (hex encoded)
        #[arg(long)]
        payment_hash: String,
        /// Invoice expiry in seconds (default: 3600)
        #[arg(long, default_value = "3600")]
        expiry_secs: u32,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        None | Some(Commands::Serve) => {
            tracing_subscriber::fmt()
                .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
                .init();

            // Load configuration
            let config = GatewayConfig::load(cli.config.as_deref())?;

            info!(
                api_port = config.api_port,
                ldk_cli_port = config.ldk_cli_port,
                network = %config.ldk.network,
                storage_dir = %config.ldk.storage_dir,
                "Starting Cashu Gateway with LDK Node backend"
            );

            let ldk_backend = Arc::new(LdkLightningBackend::setup(&config).await?);
            let backend: Arc<dyn LightningBackend> = ldk_backend.clone();

            // Initialize ecash wallet
            info!(mint_url = %config.mint_url, storage_dir = %config.ecash_storage_dir, "Initializing ecash wallet");
            let ecash_wallet = EcashWallet::new(&config.mint_url, &config.ecash_storage_dir).await?;
            let balance = ecash_wallet.get_balance().await?;
            info!(mint_url = %config.mint_url, balance_sats = balance, "Ecash wallet ready");

            let state = AppState {
                backend,
                ecash: Arc::new(ecash_wallet),
            };

            // Public gateway API
            let api_port = config.api_port;
            let public_app = Router::new()
                .route(
                    "/info",
                    get({
                        move || async move { Json(GatewayInfo { api_port }) }
                    }),
                )
                .route("/pay-invoice", post(pay_invoice_handler))
                .route("/request-invoice", post(request_invoice_handler))
                .route("/make-invoice", post(make_invoice_handler))
                .with_state(state);

            let public_addr = SocketAddr::from(([127, 0, 0, 1], config.api_port));
            info!("Public HTTP API listening on {}", public_addr);
            let public_listener = tokio::net::TcpListener::bind(public_addr).await?;

            let shutdown = async {
                tokio::signal::ctrl_c()
                    .await
                    .expect("failed to listen for ctrl+c");
                info!("Shutdown signal received");
            };

            tokio::select! {
                result = axum::serve(public_listener, public_app) => {
                    if let Err(e) = result {
                        tracing::error!("Public API server error: {}", e);
                    }
                }
                _ = shutdown => {}
            }

            ldk_backend.shutdown()?;
            Ok(())
        }
        Some(Commands::Info) => {
            let config = GatewayConfig::load(cli.config.as_deref())?;
            let url = format!("http://127.0.0.1:{}/info", config.api_port);
            let info: GatewayInfo = reqwest::get(&url).await?.json().await?;
            println!("{}", serde_json::to_string_pretty(&info)?);
            Ok(())
        }
        Some(Commands::MakeInvoice {
            amount_msat,
            payment_hash,
            expiry_secs,
        }) => {
            let config = GatewayConfig::load(cli.config.as_deref())?;
            let url = format!("http://127.0.0.1:{}/make-invoice", config.api_port);
            let request = MakeInvoiceRequest {
                amount_msat,
                payment_hash,
                expiry_secs,
            };
            let response: MakeInvoiceResponse = reqwest::Client::new()
                .post(&url)
                .json(&request)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            println!("{}", response.bolt11);
            Ok(())
        }
    }
}

/// Pay a Lightning invoice using ecash proofs.
///
/// Alice sends ecash proofs covering the invoice amount. The gateway verifies
/// the proofs with the mint, then pays the Lightning invoice and returns the result.
async fn pay_invoice_handler(
    State(state): State<AppState>,
    Json(request): Json<cashu_gateway_protocol::PayInvoiceRequest>,
) -> Result<Json<cashu_gateway_protocol::PayInvoiceResponse>, (StatusCode, String)> {
    // 1. Receive and verify ecash proofs
    let received_sats = state
        .ecash
        .receive_proofs(request.proofs)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid ecash proofs: {}", e)))?;

    info!(received_sats, bolt11 = %request.bolt11, "Ecash received, paying Lightning invoice");

    // 2. Pay the Lightning invoice (blocks until payment completes or timeout)
    let result = state
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
    State(state): State<AppState>,
    Json(request): Json<cashu_gateway_protocol::RequestInvoiceRequest>,
) -> Result<Json<cashu_gateway_protocol::RequestInvoiceResponse>, (StatusCode, String)> {
    // 1. Parse Alice's pubkey
    let alice_pubkey = EcashPublicKey::from_str(&request.pubkey)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid pubkey: {}", e)))?;

    // 2. Create HODL invoice locked to Alice's preimage_hash
    let amount_msat = request.amount_sats * 1000;
    let invoice = state
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

    let htlc_proofs = state
        .ecash
        .create_htlc_token(request.amount_sats, &payment_hash, alice_pubkey, Some(locktime))
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to create HTLC token: {}", e),
            )
        })?;

    // 4. Serialize HTLC proofs as a Cashu V4 token
    let mint_url = state.ecash.wallet().mint_url.clone();
    let token = Token::new(mint_url, htlc_proofs, None, CurrencyUnit::Sat);

    Ok(Json(cashu_gateway_protocol::RequestInvoiceResponse {
        bolt11: invoice,
        payment_hash,
        htlc_token: token.to_string(),
    }))
}

async fn make_invoice_handler(
    State(state): State<AppState>,
    Json(request): Json<MakeInvoiceRequest>,
) -> Result<Json<MakeInvoiceResponse>, (StatusCode, String)> {
    let invoice = state
        .backend
        .create_invoice_for_hash(request.amount_msat, &request.payment_hash, request.expiry_secs)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    Ok(Json(MakeInvoiceResponse {
        bolt11: invoice,
    }))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn gateway_can_create_ldk_backend() {}
}

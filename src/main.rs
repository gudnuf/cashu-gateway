use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::{Parser, Subcommand};
use tracing::info;
use tracing_subscriber::EnvFilter;

use cashu_gateway::config::GatewayConfig;
use cashu_gateway::ldk::LdkLightningBackend;
use cashu_gateway::lightning::LightningBackend;
use cashu_gateway::{GatewayInfo, MakeInvoiceRequest, MakeInvoiceResponse};

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

            let backend = Arc::new(LdkLightningBackend::setup(&config).await?);

            // Public gateway API
            let api_port = config.api_port;
            let public_app = Router::new()
                .route(
                    "/info",
                    get({
                        move || async move { Json(GatewayInfo { api_port }) }
                    }),
                )
                .route("/make-invoice", post(make_invoice_handler))
                .with_state(backend.clone());

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

            backend.shutdown()?;
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

async fn make_invoice_handler(
    State(backend): State<Arc<LdkLightningBackend>>,
    Json(request): Json<MakeInvoiceRequest>,
) -> Result<Json<MakeInvoiceResponse>, (StatusCode, String)> {
    let invoice = backend
        .create_invoice_for_hash(request.amount_msat, &request.payment_hash, request.expiry_secs)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    Ok(Json(MakeInvoiceResponse {
        bolt11: invoice.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn gateway_can_create_ldk_backend() {}
}

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use clap::{Parser, Subcommand};
use tracing::info;
use tracing_subscriber::EnvFilter;

use cashu_gateway::config::StandaloneConfig;
use cashu_gateway::ldk::LdkLightningBackend;
use cashu_gateway::lightning::LightningBackend;
use cashu_gateway::{Gateway, GatewayInfo, MakeInvoiceRequest, MakeInvoiceResponse};

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

            let config = StandaloneConfig::load(cli.config.as_deref())?;

            info!(
                api_port = config.gateway.api_port,
                ldk_cli_port = config.ldk_cli_port,
                network = %config.ldk.network,
                "Starting Cashu Gateway (standalone mode)"
            );

            // Create and start LDK backend
            let ldk_backend = Arc::new(
                LdkLightningBackend::setup(&config.ldk, config.ldk_cli_port).await?
            );

            // Create gateway
            let gateway = Gateway::new(
                ldk_backend.clone() as Arc<dyn LightningBackend>,
                config.gateway.clone(),
            )
            .await?;

            let balance = gateway.ecash().get_balance().await?;
            info!(balance_sats = balance, "Gateway ready");

            // Spawn HTLC settlement watcher as background task
            tokio::spawn(gateway.clone().run_htlc_watcher());

            // Gateway library routes (already has state applied)
            let gateway_router = gateway.router();

            // Binary-specific make-invoice route
            let make_invoice_routes = Router::new()
                .route("/make-invoice", post(make_invoice_handler))
                .with_state(gateway);
            let app = gateway_router.merge(make_invoice_routes);

            let addr = SocketAddr::from(([127, 0, 0, 1], config.gateway.api_port));
            info!("Listening on {}", addr);
            let listener = tokio::net::TcpListener::bind(addr).await?;

            let shutdown = async {
                tokio::signal::ctrl_c()
                    .await
                    .expect("failed to listen for ctrl+c");
                info!("Shutdown signal received");
            };

            tokio::select! {
                result = axum::serve(listener, app) => {
                    if let Err(e) = result {
                        tracing::error!("Server error: {}", e);
                    }
                }
                _ = shutdown => {}
            }

            ldk_backend.shutdown()?;
            Ok(())
        }
        Some(Commands::Info) => {
            let config = StandaloneConfig::load(cli.config.as_deref())?;
            let url = format!("http://127.0.0.1:{}/info", config.gateway.api_port);
            let info: GatewayInfo = reqwest::get(&url).await?.json().await?;
            println!("{}", serde_json::to_string_pretty(&info)?);
            Ok(())
        }
        Some(Commands::MakeInvoice {
            amount_msat,
            payment_hash,
            expiry_secs,
        }) => {
            let config = StandaloneConfig::load(cli.config.as_deref())?;
            let url = format!("http://127.0.0.1:{}/make-invoice", config.gateway.api_port);
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

// Binary-specific handler: create invoice by payment hash (for ldk-cli)
async fn make_invoice_handler(
    State(gw): State<Gateway>,
    Json(request): Json<MakeInvoiceRequest>,
) -> Result<Json<MakeInvoiceResponse>, (StatusCode, String)> {
    let bolt11 = gw
        .create_invoice_for_hash(request.amount_msat, &request.payment_hash, request.expiry_secs)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    Ok(Json(MakeInvoiceResponse { bolt11 }))
}

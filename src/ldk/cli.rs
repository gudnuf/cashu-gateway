//! CLI and HTTP API for managing the LDK node.
//!
//! This module provides:
//! - HTTP API endpoints for node management (used by ldk-cli binary)
//! - CLI command definitions and runner

use std::sync::Arc;

use anyhow::Result;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

use crate::config::GatewayConfig;
use crate::ldk::types::{
    LnBalance, LnChannel, LnInfo, LnNewAddress, LnOpenChannelResult, LnPeer, LnSyncResult,
};
use crate::ldk::LdkNodeOperations;

// ============================================================================
// CLI Structure
// ============================================================================

#[derive(Parser)]
#[command(name = "ldk-cli")]
#[command(about = "CLI for managing the LDK Lightning node")]
pub struct LdkCli {
    /// Port where the ldk-cli API is running (overrides config)
    #[arg(short, long)]
    pub port: Option<u16>,

    #[command(subcommand)]
    pub command: LdkCommands,
}

#[derive(Subcommand)]
pub enum LdkCommands {
    /// Get node information (id, network, status)
    Info,

    /// Get node balances (onchain + lightning)
    Balance,

    /// Generate a new onchain address for funding
    NewAddress,

    /// List all channels
    Channels,

    /// List all peers
    Peers,

    /// Connect to a peer
    Connect {
        /// Node public key (hex)
        #[arg(long)]
        node_id: String,
        /// Node address (host:port)
        #[arg(long)]
        address: String,
    },

    /// Open a channel with a peer
    OpenChannel {
        /// Node public key (hex)
        #[arg(long)]
        node_id: String,
        /// Node address (host:port)
        #[arg(long)]
        address: String,
        /// Channel size in satoshis
        #[arg(long)]
        amount_sats: u64,
        /// Push amount in satoshis (optional)
        #[arg(long)]
        push_sats: Option<u64>,
    },

    /// Close a channel cooperatively
    CloseChannel {
        /// User channel ID
        #[arg(long)]
        channel_id: u128,
        /// Counterparty node public key (hex)
        #[arg(long)]
        node_id: String,
    },

    /// Sync the node with the blockchain
    Sync,
}

// ============================================================================
// API Request/Response types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectRequest {
    pub node_id: String,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenChannelRequest {
    pub node_id: String,
    pub address: String,
    pub amount_sats: u64,
    pub push_sats: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseChannelRequest {
    pub channel_id: u128,
    pub node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvoiceForHashRequest {
    pub amount_msat: u64,
    pub payment_hash: String,
    pub expiry_secs: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvoiceResponse {
    pub bolt11: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResult {
    pub success: bool,
    pub message: String,
}

// ============================================================================
// LDK API Router
// ============================================================================

#[derive(Clone)]
struct LdkAppState<T: LdkNodeOperations> {
    backend: Arc<T>,
}

async fn get_info<T: LdkNodeOperations>(State(state): State<LdkAppState<T>>) -> Json<LnInfo> {
    Json(state.backend.get_info())
}

async fn get_balance<T: LdkNodeOperations>(State(state): State<LdkAppState<T>>) -> Json<LnBalance> {
    Json(state.backend.get_balance())
}

async fn post_new_address<T: LdkNodeOperations>(
    State(state): State<LdkAppState<T>>,
) -> Result<Json<LnNewAddress>, String> {
    state
        .backend
        .new_address()
        .map(Json)
        .map_err(|e| e.to_string())
}

async fn get_channels<T: LdkNodeOperations>(
    State(state): State<LdkAppState<T>>,
) -> Json<Vec<LnChannel>> {
    Json(state.backend.list_channels())
}

async fn get_peers<T: LdkNodeOperations>(State(state): State<LdkAppState<T>>) -> Json<Vec<LnPeer>> {
    Json(state.backend.list_peers())
}

async fn post_connect<T: LdkNodeOperations>(
    State(state): State<LdkAppState<T>>,
    Json(req): Json<ConnectRequest>,
) -> Result<Json<ApiResult>, String> {
    state
        .backend
        .connect(&req.node_id, &req.address)
        .map(Json)
        .map_err(|e| e.to_string())
}

async fn post_open_channel<T: LdkNodeOperations>(
    State(state): State<LdkAppState<T>>,
    Json(req): Json<OpenChannelRequest>,
) -> Result<Json<LnOpenChannelResult>, String> {
    state
        .backend
        .open_channel(&req.node_id, &req.address, req.amount_sats, req.push_sats)
        .map(Json)
        .map_err(|e| e.to_string())
}

async fn post_close_channel<T: LdkNodeOperations>(
    State(state): State<LdkAppState<T>>,
    Json(req): Json<CloseChannelRequest>,
) -> Result<Json<ApiResult>, String> {
    state
        .backend
        .close_channel(req.channel_id, &req.node_id)
        .map(Json)
        .map_err(|e| e.to_string())
}

async fn post_sync<T: LdkNodeOperations>(
    State(state): State<LdkAppState<T>>,
) -> Result<Json<LnSyncResult>, String> {
    state.backend.sync().map(Json).map_err(|e| e.to_string())
}

async fn post_create_invoice_for_hash<T: LdkNodeOperations>(
    State(state): State<LdkAppState<T>>,
    Json(req): Json<CreateInvoiceForHashRequest>,
) -> Result<Json<CreateInvoiceResponse>, String> {
    state
        .backend
        .create_invoice_for_hash(req.amount_msat, &req.payment_hash, req.expiry_secs)
        .map(|invoice| {
            Json(CreateInvoiceResponse {
                bolt11: invoice.to_string(),
            })
        })
        .map_err(|e| e.to_string())
}

/// Creates an axum Router for the LDK CLI API endpoints
pub fn ldk_router<T: LdkNodeOperations + 'static>(backend: Arc<T>) -> Router {
    let state = LdkAppState { backend };

    Router::new()
        .route("/ldk/info", get(get_info::<T>))
        .route("/ldk/balance", get(get_balance::<T>))
        .route("/ldk/new-address", post(post_new_address::<T>))
        .route("/ldk/channels", get(get_channels::<T>))
        .route("/ldk/peers", get(get_peers::<T>))
        .route("/ldk/connect", post(post_connect::<T>))
        .route("/ldk/open-channel", post(post_open_channel::<T>))
        .route("/ldk/close-channel", post(post_close_channel::<T>))
        .route("/ldk/sync", post(post_sync::<T>))
        .route(
            "/ldk/create-invoice-for-hash",
            post(post_create_invoice_for_hash::<T>),
        )
        .with_state(state)
}

// ============================================================================
// CLI Runner
// ============================================================================

pub async fn run_ldk_cli(cli: LdkCli) -> Result<()> {
    // Load config to get the default port
    let config = GatewayConfig::load(None)?;
    let port = cli.port.unwrap_or(config.ldk_cli_port);
    let base_url = format!("http://127.0.0.1:{}", port);
    let client = reqwest::Client::new();

    match cli.command {
        LdkCommands::Info => {
            let url = format!("{}/ldk/info", base_url);
            let response = reqwest::get(&url).await;
            handle_response::<LnInfo>(response).await?;
        }
        LdkCommands::Balance => {
            let url = format!("{}/ldk/balance", base_url);
            let response = reqwest::get(&url).await;
            handle_response::<LnBalance>(response).await?;
        }
        LdkCommands::NewAddress => {
            let url = format!("{}/ldk/new-address", base_url);
            let response = client.post(&url).send().await;
            handle_response::<LnNewAddress>(response).await?;
        }
        LdkCommands::Channels => {
            let url = format!("{}/ldk/channels", base_url);
            let response = reqwest::get(&url).await;
            handle_response::<Vec<LnChannel>>(response).await?;
        }
        LdkCommands::Peers => {
            let url = format!("{}/ldk/peers", base_url);
            let response = reqwest::get(&url).await;
            handle_response::<Vec<LnPeer>>(response).await?;
        }
        LdkCommands::Connect { node_id, address } => {
            let url = format!("{}/ldk/connect", base_url);
            let req = ConnectRequest { node_id, address };
            let response = client.post(&url).json(&req).send().await;
            handle_response::<ApiResult>(response).await?;
        }
        LdkCommands::OpenChannel {
            node_id,
            address,
            amount_sats,
            push_sats,
        } => {
            let url = format!("{}/ldk/open-channel", base_url);
            let req = OpenChannelRequest {
                node_id,
                address,
                amount_sats,
                push_sats,
            };
            let response = client.post(&url).json(&req).send().await;
            handle_response::<LnOpenChannelResult>(response).await?;
        }
        LdkCommands::CloseChannel { channel_id, node_id } => {
            let url = format!("{}/ldk/close-channel", base_url);
            let req = CloseChannelRequest { channel_id, node_id };
            let response = client.post(&url).json(&req).send().await;
            handle_response::<ApiResult>(response).await?;
        }
        LdkCommands::Sync => {
            let url = format!("{}/ldk/sync", base_url);
            let response = client.post(&url).send().await;
            handle_response::<LnSyncResult>(response).await?;
        }
    }

    Ok(())
}

async fn handle_response<T: serde::de::DeserializeOwned + serde::Serialize>(
    response: Result<reqwest::Response, reqwest::Error>,
) -> Result<()> {
    match response {
        Ok(resp) => {
            if resp.status().is_success() {
                let data: T = resp.json().await?;
                println!("{}", serde_json::to_string_pretty(&data)?);
            } else {
                let text = resp.text().await?;
                eprintln!("Error: {}", text);
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("Error connecting to ldk-cli API: {}", e);
            eprintln!("Make sure the gateway is running with the ldk-cli API enabled.");
            std::process::exit(1);
        }
    }
    Ok(())
}


//! LDK Lightning Backend implementation.
//!
//! This module contains the actual LDK node implementation that:
//! - Implements the `LightningBackend` trait for the gateway
//! - Provides internal node management operations for the CLI
//! - Starts the CLI API server internally

use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use ldk_node::bitcoin::hex::FromHex;
use ldk_node::bitcoin::secp256k1::PublicKey;
use ldk_node::lightning::ln::msgs::SocketAddress;
use ldk_node::lightning_invoice::{Bolt11Invoice, Bolt11InvoiceDescription, Description};
use ldk_node::lightning_types::payment::PaymentHash;
use ldk_node::{Builder, Node};
use tokio::task::JoinHandle;

use crate::config::GatewayConfig;
use crate::ldk::cli::{ldk_router, ApiResult};
use crate::ldk::types::{
    LnBalance, LnChannel, LnInfo, LnNewAddress, LnOpenChannelResult, LnPeer, LnSyncResult,
};
use crate::lightning::{LightningBackend, PaymentResult};

pub async fn check_esplora_health(esplora_url: &str) {
    tracing::info!(esplora_url = %esplora_url, "Checking Esplora server health...");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("Failed to build HTTP client");

    // Try to hit the block height endpoint as a simple health check
    let health_url = format!("{}/blocks/tip/height", esplora_url);

    match client.get(&health_url).send().await {
        Ok(response) if response.status().is_success() => {
            tracing::info!(esplora_url = %esplora_url, "Esplora server is reachable");
        }
        Ok(response) => {
            panic!(
                "Esplora server at {} returned error status: {}. Is the server running correctly?",
                esplora_url,
                response.status()
            );
        }
        Err(e) => {
            panic!(
                "Cannot connect to Esplora server at {}: {}. \
                Make sure the Esplora server is running before starting the gateway.",
                esplora_url, e
            );
        }
    }
}

pub trait LdkNodeOperations: Send + Sync + Clone {
    fn get_info(&self) -> LnInfo;
    fn get_balance(&self) -> LnBalance;
    fn new_address(&self) -> Result<LnNewAddress>;
    fn list_channels(&self) -> Vec<LnChannel>;
    fn list_peers(&self) -> Vec<LnPeer>;
    fn connect(&self, node_id: &str, address: &str) -> Result<ApiResult>;
    fn open_channel(
        &self,
        node_id: &str,
        address: &str,
        amount_sats: u64,
        push_sats: Option<u64>,
    ) -> Result<LnOpenChannelResult>;
    fn close_channel(&self, channel_id: u128, node_id: &str) -> Result<ApiResult>;
    fn sync(&self) -> Result<LnSyncResult>;
    fn create_invoice_for_hash(
        &self,
        amount_msat: u64,
        payment_hash: &str,
        expiry_secs: u32,
    ) -> Result<Bolt11Invoice>;
}

#[derive(Clone)]
pub struct LdkLightningBackend {
    node: Arc<Node>,
    /// Handle to the CLI API server task (kept for potential cleanup)
    #[allow(dead_code)]
    cli_server_handle: Arc<Option<JoinHandle<()>>>,
}

impl LdkLightningBackend {
    fn new(config: &GatewayConfig) -> Result<Self> {
        let network = config.network();
        let esplora_url = config
            .ldk
            .esplora_url
            .as_ref()
            .expect("esplora_url should be set by config loading");
        let rgs_url = &config.ldk.rgs_url;
        let storage_dir = &config.ldk.storage_dir;
        let listening_port = config.ldk.listening_port;

        tracing::info!(
            network = ?network,
            esplora_url = %esplora_url,
            rgs_url = ?rgs_url,
            storage_dir = %storage_dir,
            listening_port = %listening_port,
            "Initializing LDK node"
        );

        let mut builder = Builder::new();
        builder.set_network(network);
        builder.set_storage_dir_path(storage_dir.clone());
        builder.set_chain_source_esplora(esplora_url.clone(), None);

        // Only set RGS for non-regtest networks
        if let Some(rgs) = rgs_url {
            builder.set_gossip_source_rgs(rgs.clone());
        }

        let listening_addr = SocketAddress::from_str(&format!("127.0.0.1:{}", listening_port))
            .expect("valid socket address");
        builder.set_listening_addresses(vec![listening_addr])?;

        // Set mnemonic if provided, otherwise LDK will generate one
        if let Some(mnemonic_str) = &config.ldk.mnemonic {
            let mnemonic =
                ldk_node::bip39::Mnemonic::from_str(mnemonic_str).expect("valid mnemonic");
            builder.set_entropy_bip39_mnemonic(mnemonic, None);
        }

        let node = builder.build()?;
        Ok(Self {
            node: Arc::new(node),
            cli_server_handle: Arc::new(None),
        })
    }

    /// Start the LDK node.
    fn start_node(&self) -> Result<()> {
        self.node.start()?;
        Ok(())
    }

    /// Stop the LDK node.
    fn stop_node(&self) -> Result<()> {
        self.node.stop()?;
        Ok(())
    }

    /// Start the CLI API server on the given port.
    fn start_cli_server(self: Arc<Self>, port: u16) -> JoinHandle<()> {
        let cli_app = ldk_router(self);
        let cli_addr = SocketAddr::from(([127, 0, 0, 1], port));

        tracing::info!("ldk-cli API listening on {}", cli_addr);

        tokio::spawn(async move {
            let cli_listener = tokio::net::TcpListener::bind(cli_addr)
                .await
                .expect("Failed to bind CLI API listener");

            if let Err(e) = axum::serve(cli_listener, cli_app).await {
                tracing::error!("CLI API server error: {}", e);
            }
        })
    }
}

#[async_trait]
impl LightningBackend for LdkLightningBackend {
    async fn setup(config: &GatewayConfig) -> Result<Self>
    where
        Self: Sized,
    {
        // Check Esplora is reachable before initializing the node
        let esplora_url = config
            .ldk
            .esplora_url
            .as_ref()
            .expect("esplora_url should be set");
        check_esplora_health(esplora_url).await;

        // Create and start the node
        let backend = Self::new(config)?;
        backend.start_node()?;

        // Start the CLI server internally
        let backend_arc = Arc::new(backend.clone());
        let cli_handle = backend_arc.clone().start_cli_server(config.ldk_cli_port);

        // Return with the CLI handle stored
        Ok(Self {
            node: backend.node,
            cli_server_handle: Arc::new(Some(cli_handle)),
        })
    }

    fn pay_invoice(&self, bolt11: &str) -> Result<PaymentResult> {
        let invoice = Bolt11Invoice::from_str(bolt11)
            .map_err(|e| anyhow!("Invalid BOLT11 invoice: {}", e))?;

        let payment_id = self.node.bolt11_payment().send(&invoice, None)?;

        // Get the payment hash from the invoice
        let payment_hash = invoice.payment_hash().to_string();

        // Get amount from invoice (or return error if amount-less invoice)
        let amount_msat = invoice
            .amount_milli_satoshis()
            .ok_or_else(|| anyhow!("Invoice has no amount specified"))?;

        tracing::info!(
            payment_id = ?payment_id,
            payment_hash = %payment_hash,
            amount_msat = %amount_msat,
            "Payment sent"
        );

        // Note: Fee is not immediately known; returning 0 for now
        // In a real implementation, you'd wait for the payment to complete
        Ok(PaymentResult {
            payment_hash,
            amount_msat,
            fee_msat: 0,
        })
    }

    fn create_invoice_for_hash(
        &self,
        amount_msat: u64,
        payment_hash: &str,
        expiry_secs: u32,
    ) -> Result<Bolt11Invoice> {
        // Parse the payment hash from hex string
        let hash_bytes: [u8; 32] = FromHex::from_hex(payment_hash)
            .map_err(|e| anyhow!("Invalid payment hash hex: {}", e))?;
        let payment_hash = PaymentHash(hash_bytes);

        let description = Bolt11InvoiceDescription::Direct(Description::empty());

        let invoice = self
            .node
            .bolt11_payment()
            .receive_for_hash(amount_msat, &description, expiry_secs, payment_hash)?;

        Ok(invoice)
    }

    fn shutdown(&self) -> Result<()> {
        self.stop_node()
    }
}

// ============================================================================
// Internal Node Operations Implementation
// ============================================================================

impl LdkNodeOperations for LdkLightningBackend {
    fn get_info(&self) -> LnInfo {
        let status = self.node.status();
        LnInfo {
            node_id: self.node.node_id().to_string(),
            network: format!("{:?}", self.node.config().network),
            listening_addresses: self
                .node
                .config()
                .listening_addresses
                .clone()
                .unwrap_or_default()
                .iter()
                .map(|a| a.to_string())
                .collect(),
            status: if status.is_running {
                "running"
            } else {
                "stopped"
            }
            .to_string(),
        }
    }

    fn get_balance(&self) -> LnBalance {
        let balances = self.node.list_balances();
        LnBalance {
            onchain_total_sats: balances.total_onchain_balance_sats,
            onchain_spendable_sats: balances.spendable_onchain_balance_sats,
            lightning_total_sats: balances.total_lightning_balance_sats,
        }
    }

    fn new_address(&self) -> Result<LnNewAddress> {
        let address = self.node.onchain_payment().new_address()?;
        Ok(LnNewAddress {
            address: address.to_string(),
        })
    }

    fn list_channels(&self) -> Vec<LnChannel> {
        self.node
            .list_channels()
            .iter()
            .map(|c| LnChannel {
                channel_id: c.user_channel_id.0.to_string(),
                counterparty_node_id: c.counterparty_node_id.to_string(),
                channel_value_sats: c.channel_value_sats,
                outbound_capacity_msat: c.outbound_capacity_msat,
                inbound_capacity_msat: c.inbound_capacity_msat,
                is_usable: c.is_usable,
                is_channel_ready: c.is_channel_ready,
                confirmations: c.confirmations,
            })
            .collect()
    }

    fn list_peers(&self) -> Vec<LnPeer> {
        self.node
            .list_peers()
            .iter()
            .map(|p| LnPeer {
                node_id: p.node_id.to_string(),
                address: p.address.to_string(),
                is_connected: p.is_connected,
            })
            .collect()
    }

    fn connect(&self, node_id: &str, address: &str) -> Result<ApiResult> {
        let pubkey = PublicKey::from_str(node_id).map_err(|e| anyhow!("Invalid node ID: {}", e))?;
        let socket_addr =
            SocketAddress::from_str(address).map_err(|e| anyhow!("Invalid address: {}", e))?;

        self.node.connect(pubkey, socket_addr, true)?;
        Ok(ApiResult {
            success: true,
            message: format!("Connected to {}", node_id),
        })
    }

    fn open_channel(
        &self,
        node_id: &str,
        address: &str,
        amount_sats: u64,
        push_sats: Option<u64>,
    ) -> Result<LnOpenChannelResult> {
        let pubkey = PublicKey::from_str(node_id).map_err(|e| anyhow!("Invalid node ID: {}", e))?;
        let socket_addr =
            SocketAddress::from_str(address).map_err(|e| anyhow!("Invalid address: {}", e))?;

        // First connect
        self.node.connect(pubkey, socket_addr.clone(), true)?;

        // Then open channel (push amount is in msats)
        // Use private channel (not announced) for simpler operation
        let push_msat = push_sats.map(|s| s * 1000);
        let user_channel_id =
            self.node
                .open_channel(pubkey, socket_addr, amount_sats, push_msat, None)?;

        Ok(LnOpenChannelResult {
            user_channel_id: user_channel_id.0.to_string(),
            message: "Channel opening initiated. Waiting for confirmations.".to_string(),
        })
    }

    fn close_channel(&self, channel_id: u128, node_id: &str) -> Result<ApiResult> {
        let pubkey = PublicKey::from_str(node_id).map_err(|e| anyhow!("Invalid node ID: {}", e))?;
        let user_channel_id = ldk_node::UserChannelId(channel_id);

        self.node.close_channel(&user_channel_id, pubkey)?;
        Ok(ApiResult {
            success: true,
            message: "Channel close initiated".to_string(),
        })
    }

    fn sync(&self) -> Result<LnSyncResult> {
        self.node.sync_wallets()?;
        Ok(LnSyncResult {
            message: "Sync completed".to_string(),
        })
    }

    fn create_invoice_for_hash(
        &self,
        amount_msat: u64,
        payment_hash: &str,
        expiry_secs: u32,
    ) -> Result<Bolt11Invoice> {
        LightningBackend::create_invoice_for_hash(self, amount_msat, payment_hash, expiry_secs)
    }
}

// Re-export LdkNodeOperations for the Arc<LdkLightningBackend> case
impl LdkNodeOperations for Arc<LdkLightningBackend> {
    fn get_info(&self) -> LnInfo {
        (**self).get_info()
    }

    fn get_balance(&self) -> LnBalance {
        (**self).get_balance()
    }

    fn new_address(&self) -> Result<LnNewAddress> {
        (**self).new_address()
    }

    fn list_channels(&self) -> Vec<LnChannel> {
        (**self).list_channels()
    }

    fn list_peers(&self) -> Vec<LnPeer> {
        (**self).list_peers()
    }

    fn connect(&self, node_id: &str, address: &str) -> Result<ApiResult> {
        (**self).connect(node_id, address)
    }

    fn open_channel(
        &self,
        node_id: &str,
        address: &str,
        amount_sats: u64,
        push_sats: Option<u64>,
    ) -> Result<LnOpenChannelResult> {
        (**self).open_channel(node_id, address, amount_sats, push_sats)
    }

    fn close_channel(&self, channel_id: u128, node_id: &str) -> Result<ApiResult> {
        (**self).close_channel(channel_id, node_id)
    }

    fn sync(&self) -> Result<LnSyncResult> {
        (**self).sync()
    }

    fn create_invoice_for_hash(
        &self,
        amount_msat: u64,
        payment_hash: &str,
        expiry_secs: u32,
    ) -> Result<Bolt11Invoice> {
        LightningBackend::create_invoice_for_hash(self.as_ref(), amount_msat, payment_hash, expiry_secs)
    }
}


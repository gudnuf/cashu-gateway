//! Internal types for LDK node management.
//!
//! These types are used by the CLI API but are NOT exposed to the gateway.

use serde::{Deserialize, Serialize};

// ============================================================================
// Node Information Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnInfo {
    pub node_id: String,
    pub network: String,
    pub listening_addresses: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnBalance {
    pub onchain_total_sats: u64,
    pub onchain_spendable_sats: u64,
    pub lightning_total_sats: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnChannel {
    pub channel_id: String,
    pub counterparty_node_id: String,
    pub channel_value_sats: u64,
    pub outbound_capacity_msat: u64,
    pub inbound_capacity_msat: u64,
    pub is_usable: bool,
    pub is_channel_ready: bool,
    pub confirmations: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnPeer {
    pub node_id: String,
    pub address: String,
    pub is_connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnNewAddress {
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnOpenChannelResult {
    pub user_channel_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnSyncResult {
    pub message: String,
}


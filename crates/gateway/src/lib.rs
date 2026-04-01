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

pub mod config;
pub mod ecash;
pub mod ldk;
pub mod lightning;

use serde::{Deserialize, Serialize};

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

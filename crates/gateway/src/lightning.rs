//! Lightning backend trait for the Cashu gateway.

use anyhow::Result;
use async_trait::async_trait;
use ldk_node::lightning_invoice::Bolt11Invoice;
use serde::{Deserialize, Serialize};

use crate::config::GatewayConfig;


/// Result of a successful payment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentResult {
    /// Payment hash (hex encoded)
    pub payment_hash: String,
    /// Amount paid in millisatoshis
    pub amount_msat: u64,
    /// Fee paid in millisatoshis
    pub fee_msat: u64,
}

#[async_trait]
pub trait LightningBackend: Send + Sync {
    async fn setup(config: &GatewayConfig) -> Result<Self>
    where
        Self: Sized;
    fn pay_invoice(&self, bolt11: &str) -> Result<PaymentResult>;
    fn create_invoice_for_hash(
        &self,
        amount_msat: u64,
        payment_hash: &str,
        expiry_secs: u32,
    ) -> Result<Bolt11Invoice>;

    fn shutdown(&self) -> Result<()>;
}

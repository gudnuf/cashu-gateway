//! Ecash wallet module using CDK (Cashu Development Kit).
//!
//! Provides a CDK-based ecash wallet that connects to a Cashu mint.
//! This handles the ecash side of the gateway — Lightning is handled by the LDK backend.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{Context, Result};
use cdk::mint_url::MintUrl;
use cdk::nuts::CurrencyUnit;
use cdk::wallet::WalletBuilder;
use cdk::Wallet;
use cdk_sqlite::WalletSqliteDatabase;
use rand::RngCore;
use tracing::{info, warn};

/// CDK-based ecash wallet for Cashu operations.
pub struct EcashWallet {
    wallet: Wallet,
}

impl EcashWallet {
    /// Create a new ecash wallet connected to the given mint.
    ///
    /// Sets up a SQLite-backed wallet store and generates a random seed.
    /// On startup, recovers any incomplete sagas (interrupted operations).
    pub async fn new(mint_url: &str, storage_dir: &str) -> Result<Self> {
        // Ensure storage directory exists
        let storage_path = PathBuf::from(storage_dir);
        std::fs::create_dir_all(&storage_path)
            .with_context(|| format!("Failed to create ecash storage dir: {}", storage_dir))?;

        // Create SQLite wallet database
        let db_path = storage_path.join("wallet.sqlite");
        let localstore = WalletSqliteDatabase::new(&db_path)
            .await
            .with_context(|| {
                format!(
                    "Failed to create ecash SQLite database at {}",
                    db_path.display()
                )
            })?;

        // Generate random seed (64 bytes)
        // TODO: Support config-based seed for deterministic wallet recovery
        let mut seed = [0u8; 64];
        rand::thread_rng().fill_bytes(&mut seed);

        let mint = MintUrl::from_str(mint_url)
            .map_err(|e| anyhow::anyhow!("Invalid mint URL '{}': {}", mint_url, e))?;

        let wallet = WalletBuilder::new()
            .mint_url(mint)
            .unit(CurrencyUnit::Sat)
            .localstore(Arc::new(localstore))
            .seed(seed)
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build ecash wallet: {}", e))?;

        // Recover any incomplete operations from previous runs
        match wallet.recover_incomplete_sagas().await {
            Ok(report) => {
                info!(?report, "Ecash wallet saga recovery complete");
            }
            Err(e) => {
                warn!("Ecash wallet saga recovery failed (mint may be unreachable): {e}");
            }
        }

        Ok(Self { wallet })
    }

    /// Get the total ecash balance in sats.
    pub async fn get_balance(&self) -> Result<u64> {
        let balance = self
            .wallet
            .total_balance()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get ecash balance: {}", e))?;

        Ok(u64::from(balance))
    }

    /// Access the underlying CDK wallet for advanced operations.
    pub fn wallet(&self) -> &Wallet {
        &self.wallet
    }
}

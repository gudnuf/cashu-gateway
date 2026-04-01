//! Alice's ecash wallet using CDK (Cashu Development Kit).
//!
//! Provides a CDK-based ecash wallet for the Alice (client) side of the Cashu gateway.
//! Alice uses this wallet to hold ecash, generate preimages for receive flows,
//! and claim HTLC-locked tokens from the gateway.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{Context, Result};
use cdk::mint_url::MintUrl;
use cdk::nuts::{CurrencyUnit, Proof, PublicKey, SecretKey};
use cdk::wallet::{ReceiveOptions, WalletBuilder};
use cdk::Wallet;
use cdk_sqlite::WalletSqliteDatabase;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

/// Alice's CDK-based ecash wallet.
///
/// Wraps a CDK wallet connected to a Cashu mint and holds Alice's signing keypair,
/// used for HTLC spending conditions (SIG_ALL).
pub struct AliceWallet {
    wallet: Wallet,
    /// Alice's signing key, used to satisfy SIG_ALL on HTLC-locked tokens.
    secret_key: SecretKey,
}

impl AliceWallet {
    /// Create a new Alice wallet connected to the given mint.
    ///
    /// Sets up a SQLite-backed wallet store and generates a random seed.
    /// On startup, recovers any incomplete sagas (interrupted operations).
    ///
    /// Also derives a signing keypair from the seed for HTLC spending conditions.
    pub async fn new(mint_url: &str, storage_dir: &str) -> Result<Self> {
        // Ensure storage directory exists
        let storage_path = PathBuf::from(storage_dir);
        std::fs::create_dir_all(&storage_path)
            .with_context(|| format!("Failed to create wallet storage dir: {}", storage_dir))?;

        // Create SQLite wallet database
        let db_path = storage_path.join("wallet.sqlite");
        let localstore = WalletSqliteDatabase::new(&db_path)
            .await
            .with_context(|| {
                format!(
                    "Failed to create wallet SQLite database at {}",
                    db_path.display()
                )
            })?;

        // Generate random seed (64 bytes)
        // TODO: Support config-based BIP39 mnemonic for deterministic wallet recovery
        let mut seed = [0u8; 64];
        rand::thread_rng().fill_bytes(&mut seed);

        // Derive Alice's signing keypair from the first 32 bytes of the seed.
        // This key is used to satisfy SIG_ALL conditions on HTLC-locked tokens.
        let secret_key = SecretKey::from_slice(&seed[..32])
            .map_err(|e| anyhow::anyhow!("Failed to derive signing key from seed: {}", e))?;

        info!(
            alice_pubkey = %secret_key.public_key(),
            "Alice ecash signing key derived"
        );

        let mint = MintUrl::from_str(mint_url)
            .map_err(|e| anyhow::anyhow!("Invalid mint URL '{}': {}", mint_url, e))?;

        let wallet = WalletBuilder::new()
            .mint_url(mint)
            .unit(CurrencyUnit::Sat)
            .localstore(Arc::new(localstore))
            .seed(seed)
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build Alice wallet: {}", e))?;

        // Recover any incomplete operations from previous runs
        match wallet.recover_incomplete_sagas().await {
            Ok(report) => {
                info!(?report, "Alice wallet saga recovery complete");
            }
            Err(e) => {
                warn!("Alice wallet saga recovery failed (mint may be unreachable): {e}");
            }
        }

        Ok(Self { wallet, secret_key })
    }

    /// Get Alice's public key.
    ///
    /// Used in HTLC spending conditions so the gateway knows which pubkey
    /// to lock tokens to.
    pub fn pubkey(&self) -> PublicKey {
        self.secret_key.public_key()
    }

    /// Get Alice's secret key.
    ///
    /// Needed to sign when claiming HTLC-locked tokens with SIG_ALL conditions.
    pub fn secret_key(&self) -> &SecretKey {
        &self.secret_key
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

    /// Get unspent proofs sufficient for the requested amount.
    ///
    /// Returns all unspent proofs from the wallet after verifying the total
    /// is at least `amount_sats`. The gateway will handle change during the swap.
    pub async fn get_proofs_for_amount(&self, amount_sats: u64) -> Result<Vec<Proof>> {
        let proofs = self
            .wallet
            .get_unspent_proofs()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get unspent proofs: {}", e))?;

        let total: u64 = proofs.iter().map(|p| u64::from(p.amount)).sum();
        if total < amount_sats {
            return Err(anyhow::anyhow!(
                "Insufficient ecash balance: have {} sats, need {} sats",
                total,
                amount_sats
            ));
        }

        Ok(proofs)
    }

    /// Generate a random 32-byte preimage and its SHA-256 hash.
    ///
    /// Used in the receive flow: Alice generates the preimage, sends its hash
    /// to the gateway, and the gateway creates a HODL invoice locked to that hash.
    /// Alice can then claim the HTLC-locked ecash by revealing the preimage.
    ///
    /// # Returns
    /// `(preimage_bytes, hex_encoded_sha256_hash)`
    pub fn generate_preimage() -> (Vec<u8>, String) {
        let mut preimage = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut preimage);

        let hash = Sha256::digest(preimage);
        let hash_hex = hex::encode(hash);

        (preimage.to_vec(), hash_hex)
    }

    /// Claim an HTLC-locked ecash token using a preimage.
    ///
    /// Parses the Cashu token string, provides the preimage and Alice's signing
    /// key as witnesses, and receives the token via the CDK wallet. The CDK
    /// `receive` method constructs the appropriate `HTLCWitness` and satisfies
    /// the SIG_ALL spending conditions.
    ///
    /// # Arguments
    /// * `token_str` - Serialized Cashu V4 token containing HTLC-locked proofs
    /// * `preimage` - The 32-byte preimage that hashes to the HTLC payment hash
    ///
    /// # Returns
    /// The amount received in sats.
    pub async fn claim_htlc_token(&self, token_str: &str, preimage: &[u8]) -> Result<u64> {
        let preimage_hex = hex::encode(preimage);

        info!(
            preimage_hash = %hex::encode(Sha256::digest(preimage)),
            "Claiming HTLC-locked ecash token"
        );

        let opts = ReceiveOptions {
            preimages: vec![preimage_hex],
            p2pk_signing_keys: vec![self.secret_key.clone()],
            ..Default::default()
        };

        let amount = self
            .wallet
            .receive(token_str, opts)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to claim HTLC token: {}", e))?;

        let sats = u64::from(amount);
        info!(received_sats = sats, "HTLC ecash token claimed");
        Ok(sats)
    }

    /// Access the underlying CDK wallet for advanced operations.
    pub fn wallet(&self) -> &Wallet {
        &self.wallet
    }
}

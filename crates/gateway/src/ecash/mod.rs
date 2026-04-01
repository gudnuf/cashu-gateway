//! Ecash wallet module using CDK (Cashu Development Kit).
//!
//! Provides a CDK-based ecash wallet that connects to a Cashu mint.
//! This handles the ecash side of the gateway — Lightning is handled by the LDK backend.
//!
//! ## Gateway Payment Flows
//!
//! **Inbound Lightning (receive):** Gateway creates HTLC-locked ecash tokens with
//! [`create_htlc_token`](EcashWallet::create_htlc_token), locked to the Lightning payment hash.
//! Alice claims them by revealing the preimage to the mint. Gateway polls NUT-07 via
//! [`check_htlc_state`](EcashWallet::check_htlc_state) to learn the preimage and settle the
//! Lightning HTLC.
//!
//! **Outbound Lightning (pay):** Alice sends ecash proofs to the gateway. Gateway verifies
//! and receives them via [`receive_proofs`](EcashWallet::receive_proofs), then pays the
//! Lightning invoice.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{Context, Result};
use cdk::mint_url::MintUrl;
use cdk::nuts::{
    Conditions, CurrencyUnit, HTLCWitness, Proof, Proofs, PublicKey, SecretKey, SigFlag,
    SpendingConditions, State, Witness,
};
use cdk::wallet::{ReceiveOptions, WalletBuilder};
use cdk::{Amount, Wallet};
use cdk_sqlite::WalletSqliteDatabase;
use rand::RngCore;
use tracing::{debug, info, warn};

/// CDK-based ecash wallet for Cashu operations.
///
/// Holds a CDK wallet connected to a Cashu mint and a signing keypair used for
/// HTLC refund paths and SIG_ALL verification.
pub struct EcashWallet {
    wallet: Wallet,
    /// Gateway's signing key, used for HTLC refund paths.
    secret_key: SecretKey,
}

impl EcashWallet {
    /// Create a new ecash wallet connected to the given mint.
    ///
    /// Sets up a SQLite-backed wallet store and generates a random seed.
    /// On startup, recovers any incomplete sagas (interrupted operations).
    ///
    /// Also derives a signing keypair from the seed for HTLC refund paths.
    /// TODO: Support config-based BIP39 mnemonic for deterministic key derivation.
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

        // Derive gateway signing keypair from the first 32 bytes of the seed.
        // This key is used for the refund path on HTLC-locked tokens.
        let secret_key = SecretKey::from_slice(&seed[..32])
            .map_err(|e| anyhow::anyhow!("Failed to derive signing key from seed: {}", e))?;

        info!(
            gateway_pubkey = %secret_key.public_key(),
            "Gateway ecash signing key derived"
        );

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

        Ok(Self { wallet, secret_key })
    }

    /// Get the gateway's public key.
    ///
    /// This is used in HTLC refund tags so the gateway can reclaim tokens after locktime.
    pub fn pubkey(&self) -> PublicKey {
        self.secret_key.public_key()
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

    // ========================================================================
    // HTLC Token Creation (inbound Lightning receive flow)
    // ========================================================================

    /// Create HTLC-locked ecash for an inbound Lightning payment.
    ///
    /// The gateway calls this after creating a HODL invoice. The returned proofs are
    /// locked so that only `alice_pubkey` can spend them by revealing the preimage
    /// that hashes to `payment_hash`. The gateway's own pubkey is set as the refund
    /// key, allowing reclaim after `locktime`.
    ///
    /// # Arguments
    /// * `amount_sats` - Amount of ecash to lock (matches the Lightning invoice)
    /// * `payment_hash` - Hex-encoded SHA-256 hash from the Lightning invoice
    /// * `alice_pubkey` - Alice's public key (she can spend with preimage + signature)
    /// * `locktime` - Optional unix timestamp after which the gateway can refund
    ///
    /// # Flow
    /// 1. Builds `SpendingConditions::HTLCConditions` with SIG_ALL
    /// 2. Swaps existing wallet proofs into HTLC-locked proofs
    /// 3. Returns the locked proofs to be sent to Alice
    pub async fn create_htlc_token(
        &self,
        amount_sats: u64,
        payment_hash: &str,
        alice_pubkey: PublicKey,
        locktime: Option<u64>,
    ) -> Result<Proofs> {
        let gateway_pubkey = self.pubkey();

        let spending_conditions = SpendingConditions::new_htlc_hash(
            payment_hash,
            Some(Conditions {
                locktime,
                pubkeys: Some(vec![alice_pubkey]),
                refund_keys: Some(vec![gateway_pubkey]),
                num_sigs: None,
                sig_flag: SigFlag::SigAll,
                num_sigs_refund: None,
            }),
        )
        .map_err(|e| anyhow::anyhow!("Failed to create HTLC spending conditions: {}", e))?;

        let amount = Amount::from(amount_sats);

        // Swap existing proofs into HTLC-locked proofs.
        // We pass Some(amount) so the swap returns the HTLC-locked proofs as "change"
        // while the rest stays in the wallet.
        let input_proofs = self
            .wallet
            .get_unspent_proofs()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get unspent proofs for HTLC swap: {}", e))?;

        let total: u64 = input_proofs.iter().map(|p| u64::from(p.amount)).sum();
        if total < amount_sats {
            return Err(anyhow::anyhow!(
                "Insufficient ecash balance for HTLC: have {} sats, need {} sats",
                total,
                amount_sats
            ));
        }

        info!(
            amount_sats,
            payment_hash,
            alice_pubkey = %alice_pubkey,
            "Creating HTLC-locked ecash tokens"
        );

        let htlc_proofs = self
            .wallet
            .swap(
                Some(amount),
                cdk::amount::SplitTarget::default(),
                input_proofs,
                Some(spending_conditions),
                true,  // include_fees
                false, // use_p2bk
            )
            .await
            .map_err(|e| anyhow::anyhow!("Failed to swap proofs to HTLC-locked: {}", e))?;

        // When amount is Some, swap returns Some(proofs) — the HTLC-locked portion.
        // When amount is None, swap returns None (all proofs swapped, stored in DB).
        let proofs = htlc_proofs
            .ok_or_else(|| anyhow::anyhow!("Swap returned no HTLC proofs (unexpected)"))?;

        let locked_amount: u64 = proofs.iter().map(|p| u64::from(p.amount)).sum();
        info!(
            locked_amount_sats = locked_amount,
            num_proofs = proofs.len(),
            "HTLC-locked ecash tokens created"
        );

        Ok(proofs)
    }

    // ========================================================================
    // Proof Reception (outbound Lightning pay flow)
    // ========================================================================

    /// Receive ecash proofs from Alice for an outbound Lightning payment.
    ///
    /// Verifies the proofs are valid with the mint (via a swap) and adds them
    /// to the wallet's balance. Returns the total amount received in sats.
    pub async fn receive_proofs(&self, proofs: Proofs) -> Result<u64> {
        let amount = self
            .wallet
            .receive_proofs(proofs, ReceiveOptions::default(), None, None)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to receive ecash proofs: {}", e))?;

        let sats = u64::from(amount);
        info!(received_sats = sats, "Ecash proofs received and verified");
        Ok(sats)
    }

    // ========================================================================
    // NUT-07 State Monitoring (preimage discovery)
    // ========================================================================

    /// Check if HTLC proofs have been spent and extract the preimage.
    ///
    /// Polls the mint's NUT-07 `/v1/checkstate` endpoint to determine whether
    /// Alice has claimed the HTLC-locked tokens. If any proof is `State::Spent`
    /// and carries a witness with an `HTLCWitness`, the preimage is extracted
    /// and returned.
    ///
    /// # Returns
    /// * `Ok(Some(preimage_hex))` - If at least one proof is spent and the witness
    ///   contains the preimage (64-char hex string, 32 bytes)
    /// * `Ok(None)` - If proofs are still unspent or spent without a witness
    pub async fn check_htlc_state(&self, proofs: &[Proof]) -> Result<Option<String>> {
        let states = self
            .wallet
            .check_proofs_spent(proofs.to_vec())
            .await
            .map_err(|e| anyhow::anyhow!("Failed to check proof states via NUT-07: {}", e))?;

        for state in &states {
            debug!(
                y = %state.y,
                state = %state.state,
                has_witness = state.witness.is_some(),
                "NUT-07 proof state"
            );

            if state.state == State::Spent {
                if let Some(Witness::HTLCWitness(HTLCWitness {
                    preimage,
                    ..
                })) = &state.witness
                {
                    if !preimage.is_empty() {
                        info!(
                            preimage_len = preimage.len(),
                            "Preimage discovered via NUT-07 witness"
                        );
                        return Ok(Some(preimage.clone()));
                    }
                }

                // Proof is spent but no witness/preimage in the response.
                debug!(
                    y = %state.y,
                    "Proof is SPENT but NUT-07 response has no preimage witness"
                );
            }
        }

        Ok(None)
    }
}

//! Shared test infrastructure for integration tests.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use ldk_node::bitcoin::Network;
use ldk_node::lightning::ln::msgs::SocketAddress;
use ldk_node::lightning_invoice::Bolt11Invoice;
use ldk_node::{Builder, Node};
use serde_json::json;

use cashu_gateway::lightning::PaymentResult;
use cashu_gateway::GatewayInfo;

// CDK imports for Alice's test wallet
use std::sync::Arc as StdArc;
use cdk::wallet::WalletBuilder;
use cdk::nuts::{CurrencyUnit, SecretKey, PublicKey as CdkPublicKey};
use cdk::mint_url::MintUrl;
use cdk::amount::SplitTarget;
use cdk::Amount;
use cdk_common::PaymentMethod;
use cdk_common::nut00::KnownMethod;
use cdk_sqlite::WalletSqliteDatabase;
use ldk_node::bitcoin::hashes::{sha256, Hash};

// =============================================================================
// Constants
// =============================================================================

pub const BITCOIND_URL: &str = "http://127.0.0.1:18443";
pub const BITCOIND_USER: &str = "bitcoin";
pub const BITCOIND_PASS: &str = "bitcoin";
pub const ESPLORA_URL: &str = "http://127.0.0.1:3002";

pub const LN_PORT: u16 = 9735;
pub const TEST_NODE_PORT: u16 = 9836;
pub const CHANNEL_SIZE_SATS: u64 = 100_000;
pub const PUSH_SATS: u64 = 50_000;

pub const TEST_API_PORT: u16 = 13338;
pub const TEST_LDK_CLI_PORT: u16 = 13339;
pub const MINT_URL: &str = "http://127.0.0.1:8085"; // CDK mint in docker-compose

// =============================================================================
// API Types
// =============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
pub struct LnInfo {
    pub node_id: String,
    #[allow(dead_code)]
    pub network: String,
    #[allow(dead_code)]
    pub listening_addresses: Vec<String>,
    #[allow(dead_code)]
    pub status: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct LnChannel {
    #[allow(dead_code)]
    pub channel_id: String,
    #[allow(dead_code)]
    pub counterparty_node_id: String,
    #[allow(dead_code)]
    pub channel_value_sats: u64,
    #[allow(dead_code)]
    pub outbound_capacity_msat: u64,
    #[allow(dead_code)]
    pub inbound_capacity_msat: u64,
    pub is_usable: bool,
    #[allow(dead_code)]
    pub is_channel_ready: bool,
    #[allow(dead_code)]
    pub confirmations: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CreateInvoiceForHashRequest {
    pub amount_msat: u64,
    pub payment_hash: String,
    pub expiry_secs: u32,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct CreateInvoiceResponse {
    pub bolt11: String,
}

// =============================================================================
// TestEnv
// =============================================================================

pub struct TestEnv {
    gateway_process: Option<Child>,
    pub gateway_url: String,
    pub ldk_cli_url: String,
    pub mint_url: String,
    pub http: reqwest::Client,
    test_dir: PathBuf,
    pub node: Arc<Node>,
    pub alice: TestAliceWallet,
}

impl TestEnv {
    pub async fn setup() -> Result<Self> {
        let test_id = uuid::Uuid::new_v4().to_string()[..8].to_string();
        let test_dir = std::env::temp_dir().join(format!("cashu-test-{}", test_id));
        std::fs::create_dir_all(&test_dir)?;

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;

        // Wait for regtest services
        wait_for_bitcoind(&http).await?;
        wait_for_esplora(&http).await?;
        wait_for_mint(&http).await?;
        ensure_minimum_blocks(&http, 101).await?;

        // Start gateway process
        let gateway_dir = test_dir.join("gateway");
        std::fs::create_dir_all(&gateway_dir)?;

        let child = spawn_gateway(&gateway_dir)?;
        let gateway_url = format!("http://127.0.0.1:{}", TEST_API_PORT);
        let ldk_cli_url = format!("http://127.0.0.1:{}", TEST_LDK_CLI_PORT);

        wait_for_gateway(&http, &gateway_url, 30).await?;

        // Create and fund test node
        let node = create_test_node(&test_dir)?;
        fund_node(&http, &node).await?;

        // Open channel to gateway
        let gateway_node_id = get_gateway_node_id(&http, &ldk_cli_url).await?;
        open_channel_to_gateway(&http, &node, gateway_node_id, &ldk_cli_url).await?;

        let mint_url = MINT_URL.to_string();

        // Setup Alice's ecash wallet
        let alice = TestAliceWallet::setup(&test_dir, MINT_URL).await?;
        // Pre-fund Alice with some ecash (1000 sats)
        alice.mint_ecash(1000).await?;

        Ok(Self {
            gateway_process: Some(child),
            gateway_url,
            ldk_cli_url,
            mint_url,
            http,
            test_dir,
            node,
            alice,
        })
    }

    pub async fn gateway_info(&self) -> Result<GatewayInfo> {
        let resp = self
            .http
            .get(format!("{}/info", self.gateway_url))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow!("GET /info failed: {}", resp.status()));
        }
        Ok(resp.json().await?)
    }

    pub async fn create_invoice_for_hash(
        &self,
        amount_msat: u64,
        payment_hash: &str,
        expiry_secs: u32,
    ) -> Result<Bolt11Invoice> {
        let req = CreateInvoiceForHashRequest {
            amount_msat,
            payment_hash: payment_hash.to_string(),
            expiry_secs,
        };

        let resp = self
            .http
            .post(format!("{}/ldk/create-invoice-for-hash", self.ldk_cli_url))
            .json(&req)
            .send()
            .await?;

        if !resp.status().is_success() {
            let text = resp.text().await?;
            return Err(anyhow!("create-invoice-for-hash failed: {}", text));
        }

        let response: CreateInvoiceResponse = resp.json().await?;
        Ok(Bolt11Invoice::from_str(&response.bolt11)?)
    }

    pub fn pay_invoice(&self, bolt11: &str) -> Result<PaymentResult> {
        let invoice = Bolt11Invoice::from_str(bolt11)
            .map_err(|e| anyhow!("Invalid BOLT11 invoice: {}", e))?;

        let payment_id = self.node.bolt11_payment().send(&invoice, None)?;
        let payment_hash = invoice.payment_hash().to_string();
        let amount_msat = invoice
            .amount_milli_satoshis()
            .ok_or_else(|| anyhow!("Invoice has no amount"))?;

        tracing::info!(?payment_id, %payment_hash, %amount_msat, "Payment sent");

        Ok(PaymentResult {
            payment_hash: payment_hash.clone(),
            payment_preimage: payment_hash, // placeholder for test helper
            amount_msat,
            fee_msat: 0,
        })
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        if let Some(mut child) = self.gateway_process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = self.node.stop();
        std::thread::sleep(Duration::from_millis(200));

        if self.test_dir.exists() {
            let _ = std::fs::remove_dir_all(&self.test_dir);
        }
    }
}

// =============================================================================
// Setup Helpers
// =============================================================================

fn find_gateway_binary() -> Result<PathBuf> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());

    // Search from both the crate manifest dir and the workspace root
    let workspace_root = manifest_dir
        .ancestors()
        .find(|p| p.join("Cargo.lock").exists())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| manifest_dir.clone());

    for base in [&manifest_dir, &workspace_root] {
        for path in ["target/debug/cashu-gateway", "target/release/cashu-gateway"] {
            let candidate = base.join(path);
            if candidate.exists() {
                return candidate
                    .canonicalize()
                    .map_err(|e| anyhow!("Failed to canonicalize: {}", e));
            }
        }
    }

    Err(anyhow!("cashu-gateway binary not found. Run `cargo build` first."))
}

fn spawn_gateway(gateway_dir: &PathBuf) -> Result<Child> {
    let binary = find_gateway_binary()?;
    Command::new(&binary)
        .arg("serve")
        .env("GATEWAY_API_PORT", TEST_API_PORT.to_string())
        .env("GATEWAY_LDK_CLI_PORT", TEST_LDK_CLI_PORT.to_string())
        .env("GATEWAY_LDK_NETWORK", "regtest")
        .env("GATEWAY_LDK_STORAGE_DIR", gateway_dir.to_str().unwrap())
        .env("GATEWAY_LDK_LISTENING_PORT", LN_PORT.to_string())
        .env("GATEWAY_ESPLORA_URL", ESPLORA_URL)
        .env("GATEWAY_MINT_URL", MINT_URL)
        .env("GATEWAY_ECASH_STORAGE_DIR", gateway_dir.join("ecash").to_str().unwrap())
        .env("RUST_LOG", "info")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow!("Failed to spawn gateway: {}", e))
}

fn create_test_node(test_dir: &PathBuf) -> Result<Arc<Node>> {
    let node_dir = test_dir.join("test_node");
    std::fs::create_dir_all(&node_dir)?;

    let mut builder = Builder::new();
    builder.set_network(Network::Regtest);
    builder.set_storage_dir_path(node_dir.to_str().unwrap().to_string());
    builder.set_chain_source_esplora(ESPLORA_URL.to_string(), None);

    let addr = SocketAddress::from_str(&format!("0.0.0.0:{}", TEST_NODE_PORT))
        .map_err(|_| anyhow!("Invalid address"))?;
    builder.set_listening_addresses(vec![addr])?;

    let node = Arc::new(builder.build()?);
    node.start()?;
    Ok(node)
}

async fn fund_node(http: &reqwest::Client, node: &Arc<Node>) -> Result<()> {
    let addr = node.onchain_payment().new_address()?.to_string();
    ensure_wallet_loaded(http).await?;

    // Send 1 BTC to ensure sufficient funds for channel opening
    let _: String =
        serde_json::from_value(bitcoin_rpc(http, "sendtoaddress", json!([addr, 1.0])).await?)?;

    // Mine enough blocks to confirm the transaction (6+ confirmations required by LDK)
    mine_blocks(http, 10).await?;

    // Wait and sync multiple times to ensure wallet picks up the funds
    for attempt in 1..=5 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        node.sync_wallets()?;

        let balance = node.list_balances();
        let spendable = balance.spendable_onchain_balance_sats;

        if spendable >= CHANNEL_SIZE_SATS * 2 {
            tracing::info!(%spendable, "Node funded successfully");
            return Ok(());
        }

        tracing::info!(attempt, %spendable, "Waiting for balance to sync...");
        mine_blocks(http, 2).await?;
    }

    let balance = node.list_balances();
    Err(anyhow!(
        "Failed to fund node: only {} sats available, need at least {} sats",
        balance.spendable_onchain_balance_sats,
        CHANNEL_SIZE_SATS * 2
    ))
}

async fn get_gateway_node_id(
    http: &reqwest::Client,
    ldk_cli_url: &str,
) -> Result<ldk_node::bitcoin::secp256k1::PublicKey> {
    let info: LnInfo = http
        .get(format!("{}/ldk/info", ldk_cli_url))
        .send()
        .await?
        .json()
        .await?;

    info.node_id.parse().map_err(|_| anyhow!("Invalid node_id"))
}

async fn open_channel_to_gateway(
    http: &reqwest::Client,
    node: &Arc<Node>,
    gateway_node_id: ldk_node::bitcoin::secp256k1::PublicKey,
    ldk_cli_url: &str,
) -> Result<()> {
    let gateway_addr = SocketAddress::from_str(&format!("127.0.0.1:{}", LN_PORT))
        .map_err(|_| anyhow!("Invalid gateway address"))?;

    node.connect(gateway_node_id, gateway_addr.clone(), true)?;
    tokio::time::sleep(Duration::from_secs(1)).await;

    let push_msat = Some(PUSH_SATS * 1000);
    node.open_channel(gateway_node_id, gateway_addr, CHANNEL_SIZE_SATS, push_msat, None)?;

    wait_for_channel_usable(http, ldk_cli_url, 90).await
}

// =============================================================================
// Bitcoin/Regtest Helpers
// =============================================================================

pub async fn bitcoin_rpc(
    http: &reqwest::Client,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    let body = json!({
        "jsonrpc": "1.0",
        "id": "test",
        "method": method,
        "params": params
    });

    let resp = http
        .post(BITCOIND_URL)
        .basic_auth(BITCOIND_USER, Some(BITCOIND_PASS))
        .json(&body)
        .send()
        .await?;

    let json: serde_json::Value = resp.json().await?;

    if let Some(error) = json.get("error") {
        if !error.is_null() {
            return Err(anyhow!("RPC error: {}", error));
        }
    }

    json.get("result")
        .cloned()
        .ok_or_else(|| anyhow!("No result in RPC response"))
}

pub async fn ensure_wallet_loaded(http: &reqwest::Client) -> Result<()> {
    if bitcoin_rpc(http, "loadwallet", json!(["default"])).await.is_ok() {
        return Ok(());
    }
    if bitcoin_rpc(http, "createwallet", json!(["default"])).await.is_ok() {
        return Ok(());
    }
    bitcoin_rpc(http, "getwalletinfo", json!([])).await?;
    Ok(())
}

pub async fn mine_blocks(http: &reqwest::Client, count: u64) -> Result<()> {
    ensure_wallet_loaded(http).await?;
    let address: String =
        serde_json::from_value(bitcoin_rpc(http, "getnewaddress", json!([])).await?)?;
    bitcoin_rpc(http, "generatetoaddress", json!([count, address])).await?;
    Ok(())
}

// =============================================================================
// Wait Helpers
// =============================================================================

async fn wait_for_bitcoind(http: &reqwest::Client) -> Result<()> {
    let timeout = Duration::from_secs(10);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if bitcoin_rpc(http, "getblockchaininfo", json!([])).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(anyhow!("Bitcoind not available. Run `start-regtest` first."))
}

async fn wait_for_esplora(http: &reqwest::Client) -> Result<()> {
    let timeout = Duration::from_secs(10);
    let start = std::time::Instant::now();
    let url = format!("{}/blocks/tip/height", ESPLORA_URL);

    while start.elapsed() < timeout {
        if let Ok(resp) = http.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(anyhow!("Esplora not available. Run `start-regtest` first."))
}

async fn wait_for_mint(http: &reqwest::Client) -> Result<()> {
    let timeout = Duration::from_secs(30);
    let start = std::time::Instant::now();
    let url = format!("{}/v1/info", MINT_URL);

    while start.elapsed() < timeout {
        if let Ok(resp) = http.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(anyhow!("CDK mint not available at {}. Check docker-compose.", MINT_URL))
}

async fn wait_for_gateway(
    http: &reqwest::Client,
    gateway_url: &str,
    timeout_secs: u64,
) -> Result<()> {
    let timeout = Duration::from_secs(timeout_secs);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if let Ok(resp) = http.get(format!("{}/info", gateway_url)).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(anyhow!("Gateway not ready after {} seconds", timeout_secs))
}

async fn wait_for_channel_usable(
    http: &reqwest::Client,
    ldk_cli_url: &str,
    timeout_secs: u64,
) -> Result<()> {
    let timeout = Duration::from_secs(timeout_secs);
    let start = std::time::Instant::now();
    let channels_url = format!("{}/ldk/channels", ldk_cli_url);
    let sync_url = format!("{}/ldk/sync", ldk_cli_url);

    tokio::time::sleep(Duration::from_secs(2)).await;
    mine_blocks(http, 6).await?;

    while start.elapsed() < timeout {
        let _ = http.post(&sync_url).send().await;

        if let Ok(resp) = http.get(&channels_url).send().await {
            if let Ok(channels) = resp.json::<Vec<LnChannel>>().await {
                if channels.iter().any(|c| c.is_usable) {
                    return Ok(());
                }
            }
        }

        mine_blocks(http, 1).await?;
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err(anyhow!("Channel not usable within {} seconds", timeout_secs))
}

async fn ensure_minimum_blocks(http: &reqwest::Client, min_blocks: u64) -> Result<()> {
    let block_count: u64 =
        serde_json::from_value(bitcoin_rpc(http, "getblockcount", json!([])).await?)?;

    if block_count < min_blocks {
        mine_blocks(http, min_blocks - block_count).await?;
    }
    Ok(())
}

// =============================================================================
// Alice Test Wallet (CDK-based)
// =============================================================================

/// CDK-based test wallet for Alice, connected to the fakewallet mint.
pub struct TestAliceWallet {
    pub wallet: cdk::Wallet,
    pub secret_key: SecretKey,
    pub pubkey: CdkPublicKey,
}

impl TestAliceWallet {
    /// Create a new test wallet connected to the CDK mint.
    pub async fn setup(test_dir: &PathBuf, mint_url: &str) -> Result<Self> {
        let wallet_dir = test_dir.join("alice_wallet");
        std::fs::create_dir_all(&wallet_dir)?;

        let db_path = wallet_dir.join("alice.sqlite");
        let localstore = WalletSqliteDatabase::new(&db_path)
            .await
            .map_err(|e| anyhow!("Failed to create Alice wallet DB: {}", e))?;

        // Random seed for test wallet
        let mut seed = [0u8; 64];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);

        // Derive Alice's signing keypair from first 32 bytes
        let secret_key = SecretKey::from_slice(&seed[..32])
            .map_err(|e| anyhow!("Failed to derive Alice signing key: {}", e))?;
        let pubkey = secret_key.public_key();

        let mint = MintUrl::from_str(mint_url)
            .map_err(|e| anyhow!("Invalid mint URL: {}", e))?;

        let wallet = WalletBuilder::new()
            .mint_url(mint)
            .unit(CurrencyUnit::Sat)
            .localstore(StdArc::new(localstore))
            .seed(seed)
            .build()
            .map_err(|e| anyhow!("Failed to build Alice wallet: {}", e))?;

        tracing::info!(pubkey = %pubkey, "Alice test wallet created");

        Ok(Self {
            wallet,
            secret_key,
            pubkey,
        })
    }

    /// Mint ecash from the fakewallet CDK mint.
    ///
    /// The fakewallet backend auto-approves mint quotes, so this
    /// creates a quote and immediately mints the tokens.
    pub async fn mint_ecash(&self, amount_sats: u64) -> Result<u64> {
        let amount = Amount::from(amount_sats);

        // Create mint quote (fakewallet uses Bolt11 method)
        let quote = self.wallet.mint_quote(
                PaymentMethod::Known(KnownMethod::Bolt11),
                Some(amount),
                None,
                None,
            )
            .await
            .map_err(|e| anyhow!("Failed to create mint quote: {}", e))?;

        tracing::info!(quote_id = %quote.id, amount_sats, "Mint quote created");

        // Fakewallet auto-pays quotes after a few seconds.
        // Poll the quote status via the mint REST API until PAID, then mint once.
        let status_url = format!("{}/v1/mint/quote/bolt11/{}", MINT_URL, quote.id);
        let http = reqwest::Client::new();

        for attempt in 1..=30 {
            tokio::time::sleep(Duration::from_secs(1)).await;

            if let Ok(resp) = http.get(&status_url).send().await {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    let state = body["state"].as_str().unwrap_or("unknown");
                    tracing::info!(attempt, state, "Checking mint quote status");
                    if state == "PAID" {
                        break;
                    }
                }
            }
        }

        // Now mint exactly once
        let proofs = self.wallet.mint(&quote.id, SplitTarget::default(), None)
            .await
            .map_err(|e| anyhow!("Failed to mint ecash: {}", e))?;

        let sats: u64 = proofs.iter().map(|p| u64::from(p.amount)).sum();
        tracing::info!(minted_sats = sats, "Ecash minted successfully");
        Ok(sats)
    }

    /// Get total ecash balance in sats.
    pub async fn balance(&self) -> Result<u64> {
        let balance = self.wallet.total_balance()
            .await
            .map_err(|e| anyhow!("Failed to get Alice balance: {}", e))?;
        Ok(u64::from(balance))
    }

    /// Get unspent proofs from the wallet.
    pub async fn get_proofs(&self) -> Result<Vec<cdk::nuts::Proof>> {
        self.wallet.get_unspent_proofs()
            .await
            .map_err(|e| anyhow!("Failed to get Alice proofs: {}", e))
    }

    /// Get the hex-encoded public key.
    pub fn pubkey_hex(&self) -> String {
        self.pubkey.to_string()
    }
}

/// Generate a random 32-byte preimage and its SHA256 hash (hex-encoded).
pub fn generate_preimage_pair() -> ([u8; 32], String) {
    let mut preimage = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut preimage);
    let hash = sha256::Hash::hash(&preimage);
    (preimage, hash.to_string())
}


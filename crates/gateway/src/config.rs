//! Gateway configuration with support for config files and environment variables.
//!
//! Configuration is loaded with the following precedence (highest to lowest):
//! 1. Environment variables (e.g., `GATEWAY_API_PORT`, `GATEWAY_LDK_STORAGE_DIR`)
//! 2. Config file (config.toml)
//! 3. Default values

use std::env;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_API_PORT: u16 = 3338;
const DEFAULT_LDK_CLI_PORT: u16 = 3339;
const DEFAULT_LN_PORT: u16 = 9735;
const DEFAULT_STORAGE_DIR: &str = ".ldk-node-gateway";
const DEFAULT_NETWORK: &str = "regtest";
const DEFAULT_ESPLORA_URL_REGTEST: &str = "http://127.0.0.1:3002";
const DEFAULT_ESPLORA_URL_TESTNET: &str = "https://blockstream.info/testnet/api";
const DEFAULT_RGS_URL_TESTNET: &str = "https://rapidsync.lightningdevkit.org/testnet/snapshot";
const DEFAULT_ECASH_STORAGE_DIR: &str = ".ecash-gateway";

// ============================================================================
// Configuration Types
// ============================================================================

/// Main gateway configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GatewayConfig {
    /// Port for the public gateway API
    pub api_port: u16,

    /// Port for the internal ldk-cli API
    pub ldk_cli_port: u16,

    /// LDK node configuration
    pub ldk: LdkConfig,

    /// Cashu mint URL for ecash operations (required)
    pub mint_url: String,

    /// Directory to store ecash wallet data (SQLite)
    pub ecash_storage_dir: String,
}

/// LDK Lightning node configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LdkConfig {
    /// Bitcoin network (regtest, testnet, signet, mainnet)
    pub network: String,

    /// Directory to store LDK node data
    pub storage_dir: String,

    /// Port for Lightning P2P connections
    pub listening_port: u16,

    /// Esplora server URL for chain data
    pub esplora_url: Option<String>,

    /// Rapid Gossip Sync URL (optional, not used for regtest)
    pub rgs_url: Option<String>,

    /// BIP39 mnemonic for node entropy (optional - will be generated if not provided)
    pub mnemonic: Option<String>,
}

// ============================================================================
// Default Implementations
// ============================================================================

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            api_port: DEFAULT_API_PORT,
            ldk_cli_port: DEFAULT_LDK_CLI_PORT,
            ldk: LdkConfig::default(),
            mint_url: String::new(),
            ecash_storage_dir: DEFAULT_ECASH_STORAGE_DIR.to_string(),
        }
    }
}

impl Default for LdkConfig {
    fn default() -> Self {
        Self {
            network: DEFAULT_NETWORK.to_string(),
            storage_dir: DEFAULT_STORAGE_DIR.to_string(),
            listening_port: DEFAULT_LN_PORT,
            esplora_url: None,
            rgs_url: None,
            mnemonic: None,
        }
    }
}

// ============================================================================
// Configuration Loading
// ============================================================================

impl GatewayConfig {
    /// Load configuration from file and environment variables.
    ///
    /// Precedence (highest to lowest):
    /// 1. Environment variables
    /// 2. Config file
    /// 3. Default values
    pub fn load(config_path: Option<&Path>) -> Result<Self> {
        // Start with defaults
        let mut config = Self::default();

        // Load from config file if provided or if default exists
        if let Some(path) = config_path {
            config = Self::load_from_file(path)?;
        } else if Path::new("config.toml").exists() {
            config = Self::load_from_file(Path::new("config.toml"))?;
        }

        // Apply environment variable overrides
        config.apply_env_overrides();

        // Resolve esplora URL based on network if not set
        if config.ldk.esplora_url.is_none() {
            config.ldk.esplora_url = Some(config.default_esplora_url());
        }

        // Resolve RGS URL based on network if not set and not regtest
        if config.ldk.rgs_url.is_none() && config.ldk.network != "regtest" {
            config.ldk.rgs_url = Some(DEFAULT_RGS_URL_TESTNET.to_string());
        }

        Ok(config)
    }

    /// Load configuration from a TOML file
    fn load_from_file(path: &Path) -> Result<Self> {
        let contents = fs::read_to_string(path)
            .with_context(|| format!("Failed to read config file: {}", path.display()))?;

        toml::from_str(&contents)
            .with_context(|| format!("Failed to parse config file: {}", path.display()))
    }

    /// Apply environment variable overrides
    fn apply_env_overrides(&mut self) {
        // Gateway API ports
        if let Ok(val) = env::var("GATEWAY_API_PORT") {
            if let Ok(port) = val.parse() {
                self.api_port = port;
            }
        }
        if let Ok(val) = env::var("GATEWAY_LDK_CLI_PORT") {
            if let Ok(port) = val.parse() {
                self.ldk_cli_port = port;
            }
        }

        // LDK configuration - support both GATEWAY_ prefixed and legacy env vars
        if let Ok(val) = env::var("GATEWAY_LDK_NETWORK").or_else(|_| env::var("LDK_NETWORK")) {
            self.ldk.network = val;
        }
        if let Ok(val) = env::var("GATEWAY_LDK_STORAGE_DIR") {
            self.ldk.storage_dir = val;
        }
        if let Ok(val) = env::var("GATEWAY_LDK_LISTENING_PORT") {
            if let Ok(port) = val.parse() {
                self.ldk.listening_port = port;
            }
        }
        if let Ok(val) = env::var("GATEWAY_ESPLORA_URL").or_else(|_| env::var("ESPLORA_URL")) {
            self.ldk.esplora_url = Some(val);
        }
        if let Ok(val) = env::var("GATEWAY_RGS_URL").or_else(|_| env::var("RGS_URL")) {
            self.ldk.rgs_url = Some(val);
        }
        if let Ok(val) = env::var("GATEWAY_LDK_MNEMONIC") {
            self.ldk.mnemonic = Some(val);
        }

        // Ecash configuration
        if let Ok(val) = env::var("GATEWAY_MINT_URL") {
            self.mint_url = val;
        }
        if let Ok(val) = env::var("GATEWAY_ECASH_STORAGE_DIR") {
            self.ecash_storage_dir = val;
        }
    }

    /// Get default esplora URL based on network
    fn default_esplora_url(&self) -> String {
        match self.ldk.network.as_str() {
            "regtest" => DEFAULT_ESPLORA_URL_REGTEST,
            _ => DEFAULT_ESPLORA_URL_TESTNET,
        }
        .to_string()
    }

    /// Get the network as ldk_node Network type
    pub fn network(&self) -> ldk_node::bitcoin::Network {
        match self.ldk.network.to_lowercase().as_str() {
            "regtest" => ldk_node::bitcoin::Network::Regtest,
            "testnet" => ldk_node::bitcoin::Network::Testnet,
            "signet" => ldk_node::bitcoin::Network::Signet,
            "mainnet" | "bitcoin" => ldk_node::bitcoin::Network::Bitcoin,
            _ => ldk_node::bitcoin::Network::Regtest,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = GatewayConfig::default();
        assert_eq!(config.api_port, 3338);
        assert_eq!(config.ldk_cli_port, 3339);
        assert_eq!(config.ldk.network, "regtest");
        assert_eq!(config.ldk.listening_port, 9735);
    }

    #[test]
    fn test_network_parsing() {
        let mut config = GatewayConfig::default();

        config.ldk.network = "regtest".to_string();
        assert_eq!(config.network(), ldk_node::bitcoin::Network::Regtest);

        config.ldk.network = "testnet".to_string();
        assert_eq!(config.network(), ldk_node::bitcoin::Network::Testnet);

        config.ldk.network = "mainnet".to_string();
        assert_eq!(config.network(), ldk_node::bitcoin::Network::Bitcoin);
    }
}


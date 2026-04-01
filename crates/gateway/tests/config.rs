//! Configuration loading tests.

use std::io::Write;

use cashu_gateway::GatewayConfig;

#[test]
fn test_defaults() {
    let config = GatewayConfig::default();

    assert_eq!(config.api_port, 3338);
    assert_eq!(config.ldk_cli_port, 3339);
    assert_eq!(config.ldk.network, "regtest");
    assert_eq!(config.ldk.storage_dir, ".ldk-node-gateway");
    assert_eq!(config.ldk.listening_port, 9735);
}

#[test]
fn test_load_from_toml() {
    let temp_dir = tempfile::tempdir().unwrap();
    let config_path = temp_dir.path().join("config.toml");

    let toml = r#"
api_port = 4000
ldk_cli_port = 4001

[ldk]
network = "testnet"
storage_dir = "/custom/path"
listening_port = 9999
esplora_url = "http://custom-esplora:3002"
"#;

    let mut file = std::fs::File::create(&config_path).unwrap();
    file.write_all(toml.as_bytes()).unwrap();

    // Clear env vars that would override TOML values (e.g. nix devShell sets LDK_NETWORK)
    let env_vars = [
        "GATEWAY_API_PORT", "GATEWAY_LDK_CLI_PORT", "GATEWAY_LDK_NETWORK",
        "LDK_NETWORK", "GATEWAY_LDK_STORAGE_DIR", "GATEWAY_LDK_LISTENING_PORT",
        "GATEWAY_ESPLORA_URL", "ESPLORA_URL",
    ];
    let saved: Vec<_> = env_vars.iter().map(|k| (*k, std::env::var(k).ok())).collect();
    for k in &env_vars {
        std::env::remove_var(k);
    }

    let config = GatewayConfig::load(Some(&config_path)).unwrap();

    // Restore env vars
    for (k, v) in &saved {
        match v {
            Some(val) => std::env::set_var(k, val),
            None => std::env::remove_var(k),
        }
    }

    assert_eq!(config.api_port, 4000);
    assert_eq!(config.ldk_cli_port, 4001);
    assert_eq!(config.ldk.network, "testnet");
    assert_eq!(config.ldk.storage_dir, "/custom/path");
    assert_eq!(config.ldk.listening_port, 9999);
    assert_eq!(
        config.ldk.esplora_url,
        Some("http://custom-esplora:3002".to_string())
    );
}


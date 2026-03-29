//! Lightning integration tests for the Cashu Gateway.
//!
//! These tests require a running regtest environment:
//! ```bash
//! start-regtest
//! cargo build && cargo test --test integration -- --ignored --nocapture --test-threads=1
//! ```

mod common;

use ldk_node::bitcoin::hashes::{sha256, Hash};

use common::TestEnv;

#[tokio::test(flavor = "multi_thread")]
#[ignore] // Requires regtest environment
async fn test_create_invoice_for_hash() {
    let env = TestEnv::setup().await.expect("Failed to setup network");

    let preimage = [0u8; 32];
    let payment_hash = sha256::Hash::hash(&preimage);
    let payment_hash_hex = payment_hash.to_string();

    let amount_msat = 10_000; // 10 sats
    let invoice = env
        .create_invoice_for_hash(amount_msat, &payment_hash_hex, 3600)
        .await
        .expect("Failed to create invoice");

    assert_eq!(invoice.amount_milli_satoshis(), Some(amount_msat));
    assert_eq!(invoice.payment_hash().to_string(), payment_hash_hex);

    // Test node pays the invoice
    let payment = env
        .pay_invoice(&invoice.to_string())
        .expect("Failed to pay invoice");

    assert_eq!(payment.amount_msat, amount_msat);
    assert_eq!(payment.payment_hash, payment_hash_hex);
}

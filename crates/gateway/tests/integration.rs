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

/// Alice sends ecash proofs to the gateway, gateway pays a Lightning invoice.
///
/// Flow:
/// 1. Alice has ecash from the CDK mint
/// 2. Alice submits proofs + bolt11 invoice to gateway's /pay-invoice endpoint
/// 3. Gateway verifies proofs, pays the LN invoice
/// 4. Alice receives the payment preimage
#[tokio::test(flavor = "multi_thread")]
#[ignore] // Requires regtest environment
async fn test_alice_pays_ln_via_ecash() {
    let _env = TestEnv::setup().await.expect("Failed to setup network");

    // TODO: Alice mints ecash from CDK mint (via fakewallet)
    // TODO: Create a test LN invoice (from test node)
    // TODO: Alice calls gateway /pay-invoice with proofs + bolt11
    // TODO: Assert payment succeeded and preimage returned
    todo!("E2E: alice pays LN invoice via ecash through gateway");
}

/// External payer pays a Lightning invoice to the gateway, Alice receives ecash.
///
/// Flow:
/// 1. Alice requests a HODL invoice from the gateway (with her pubkey + blinded messages)
/// 2. Gateway creates HODL invoice + HTLC-locked ecash token
/// 3. External payer pays the HODL invoice
/// 4. Alice claims the HTLC ecash at the mint (she knows the preimage)
/// 5. Gateway detects the claim via NUT-07, extracts preimage, settles HODL invoice
#[tokio::test(flavor = "multi_thread")]
#[ignore] // Requires regtest environment
async fn test_alice_receives_ecash_via_ln() {
    let _env = TestEnv::setup().await.expect("Failed to setup network");

    // TODO: Alice generates preimage + hash
    // TODO: Alice calls gateway /request-invoice with pubkey + blinded messages + preimage_hash
    // TODO: External payer pays the returned HODL invoice
    // TODO: Alice claims HTLC ecash at the mint using her preimage
    // TODO: Assert Alice received the ecash
    // TODO: Assert gateway settled the HODL invoice (extracted preimage from NUT-07)
    todo!("E2E: alice receives ecash via inbound LN payment through gateway");
}

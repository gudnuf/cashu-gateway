//! Lightning integration tests for the Cashu Gateway.
//!
//! These tests require a running regtest environment:
//! ```bash
//! start-regtest
//! cargo build && cargo test --test integration -- --ignored --nocapture --test-threads=1
//! ```

mod common;

use ldk_node::bitcoin::hashes::{sha256, Hash};
use ldk_node::lightning_invoice::{Bolt11InvoiceDescription, Description};

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
    let env = TestEnv::setup().await.expect("Failed to setup network");

    // 1. Test node creates a Lightning invoice
    let amount_sats = 10;
    let amount_msat = amount_sats * 1000;
    let description = Bolt11InvoiceDescription::Direct(
        Description::new("test-alice-pays".to_string()).expect("valid description"),
    );
    let invoice = env
        .node
        .bolt11_payment()
        .receive(amount_msat, &description, 3600)
        .expect("Failed to create test invoice");

    // 2. Alice gets proofs from her wallet
    let proofs = env.alice.get_proofs().await.expect("Failed to get proofs");
    assert!(!proofs.is_empty(), "Alice should have proofs");

    // 3. Alice sends proofs + invoice to gateway
    let gateway_client = cashu_alice::GatewayClient::new(&env.gateway_url);
    let request = cashu_gateway_protocol::PayInvoiceRequest {
        bolt11: invoice.to_string(),
        proofs,
    };
    let response = gateway_client
        .pay_invoice(request)
        .await
        .expect("pay_invoice failed");

    // 4. Assert success
    assert!(response.paid, "Payment should succeed");
    assert!(
        response.payment_preimage.is_some(),
        "Should return preimage"
    );
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
    let env = TestEnv::setup().await.expect("Failed to setup network");

    let gateway_client = cashu_alice::GatewayClient::new(&env.gateway_url);

    // Step 0: Fund the gateway's ecash wallet by having Alice pay a LN invoice.
    // The gateway needs ecash balance to create HTLC-locked tokens.
    {
        let fund_amount_msat = 500_000; // 500 sats
        let description = Bolt11InvoiceDescription::Direct(
            Description::new("fund-gateway".to_string()).expect("valid description"),
        );
        let invoice = env
            .node
            .bolt11_payment()
            .receive(fund_amount_msat, &description, 3600)
            .expect("Failed to create funding invoice");

        let proofs = env.alice.get_proofs().await.expect("Failed to get proofs");
        let request = cashu_gateway_protocol::PayInvoiceRequest {
            bolt11: invoice.to_string(),
            proofs,
        };
        let response = gateway_client
            .pay_invoice(request)
            .await
            .expect("Gateway funding via pay_invoice failed");
        assert!(response.paid, "Funding payment should succeed");
    }

    // Step 1: Alice generates preimage and hash
    let (preimage, preimage_hash_hex) = common::generate_preimage_pair();

    // Step 2: Alice requests a HODL invoice from the gateway
    let amount_sats = 100;
    let request = cashu_gateway_protocol::RequestInvoiceRequest {
        amount_sats,
        pubkey: env.alice.pubkey_hex(),
        blinded_messages: vec![], // gateway creates proofs directly, not from blinded messages
        preimage_hash: preimage_hash_hex,
    };

    let response = gateway_client
        .request_invoice(request)
        .await
        .expect("request_invoice failed");

    // Step 3: Verify response
    assert!(
        !response.bolt11.is_empty(),
        "Should return a bolt11 invoice"
    );
    assert!(
        !response.payment_hash.is_empty(),
        "Should return payment hash"
    );
    assert!(
        !response.htlc_token.is_empty(),
        "Should return HTLC token"
    );

    // Step 4: External payer (test node) pays the HODL invoice
    let payment_result = env
        .pay_invoice(&response.bolt11)
        .expect("Test node failed to pay HODL invoice");
    assert_eq!(payment_result.amount_msat, amount_sats * 1000);

    // Step 5: Alice claims the HTLC-locked ecash using her preimage.
    // She needs her signing key (for SIG_ALL) and the preimage.
    let preimage_hex = hex::encode(preimage);
    let opts = cdk::wallet::ReceiveOptions {
        preimages: vec![preimage_hex],
        p2pk_signing_keys: vec![env.alice.secret_key.clone()],
        ..Default::default()
    };

    let claimed_amount = env
        .alice
        .wallet
        .receive(&response.htlc_token, opts)
        .await
        .expect("Alice failed to claim HTLC token");

    let claimed_sats = u64::from(claimed_amount);
    assert!(claimed_sats > 0, "Alice should have received ecash");

    // Note: Full HODL invoice settlement (gateway extracting preimage via NUT-07
    // and settling the LN HTLC) is not yet wired -- Phase 3 will add that.
}

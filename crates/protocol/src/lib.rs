//! Cashu Gateway protocol types.
//!
//! Shared request/response types for the gateway API contract,
//! consumed by both the gateway (server) and Alice (client).

use serde::{Deserialize, Serialize};

// Re-export CDK types used in the API surface
pub use cdk_common::nut00::{BlindedMessage, Proof};

// === Pay-with-ecash (outbound Lightning payment) ===

/// Alice requests the gateway to pay a Lightning invoice using ecash proofs.
///
/// Alice sends ecash proofs to cover the invoice amount plus fees.
/// The gateway verifies the proofs, pays the Lightning invoice, and
/// returns the result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayInvoiceRequest {
    /// Bolt11 Lightning invoice to pay.
    pub bolt11: String,
    /// Ecash proofs as payment for the invoice.
    pub proofs: Vec<Proof>,
}

/// Result of a pay-with-ecash request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayInvoiceResponse {
    /// Whether the Lightning payment succeeded.
    pub paid: bool,
    /// Hex-encoded payment preimage, present if payment succeeded.
    pub payment_preimage: Option<String>,
    /// Fee paid in millisatoshis, present if payment succeeded.
    pub fee_msat: Option<u64>,
}

// === Receive-ecash (inbound Lightning payment) ===

/// Alice requests a Lightning invoice from the gateway to receive ecash.
///
/// The gateway creates a HODL invoice and HTLC-locked ecash:
/// - HTLC is locked to the payment_hash
/// - Spending condition: SIG_ALL with Alice's pubkey
/// - Refund condition: gateway's pubkey
///
/// Alice generates a preimage and sends its hash. The gateway creates
/// the HODL invoice locked to that hash. When someone pays the invoice,
/// Alice (who already knows the preimage) swaps the HTLC at the mint.
/// The gateway polls NUT-07, extracts the preimage from the witness,
/// and settles the HODL invoice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestInvoiceRequest {
    /// Requested amount in satoshis.
    pub amount_sats: u64,
    /// Alice's public key (hex) for the HTLC spending condition.
    pub pubkey: String,
    /// Alice's blinded messages for the ecash she wants to receive.
    pub blinded_messages: Vec<BlindedMessage>,
    /// Hex-encoded SHA256 hash of Alice's preimage.
    /// Gateway creates the HODL invoice locked to this hash.
    /// Alice already knows the preimage and can swap the HTLC at the mint.
    pub preimage_hash: String,
}

/// Response containing the HODL invoice and HTLC-locked ecash token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestInvoiceResponse {
    /// Bolt11 HODL invoice for the payer.
    pub bolt11: String,
    /// Hex-encoded payment hash.
    pub payment_hash: String,
    /// Serialized HTLC-locked ecash token (Cashu V4 token string).
    pub htlc_token: String,
}

// === Settlement notification ===

/// Alice notifies the gateway that she claimed the HTLC ecash.
///
/// This is an optional optimization -- the gateway also polls NUT-07
/// to detect when the HTLC is claimed and extract the preimage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettleRequest {
    /// Hex-encoded payment hash identifying the HODL invoice to settle.
    pub payment_hash: String,
}

/// Result of a settle request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettleResponse {
    /// Whether the HODL invoice was successfully settled.
    pub settled: bool,
}

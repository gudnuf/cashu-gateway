# Gateway Receive Protocol Specification

The following was generated based on the current code. It will give you a good idea of the message structure and cashu secrets that are used, but this should not be considered the final word. Rely on the code for now to see how it works exactly.

## Overview

Three-party protocol for receiving Lightning payments through a gateway using Cashu ecash tokens with HTLC and P2PK locking mechanisms.

**Actors:**

- **Alice**: Receiver who wants to receive Lightning sats as ecash
- **Gateway**: Lightning node operator that creates invoices and locks funds in HTLCs
- **Dealer**: Intermediary that swaps HTLCs for ecash, claims routing fees

**Fee Structure:** Dealer charges 2 sat flat fee per receive operation

---

## Protocol Flow Summary

1. **Alice → Dealer:** Request fee blinded messages
2. **Alice → Gateway:** Send aggregated blinded messages (dealer + hers), get HODL invoice
3. **External:** Invoice gets paid, gateway holds payment (doesn't settle)
4. **Gateway → Mint:** Create HTLC token with SIG_ALL (without preimage)
5. **Gateway → Dealer:** Forward HTLC for swap
6. **Dealer:** Add preimage, swap HTLC with mint, claim fee, return preimage to gateway
7. **Gateway:** Settle invoice with preimage
8. **Dealer → Alice:** Forward Alice's blinded signatures
9. **Alice:** Unblind signatures, receive proofs

---

## Message Flow

### 1. Alice → Dealer: `request_dealer_fee`

Alice requests blinded messages for dealer's fee.

**Request:**

```json
{
  "method": "request_dealer_fee",
  "params": {
    "preimageHash": "<32-byte hex>",
    "amount": 21
  }
}
```

**Response:**

```json
{
  "result": {
    "success": true,
    "feeAmount": 2,
    "blindedMessages": [
      { "amount": 1, "B_": "...", "id": "..." },
      { "amount": 1, "B_": "...", "id": "..." }
    ]
  }
}
```

**Dealer Action:**

- Creates P2PK blinded messages (2 sats) locked to **Dealer's pubkey**
- Secret format: `["P2PK", {"nonce": "...", "data": "02<dealer_pubkey>"}]`
- Stores `PendingDealerFee` with outputData for later unblinding

---

### 2. Alice → Gateway: `make_invoice`

Alice sends aggregated blinded messages (dealer fee + her own) to gateway.

**Request:**

```json
{
  "method": "make_invoice",
  "params": {
    "amount": 23,
    "preimageHash": "<32-byte hex>",
    "blindedMessages": [
      // Dealer's 2 blinded messages
      { "amount": 1, "B_": "...", "id": "..." },
      { "amount": 1, "B_": "...", "id": "..." },
      // Alice's blinded messages
      { "amount": 1, "B_": "...", "id": "..." },
      { "amount": 4, "B_": "...", "id": "..." },
      { "amount": 16, "B_": "...", "id": "..." }
    ],
    "dealerPubkey": "4bfa7578..."
  }
}
```

**Alice's Blinded Messages:**

- P2PK locked to **Alice's pubkey**
- Secret format: `["P2PK", {"nonce": "...", "data": "02<alice_pubkey>"}]`
- Alice stores outputData locally to unblind signatures later

**Response:**

```json
{
  "result": {
    "success": true,
    "message": "Invoice created",
    "data": {
      "invoice": "lnbc230p1p5snyrddqq..."
    }
  }
}
```

**Gateway Action:**

- Creates HODL invoice locked to Alice's `preimageHash`
- Stores `PendingReceiveRequest` with blinded messages
- **Does NOT create HTLC yet** - waits for payment

---

### 3. Invoice Payment Held

Lightning invoice gets paid but gateway holds it without settling.

**Gateway Detection:**

- Lightning node receives payment but doesn't settle (HODL invoice)
- Gateway looks up pending request by payment hash

---

### 4. Gateway → Mint: Create HTLC Token

Gateway creates HTLC token locked to the invoice's payment hash (Alice's original preimageHash).

**HTLC Proof Secret Format:**

```json
[
  "P2PK",
  {
    "nonce": "<random 32-byte hex>",
    "data": "02<gateway_pubkey>",
    "tags": [
      ["sigflag", "SIG_ALL"],
      ["preimage_hash", "<payment_hash>"],
      ["locktime", "<expiry_unix_sec>"],
      ["refund", "02<gateway_pubkey>"],
      ["n_sigs_refund", "1"]
    ]
  }
]
```

**Key Properties:**

- Primary locking pubkey: Gateway's pubkey
- `SIG_ALL` flag: Commits to both input proofs AND output blinded messages
- `preimage_hash`: Invoice payment hash (dealer must provide preimage to spend)
- `refund`: Gateway can reclaim after locktime expires

**Gateway Signs SIG_ALL:**

```
message = secret_0 || ... || secret_n || B_0 || ... || B_m
signature = schnorr.sign(SHA256(message), gateway_privkey)
```

**Witnessed HTLC Token:**

```json
{
  "proofs": [
    {
      "amount": 1,
      "secret": "<HTLC secret above>",
      "C": "...",
      "id": "...",
      "witness": {
        "signatures": ["<gateway_sig_all_signature>"]
      }
    }
    // ... more HTLC proofs totaling 23 sats
  ]
}
```

**Note:** Gateway does NOT include preimage yet - dealer will add it when spending. The signature is just to force the dealer to create the specified outputs.

---

### 5. Gateway → Dealer: `swap_htlc`

Gateway forwards HTLC token to dealer for swap.

**Request:**

```json
{
  "method": "swap_htlc",
  "params": {
    "htlcToken": "cashuA<encoded_token>",
    "blindedMessages": [
      /* same 23 sats of blinded messages */
    ],
    "requestPreimageHash": "<original from alice>",
    "alicePubkey": "2dcb27f6..."
  }
}
```

**Response:**

```json
{
  "result": {
    "success": true,
    "message": "HTLC swapped successfully",
    "data": {
      "preimage": "<invoice_preimage>"
    }
  }
}
```

**Dealer Action:**

1. **Add preimage to HTLC witness:**
   - Dealer must provide the preimage that matches the `preimage_hash` tag
   - Updates each proof's witness: `{"signatures": ["<gateway_sig>"], "preimage": "<preimage>"}`

2. **Swap HTLC with mint:**
   - Submits HTLC token + all 23 blinded messages to mint's `/v1/swap` endpoint
   - Mint validates:
     - SIG_ALL signature is valid for inputs + outputs
     - Preimage in witness hashes to `preimage_hash` tag
     - Gateway's signature commits to exact output blinded messages
   - Mint returns 23 blinded signatures

3. **Split signatures:**
   - First 2 blinded sigs → Dealer (fee)
   - Remaining 21 blinded sigs → Alice

4. **Unblind dealer's signatures:**
   - Uses stored `PendingDealerFee.outputData` secrets/blinding factors
   - Creates proofs locked to Dealer's P2PK
   - Saves to dealer's database

5. **Return preimage to gateway** (in response)

6. **Forward Alice's signatures to Alice** (next step)

---

### 6. Gateway Settles Invoice

Gateway receives preimage from dealer's response and settles the HODL invoice.

**Gateway Action:**

- Extracts preimage from dealer's response
- Verifies `SHA256(preimage) == payment_hash`
- Settles Lightning invoice with preimage
- Payment completes, gateway earns routing fees

---

### 7. Dealer → Alice: `blinded_signatures`

Dealer sends Alice's portion of blinded signatures.

**Request:**

```json
{
  "method": "blinded_signatures",
  "params": {
    "preimageHash": "<original from step 1>",
    "blindedSignatures": [
      { "C_": "...", "id": "...", "amount": 1 },
      { "C_": "...", "id": "...", "amount": 4 },
      { "C_": "...", "id": "...", "amount": 16 }
    ]
  }
}
```

**Response:**

```json
{
  "result": {
    "success": true,
    "message": "Signatures received"
  }
}
```

**Alice Action:**

1. **Unblind signatures:**
   - Uses stored `PendingHTLCRequest.outputData` secrets/blinding factors
   - Creates proofs with P2PK locked to Alice's pubkey
2. **Save proofs:**
   - Validates each proof's P2PK secret signature using Alice's privkey
   - Adds proofs to Alice's database
   - Updates balance: +21 sats

---

## Proof Secret Types

### Dealer Fee Proofs (2 sats)

```json
[
  "P2PK",
  {
    "nonce": "<random>",
    "data": "02<dealer_pubkey>",
    "tags": [["sigflag", "SIG_INPUTS"]]
  }
]
```

- Locked to dealer's pubkey
- Standard P2PK (SIG_INPUTS)

### Alice's Proofs (21 sats)

```json
[
  "P2PK",
  {
    "nonce": "<random>",
    "data": "02<alice_pubkey>",
    "tags": [["sigflag", "SIG_INPUTS"]]
  }
]
```

- Locked to Alice's pubkey
- Standard P2PK (SIG_INPUTS)

### Gateway's HTLC Proofs (23 sats)

```json
[
  "P2PK",
  {
    "nonce": "<random>",
    "data": "02<gateway_pubkey>",
    "tags": [
      ["sigflag", "SIG_ALL"],
      ["preimage_hash", "<invoice_payment_hash>"],
      ["locktime", "<expiry_unix_sec>"],
      ["refund", "02<gateway_pubkey>"],
      ["n_sigs_refund", "1"]
    ]
  }
]
```

- Locked to invoice payment hash (dealer must provide preimage)
- SIG_ALL: Gateway signature commits to exact outputs
- Refund path: Gateway can reclaim after locktime

---

## Security Properties

1. **Atomic Swap:** Gateway's SIG_ALL signature binds HTLC inputs to exact output blinded messages, preventing dealer from swapping for different amounts

2. **HODL Invoice Protection:** Gateway doesn't settle Lightning payment until dealer proves HTLC was swapped by providing the preimage

3. **Payment Proof:** Dealer must provide valid preimage to spend HTLC, which proves:
   - Lightning payment was successful
   - HTLC was actually swapped with mint (dealer couldn't get preimage otherwise)

4. **No Trust Required:**
   - Gateway can't steal: Must lock funds in HTLC before settling invoice
   - Dealer can't steal: HTLC commits to exact blinded message outputs via SIG_ALL
   - Alice gets exactly what she requested (minus fee)

5. **Refund Path:** Gateway can reclaim HTLC after locktime if dealer fails to swap

---

## Key Implementation Details

- **Transport:** Nostr NIP-04 encrypted messages between parties
- **Dealer Fee:** Fixed 2 sats per receive operation
- **Blinding:** Cashu blind signatures ensure mint cannot link Alice's proofs to the HTLC
- **HODL Invoice:** Gateway holds invoice payment until dealer provides preimage by successfully swapping HTLC
- **Preimage Flow:** Alice generates → Gateway locks invoice → Dealer spends HTLC → Gateway settles invoice

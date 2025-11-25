# Receiving Ecash through a LN Gateway

## Overview

Three-party protocol for receiving payments through a gateway.
**Actors:**

- **Alice**: Receiver who wants to receive a LN payment as ecash
- **Gateway**: Lightning node operator that creates invoices and locks funds in HTLCs
- **Dealer**: Intermediary that swaps HTLCs for ecash, charges a fee to sell the preimage to the gateway

---

## Protocol Flow Summary

1. **Alice → Dealer:** Request fee blinded messages (sends preimage to dealer)
2. **Alice → Gateway:** Send aggregated blinded messages (dealer + hers), get invoice
3. **External:** Invoice gets paid, gateway holds payment
4. **Gateway → Mint:** Create HTLC token with SIG_ALL committing to Alice and Dealer outputs
5. **Gateway → Dealer:** Forward HTLC for swap
6. **Dealer:** Swaps HTLC using preimage from Alice, revealing preimage to gateway
7. **Gateway:** Settle invoice with preimage
8. **Dealer → Alice:** Forward Alice's blinded signatures (optional, Alice could restore when HTLC is spent)
9. **Alice:** Unblind signatures, receive proofs

---

## Message Flow

### 1. Alice → Dealer: `request_dealer_fee`

Alice requests blinded messages for dealer's fee and sends the preimage.

**Request:**

```json
{
  "method": "request_dealer_fee",
  "params": {
    "preimage": "<32-byte hex>",
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
- Secret format: `["P2PK", {"nonce": "...", "data": "<dealer_pubkey>"}]`
- Stores preimage and outputData for later unblinding

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
    "dealerPubkey": "024bfa7578..."
  }
}
```

**Alice's Blinded Messages:**

- P2PK locked to **Alice's pubkey**
  > TODO: Does this need to be P2PK locked? It should be fine if the dealer only knows B\_
- Secret format: `["P2PK", {"nonce": "...", "data": "<alice_pubkey>"}]`
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

---

### 3. Invoice Payment Held

Lightning invoice gets paid but gateway holds it without settling.

**Gateway Detection:**

- Lightning node receives payment but can't settle without the preimage
- Gateway looks up pending request by payment hash

---

### 4. Gateway → Mint: Create HTLC Token

Gateway creates HTLC token locked to the invoice's payment hash (Alice's original preimageHash).

**HTLC Proof Secret Format:**

```json
[
  "HTLC",
  {
    "data": "<preimage_hash>",
    "nonce": "<random 32-byte hex>",
    "tags": [
      ["sigflag", "SIG_ALL"],
      ["pubkeys", "<gateway_pubkey>"],
      ["n_sigs", "1"]
      ["locktime", "<expiry_unix_sec>"],
      ["refund", "<gateway_pubkey>"],
      ["n_sigs_refund", "1"]
    ]
  }
]
```

**Key Properties:**

- `data`: Invoice payment hash / preimage hash (dealer must provide preimage to spend)
- `pubkeys` tag: Gateway's pubkey that must sign with SIG_ALL
- `SIG_ALL` flag: Commits to both input proofs AND output blinded messages
- `refund`: Gateway can reclaim after locktime expires

**Gateway Signs SIG_ALL:**

```
message = secret_0 || ... || secret_n || B_0 || ... || B_m
signature = schnorr.sign(SHA256(message), gateway_privkey)
```

**Witnessed HTLC Token (no preimage):**

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
    "htlcToken": "cashuB<encoded_token>",
    "blindedMessages": [
      ...
    ],
    "requestPreimageHash": "<original from alice>",
    "alicePubkey": "022dcb27f6..." // TODO: remove? The dealer should already know this
  }
}
```

**Response:**

> TODO: Does the dealer need to send a response to the gateway? Or is swapping enough?

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
     > Question: How do mint validate sig all in this case with the preimage? Preimage must be required on all, but what about the signature?
   - Updates each proof's witness: `{"signatures": ["<gateway_sig>"], "preimage": "<preimage>"}`

2. **Swap HTLC with mint:**
   - Submits HTLC token + blinded messages to mint's `/v1/swap` endpoint
   - Mint validates:
     - SIG_ALL signature is valid for inputs + outputs
     - Preimage in witness hashes to `preimage_hash` tag
     - Gateway's signature commits to exact output blinded messages

3. **Split signatures:**
   - First 2 blinded sigs → Dealer (fee)
   - Remaining 21 blinded sigs → Alice

4. **Unblind dealer's signatures:**
   - Uses stored `PendingDealerFee.outputData` secrets/blinding factors
     > TODO: again, do we need P2PK here?
   - Creates proofs locked to Dealer's P2PK

> TODO: If we decide to keep this, also return the Y values the gateway could use 5. **Return preimage to gateway** (in response)

6. **Forward Alice's signatures to Alice** (next step)

> TODO: consider how the dealer blinded messages are being created and

---

### 6. Gateway Settles Invoice

Gateway receives preimage from the mint and settles the HODL invoice.

**Gateway Action:**

- Extracts preimage from dealer's response
- Verifies `SHA256(preimage) == payment_hash`
- Settles Lightning invoice with preimage
- Payment completes, gateway earns routing fees

---

### 7. Dealer → Alice: `blinded_signatures` (optional)

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
    "data": "<dealer_pubkey>"
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
    "data": "<alice_pubkey>"
  }
]
```

- Locked to Alice's pubkey
- Standard P2PK (SIG_INPUTS)

### Gateway's HTLC Proofs (23 sats)

```json
[
  "HTLC",
  {
    "data": "<invoice_payment_hash>",
    "nonce": "<random>",
    "tags": [
      ["sigflag", "SIG_ALL"],
      ["pubkeys", "<gateway_pubkey>"],
      ["locktime", "<expiry_unix_sec>"],
      ["refund", "<gateway_pubkey>"],
      ["n_sigs_refund", "1"]
    ]
  }
]
```

- Locked to invoice payment hash (dealer must provide preimage)
- SIG*ALL: Gateway signature commits to exact outputs (dealer fee `B*`s and Alice `B\_`s)
- Refund path: Gateway can reclaim after locktime

---

## Things to consider

- Does the dealer need to know Alice's secrets for the outputs she will receive? We say that Alice will create P2PK outputs, but that's probably not necessary?
- The dealer and the gateway can collaborate in many ways if they know how to contact eachother. Unless there was dark magic, the dealer always has to know the preimage, so then there's nothing stopping the dealer and the gateway from running away with the money.
  - Is there a way we can do this so that the gateway and the dealer are unaware of eachother?
  - If we use nostr, then there's still nothing stopping a gateway from blasting out that they're looking for a specific preimage.
  - We could make the dealer and/or the gateway create some sort of bond. We could make the gateway create the unsigned HTLC proofs first to give alice along with the invoice, but the gateway could just wait for this to expire while colluding with the dealer, then reclaim it. I guess this is the problem with bonds, they will have to expire when the invoice expires.

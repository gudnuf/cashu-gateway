import type { Proof } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * Constructs the message to sign for SIG_ALL according to NUT-11
 *
 * For swap: msg = secret_0 || ... || secret_n || B_0 || ... || B_m
 *
 * @param inputProofs - The input proofs with their secrets
 * @param outputBlindedMessages - The output blinded messages (must have B_ field)
 * @returns SHA256 hash of the concatenated message
 */
export function constructSigAllMessage(
  inputProofs: Proof[],
  outputBlindedMessages: Array<{ B_: string }>
): Uint8Array {
  // Concatenate all input secrets
  let message = "";
  for (const proof of inputProofs) {
    message += proof.secret;
  }

  // Concatenate all output B_ values (as hex strings)
  for (const output of outputBlindedMessages) {
    message += output.B_;
  }

  // Encode to bytes and hash
  const msgBytes = new TextEncoder().encode(message);
  return sha256(msgBytes);
}

/**
 * Signs a SIG_ALL message with a private key
 *
 * @param privkey - The private key (hex string)
 * @param inputProofs - The input proofs
 * @param outputBlindedMessages - The output blinded messages
 * @returns The signature as a hex string
 */
export function signSigAllMessage(
  privkey: string,
  inputProofs: Proof[],
  outputBlindedMessages: Array<{ B_: string }>
): string {
  const message = constructSigAllMessage(inputProofs, outputBlindedMessages);
  const privkeyBytes = hexToBytes(privkey);
  const signature = schnorr.sign(message, privkeyBytes);
  return bytesToHex(signature);
}

/**
 * Verifies a SIG_ALL signature
 *
 * @param signature - The signature to verify (hex string)
 * @param pubkey - The public key (hex string, with 02/03 prefix)
 * @param inputProofs - The input proofs
 * @param outputBlindedMessages - The output blinded messages
 * @returns True if valid
 */
export function verifySigAllSignature(
  signature: string,
  pubkey: string,
  inputProofs: Proof[],
  outputBlindedMessages: Array<{ B_: string }>
): boolean {
  const sigBytes = hexToBytes(signature);
  let pubkeyBytes = hexToBytes(pubkey);

  // Schnorr uses x-only pubkeys (32 bytes), so strip the prefix if present
  if (pubkeyBytes.length === 33) {
    pubkeyBytes = pubkeyBytes.slice(1);
  } else if (pubkeyBytes.length !== 32) {
    return false;
  }

  const message = constructSigAllMessage(inputProofs, outputBlindedMessages);
  return schnorr.verify(sigBytes, message, pubkeyBytes);
}

/**
 * Creates P2PK proofs with SIG_ALL flag and preimage hash
 *
 * This adds the necessary tags for HTLC-like functionality:
 * - sigflag: SIG_ALL
 * - preimage_hash: the hash of the preimage that unlocks the token
 * - pubkeys, n_sigs, locktime, refund, n_sigs_refund as specified
 */
export function createHTLCP2PKSecret(options: {
  preimageHash: string;
  lockingPubkeys: string[];
  requiredSignatures: number;
  locktime: number;
  refundPubkeys: string[];
  requiredRefundSignatures: number;
}): [string, { nonce: string; data: string; tags: string[][] }] {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

  const tags: string[][] = [
    ["sigflag", "SIG_ALL"],
    ["preimage_hash", options.preimageHash],
  ];

  // Add locktime
  if (options.locktime) {
    tags.push(["locktime", String(options.locktime)]);
  }

  // Add additional locking pubkeys if more than one
  if (options.lockingPubkeys.length > 1) {
    tags.push(["pubkeys", ...options.lockingPubkeys.slice(1)]);
  }

  // Add n_sigs if > 1
  if (options.requiredSignatures > 1) {
    tags.push(["n_sigs", String(options.requiredSignatures)]);
  }

  // Add refund keys
  if (options.refundPubkeys.length > 0) {
    tags.push(["refund", ...options.refundPubkeys]);
  }

  // Add n_sigs_refund if > 1
  if (options.requiredRefundSignatures > 1) {
    tags.push(["n_sigs_refund", String(options.requiredRefundSignatures)]);
  }

  return [
    "P2PK",
    {
      nonce,
      data: options.lockingPubkeys[0], // Primary pubkey
      tags,
    },
  ];
}

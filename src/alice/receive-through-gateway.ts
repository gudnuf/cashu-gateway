import type { OutputDataLike } from "@cashu/cashu-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { logger } from "../lib/logger";
import type { NostrClient } from "../nostr";
import type { Wallet } from "../wallet";
import type { PendingHTLCRequest } from "./index";

// ============================================================================
// Receive Through Gateway Protocol (Dealer-Based)
// ============================================================================
// Alice receives Lightning payments via a three-party protocol:
// 1. Request dealer's fee blinded messages and create her own P2PK blinded messages
// 2. Send aggregated blinded messages to gateway, which returns an invoice
// 3. After invoice payment, gateway creates HTLC and sends to dealer
// 4. Dealer swaps HTLC (claims fee), returns blinded signatures to Alice
// 5. Alice unblinds signatures to create spendable P2PK proofs

export type ReceiveThroughGatewayParams = {
  amount: number;
  alicePublicKey: string;
  wallet: Wallet;
  nostr: NostrClient;
  gatewayPublicKey: string;
  dealerPublicKey: string;
};

export type ReceiveResult = {
  success: boolean;
  message?: string;
  data?: {
    invoice: string;
    preimageHash: string;
    aliceCount: number;
    dealerCount: number;
    totalAmount: number;
    aliceAmount: number;
    feeAmount: number;
  };
  error?: string;
  pendingRequest?: PendingHTLCRequest;
  preimageHash?: string;
};

export async function receiveThroughGateway(
  params: ReceiveThroughGatewayParams
): Promise<ReceiveResult> {
  const { amount, alicePublicKey, wallet, nostr, gatewayPublicKey, dealerPublicKey } = params;

  logger.info(`Requesting ${amount} sats from gateway (via dealer)`);

  try {
    // Generate preimage hash for tracking (NWC will use its own preimage for the invoice)
    const preimage = randomBytes(32);
    const preimageHash = bytesToHex(sha256(preimage));

    // Step 1: Request dealer fee blinded messages
    logger.info("Requesting dealer fee blinded messages...");
    const dealerResponse = await nostr.requestAndWaitForResponse(dealerPublicKey, {
      method: "request_dealer_fee",
      params: {
        preimageHash: preimageHash,
        amount: amount,
      },
    });

    if (dealerResponse.error) {
      return {
        success: false,
        error: `Dealer error: ${dealerResponse.error.message}`,
      };
    }

    const dealerBlindedMessages = dealerResponse.result.blindedMessages;
    const feeAmount = dealerResponse.result.feeAmount;
    logger.info(
      `Dealer provided ${dealerBlindedMessages.length} blinded messages for ${feeAmount} sat fee`
    );

    // Step 2: Create Alice's P2PK blinded messages
    const aliceOutputData = wallet.createP2PKBlindedMessages(
      amount,
      `02${alicePublicKey}`,
      undefined,
      "Alice receive"
    );
    const aliceBlindedMessages = aliceOutputData.map((od: OutputDataLike) => od.blindedMessage);
    logger.info(`Created ${aliceOutputData.length} blinded messages for ${amount} sats`);

    // Step 3: Aggregate dealer and Alice blinded messages
    const aggregatedBlindedMessages = [...dealerBlindedMessages, ...aliceBlindedMessages];
    logger.info(`Aggregated ${aggregatedBlindedMessages.length} total blinded messages`);

    // Store Alice's output data to unblind signatures when gateway responds
    const pendingRequest: PendingHTLCRequest = {
      outputData: aliceOutputData,
      amount,
      timestamp: Date.now(),
    };

    // Step 4: Request invoice from gateway with aggregated blinded messages
    const gatewayResponse = await nostr.requestAndWaitForResponse(gatewayPublicKey, {
      method: "make_invoice",
      params: {
        amount: amount + feeAmount,
        preimageHash: preimageHash,
        blindedMessages: aggregatedBlindedMessages,
        dealerPubkey: dealerPublicKey,
      },
    });

    if (gatewayResponse.error) {
      return {
        success: false,
        error: gatewayResponse.error.message,
      };
    }

    const invoice = gatewayResponse.result.data.invoice;

    logger.info(`Invoice created: ${invoice}`);
    logger.info("Waiting for payment and blinded signatures...");

    return {
      success: true,
      message: `Invoice created. Waiting for payment and signatures...`,
      data: {
        invoice:
          "The gateway can't hodl invoices yet, so its not really using our preimage, it just pays itself",
        preimageHash,
        aliceCount: aliceOutputData.length,
        dealerCount: dealerBlindedMessages.length,
        totalAmount: amount + feeAmount,
        aliceAmount: amount,
        feeAmount: feeAmount,
      },
      pendingRequest,
      preimageHash,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create blinded messages",
    };
  }
}

// ============================================================================
// Receive Blinded Signatures from Dealer
// ============================================================================
// Final step: unblind the dealer's returned signatures using Alice's secrets
// to create spendable P2PK proofs, then store them in the wallet.

export type ReceiveBlindedSigsParams = {
  blindedSignatures: { C_: string; id: string; amount: number }[];
  pendingRequest: PendingHTLCRequest;
  wallet: Wallet;
  alicePrivateKey: string;
};

export async function receiveBlindedSigsFromDealer(
  params: ReceiveBlindedSigsParams
): Promise<{ totalAmount: number }> {
  const { blindedSignatures, pendingRequest, wallet, alicePrivateKey } = params;

  // Unblind the mint's signatures using our secrets and blinding factors
  const proofs = wallet.unblindSignaturesAndCreateProofs(
    pendingRequest.outputData,
    blindedSignatures
  );

  // Store the P2PK proofs in wallet
  await wallet.receiveProofsFromDealer(proofs, alicePrivateKey);

  const totalAmount = proofs.reduce((sum, proof) => sum + proof.amount, 0);

  logger.info(`Successfully received ${totalAmount} sats through gateway!`);
  logger.info(`New balance: ${wallet.getBalance()} sats`);

  return { totalAmount };
}

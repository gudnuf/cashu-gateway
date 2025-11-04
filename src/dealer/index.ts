import type { OutputDataLike } from "@cashu/cashu-ts";
import type { BaseCommandContext } from "../cli";
import { getDealerConfig } from "../config";
import { logger, shortenKey } from "../lib/logger";
import { initializeService, setupShutdownHandler, startCliServer } from "../lib/service";
import type { Request, Response } from "../types";
import { createErrorResponse, createResponse, isRequestForMethod } from "../types";
import { requestDealerFee } from "./request-dealer-fee";
import { swapHTLC } from "./swap-htlc";

// ============================================================================
// Dealer - Preimage Distributor
// ============================================================================
// A dealer sells preimages to gateways on behalf of the supplier (code name: Alice)

export const DEALER_FEE = 2;

export type PendingDealerFee = {
  outputData: OutputDataLike[];
  amount: number;
  alicePubkey: string;
  timestamp: number;
};

const config = getDealerConfig();

const { wallet, keys, nostr, db } = await initializeService({
  name: "Dealer",
  mintUrl: config.mintUrl,
  relayUrl: config.relayUrl,
  mnemonic: config.mnemonic,
  dbPath: "./data/dealer.db",
  port: 3002,
});

logger.info(`pubkey: ${shortenKey(keys.getPublicKeyHex())}`);

const pendingDealerFees = new Map<string, PendingDealerFee>();

// Setup CLI server with base commands only (no custom commands yet)
const commandContext: BaseCommandContext = {
  wallet,
  keys,
};

const { server } = startCliServer({
  port: 3002,
  baseContext: commandContext,
});

// ============================================================================
// Dealer Protocol Handler
// ============================================================================

async function handleRequest(
  senderPubkey: string,
  request: Request
): Promise<Response | undefined> {
  if (isRequestForMethod(request, "info")) {
    return createResponse<"info">({
      type: "dealer",
      name: "Dealer",
      timestamp: Date.now(),
    });
  }

  if (isRequestForMethod(request, "request_dealer_fee")) {
    const { preimageHash, amount } = request.params ?? {};
    if (!preimageHash || !amount) {
      return createErrorResponse<"request_dealer_fee">(
        -32602,
        "Usage: request_dealer_fee <preimageHash> <amount>"
      );
    }

    try {
      // Create dealer fee blinded messages
      const { pendingFee, blindedMessages } = requestDealerFee({
        alicePubkey: senderPubkey,
        wallet,
        keys,
      });

      // Store pending fee for later swap
      pendingDealerFees.set(preimageHash, pendingFee);

      return createResponse<"request_dealer_fee">({
        success: true,
        feeAmount: DEALER_FEE,
        blindedMessages,
      });
    } catch (error) {
      return createErrorResponse<"request_dealer_fee">(
        -32603,
        error instanceof Error ? error.message : "Failed to create dealer fee blinded messages"
      );
    }
  }

  if (isRequestForMethod(request, "swap_htlc")) {
    const { htlcToken, blindedMessages, requestPreimageHash, preimage, alicePubkey } =
      request.params ?? {};
    if (!htlcToken || !blindedMessages || !requestPreimageHash || !preimage || !alicePubkey) {
      return createErrorResponse<"swap_htlc">(
        -32602,
        "Usage: swap_htlc <htlcToken> <blindedMessages> <requestPreimageHash> <preimage> <alicePubkey>"
      );
    }

    // Look up pending fee before calling handler
    const pendingFee = pendingDealerFees.get(requestPreimageHash);
    if (!pendingFee) {
      return createErrorResponse<"swap_htlc">(-32603, "No pending dealer fee request found");
    }

    try {
      // Swap HTLC and claim dealer fee
      const { dealerTotal, aliceSignatures } = await swapHTLC({
        htlcToken,
        blindedMessages,
        pendingFee,
        wallet,
      });

      // Forward Alice's blinded signatures to her
      logger.info(`Forwarding ${aliceSignatures.length} blinded signatures to Alice`);
      await nostr.sendRequest(pendingFee.alicePubkey, {
        method: "blinded_signatures",
        params: {
          preimageHash: requestPreimageHash,
          blindedSignatures: aliceSignatures,
        },
      });
      logger.info("Sent blinded signatures to Alice");

      // Clean up pending request after successful swap
      pendingDealerFees.delete(requestPreimageHash);

      return createResponse<"swap_htlc">({
        success: true,
        message: `Successfully swapped HTLC and claimed ${dealerTotal} sats in fees`,
      });
    } catch (error) {
      return createErrorResponse<"swap_htlc">(
        -32603,
        error instanceof Error ? error.message : "Failed to swap HTLC token"
      );
    }
  }

  return {
    error: {
      code: -32601,
      message: `Method not found: ${request.method}`,
    },
  };
}

await nostr.listen(handleRequest);
logger.info("Ready");

setupShutdownHandler({ serviceName: "Dealer", server, wallet, db });

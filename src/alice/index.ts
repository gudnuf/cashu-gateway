import type { OutputDataLike } from "@cashu/cashu-ts";
import type { BaseCommandContext, CommandDef, CommandRegistry } from "../cli";
import { getAliceConfig } from "../config";
import { logger, shortenKey } from "../lib/logger";
import { initializeService, setupShutdownHandler, startCliServer } from "../lib/service";
import type { NostrClient } from "../nostr";
import type { Request, Response } from "../types";
import { createErrorResponse, createResponse, isRequestForMethod } from "../types";
import { payThroughGateway } from "./pay-through-gateway";
import { receiveBlindedSigsFromDealer, receiveThroughGateway } from "./receive-through-gateway";

// ============================================================================
// Alice - "I want to send and receive lightning payments, but my mint won't allow it :("
// ============================================================================
// Alice sells preimages to a gateway which atomically sends and receives lightning payments in exchange for ecash.
// - For receiving payments, alice buys ecash from the gateway
// - For sending payments, alice buys bitcoin via the gateway

export type PendingHTLCRequest = {
  outputData: OutputDataLike[];
  amount: number;
  timestamp: number;
};

const config = getAliceConfig();

const { wallet, keys, nostr, db } = await initializeService({
  name: "Alice",
  mintUrl: config.mintUrl,
  relayUrl: config.relayUrl,
  mnemonic: config.mnemonic,
  dbPath: "./data/alice.db",
  port: 3001,
});

logger.info(`pubkey: ${shortenKey(keys.getPublicKeyHex())}`);

const pendingHTLCRequests = new Map<string, PendingHTLCRequest>();

export type AliceCommandContext = BaseCommandContext & {
  nostr: NostrClient;
  config: typeof config;
};

// ============================================================================
// CLI Command Definitions
// ============================================================================

const payThroughGatewayCommand: CommandDef<AliceCommandContext> = {
  description: "Pay a Lightning invoice via gateway",
  args: [
    {
      name: "invoice",
      type: "bolt11",
      description: "BOLT11 invoice to pay",
    },
    {
      name: "gateway_pubkey",
      type: "hex64",
      description: "Gateway public key",
    },
    {
      name: "amount",
      type: "number",
      description: "Amount in sats (optional if invoice has amount)",
      optional: true,
    },
  ],
  handler: async (context, args) => {
    return payThroughGateway({
      invoice: args.invoice as string,
      amount: args.amount as number,
      wallet: context.wallet,
      nostr: context.nostr,
      gatewayPublicKey: args.gateway_pubkey as string,
      mintUrl: context.config.mintUrl,
    });
  },
};

const receiveThroughGatewayCommand: CommandDef<AliceCommandContext> = {
  description: "Request sats from gateway (creates P2PK blinded messages)",
  args: [
    {
      name: "amount",
      type: "number",
      description: "Amount in sats to request",
    },
    {
      name: "gateway_pubkey",
      type: "hex64",
      description: "Gateway public key",
    },
    {
      name: "dealer_pubkey",
      type: "hex64",
      description: "Dealer public key",
    },
  ],
  handler: async (context, args) => {
    const result = await receiveThroughGateway({
      amount: args.amount as number,
      alicePublicKey: context.keys.getPublicKeyHex(),
      wallet: context.wallet,
      nostr: context.nostr,
      gatewayPublicKey: args.gateway_pubkey as string,
      dealerPublicKey: args.dealer_pubkey as string,
    });

    // Store pending request if successful
    if (result.success && result.pendingRequest && result.preimageHash) {
      pendingHTLCRequests.set(result.preimageHash, result.pendingRequest);
    }

    // Return result without internal fields that contain BigInt values
    const { pendingRequest, preimageHash, ...returnResult } = result;
    return returnResult;
  },
};

function createAliceCliCommands(): CommandRegistry<AliceCommandContext> {
  const commands: CommandRegistry<AliceCommandContext> = new Map();

  commands.set("pay", payThroughGatewayCommand);
  commands.set("receive", receiveThroughGatewayCommand);

  return commands;
}

async function handleNostrMessageForAlice(
  context: AliceCommandContext,
  _senderPubkey: string,
  request: Request
): Promise<Response | undefined> {
  if (isRequestForMethod(request, "blinded_signatures")) {
    // The dealer sends this message to alice after completeing the deal with the gateway by swapping the SIG_ALL HTLC
    // Note that this could be removed if alice were to watch for the HTLC Ys to be spent, then restore her outputs
    const { preimageHash, blindedSignatures } = request.params ?? {};
    if (!preimageHash || !blindedSignatures) {
      return createErrorResponse<"blinded_signatures">(
        -32602,
        "Missing preimageHash or blindedSignatures"
      );
    }

    // Look up pending request before calling handler
    const pendingRequest = pendingHTLCRequests.get(preimageHash);
    if (!pendingRequest) {
      return createErrorResponse<"blinded_signatures">(-32603, "No pending HTLC request found");
    }

    try {
      const result = await receiveBlindedSigsFromDealer({
        blindedSignatures,
        pendingRequest,
        wallet: context.wallet,
        alicePrivateKey: context.keys.getPrivateKeyHex(),
      });

      // Clean up pending request after successful processing
      pendingHTLCRequests.delete(preimageHash);

      return createResponse<"blinded_signatures">({
        success: true,
        message: `Successfully received ${result.totalAmount} sats`,
      });
    } catch (error) {
      return createErrorResponse<"blinded_signatures">(
        -32603,
        error instanceof Error ? error.message : "Failed to process blinded signatures"
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

const commands = createAliceCliCommands();
const commandContext: AliceCommandContext = {
  wallet,
  keys,
  nostr,
  config,
};

nostr.listen((senderPubkey: string, request: Request) =>
  handleNostrMessageForAlice(commandContext, senderPubkey, request)
);

const { server } = startCliServer({
  port: 3001,
  baseContext: commandContext,
  customCommands: commands,
});

setupShutdownHandler({ serviceName: "Alice", server, wallet, db });

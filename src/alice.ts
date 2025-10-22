import { getEncodedToken, type Token } from "@cashu/cashu-ts";
import { parseBolt11Invoice } from "./bolt11";
import type { BaseCommandContext, CommandRegistry } from "./cli";
import { getAliceConfig } from "./config";
import type { NostrClient } from "./nostr";
import { initializeService, setupShutdownHandler, startCliServer } from "./service";
import type { InfoRequest, PayInvoiceRequest } from "./types";

// ============================================================================
// Alice Service - Lightning Payment Client
// ============================================================================
// Alice initiates Lightning payments through a gateway using HTLC-locked
// Cashu tokens. She creates HTLC tokens locked to payment hashes and sends
// them to the gateway over Nostr for payment execution.

const config = getAliceConfig();

const { wallet, keys, logger, nostr, db } = await initializeService({
  name: "Alice",
  mintUrl: config.mintUrl,
  relayUrl: config.relayUrl,
  mnemonic: config.mnemonic,
  dbPath: "./data/alice.db",
  port: 3001,
});

type AliceCommandContext = BaseCommandContext & {
  nostr: NostrClient;
  config: typeof config;
};

async function handlePayThroughGateway(
  context: AliceCommandContext,
  invoice: string,
  gatewayPublicKey: string,
  amount?: number
): Promise<{ success: boolean; message?: string; data?: unknown; error?: string }> {
  const parsed = parseBolt11Invoice(invoice);

  if (!parsed.valid) {
    return {
      success: false,
      error: "Invalid BOLT11 invoice",
    };
  }

  const { decoded } = parsed;

  let amountSat: number;
  if (decoded.amountSat) {
    if (amount !== undefined && amount !== decoded.amountSat) {
      return {
        success: false,
        error: `Amount mismatch: invoice has ${decoded.amountSat} sats but ${amount} sats was provided`,
      };
    }
    amountSat = decoded.amountSat;
  } else {
    if (amount === undefined) {
      return {
        success: false,
        error: "Invoice doesn't have an amount. Please provide an amount argument.",
      };
    }
    amountSat = amount;
  }

  if (!decoded.paymentHash) {
    return {
      success: false,
      error: "Invoice must have a payment hash",
    };
  }

  context.logger.info(`Paying invoice for ${amountSat} sats`);

  try {
    const result = await context.wallet.sendHTLC(
      amountSat,
      decoded.paymentHash,
      decoded.expiryUnixSec ?? Date.now() + 1000 * 60 * 60 * 24 // 24 hours
    );

    result?.keep && context.wallet.getWalletDatabase().saveProofs(result.keep);

    if (!result?.send || result.send.length === 0) {
      return {
        success: false,
        error: "Failed to create HTLC token",
      };
    }

    const token: Token = {
      mint: context.config.mintUrl,
      proofs: result.send,
    };
    const encodedToken = getEncodedToken(token);

    context.logger.info("Sending payment request to gateway...");
    const request: PayInvoiceRequest = {
      method: "pay_invoice",
      params: {
        invoice,
        token: encodedToken,
      },
    };

    const response = await context.nostr.requestAndWaitForResponse(gatewayPublicKey, request);

    if (response.error) {
      return {
        success: false,
        error: response.error.message,
      };
    }

    context.logger.info("Payment completed successfully!");

    return {
      success: true,
      message: "Invoice paid successfully via gateway",
      data: response.result,
    };
  } catch (error) {
    context.logger.error("Payment failed:", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to pay invoice",
    };
  }
}

function createAliceCommands(): CommandRegistry<AliceCommandContext> {
  const commands: CommandRegistry<AliceCommandContext> = new Map();

  commands.set("pay", {
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
      return handlePayThroughGateway(
        context,
        args.invoice as string,
        args.gateway_pubkey as string,
        args.amount as number | undefined
      );
    },
  });

  commands.set("info", {
    description: "Get info from another service",
    args: [
      {
        name: "public_key",
        type: "hex64",
        description: "Public key of the service",
      },
    ],
    handler: async (context, args) => {
      const request: InfoRequest = { method: "info" };
      const response = await context.nostr.requestAndWaitForResponse(
        args.public_key as string,
        request
      );

      if (response.error) {
        return {
          success: false,
          error: response.error.message,
        };
      }

      return {
        success: true,
        message: "Info received",
        data: response.result,
      };
    },
  });

  return commands;
}

// Setup CLI server with Alice-specific commands
const aliceCommands = createAliceCommands();
const commandContext: AliceCommandContext = {
  wallet,
  keys,
  logger,
  nostr,
  config,
};

const { server } = startCliServer({
  port: 3001,
  logger,
  baseContext: commandContext,
  customCommands: aliceCommands,
});

setupShutdownHandler({ logger, server, wallet, db });

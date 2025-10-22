import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { getEncodedToken, type Token } from "@cashu/cashu-ts";
import { parseBolt11Invoice } from "./bolt11";
import {
  type BaseCommandContext,
  type CommandRegistry,
  createBaseCommands,
  createCliServer,
  createCommandHandlerFromRegistry,
  mergeCommandRegistries,
} from "./cli";
import { getAliceConfig } from "./config";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
import { NostrClient } from "./nostr";
import type { InfoRequest, PayInvoiceRequest } from "./types";
import { Wallet } from "./wallet";

const logger = new NamedLogger("Alice");

const config = getAliceConfig();

const aliceKeys = new Keys(config.mnemonic);
logger.info(`Public key: ${aliceKeys.getPublicKeyHex()}`);

mkdirSync("./data", { recursive: true });

const db = new Database("./data/alice.db", { create: true });

const aliceWallet = new Wallet({
  mintUrl: config.mintUrl,
  db,
  name: "Alice",
});

await aliceWallet.initialize();

const nostr = new NostrClient(aliceKeys, config.relayUrl, logger);

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
  context.logger.info(`Payment hash: ${decoded.paymentHash}`);
  context.logger.debug("Decoded invoice:", { decoded });

  try {
    context.logger.info("Creating HTLC-locked token...");
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
    context.logger.debug("Gateway response:", { result: response.result });

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

const baseCommands = createBaseCommands();
const aliceCommands = createAliceCommands();
const allCommands = mergeCommandRegistries(baseCommands, aliceCommands);

const commandContext: AliceCommandContext = {
  wallet: aliceWallet,
  keys: aliceKeys,
  logger,
  nostr,
  config,
};

const commandHandler = createCommandHandlerFromRegistry(allCommands, commandContext);

const PORT = 3001;
const server = createCliServer(PORT, logger, commandHandler);

process.on("SIGINT", () => {
  logger.info("Shutting down");
  server.stop();
  aliceWallet.close();
  db.close();
  process.exit(0);
});

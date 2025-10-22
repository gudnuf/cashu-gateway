import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { getDecodedToken } from "@cashu/cashu-ts";
import { RelayPool } from "applesauce-relay";
import { WalletConnect } from "applesauce-wallet-connect";
import { decodeBolt11 } from "./bolt11";
import {
  type BaseCommandContext,
  type CommandRegistry,
  createBaseCommands,
  createCliServer,
  createCommandHandlerFromRegistry,
  mergeCommandRegistries,
} from "./cli";
import { getGatewayConfig } from "./config";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
import { NostrClient } from "./nostr";
import type { Request, Response } from "./types";
import { createErrorResponse, createResponse, isRequestForMethod } from "./types";
import { Wallet } from "./wallet";

const logger = new NamedLogger("Gateway");

const config = getGatewayConfig();

const gatewayKeys = new Keys(config.mnemonic);
logger.info(`Public key: ${gatewayKeys.getPublicKeyHex()}`);

mkdirSync("./data", { recursive: true });

const db = new Database("./data/gateway.db", { create: true });

const gatewayWallet = new Wallet({
  mintUrl: config.mintUrl,
  db,
  name: "Gateway",
});

await gatewayWallet.initialize();

const pool = new RelayPool();
WalletConnect.pool = pool;

const nwcWallet = WalletConnect.fromConnectURI(config.nwcUri);

const nostr = new NostrClient(gatewayKeys, config.relayUrl, logger);

type GatewayCommandContext = BaseCommandContext & {
  nwcWallet: typeof nwcWallet;
};

function createGatewayCommands(): CommandRegistry<GatewayCommandContext> {
  const commands: CommandRegistry<GatewayCommandContext> = new Map();

  commands.set("pay", {
    description: "Pay a Lightning invoice via NWC",
    args: [
      {
        name: "invoice",
        type: "bolt11",
        description: "BOLT11 invoice to pay",
      },
    ],
    handler: async (context, args) => {
      const result = await context.nwcWallet.payInvoice(args.invoice as string);
      return {
        success: true,
        message: "Invoice paid successfully",
        data: { result },
      };
    },
  });

  commands.set("nwc_info", {
    description: "Get NWC wallet info",
    args: [],
    handler: async (context) => {
      const info = await context.nwcWallet.getInfo();
      return {
        success: true,
        message: "NWC info retrieved",
        data: { info },
      };
    },
  });

  return commands;
}

const baseCommands = createBaseCommands();
const gatewayCommands = createGatewayCommands();
const allCommands = mergeCommandRegistries(baseCommands, gatewayCommands);

const commandContext: GatewayCommandContext = {
  wallet: gatewayWallet,
  keys: gatewayKeys,
  logger,
  nwcWallet,
};

const commandHandler = createCommandHandlerFromRegistry(allCommands, commandContext);

const PORT = 3003;
const server = createCliServer(PORT, logger, commandHandler);

async function handleRequest(
  _senderPubkey: string,
  request: Request
): Promise<Response | undefined> {
  if (isRequestForMethod(request, "info")) {
    return createResponse<"info">({
      type: "gateway",
      name: "Gateway",
      timestamp: Date.now(),
    });
  }

  if (isRequestForMethod(request, "pay_invoice")) {
    const { invoice, token } = request.params ?? {};
    if (!invoice || !token) {
      return createErrorResponse<"pay_invoice">(-32602, "Usage: pay_invoice <invoice> <token>");
    }

    try {
      const decodedToken = getDecodedToken(token);
      logger.info(`Received payment request with ${decodedToken.proofs.length} HTLC proofs`);
      logger.debug("Decoded token:", { proofs: decodedToken.proofs, mint: decodedToken.mint });

      const preimageHash = JSON.parse(decodedToken.proofs[0].secret)[1].data;

      const parseResult = decodeBolt11(invoice);
      logger.debug("Decoded bolt11:", { invoice: parseResult });

      const paymentHash = parseResult.paymentHash;

      logger.info(`Verifying HTLC lock - bolt11 payment hash: ${paymentHash}`);
      logger.info(`Token preimage hash: ${preimageHash}`);

      if (paymentHash !== preimageHash) {
        logger.error("HTLC verification failed: payment hash mismatch");
        return createErrorResponse<"pay_invoice">(
          -32602,
          "Preimage hash does not match payment hash"
        );
      }

      logger.info("Paying invoice via NWC...");
      const { preimage, fees_paid } = await nwcWallet.payInvoice(invoice);
      logger.info(`Invoice paid! Fees: ${fees_paid} msats. Preimage: ${preimage}`);

      const { success, proofs } = await gatewayWallet.receiveHTLCToken(token, preimage);
      if (!success) {
        return createErrorResponse<"pay_invoice">(-32603, "Failed to claim HTLC token");
      }

      logger.debug("Claimed proofs:", {
        count: proofs?.length,
        totalAmount: proofs?.reduce((sum, p) => sum + p.amount, 0) ?? 0,
      });

      return createResponse<"pay_invoice">({
        success: true,
        message: "Invoice paid and HTLC claimed successfully",
        data: { preimage },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to pay invoice and claim HTLC";
      logger.error("Error in pay_invoice:", { error: errorMessage });
      return createErrorResponse<"pay_invoice">(-32603, errorMessage);
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

process.on("SIGINT", () => {
  logger.info("Shutting down");
  server.stop();
  gatewayWallet.close();
  db.close();
  process.exit(0);
});

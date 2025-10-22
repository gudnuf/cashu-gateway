import { getDecodedToken } from "@cashu/cashu-ts";
import { RelayPool } from "applesauce-relay";
import { WalletConnect } from "applesauce-wallet-connect";
import { decodeBolt11 } from "./bolt11";
import type { BaseCommandContext, CommandDef, CommandRegistry } from "./cli";
import { getGatewayConfig } from "./config";
import { initializeService, setupShutdownHandler, startCliServer } from "./service";
import type { Request, Response } from "./types";
import { createErrorResponse, createResponse, isRequestForMethod } from "./types";

// ============================================================================
// Gateway Service - Lightning Payment Gateway
// ============================================================================
// The Gateway receives HTLC-locked Cashu tokens from clients, verifies the
// HTLC lock matches the payment hash, executes Lightning payments via NWC,
// and claims the tokens using the payment preimage.

const config = getGatewayConfig();

const { wallet, keys, logger, nostr, db } = await initializeService({
  name: "Gateway",
  mintUrl: config.mintUrl,
  relayUrl: config.relayUrl,
  mnemonic: config.mnemonic,
  dbPath: "./data/gateway.db",
  port: 3003,
});

// Setup NWC wallet for Lightning payments
const pool = new RelayPool();
WalletConnect.pool = pool;
const nwcWallet = WalletConnect.fromConnectURI(config.nwcUri);

type GatewayCommandContext = BaseCommandContext & {
  nwcWallet: typeof nwcWallet;
};

const payCommand: CommandDef<GatewayCommandContext> = {
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
};

const nwcInfoCommand: CommandDef<GatewayCommandContext> = {
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
};

function createGatewayCommands(): CommandRegistry<GatewayCommandContext> {
  const commands: CommandRegistry<GatewayCommandContext> = new Map();

  commands.set("pay", payCommand);
  commands.set("nwc-info", nwcInfoCommand);

  return commands;
}

// Setup CLI server with Gateway-specific commands
const gatewayCommands = createGatewayCommands();
const commandContext: GatewayCommandContext = {
  wallet,
  keys,
  logger,
  nwcWallet,
};

const { server } = startCliServer({
  port: 3003,
  logger,
  baseContext: commandContext,
  customCommands: gatewayCommands,
});

// ============================================================================
// Gateway Protocol Handler
// ============================================================================

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

      const preimageHash = JSON.parse(decodedToken.proofs[0].secret)[1].data;

      const parseResult = decodeBolt11(invoice);

      const paymentHash = parseResult.paymentHash;

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

      const { success, proofs } = await wallet.receiveHTLCToken(token, preimage);
      if (!success) {
        return createErrorResponse<"pay_invoice">(-32603, "Failed to claim HTLC token");
      }

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

setupShutdownHandler({ logger, server, wallet, db });

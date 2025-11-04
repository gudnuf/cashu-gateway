import { RelayPool } from "applesauce-relay";
import { WalletConnect } from "applesauce-wallet-connect";
import type { BaseCommandContext } from "../cli";
import { getGatewayConfig } from "../config";
import { logger, shortenKey } from "../lib/logger";
import { ProofStateSubscriptionManager } from "../lib/proof-state-subscription-manager";
import { initializeService, setupShutdownHandler, startCliServer } from "../lib/service";
import type { Request, Response } from "../types";
import { createErrorResponse, createResponse, isRequestForMethod } from "../types";
import { MakeInvoiceHandler } from "./make-invoice";
import { payInvoice } from "./pay-invoice";

// ============================================================================
// Gateway Service - Lightning Payment Gateway
// ============================================================================
// The Gateway pays invoices for ecash from Alice that is locked to the invoice payment hash and
// gives Alice ecash so that Alice gives the gateway the preimage of incoming htlcs

const config = getGatewayConfig();

const { wallet, keys, nostr, db } = await initializeService({
  name: "Gateway",
  mintUrl: config.mintUrl,
  relayUrl: config.relayUrl,
  mnemonic: config.mnemonic,
  dbPath: "./data/gateway.db",
  port: 3003,
});

logger.info(`pubkey: ${shortenKey(keys.getPublicKeyHex())}`);

// Initialize proof state subscription manager to track HTLC spending
const proofStateManager = new ProofStateSubscriptionManager(wallet.getWallet());

proofStateManager.onSetSpent((set) => {
  if (!set.preimage) {
    logger.error("No preimage for spent HTLC");
    return;
  }

  logger.info(`HTLC spent: ${set.id}`, {
    description: set.description,
    proofCount: set.proofs.length,
    preimage: set.preimage,
  });
});

// Setup NWC wallets for Lightning payments
// We use two separate instances to avoid blocking:
// 1. nwcWallet for making requests (invoices, payments)
// 2. nwcListener for listening to notifications
const pool = new RelayPool();
WalletConnect.pool = pool;
const nwcWallet = WalletConnect.fromConnectURI(config.nwcUri);
const nwcListener = WalletConnect.fromConnectURI(config.nwcUri);

// Initialize make invoice handler with payment listener
const makeInvoiceHandler = new MakeInvoiceHandler(
  wallet,
  keys,
  nostr,
  proofStateManager,
  nwcWallet,
  nwcListener,
  config.mintUrl
);

const commandContext: BaseCommandContext = {
  wallet,
  keys,
};

const { server } = startCliServer({
  port: 3003,
  baseContext: commandContext,
});

// ============================================================================
// Gateway Protocol Handler
// ============================================================================

async function handleNostrMessageForGateway(
  senderPubkey: string,
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
      const result = await payInvoice({
        invoice,
        token,
        wallet,
        nwcWallet,
        gatewayPrivateKey: keys.getPrivateKeyHex(),
      });

      return createResponse<"pay_invoice">({
        success: true,
        message: "Invoice paid and HTLC claimed successfully",
        data: { preimage: result.preimage },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to pay invoice and claim HTLC";
      logger.error("Error in pay_invoice:", { error: errorMessage });
      return createErrorResponse<"pay_invoice">(-32603, errorMessage);
    }
  }

  if (isRequestForMethod(request, "make_invoice")) {
    const {
      amount,
      blindedMessages,
      preimageHash: requestPreimageHash,
      dealerPubkey,
    } = request.params ?? {};
    if (!amount || !blindedMessages || !requestPreimageHash || !dealerPubkey) {
      return createErrorResponse<"make_invoice">(
        -32602,
        "Usage: make_invoice <amount> <preimageHash> <blindedMessages> <dealerPubkey>"
      );
    }

    try {
      const invoice = await makeInvoiceHandler.createInvoiceAndWaitForPayment(senderPubkey, {
        amount,
        blindedMessages,
        preimageHash: requestPreimageHash,
        dealerPubkey,
        nwcWallet,
        mintUrl: config.mintUrl,
      });

      return createResponse<"make_invoice">({
        success: true,
        message: "Invoice created, waiting for payment",
        data: { invoice },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to create invoice";
      logger.error("Error in make_invoice:", { error: errorMessage });
      return createErrorResponse<"make_invoice">(-32603, errorMessage);
    }
  }

  return {
    error: {
      code: -32601,
      message: `Method not found: ${request.method}`,
    },
  };
}

await nostr.listen(handleNostrMessageForGateway);
logger.info("Ready");

setupShutdownHandler({
  serviceName: "Gateway",
  server,
  wallet,
  db,
  cleanup: () => {
    proofStateManager.cleanup();
    makeInvoiceHandler.cleanup();
  },
});

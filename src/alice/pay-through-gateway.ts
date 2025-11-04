import { getEncodedToken, type Token } from "@cashu/cashu-ts";
import { parseBolt11Invoice } from "../lib/bolt11";
import { logger } from "../lib/logger";
import type { NostrClient } from "../nostr";
import type { PayInvoiceRequest } from "../types";
import type { Wallet } from "../wallet";

// ============================================================================
// Pay Through Gateway Protocol
// ============================================================================
// Alice can pay Lightning invoices by selling an HTLC token to a gateway that is
// locked to the payment hash of the invoice she wants to pay.

export type PayThroughGatewayParams = {
  invoice: string;
  amount?: number;
  wallet: Wallet;
  nostr: NostrClient;
  gatewayPublicKey: string;
  mintUrl: string;
};

export type PaymentResult = {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
};

export async function payThroughGateway(params: PayThroughGatewayParams): Promise<PaymentResult> {
  const { invoice, amount, wallet, nostr, gatewayPublicKey, mintUrl } = params;

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

  logger.info(`Paying invoice for ${amountSat} sats`);

  try {
    // Create HTLC token locked to payment hash
    const result = await wallet.sendHTLC(amountSat, {
      preimageHash: decoded.paymentHash,
      locktime: decoded.expiryUnixSec ?? Date.now() + 1000 * 60 * 60 * 24, // 24 hours
    });

    if (!result?.send || result.send.length === 0) {
      return {
        success: false,
        error: "Failed to create HTLC token",
      };
    }

    const token: Token = {
      mint: mintUrl,
      proofs: result.send,
    };
    const encodedToken = getEncodedToken(token);

    logger.info("Sending payment request to gateway...");
    const request: PayInvoiceRequest = {
      method: "pay_invoice",
      params: {
        invoice,
        token: encodedToken,
      },
    };

    const response = await nostr.requestAndWaitForResponse(gatewayPublicKey, request);

    if (response.error) {
      return {
        success: false,
        error: response.error.message,
      };
    }

    logger.info("Payment completed successfully!");

    return {
      success: true,
      message: "Invoice paid successfully via gateway",
      data: response.result,
    };
  } catch (error) {
    logger.error("Payment failed:", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to pay invoice",
    };
  }
}

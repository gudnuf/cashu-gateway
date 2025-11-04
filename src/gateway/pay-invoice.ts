import { getDecodedToken } from "@cashu/cashu-ts";
import { decodeBolt11 } from "../lib/bolt11";
import { logger } from "../lib/logger";
import type { Wallet } from "../wallet";

// ============================================================================
// Pay Invoice - Execute Lightning Payment and Claim HTLC
// ============================================================================
// 1. Verify HTLC lock matches invoice payment hash
// 2. Pay invoice via NWC
// 3. Claim HTLC token with preimage

type PayInvoiceParams = {
  invoice: string;
  token: string;
  wallet: Wallet;
  nwcWallet: any; // WalletConnect instance
  gatewayPrivateKey: string;
};

type PayInvoiceResult = {
  preimage: string;
  feesPaid: number;
};

export async function payInvoice(params: PayInvoiceParams): Promise<PayInvoiceResult> {
  const { invoice, token, wallet, nwcWallet, gatewayPrivateKey } = params;

  const decodedToken = getDecodedToken(token);
  logger.info(`Received payment request with ${decodedToken.proofs.length} HTLC proofs`);

  const preimageHash = JSON.parse(decodedToken.proofs[0].secret)[1].data;

  const parseResult = decodeBolt11(invoice);
  const paymentHash = parseResult.paymentHash;

  if (paymentHash !== preimageHash) {
    logger.error("HTLC verification failed: payment hash mismatch");
    throw new Error("Preimage hash does not match payment hash");
  }

  logger.info("Paying invoice via NWC...");
  const { preimage, fees_paid } = await nwcWallet.payInvoice(invoice);
  logger.info(`Invoice paid! Fees: ${fees_paid} msats. Preimage: ${preimage}`);

  const { success } = await wallet.receiveHTLCToken(token, preimage, gatewayPrivateKey);
  if (!success) {
    throw new Error("Failed to claim HTLC token");
  }

  return {
    preimage,
    feesPaid: fees_paid,
  };
}

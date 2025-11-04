import { logger } from "../lib/logger";
import type { Wallet } from "../wallet";
import type { PendingDealerFee } from "./index";

// ============================================================================
// Swap HTLC - Exchange HTLC Token for Blinded Signatures
// ============================================================================
// 1. Swap HTLC token for blinded signatures from mint
// 2. Unblind dealer's signatures and claim fee
// 3. Return Alice's blinded signatures for forwarding

type SwapHTLCParams = {
  htlcToken: string;
  blindedMessages: any[];
  pendingFee: PendingDealerFee;
  wallet: Wallet;
};

type SwapHTLCResult = {
  dealerTotal: number;
  aliceSignatures: { C_: string; id: string; amount: number }[];
};

export async function swapHTLC(params: SwapHTLCParams): Promise<SwapHTLCResult> {
  const { htlcToken, blindedMessages, pendingFee, wallet } = params;

  logger.info("Swapping HTLC for blinded signatures...");

  // Swap HTLC token directly (gateway already signed it with SIG_ALL)
  const { success, blindedSignatures, error } = await wallet.receiveSigAllToken(
    htlcToken,
    blindedMessages
  );

  if (!success || !blindedSignatures) {
    logger.error("Failed to swap HTLC token:", { error });
    throw new Error(error || "Failed to swap HTLC token");
  }

  logger.info(`Received ${blindedSignatures.length} blinded signatures from mint`);

  // Extract dealer's blinded signatures (first DEALER_FEE sats worth)
  // The outputData tells us which signatures belong to the dealer
  const dealerSignatures = blindedSignatures.slice(0, pendingFee.outputData.length);
  const aliceSignatures = blindedSignatures.slice(pendingFee.outputData.length);

  // Unblind dealer's signatures to create spendable proofs
  const dealerProofs = wallet.unblindSignaturesAndCreateProofs(
    pendingFee.outputData,
    dealerSignatures
  );

  // Save dealer's proofs to database
  wallet.getWalletDatabase().saveProofs(dealerProofs);

  const dealerTotal = dealerProofs.reduce((sum, proof) => sum + proof.amount, 0);
  logger.info(`Claimed ${dealerTotal} sats in fees`);
  logger.info(`New balance: ${wallet.getBalance()} sats`);

  return {
    dealerTotal,
    aliceSignatures,
  };
}

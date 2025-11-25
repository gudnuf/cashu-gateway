import type { Keys } from "../lib/keys";
import { logger } from "../lib/logger";
import type { Wallet } from "../wallet";
import { DEALER_FEE, type PendingDealerFee } from "./index";

// ============================================================================
// Request Dealer Fee - Create Fee Blinded Messages
// ============================================================================
// Creates P2PK blinded messages for dealer fee locked to dealer's pubkey

type RequestDealerFeeParams = {
  alicePubkey: string;
  preimage: string;
  wallet: Wallet;
  keys: Keys;
};

type RequestDealerFeeResult = {
  pendingFee: PendingDealerFee;
  blindedMessages: { amount: number; B_: string; id: string }[];
};

export function requestDealerFee(params: RequestDealerFeeParams): RequestDealerFeeResult {
  const { alicePubkey, preimage, wallet, keys } = params;

  const dealerPubkey = keys.getPublicKeyHex();

  // Create P2PK blinded messages for dealer fee locked to dealer's pubkey
  const outputData = wallet.createP2PKBlindedMessages(DEALER_FEE, `02${dealerPubkey}`, undefined);
  const blindedMessages = outputData.map((od) => od.blindedMessage);

  logger.info(`Created ${blindedMessages.length} fee blinded messages for ${DEALER_FEE} sats`);
  logger.info("Stored preimage for HTLC spending");

  return {
    pendingFee: {
      outputData,
      amount: DEALER_FEE,
      alicePubkey,
      preimage,
      timestamp: Date.now(),
    },
    blindedMessages,
  };
}

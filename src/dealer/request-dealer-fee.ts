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
  wallet: Wallet;
  keys: Keys;
};

type RequestDealerFeeResult = {
  pendingFee: PendingDealerFee;
  blindedMessages: any[];
};

export function requestDealerFee(params: RequestDealerFeeParams): RequestDealerFeeResult {
  const { alicePubkey, wallet, keys } = params;

  const dealerPubkey = keys.getPublicKeyHex();

  // Create P2PK blinded messages for dealer fee locked to dealer's pubkey
  const outputData = wallet.createP2PKBlindedMessages(
    DEALER_FEE,
    `02${dealerPubkey}`,
    undefined,
    "Dealer fee"
  );
  const blindedMessages = outputData.map((od) => od.blindedMessage);

  logger.info(`Created ${blindedMessages.length} fee blinded messages for ${DEALER_FEE} sats`);

  return {
    pendingFee: {
      outputData,
      amount: DEALER_FEE,
      alicePubkey,
      timestamp: Date.now(),
    },
    blindedMessages,
  };
}

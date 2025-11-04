import { getEncodedToken, type Proof, type SerializedBlindedMessage } from "@cashu/cashu-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decodeBolt11 } from "../lib/bolt11";
import type { Keys } from "../lib/keys";
import { logger } from "../lib/logger";
import type { ProofStateSubscriptionManager } from "../lib/proof-state-subscription-manager";
import type { NostrClient } from "../nostr";
import { signSigAllMessage } from "../p2pk-sigall";
import type { Wallet } from "../wallet";

// ============================================================================
// Make Invoice Operation - Gateway creates invoice for receiving
// ============================================================================
// 1. Receive make_invoice request with aggregated blinded messages (dealer + Alice)
// 2. Create invoice (NWC generates its own preimage - workaround)
// 3. Store pending request (DO NOT create HTLC yet)
// 4. Wait for invoice payment
// 5. After payment, create HTLC token with SIG_ALL locked to invoice's payment hash
// 6. Sign HTLC and forward to dealer for swap
// 7. Dealer swaps HTLC, claims fee, and sends remaining signatures to Alice

type PendingReceiveRequest = {
  alicePubkey: string;
  blindedMessages: SerializedBlindedMessage[];
  requestPreimageHash: string;
  dealerPubkey: string;
  timestamp: number;
};

type MakeInvoiceParams = {
  amount: number;
  blindedMessages: SerializedBlindedMessage[];
  preimageHash: string;
  dealerPubkey: string;
  nwcWallet: any; // WalletConnect instance
  mintUrl: string;
};

export class MakeInvoiceHandler {
  private pendingReceiveRequests = new Map<string, PendingReceiveRequest>();
  private processedPayments = new Set<string>();

  constructor(
    private wallet: Wallet,
    private keys: Keys,
    private nostr: NostrClient,
    private proofStateManager: ProofStateSubscriptionManager,
    private nwcWallet: any,
    private nwcListener: any,
    private mintUrl: string
  ) {
    this.setupPaymentListener();
  }

  async createInvoiceAndWaitForPayment(
    alicePubkey: string,
    params: MakeInvoiceParams
  ): Promise<string> {
    const { amount, blindedMessages, preimageHash: requestPreimageHash, dealerPubkey } = params;

    // WORKAROUND: NWC doesn't support creating invoices with custom preimages
    // We use NWC's generated preimage instead of requestPreimageHash
    const transaction = await this.nwcWallet.makeInvoice(amount);
    const invoice = transaction.invoice;
    if (!invoice) {
      throw new Error("Failed to get invoice from NWC wallet");
    }

    const decodedInvoice = decodeBolt11(invoice);
    const paymentHash = decodedInvoice.paymentHash;
    if (!paymentHash) {
      throw new Error("Failed to get payment hash from NWC wallet");
    }

    logger.info(`Created invoice with payment hash: ${paymentHash}`);

    // Store pending receive request with dealer pubkey from Alice's request
    this.pendingReceiveRequests.set(paymentHash, {
      alicePubkey,
      blindedMessages,
      requestPreimageHash,
      dealerPubkey,
      timestamp: Date.now(),
    });

    logger.info("Pending request stored, waiting for payment...");

    // TEST MODE: Auto-pay invoice after 800ms to trigger the flow
    setTimeout(async () => {
      try {
        logger.info("Test mode: Paying invoice...");
        const payResult = await this.nwcWallet.payInvoice(invoice);
        logger.info(`Test payment completed. Fees: ${payResult.fees_paid} msats`);
      } catch (error) {
        logger.error("Test payment failed:", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 800);

    return invoice;
  }

  private setupPaymentListener() {
    this.nwcListener.notification("payment_received", async (tx: any) => {
      if (!tx.preimage) {
        logger.error("No preimage found in payment notification");
        return;
      }

      if (this.processedPayments.has(tx.preimage)) {
        return;
      }

      this.processedPayments.add(tx.preimage);

      // Calculate payment hash from preimage
      const preimageHash = bytesToHex(sha256(hexToBytes(tx.preimage)));

      // Look up pending request by payment hash
      const pendingRequest = this.pendingReceiveRequests.get(preimageHash);
      if (!pendingRequest) {
        logger.debug(`No pending request found for payment hash: ${preimageHash}`);
        return;
      }

      logger.info("Payment received! Processing pending receive request...");

      try {
        await this.processPayment(tx, pendingRequest, preimageHash);
        this.pendingReceiveRequests.delete(preimageHash);
      } catch (error) {
        logger.error("Error processing payment:", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private async processPayment(
    tx: any,
    pendingRequest: PendingReceiveRequest,
    preimageHash: string
  ) {
    const { alicePubkey, blindedMessages, requestPreimageHash, dealerPubkey } = pendingRequest;

    // Get decoded invoice details
    if (!tx.invoice) {
      logger.error("No invoice found in payment notification");
      return;
    }

    const decodedInvoice = decodeBolt11(tx.invoice);
    const expiryUnix = decodedInvoice.expiryUnixSec ?? Date.now() + 1000 * 60 * 60 * 24;
    const paymentHash = preimageHash;

    const refundPubkey = `02${this.keys.getPublicKeyHex()}`;
    const lockingPubkey = `02${this.keys.getPublicKeyHex()}`;

    // Calculate total amount from blinded messages
    const totalAmount = blindedMessages.reduce((sum, bm) => sum + bm.amount, 0);

    // NOW create HTLC token locked to invoice's payment hash with SIG_ALL
    logger.info(`Creating HTLC token for ${totalAmount} sats...`);
    const htlcResult = await this.wallet.sendHTLC(totalAmount, {
      preimageHash: paymentHash,
      sigflag: "SIG_ALL",
      pubkeys: [lockingPubkey],
      locktime: expiryUnix,
      refund: [refundPubkey],
      n_sigs_refund: 1,
    });

    const inputProofs = htlcResult.send;
    const outputBlindedMessages = blindedMessages.map((bm) => ({ B_: bm.B_ }));

    // Sign message committing to input proofs and output blinded messages (SIG_ALL)
    const signature = signSigAllMessage(
      this.keys.getPrivateKeyHex(),
      inputProofs,
      outputBlindedMessages
    );

    // Attach witness with signature and preimage to all proofs
    const signedProofs: Proof[] = inputProofs.map((proof) => ({
      ...proof,
      witness: {
        signatures: [signature],
        // TODO: dealer is the one that needs to add the preimage. Gateway just signs
        preimage: tx.preimage,
      },
    }));

    const witness = {
      signatures: [signature],
      preimage: tx.preimage,
    };

    logger.debug("HTLC witness (signature + preimage):", witness);

    // Create witnessed HTLC token
    const htlcToken = getEncodedToken({
      mint: this.mintUrl,
      proofs: signedProofs,
    });

    logger.info("HTLC created and signed, forwarding to dealer for swap...");

    // Track HTLC spending
    await this.proofStateManager.trackProofSet(
      paymentHash,
      inputProofs,
      `HTLC for ${totalAmount} sats (payment hash: ${paymentHash.slice(0, 8)}...)`
    );

    // Send swap_htlc request to dealer
    const dealerResponse = await this.nostr.requestAndWaitForResponse(dealerPubkey, {
      method: "swap_htlc",
      params: {
        htlcToken,
        blindedMessages,
        requestPreimageHash,
        preimage: tx.preimage,
        alicePubkey,
      },
    });

    if (dealerResponse.error) {
      logger.error("Dealer swap failed:", { error: dealerResponse.error.message });
      return;
    }

    logger.info("Dealer swap completed successfully");
  }

  cleanup() {
    this.pendingReceiveRequests.clear();
    this.processedPayments.clear();
  }
}

import type { Wallet as CashuWallet, Proof, ProofState } from "@cashu/cashu-ts";
import { logger } from "./logger";

export type TrackedProofSet = {
  id: string;
  proofs: Proof[];
  description?: string;
  preimage?: string;
};

type Subscription = {
  trackedSets: Map<string, TrackedProofSet>;
  canceller: () => void;
};

export class ProofStateSubscriptionManager {
  private wallet: CashuWallet;
  private subscription: Subscription | null = null;
  private proofStates: Map<string, ProofState["state"]> = new Map();
  private onProofSetSpent: ((set: TrackedProofSet) => void) | null = null;

  constructor(wallet: CashuWallet) {
    this.wallet = wallet;
  }

  /**
   * Subscribe to proof state updates for a set of proofs
   * @param id Unique identifier for this proof set
   * @param proofs Proofs to track
   * @param description Optional description for logging
   */
  async trackProofSet(id: string, proofs: Proof[], description?: string): Promise<void> {
    const trackedSet: TrackedProofSet = { id, proofs, description };

    if (!this.subscription) {
      // Create temporary map for the subscription
      const trackedSets = new Map<string, TrackedProofSet>();
      trackedSets.set(id, trackedSet);
      await this.createSubscription(trackedSets, proofs);
    } else {
      // Add to existing tracked sets and recreate subscription with all proofs
      this.subscription.trackedSets.set(id, trackedSet);

      // Cancel old subscription and create new one with all proofs
      this.subscription.canceller();

      const allProofs = Array.from(this.subscription.trackedSets.values()).flatMap(
        (set) => set.proofs
      );

      await this.createSubscription(this.subscription.trackedSets, allProofs);
    }

    logger.debug(`Tracking proof set: ${id}`, {
      description,
      proofCount: proofs.length,
    });
  }

  /**
   * Set callback to be called when all proofs in a set are spent
   */
  onSetSpent(callback: (set: TrackedProofSet) => void): void {
    this.onProofSetSpent = callback;
  }

  /**
   * Stop tracking a specific proof set
   */
  stopTracking(id: string): void {
    if (this.subscription) {
      this.subscription.trackedSets.delete(id);
      logger.debug(`Stopped tracking proof set: ${id}`);

      // If no more sets to track, clean up subscription
      if (this.subscription.trackedSets.size === 0) {
        this.cleanup();
      }
    }
  }

  /**
   * Clean up subscription and tracked state
   */
  cleanup(): void {
    if (this.subscription) {
      this.subscription.canceller();
      this.subscription = null;
      this.proofStates.clear();
      logger.debug("Cleaned up proof state subscription");
    }
  }

  private async createSubscription(
    trackedSets: Map<string, TrackedProofSet>,
    proofs: Proof[]
  ): Promise<void> {
    logger.info("Creating proof state subscription", {
      proofCount: proofs.length,
    });

    try {
      // Subscribe to proof state updates for the given proofs
      const canceller = await this.wallet.on.proofStateUpdates(
        proofs,
        (proofUpdate: ProofState & { proof: Proof }) => {
          this.handleProofStateUpdate(proofUpdate, trackedSets);
        },
        (error: Error) => {
          logger.error("Proof state update error", { error: error.message });
        }
      );

      this.subscription = {
        trackedSets,
        canceller,
      };

      // Handle WebSocket closure
      this.wallet.mint.webSocketConnection?.onClose((event) => {
        logger.debug("Mint WebSocket closed", { event });
        this.subscription = null;
      });
    } catch (error) {
      logger.error("Failed to create proof state subscription", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private handleProofStateUpdate(
    proofUpdate: ProofState & { proof: Proof },
    trackedSets: Map<string, TrackedProofSet>
  ): void {
    const { proof, state, witness } = proofUpdate;

    // Update the state for this proof
    this.proofStates.set(proof.C, state);

    // Extract preimage from witness if proof is spent (NUT-07, NUT-14)
    let preimage: string | undefined;
    if (state === "SPENT" && witness) {
      try {
        const witnessData = JSON.parse(witness);
        if (witnessData.preimage) {
          preimage = witnessData.preimage;
        }
      } catch (error) {
        logger.debug("Failed to parse witness", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Check each tracked set to see if all proofs are spent
    for (const [setId, trackedSet] of trackedSets.entries()) {
      const allProofsSpent = trackedSet.proofs.every((p) => this.proofStates.get(p.C) === "SPENT");

      if (preimage && !trackedSet.preimage) {
        trackedSet.preimage = preimage;
      }

      if (allProofsSpent) {
        logger.debug(`All proofs spent for set: ${setId}`, {
          description: trackedSet.description,
          preimage: trackedSet.preimage,
        });

        // Call the callback if set
        if (this.onProofSetSpent) {
          this.onProofSetSpent(trackedSet);
        }

        // Remove from tracking and clean up state
        trackedSets.delete(setId);
        for (const p of trackedSet.proofs) {
          this.proofStates.delete(p.C);
        }
      }
    }
  }
}

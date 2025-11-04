import type { Database } from "bun:sqlite";
import {
  blindMessage,
  Wallet as CashuWallet,
  getDecodedToken,
  hashToCurve,
  type MintKeys,
  type MintKeyset,
  type OutputConfig,
  OutputData,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedMessage,
  signP2PKSecret,
  type Token,
} from "@cashu/cashu-ts";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { logger } from "./lib/logger";
import type { HTLCConfig } from "./types";

type WalletConfig = {
  mintUrl: string;
  db: Database;
  name: string;
};

type MintCache = {
  keysets: MintKeyset[];
  keys: MintKeys[];
  unit: string;
  mintUrl: string;
};

class WalletDatabase {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.run(`
			CREATE TABLE IF NOT EXISTS mint_cache (
				mint_url TEXT PRIMARY KEY,
				unit TEXT NOT NULL,
				keysets TEXT NOT NULL,
				keys TEXT NOT NULL,
				updated_at INTEGER DEFAULT (strftime('%s', 'now'))
			)
		`);

    this.db.run(`
			CREATE TABLE IF NOT EXISTS proofs (
				Y TEXT PRIMARY KEY,
				id TEXT NOT NULL,
				amount INTEGER NOT NULL,
				secret TEXT NOT NULL,
				C TEXT NOT NULL,
				dleq TEXT,
				witness TEXT,
				created_at INTEGER DEFAULT (strftime('%s', 'now'))
			)
		`);
  }

  getCachedMint(mintUrl: string): MintCache | null {
    const row = this.db
      .query<{ mint_url: string; unit: string; keysets: string; keys: string }, string>(
        "SELECT mint_url, unit, keysets, keys FROM mint_cache WHERE mint_url = ?"
      )
      .get(mintUrl);

    if (!row) return null;

    try {
      return {
        mintUrl: row.mint_url,
        unit: row.unit,
        keysets: JSON.parse(row.keysets) as MintKeyset[],
        keys: JSON.parse(row.keys) as MintKeys[],
      };
    } catch (error) {
      console.error("Failed to parse cached mint data:", error);
      return null;
    }
  }

  saveMintCache(cache: MintCache): void {
    this.db.run(
      `INSERT INTO mint_cache (mint_url, unit, keysets, keys, updated_at)
			 VALUES (?, ?, ?, ?, strftime('%s', 'now'))
			 ON CONFLICT(mint_url) DO UPDATE SET
			 	unit = excluded.unit,
			 	keysets = excluded.keysets,
			 	keys = excluded.keys,
			 	updated_at = excluded.updated_at`,
      [cache.mintUrl, cache.unit, JSON.stringify(cache.keysets), JSON.stringify(cache.keys)]
    );
  }

  saveProofs(proofs: Proof[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO proofs (Y, id, amount, secret, C, dleq, witness)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const proof of proofs) {
      const secretBytes = new TextEncoder().encode(proof.secret);
      const Y = hashToCurve(secretBytes).toHex(true);

      stmt.run(
        Y,
        proof.id,
        proof.amount,
        proof.secret,
        proof.C,
        proof.dleq ? JSON.stringify(proof.dleq) : null,
        proof.witness ? JSON.stringify(proof.witness) : null
      );
    }

    stmt.finalize();
  }

  getDb(): Database {
    return this.db;
  }
  removeProofs(proofs: Pick<Proof, "secret">[]): void {
    const yValues = proofs.map((proof) => {
      const secretBytes = new TextEncoder().encode(proof.secret);
      return hashToCurve(secretBytes).toHex(true);
    });

    this.db.run(`DELETE FROM proofs WHERE Y IN (${yValues.map((y) => `'${y}'`).join(",")})`);
  }
}

export class Wallet {
  private _wallet: CashuWallet | null = null;
  private db: WalletDatabase;
  private config: WalletConfig;

  constructor(config: WalletConfig) {
    this.config = config;
    this.db = new WalletDatabase(config.db);
  }

  private get wallet(): CashuWallet {
    if (!this._wallet) {
      throw new Error("Wallet not initialized. Call initialize() first.");
    }
    return this._wallet;
  }

  async initialize(): Promise<void> {
    const cachedMint = this.db.getCachedMint(this.config.mintUrl);

    if (cachedMint) {
      this._wallet = new CashuWallet(cachedMint.mintUrl, {
        unit: cachedMint.unit,
        keysets: cachedMint.keysets,
        keys: cachedMint.keys,
        logger,
      });
    } else {
      this._wallet = new CashuWallet(this.config.mintUrl, { logger });
    }

    await this.wallet.loadMint();

    const cache = this.wallet.keyChain.getCache();
    this.db.saveMintCache(cache);

    logger.debug(`Wallet initialized with mint: ${this.config.mintUrl}`);
  }

  getWallet(): CashuWallet {
    if (!this.wallet) {
      throw new Error("Wallet not initialized. Call initialize() first.");
    }
    return this.wallet;
  }

  getDb(): Database {
    return this.db.getDb();
  }

  getWalletDatabase(): WalletDatabase {
    return this.db;
  }

  close(): void {
    this._wallet = null;
  }

  async receiveToken(token: string | Token) {
    try {
      const proofs = await this.wallet.receive(token);
      if (!proofs) {
        throw new Error("Failed to receive token");
      }
      this.db.saveProofs(proofs);
      return { success: true, proofs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  getBalance(): number {
    const result = this.db
      .getDb()
      .query<{ balance: number }, []>("SELECT COALESCE(SUM(amount), 0) as balance FROM proofs")
      .get();
    return result?.balance ?? 0;
  }

  async receiveHTLCToken(token: string | Token, preimage: string, privateKeys: string | string[]) {
    const decodedToken = typeof token === "string" ? getDecodedToken(token) : token;

    const proofsWithWitness: Proof[] = decodedToken.proofs.map((proof) => {
      const signatures: string[] = [];
      const keys = Array.isArray(privateKeys) ? privateKeys : [privateKeys];

      for (const privateKey of keys) {
        const signature = signP2PKSecret(proof.secret, privateKey);
        signatures.push(signature);
      }

      return {
        ...proof,
        witness: JSON.stringify({
          preimage: preimage,
          signatures: signatures,
        }),
      };
    });

    const witnessedToken: Token = {
      ...decodedToken,
      proofs: proofsWithWitness,
    };

    try {
      return this.receiveToken(witnessedToken);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Receives an HTLC token after the locktime has expired using refund keys.
   * Used when an HTLC times out and needs to be refunded.
   *
   * @param token - The HTLC token to refund
   * @param refundPrivateKeys - Private key(s) corresponding to the refund pubkeys
   * @returns Success status and proofs or error
   */
  async claimRefund(token: string | Token, refundPrivateKeys: string | string[]) {
    const decodedToken = typeof token === "string" ? getDecodedToken(token) : token;

    const proofsWithWitness: Proof[] = decodedToken.proofs.map((proof, index) => {
      // For SIG_ALL, only the first proof needs the witness
      if (index === 0) {
        const signatures: string[] = [];
        const keys = Array.isArray(refundPrivateKeys) ? refundPrivateKeys : [refundPrivateKeys];

        for (const privateKey of keys) {
          const signature = signP2PKSecret(proof.secret, privateKey);
          signatures.push(signature);
        }

        return {
          ...proof,
          witness: {
            signatures: signatures,
          },
        };
      }
      return proof;
    });

    const witnessedToken: Token = {
      ...decodedToken,
      proofs: proofsWithWitness,
    };

    try {
      return this.receiveToken(witnessedToken);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Sends an HTLC-locked token with full NUT-11 tag support.
   *
   * @param amount - The amount in sats to send
   * @param config - HTLC configuration object with all NUT-11 tags
   * @returns The sent token
   *
   * @example
   * ```ts
   * const token = await wallet.sendHTLC(100, {
   *   preimageHash: "023192200a0cfd3867e48eb63b03ff599c7e46c8f4e41146b2d281173ca6c50c54",
   *   sigflag: "SIG_ALL",
   *   pubkeys: ["02698c4e2b5f9534cd0687d87513c759790cf829aa5739184a3e3735471fbda904"],
   *   n_sigs: 1,
   *   locktime: 1689418329,
   *   refund: ["033281c37677ea273eb7183b783067f5244933ef78d8c3f15b1a77cb246099c26e"],
   *   n_sigs_refund: 1
   * });
   * ```
   */
  async sendHTLC(amount: number, config: HTLCConfig) {
    const outputConfig: OutputConfig = {
      send: {
        type: "factory",
        factory: (amount, keys) => {
          const tags: string[][] = [];

          // Add sigflag if specified (defaults to SIG_INPUTS if not specified)
          if (config.sigflag) {
            tags.push(["sigflag", config.sigflag]);
          }

          // Add pubkeys array if specified
          if (config.pubkeys && config.pubkeys.length > 0) {
            tags.push(["pubkeys", ...config.pubkeys]);
          }

          // Add n_sigs if specified (must be a string per NUT-11)
          if (config.n_sigs !== undefined) {
            tags.push(["n_sigs", String(config.n_sigs)]);
          }

          // Add locktime if specified (must be a string per NUT-11)
          if (config.locktime !== undefined) {
            tags.push(["locktime", String(config.locktime)]);
          }

          // Add refund pubkeys array if specified
          if (config.refund && config.refund.length > 0) {
            tags.push(["refund", ...config.refund]);
          }

          // Add n_sigs_refund if specified (must be a string per NUT-11)
          if (config.n_sigs_refund !== undefined) {
            tags.push(["n_sigs_refund", String(config.n_sigs_refund)]);
          }

          const htlcSecret: [string, { nonce: string; data: string; tags: string[][] }] = [
            "HTLC",
            {
              data: config.preimageHash,
              nonce: bytesToHex(randomBytes(32)),
              tags: tags,
            },
          ];

          const secretBytes = new TextEncoder().encode(JSON.stringify(htlcSecret));
          const { r, B_ } = blindMessage(secretBytes);
          const serializedBlindedMessage: SerializedBlindedMessage = {
            amount: amount,
            B_: B_.toHex(true),
            id: keys.id,
          };
          return new OutputData(serializedBlindedMessage, r, secretBytes);
        },
      },
    };

    const proofs = this.selectProofsToSend(amount);

    const result = await this.wallet.send(amount, proofs, undefined, outputConfig);

    if (result.keep && result.keep.length > 0) {
      this.db.saveProofs(result.keep);
    }

    const proof = result.send[0];
    const secret = JSON.parse(proof.secret);
    logger.debug("SIG_ALL HTLC secret:", secret);

    return result;
  }

  private selectProofsToSend(amount: number): Proof[] {
    const allProofs = this.db
      .getDb()
      .query<{ secret: string; C: string; id: string; amount: number; witness: string }, []>(
        "SELECT secret, C, id, amount, witness FROM proofs"
      )
      .all();
    const result = this.wallet.selectProofsToSend(allProofs, amount, true, false);
    if (!result) {
      throw new Error("Failed to select proofs to send");
    }

    this.db.removeProofs(result.send);

    return result.send;
  }

  /**
   * Creates P2PK blinded messages for an amount locked to a public key.
   * This generates blinded messages without requiring any input proofs.
   *
   * @param amount - The amount in sats to create blinded messages for
   * @param pubkey - The public key to lock the blinded messages to
   * @param customSplit - Optional custom denomination split (e.g., [1, 2, 4, 8])
   * @param label - Optional label for logging context (e.g., "Dealer fee", "Alice receive")
   * @returns Array of OutputDataLike objects containing blinded messages and secrets
   */
  createP2PKBlindedMessages(
    amount: number,
    pubkey: string,
    customSplit?: number[],
    label?: string
  ): OutputDataLike[] {
    const keyset = this.wallet.keyChain.getCheapestKeyset();

    const outputData = OutputData.createP2PKData({ pubkey }, amount, keyset, customSplit);
    const od = outputData[0];
    const secret = od.secret;
    const decodedSecret = new TextDecoder().decode(secret);
    const context = label ? `${label} P2PK secret` : "P2PK secret";
    logger.debug(`${context}:`, JSON.parse(decodedSecret));

    return outputData;
  }

  /**
   * Receives a SIG_ALL token by swapping it with specific blinded messages.
   * This is used when the token is spendable (has signatures + preimage) but we need
   * to swap it for specific outputs that will be unblinded by another party.
   *
   * @param token - The spendable HTLC token (with SIG_ALL signatures and preimage in witness)
   * @param blindedMessages - The specific blinded messages to use as outputs
   * @returns The blinded signatures from the mint (to be unblinded by the dealer)
   */
  async receiveSigAllToken(
    token: string | Token,
    blindedMessages: SerializedBlindedMessage[]
  ): Promise<{
    success: boolean;
    blindedSignatures?: { C_: string; id: string; amount: number }[];
    error?: string;
  }> {
    try {
      const decodedToken = typeof token === "string" ? getDecodedToken(token) : token;

      // Swap HTLC proofs (inputs) for blinded signatures on Alice's outputs
      const { signatures } = await this.wallet.mint.swap({
        inputs: decodedToken.proofs,
        outputs: blindedMessages,
      });

      return {
        success: true,
        blindedSignatures: signatures.map((sig) => ({
          C_: sig.C_,
          id: sig.id,
          amount: sig.amount,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Unblinds signatures and creates proofs from output data.
   * This is used by Alice to construct spendable proofs from the blinded signatures
   * returned by the gateway.
   *
   * @param outputData - The output data containing blinding factors and secrets
   * @param blindedSignatures - The blinded signatures from the mint
   * @returns The constructed proofs that can be saved and spent
   */
  unblindSignaturesAndCreateProofs(
    outputData: OutputDataLike[],
    blindedSignatures: { C_: string; id: string; amount: number }[]
  ): Proof[] {
    if (outputData.length !== blindedSignatures.length) {
      throw new Error(
        `Mismatch between output data (${outputData.length}) and blinded signatures (${blindedSignatures.length})`
      );
    }

    const proofs: Proof[] = [];
    for (let i = 0; i < outputData.length; i++) {
      const od = outputData[i];
      const sig = blindedSignatures[i];

      // Get the keyset for this signature
      const keyset = this.wallet.keyChain.getKeyset(sig.id);
      if (!keyset) {
        throw new Error(`Keyset not found for id: ${sig.id}`);
      }

      // Construct the proof using the output data's toProof method
      const proof = od.toProof(sig, keyset);
      proofs.push(proof);
    }

    return proofs;
  }

  async receiveProofsFromDealer(proofs: Proof[], privateKey: string) {
    // TODO: cashu-ts bug when pubkey is 32 bytes?
    const unlockedProofs = await this.wallet.receive(
      { proofs, mint: this.config.mintUrl, unit: "sat" },
      { privkey: privateKey }
    );

    this.db.saveProofs(unlockedProofs);
  }
}

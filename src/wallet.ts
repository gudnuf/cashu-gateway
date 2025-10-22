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
  type Proof,
  type SerializedBlindedMessage,
  type Token,
} from "@cashu/cashu-ts";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { NamedLogger } from "./logger";

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
    const logger = new NamedLogger(this.config.name, "wallet");

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

    logger.info(`Wallet initialized with mint: ${this.config.mintUrl}`);
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

  async receiveHTLCToken(token: string | Token, preimage: string) {
    const decodedToken = typeof token === "string" ? getDecodedToken(token) : token;

    // According to NUT-14, HTLC witness format is: { "preimage": <hex_str>, "signatures": [] }
    const htlcWitness = {
      preimage: preimage,
      signatures: [] as string[],
    };

    const proofsWithWitness: Proof[] = decodedToken.proofs.map((proof) => ({
      ...proof,
      witness: JSON.stringify(htlcWitness),
    }));

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

  async sendHTLC(amount: number, preimageHash: string, expiryUnix: number, refundPubkey?: string) {
    const outputConfig: OutputConfig = {
      send: {
        type: "factory",
        factory: (amount, keys) => {
          const htlcSecret: [string, { nonce: string; data: string; tags: string[][] }] = [
            "HTLC",
            {
              data: preimageHash,
              nonce: bytesToHex(randomBytes(32)),
              tags: [["locktime", String(expiryUnix)]],
            },
          ];
          if (refundPubkey) {
            htlcSecret[1].tags.push(["refund", refundPubkey]);
          }
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
}

import { Wallet as CashuWallet, type MintKeyset, type MintKeys } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { NamedLogger } from './logger';

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
	}

	getCachedMint(mintUrl: string): MintCache | null {
		const row = this.db
			.query<{ mint_url: string; unit: string; keysets: string; keys: string }, string>(
				'SELECT mint_url, unit, keysets, keys FROM mint_cache WHERE mint_url = ?'
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
			console.error('Failed to parse cached mint data:', error);
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

	getDb(): Database {
		return this.db;
	}
}

export class Wallet {
	private wallet: CashuWallet | null = null;
	private db: WalletDatabase;
	private config: WalletConfig;

	constructor(config: WalletConfig) {
		this.config = config;
		this.db = new WalletDatabase(config.db);
	}

	async initialize(): Promise<void> {
		const cachedMint = this.db.getCachedMint(this.config.mintUrl);
		const logger = new NamedLogger(this.config.name, 'wallet');

		if (cachedMint) {
			logger.debug(`Initializing wallet with cached mint data from: ${cachedMint.mintUrl}`);
			this.wallet = new CashuWallet(cachedMint.mintUrl, {
				unit: cachedMint.unit,
				keysets: cachedMint.keysets,
				keys: cachedMint.keys,
				logger
			});
		} else {
			logger.debug(`Initializing wallet with mint: ${this.config.mintUrl}`);
			this.wallet = new CashuWallet(this.config.mintUrl, { logger });
		}

		await this.wallet.loadMint();

		const cache = this.wallet.keyChain.getCache();
		this.db.saveMintCache(cache);

		logger.info(`Wallet initialized with mint: ${this.config.mintUrl}`);
	}

	getWallet(): CashuWallet {
		if (!this.wallet) {
			throw new Error('Wallet not initialized. Call initialize() first.');
		}
		return this.wallet;
	}

	getDb(): Database {
		return this.db.getDb();
	}

	close(): void {
		this.wallet = null;
	}
}


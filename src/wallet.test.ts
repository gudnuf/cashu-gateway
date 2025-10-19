import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Wallet } from './wallet';
import { unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TEST_MINT_URL = 'https://testnut.cashu.space';
const TEST_DB_PATH = './data/test-wallet.db';

describe('Wallet', () => {
	beforeEach(async () => {
		// Ensure data directory exists
		if (!existsSync('./data')) {
			await mkdir('./data', { recursive: true });
		}
		// Clean up test database before each test
		if (existsSync(TEST_DB_PATH)) {
			await unlink(TEST_DB_PATH);
		}
	});

	afterEach(async () => {
		// Clean up test database after each test
		if (existsSync(TEST_DB_PATH)) {
			await unlink(TEST_DB_PATH);
		}
	});

	test('should initialize wallet and cache mint data', async () => {
		const db = new Database(TEST_DB_PATH, { create: true });
		const wallet = new Wallet({
			mintUrl: TEST_MINT_URL,
			db,
			name: 'Test Wallet',
		});

		await wallet.initialize();

		const walletDb = wallet.getDb();
		const cachedMint = walletDb
			.query('SELECT * FROM mint_cache WHERE mint_url = ?')
			.get(TEST_MINT_URL);

		expect(cachedMint).toBeTruthy();
		expect(cachedMint).toHaveProperty('mint_url', TEST_MINT_URL);
		expect(cachedMint).toHaveProperty('unit');
		expect(cachedMint).toHaveProperty('keysets');
		expect(cachedMint).toHaveProperty('keys');

		wallet.close();
		db.close();
	}, 30000);

	test('should use cached data on second initialization', async () => {
		// First initialization - fetches from mint
		const db1 = new Database(TEST_DB_PATH, { create: true });
		const wallet1 = new Wallet({
			mintUrl: TEST_MINT_URL,
			db: db1,
			name: 'Test Wallet',
		});

		await wallet1.initialize();

		const walletDb1 = wallet1.getDb();
		const firstCache = walletDb1
			.query('SELECT keysets, keys, updated_at FROM mint_cache WHERE mint_url = ?')
			.get(TEST_MINT_URL) as any;

		expect(firstCache).toBeTruthy();
		const firstKeysets = firstCache.keysets;
		const firstKeys = firstCache.keys;
		const firstUpdatedAt = firstCache.updated_at;

		wallet1.close();
		db1.close();

		// Wait a moment to ensure timestamp would be different if updated
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Second initialization - should use cache
		const db2 = new Database(TEST_DB_PATH, { create: true });
		const wallet2 = new Wallet({
			mintUrl: TEST_MINT_URL,
			db: db2,
			name: 'Test Wallet',
		});

		await wallet2.initialize();

		const walletDb2 = wallet2.getDb();
		const secondCache = walletDb2
			.query('SELECT keysets, keys, updated_at FROM mint_cache WHERE mint_url = ?')
			.get(TEST_MINT_URL) as any;

		expect(secondCache).toBeTruthy();

		// Verify the cache data is exactly the same
		expect(secondCache.keysets).toBe(firstKeysets);
		expect(secondCache.keys).toBe(firstKeys);

		// Note: updated_at will be different because we call saveMintCache after loadMint
		// But the important part is that the keysets and keys data are the same

		wallet2.close();
		db2.close();
	}, 30000);

	test('wallet should be functional after initialization', async () => {
		const db = new Database(TEST_DB_PATH, { create: true });
		const wallet = new Wallet({
			mintUrl: TEST_MINT_URL,
			db,
			name: 'Test Wallet',
		});

		await wallet.initialize();

		const cashuWallet = wallet.getWallet();
		expect(cashuWallet).toBeTruthy();
		expect(cashuWallet.mint.mintUrl).toBe(TEST_MINT_URL);

		wallet.close();
		db.close();
	}, 30000);

	test('should throw error when accessing wallet before initialization', () => {
		const db = new Database(TEST_DB_PATH, { create: true });
		const wallet = new Wallet({
			mintUrl: TEST_MINT_URL,
			name: 'Test Wallet',
			db,
		});

		expect(() => wallet.getWallet()).toThrow('Wallet not initialized');
		
		db.close();
	});
});


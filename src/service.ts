import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { BaseCommandContext, CommandHandler, CommandRegistry } from "./cli";
import {
  createBaseCommands,
  createCliServer,
  createCommandHandlerFromRegistry,
  mergeCommandRegistries,
} from "./cli";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
import { NostrClient } from "./nostr";
import { Wallet } from "./wallet";

export type ServiceConfig = {
  name: string;
  mintUrl: string;
  relayUrl: string;
  mnemonic: string;
  dbPath: string;
  port: number;
};

export type ServiceContext = {
  wallet: Wallet;
  keys: Keys;
  logger: NamedLogger;
  nostr: NostrClient;
  db: Database;
};

/**
 * Initialize common service components (database, keys, wallet, nostr)
 */
export async function initializeService(config: ServiceConfig): Promise<ServiceContext> {
  const logger = new NamedLogger(config.name);

  // Setup database
  mkdirSync("./data", { recursive: true });
  const db = new Database(config.dbPath, { create: true });

  // Setup keys
  const keys = new Keys(config.mnemonic);
  logger.info(`Public key: ${keys.getPublicKeyHex()}`);

  // Setup wallet
  const wallet = new Wallet({
    mintUrl: config.mintUrl,
    db,
    name: config.name,
  });
  await wallet.initialize();

  // Setup nostr client
  const nostr = new NostrClient(keys, config.relayUrl, logger);

  return { wallet, keys, logger, nostr, db };
}

export type CliServerConfig<TContext extends BaseCommandContext> = {
  port: number;
  logger: NamedLogger;
  baseContext: BaseCommandContext;
  customCommands?: CommandRegistry<TContext>;
};

/**
 * Start CLI server with base commands and optional custom commands
 */
export function startCliServer<TContext extends BaseCommandContext>(
  config: CliServerConfig<TContext>
): { server: ReturnType<typeof Bun.serve>; handler: CommandHandler } {
  const baseCommands = createBaseCommands();
  const allCommands = config.customCommands
    ? mergeCommandRegistries(baseCommands, config.customCommands)
    : baseCommands;

  const commandContext = {
    ...config.baseContext,
    ...(config.customCommands ? {} : {}),
  } as TContext;

  const commandHandler = createCommandHandlerFromRegistry(allCommands, commandContext);
  const server = createCliServer(config.port, config.logger, commandHandler);

  return { server, handler: commandHandler };
}

export type ShutdownConfig = {
  logger: NamedLogger;
  server: ReturnType<typeof Bun.serve>;
  wallet: Wallet;
  db: Database;
};

/**
 * Setup graceful shutdown handler
 */
export function setupShutdownHandler(config: ShutdownConfig): void {
  process.on("SIGINT", () => {
    config.logger.info("Shutting down");
    config.server.stop();
    config.wallet.close();
    config.db.close();
    process.exit(0);
  });
}

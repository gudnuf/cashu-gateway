import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { BaseCommandContext, CommandHandler, CommandRegistry } from "../cli";
import {
  createBaseCommands,
  createCliServer,
  createCommandHandlerFromRegistry,
  mergeCommandRegistries,
} from "../cli";
import { NostrClient } from "../nostr";
import { Wallet } from "../wallet";
import { Keys } from "./keys";
import { logger } from "./logger";

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
  nostr: NostrClient;
  db: Database;
};

/**
 * Initialize common service components (database, keys, wallet, nostr)
 */
export async function initializeService(config: ServiceConfig): Promise<ServiceContext> {
  logger.setServiceName(config.name.toLowerCase());

  mkdirSync("./data", { recursive: true });
  const db = new Database(config.dbPath, { create: true });

  const keys = new Keys(config.mnemonic);

  const wallet = new Wallet({
    mintUrl: config.mintUrl,
    db,
    name: config.name,
  });
  await wallet.initialize();

  const nostr = new NostrClient(keys, config.relayUrl);

  return { wallet, keys, nostr, db };
}

export type CliServerConfig<TContext extends BaseCommandContext> = {
  port: number;
  baseContext: BaseCommandContext;
  customCommands?: CommandRegistry<TContext>;
};

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
  const server = createCliServer(config.port, commandHandler);

  logger.info(`Server started on port ${config.port}`);

  return { server, handler: commandHandler };
}

export type ShutdownConfig = {
  serviceName: string;
  server: ReturnType<typeof Bun.serve>;
  wallet: Wallet;
  db: Database;
  cleanup?: () => void;
};

export function setupShutdownHandler(config: ShutdownConfig): void {
  process.on("SIGINT", () => {
    logger.info("Shutting down");
    config.cleanup?.();
    config.server.stop();
    config.wallet.close();
    config.db.close();
    process.exit(0);
  });
}

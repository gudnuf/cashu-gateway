import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import {
  type BaseCommandContext,
  createBaseCommands,
  createCliServer,
  createCommandHandlerFromRegistry,
} from "./cli";
import { getDealerConfig } from "./config";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
import { NostrClient } from "./nostr";
import type { Request, Response } from "./types";
import { createResponse, isRequestForMethod } from "./types";
import { Wallet } from "./wallet";

const logger = new NamedLogger("Dealer");

const config = getDealerConfig();

const dealerKeys = new Keys(config.mnemonic);
logger.info(`Public key: ${dealerKeys.getPublicKeyHex()}`);

mkdirSync("./data", { recursive: true });

const db = new Database("./data/dealer.db", { create: true });

const dealerWallet = new Wallet({
  mintUrl: config.mintUrl,
  db,
  name: "Dealer",
});

await dealerWallet.initialize();

const nostr = new NostrClient(dealerKeys, config.relayUrl, logger);

const baseCommands = createBaseCommands();
const commandContext: BaseCommandContext = {
  wallet: dealerWallet,
  keys: dealerKeys,
  logger,
};
const commandHandler = createCommandHandlerFromRegistry(baseCommands, commandContext);

const PORT = 3002;
const server = createCliServer(PORT, logger, commandHandler);

async function handleRequest(
  _senderPubkey: string,
  request: Request
): Promise<Response | undefined> {
  if (isRequestForMethod(request, "info")) {
    return createResponse<"info">({
      type: "dealer",
      name: "Dealer",
      timestamp: Date.now(),
    });
  }

  return {
    error: {
      code: -32601,
      message: `Method not found: ${request.method}`,
    },
  };
}

await nostr.listen(handleRequest);
logger.info("Ready");

process.on("SIGINT", () => {
  logger.info("Shutting down");
  server.stop();
  dealerWallet.close();
  db.close();
  process.exit(0);
});

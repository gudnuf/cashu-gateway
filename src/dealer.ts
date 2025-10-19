import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
import { NostrClient } from "./nostr";
import type { Request, Response } from "./types";
import { Wallet } from "./wallet";

const logger = new NamedLogger("Dealer");

const mnemonic = process.env.DEALER_MNEMONIC;
if (!mnemonic) {
  throw new Error("DEALER_MNEMONIC environment variable is required");
}

const mintUrl = process.env.MINT_URL;
if (!mintUrl) {
  throw new Error("MINT_URL environment variable is required");
}

const relayUrl = process.env.RELAY_URL;
if (!relayUrl) {
  throw new Error("RELAY_URL environment variable is required");
}

const dealerKeys = new Keys(mnemonic);
logger.info(`Public key: ${dealerKeys.getPublicKeyHex()}`);

mkdirSync("./data", { recursive: true });

const db = new Database("./data/dealer.db", { create: true });

const dealerWallet = new Wallet({
  mintUrl,
  db,
  name: "Dealer",
});

await dealerWallet.initialize();

const nostr = new NostrClient(dealerKeys, relayUrl, logger);

async function handleRequest(
  _senderPubkey: string,
  request: Request
): Promise<Response | undefined> {
  switch (request.method) {
    case "info":
      return {
        result: {
          type: "dealer",
          name: "Dealer",
          timestamp: Date.now(),
        },
      };
    default:
      return {
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
  }
}

await nostr.listen(handleRequest);
logger.info("Ready");

process.on("SIGINT", () => {
  logger.info("Shutting down");
  dealerWallet.close();
  db.close();
  process.exit(0);
});

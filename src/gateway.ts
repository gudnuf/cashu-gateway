import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
import { NostrClient } from "./nostr";
import type { Request, Response } from "./types";
import { Wallet } from "./wallet";

const logger = new NamedLogger("Gateway");

const mnemonic = process.env.GATEWAY_MNEMONIC;
if (!mnemonic) {
  throw new Error("GATEWAY_MNEMONIC environment variable is required");
}

const mintUrl = process.env.MINT_URL;
if (!mintUrl) {
  throw new Error("MINT_URL environment variable is required");
}

const relayUrl = process.env.RELAY_URL;
if (!relayUrl) {
  throw new Error("RELAY_URL environment variable is required");
}

const gatewayKeys = new Keys(mnemonic);
logger.info(`Public key: ${gatewayKeys.getPublicKeyHex()}`);

mkdirSync("./data", { recursive: true });

const db = new Database("./data/gateway.db", { create: true });

const gatewayWallet = new Wallet({
  mintUrl,
  db,
  name: "Gateway",
});

await gatewayWallet.initialize();

const nostr = new NostrClient(gatewayKeys, relayUrl, logger);

async function handleRequest(
  _senderPubkey: string,
  request: Request
): Promise<Response | undefined> {
  switch (request.method) {
    case "info":
      return {
        result: {
          type: "gateway",
          name: "Gateway",
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
  gatewayWallet.close();
  db.close();
  process.exit(0);
});

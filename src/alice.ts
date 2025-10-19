import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { type CommandResponse, createCliServer } from "./cli";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
import { NostrClient } from "./nostr";
import type { InfoRequest } from "./types";
import { Wallet } from "./wallet";

const logger = new NamedLogger("Alice");

const mnemonic = process.env.ALICE_MNEMONIC;
if (!mnemonic) {
  throw new Error("ALICE_MNEMONIC environment variable is required");
}

const mintUrl = process.env.MINT_URL;
if (!mintUrl) {
  throw new Error("MINT_URL environment variable is required");
}

const relayUrl = process.env.RELAY_URL;
if (!relayUrl) {
  throw new Error("RELAY_URL environment variable is required");
}

const aliceKeys = new Keys(mnemonic);
logger.info(`Public key: ${aliceKeys.getPublicKeyHex()}`);

mkdirSync("./data", { recursive: true });

const db = new Database("./data/alice.db", { create: true });

const aliceWallet = new Wallet({
  mintUrl,
  db,
  name: "Alice",
});

await aliceWallet.initialize();

const nostr = new NostrClient(aliceKeys, relayUrl, logger);

async function handleCommand(command: string, args: string[]): Promise<CommandResponse> {
  switch (command) {
    case "receive":
      return {
        success: true,
        message: "Command received",
      };
    case "pk":
      return {
        success: true,
        message: "Public key retrieved",
        data: { publicKey: aliceKeys.getPublicKeyHex() },
      };
    case "info": {
      const publicKey = args[0];
      if (!publicKey || publicKey.length !== 64) {
        return {
          success: false,
          error: "Usage: info <public_key>",
        };
      }

      try {
        const request: InfoRequest = { method: "info" };
        const response = await nostr.requestAndWaitForResponse(publicKey, request);

        if (response.error) {
          return {
            success: false,
            error: response.error.message,
          };
        }

        return {
          success: true,
          message: "Info received",
          data: response.result,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
    default:
      return {
        success: false,
        error: `Unknown command: ${command}`,
      };
  }
}

const PORT = 3001;
const server = createCliServer(PORT, logger, handleCommand);

process.on("SIGINT", () => {
  logger.info("Shutting down");
  server.stop();
  aliceWallet.close();
  db.close();
  process.exit(0);
});

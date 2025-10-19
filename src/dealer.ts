import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { type CommandResponse, createCliServer } from "./cli";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
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

async function handleCommand(command: string, _args: string[]): Promise<CommandResponse> {
  switch (command) {
    default:
      return {
        success: false,
        error: `Unknown command: ${command}`,
      };
  }
}

const PORT = 3002;
const server = createCliServer(PORT, logger, handleCommand);

process.on("SIGINT", () => {
  logger.info("Shutting down");
  server.stop();
  dealerWallet.close();
  db.close();
  process.exit(0);
});

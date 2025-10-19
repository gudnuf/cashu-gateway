import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { type CommandResponse, createCliServer } from "./cli";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
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

async function handleCommand(command: string, _args: string[]): Promise<CommandResponse> {
  switch (command) {
    case "receive":
      return {
        success: true,
        message: "Command received",
      };
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

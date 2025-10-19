import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { type CommandResponse, createCliServer } from "./cli";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
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

async function handleCommand(command: string, _args: string[]): Promise<CommandResponse> {
  switch (command) {
    default:
      return {
        success: false,
        error: `Unknown command: ${command}`,
      };
  }
}

const PORT = 3003;
const server = createCliServer(PORT, logger, handleCommand);

process.on("SIGINT", () => {
  logger.info("Shutting down");
  server.stop();
  gatewayWallet.close();
  db.close();
  process.exit(0);
});

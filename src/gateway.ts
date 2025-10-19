import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Keys } from "./keys";
import { NamedLogger } from "./logger";
import { Wallet } from "./wallet";

const logger = new NamedLogger("Gateway");

const mnemonic = process.env.GATEWAY_MNEMONIC;
if (!mnemonic) {
  throw new Error("GATEWAY_MNEMONIC environment variable is required");
}

const gatewayKeys = new Keys(mnemonic);
logger.info(`Public key: ${gatewayKeys.getPublicKeyHex()}`);

mkdirSync("./data", { recursive: true });

const db = new Database("./data/gateway.db", { create: true });

const gatewayWallet = new Wallet({
  mintUrl: "https://testnut.cashu.space",
  db,
  name: "Gateway",
});

await gatewayWallet.initialize();

process.on("SIGINT", () => {
  logger.info("Shutting down");
  gatewayWallet.close();
  db.close();
  process.exit(0);
});

setInterval(() => {}, 1000);

#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Keys } from "../src/keys";

const envPath = ".env";
const printOnly = process.argv.includes("--print");
const force = process.argv.includes("--force");

const alice = Keys.generateMnemonic(128);
const dealer = Keys.generateMnemonic(128);
const gateway = Keys.generateMnemonic(128);

const MINT_URL = "http://localhost:8085";
const RELAY_URL = "ws://localhost:4869";
const NWC_URI = "nostr+walletconnect://relay.example.com?secret=CHANGE_ME&pubkey=CHANGE_ME";

if (printOnly) {
  console.log(`ALICE_MNEMONIC="${alice}"`);
  console.log(`DEALER_MNEMONIC="${dealer}"`);
  console.log(`GATEWAY_MNEMONIC="${gateway}"`);
  console.log();
  console.log(`MINT_URL="${MINT_URL}"`);
  console.log(`RELAY_URL="${RELAY_URL}"`);
  console.log(`NWC_URI="${NWC_URI}"`);
  console.log();
  console.log(`LOG_LEVEL="info"`);
  console.log();
  console.log(`# ALICE_LOG_LEVEL="debug"`);
  console.log(`# ALICE_WALLET_LOG_LEVEL="off"`);
  console.log(`# GATEWAY_LOG_LEVEL="debug"`);
  console.log(`# GATEWAY_WALLET_LOG_LEVEL="off"`);
  console.log(`# DEALER_LOG_LEVEL="debug"`);
  console.log(`# DEALER_WALLET_LOG_LEVEL="off"`);
  process.exit(0);
}

if (existsSync(envPath) && !force) {
  console.error(".env exists, use --force to overwrite");
  process.exit(1);
}

const content = `ALICE_MNEMONIC="${alice}"
DEALER_MNEMONIC="${dealer}"
GATEWAY_MNEMONIC="${gateway}"

MINT_URL="${MINT_URL}"
RELAY_URL="${RELAY_URL}"
NWC_URI="${NWC_URI}"

LOG_LEVEL="info"

# ALICE_LOG_LEVEL="debug"
# ALICE_WALLET_LOG_LEVEL="off"
# GATEWAY_LOG_LEVEL="debug"
# GATEWAY_WALLET_LOG_LEVEL="off"
# DEALER_LOG_LEVEL="debug"
# DEALER_WALLET_LOG_LEVEL="off"
`;

await writeFile(envPath, content, "utf-8");

console.log("\x1b[32m✓ Environment variables written to .env\x1b[0m");

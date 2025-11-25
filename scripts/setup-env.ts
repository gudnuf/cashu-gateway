#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Keys } from "../src/lib/keys";

const printOnly = process.argv.includes("--print");
const force = process.argv.includes("--force");

const MINT_URL = "http://localhost:8085";
const RELAY_URL = "ws://localhost:4869";
const NWC_URI = "nostr+walletconnect://relay.example.com?secret=CHANGE_ME&pubkey=CHANGE_ME";

function generateEnv() {
  return `MINT_URL="${MINT_URL}"
RELAY_URL="${RELAY_URL}"

ALICE_MNEMONIC="${Keys.generateMnemonic(128)}"
DEALER_MNEMONIC="${Keys.generateMnemonic(128)}"
GATEWAY_MNEMONIC="${Keys.generateMnemonic(128)}"
NWC_URI="${NWC_URI}"
`;
}

if (printOnly) {
  console.log(generateEnv());
  process.exit(0);
}

if (existsSync(".env") && !force) {
  console.error(".env exists, use --force to overwrite");
  process.exit(1);
}

await writeFile(".env", generateEnv(), "utf-8");
console.log("\x1b[32m✓ .env\x1b[0m");

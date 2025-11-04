#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Keys } from "../src/lib/keys";

const printOnly = process.argv.includes("--print");
const force = process.argv.includes("--force");

// Get service name from arguments (alice, dealer, gateway, or all)
const args = process.argv.filter((arg) => !arg.startsWith("--") && !arg.endsWith("setup-env.ts"));
const service = args[0] || "all";

const MINT_URL = "http://localhost:8085";
const RELAY_URL = "ws://localhost:4869";
const NWC_URI = "nostr+walletconnect://relay.example.com?secret=CHANGE_ME&pubkey=CHANGE_ME";

function showHelp() {
  console.log(`Usage: bun run setup-env [SERVICE] [OPTIONS]

SERVICE:
  alice      Generate alice.env
  dealer     Generate dealer.env
  gateway    Generate gateway.env
  all        Generate all service env files (default)

OPTIONS:
  --print    Print to stdout instead of writing files
  --force    Overwrite existing files
  --help     Show this help message

Examples:
  bun run setup-env alice           # Create alice.env
  bun run setup-env gateway --force # Overwrite gateway.env
  bun run setup-env --print         # Print all configs
`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  showHelp();
  process.exit(0);
}

if (!["alice", "dealer", "gateway", "all"].includes(service)) {
  console.error(`Unknown service: ${service}`);
  showHelp();
  process.exit(1);
}

const alice = Keys.generateMnemonic(128);
const dealer = Keys.generateMnemonic(128);
const gateway = Keys.generateMnemonic(128);

function generateAliceEnv() {
  return `# Alice Service Configuration
ALICE_MNEMONIC="${alice}"
MINT_URL="${MINT_URL}"
RELAY_URL="${RELAY_URL}"
LOG_LEVEL="info"

# Optional: Override log levels
# ALICE_LOG_LEVEL="debug"
# ALICE_WALLET_LOG_LEVEL="off"
`;
}

function generateDealerEnv() {
  return `# Dealer Service Configuration
DEALER_MNEMONIC="${dealer}"
MINT_URL="${MINT_URL}"
RELAY_URL="${RELAY_URL}"
LOG_LEVEL="info"

# Optional: Override log levels
# DEALER_LOG_LEVEL="debug"
# DEALER_WALLET_LOG_LEVEL="off"
`;
}

function generateGatewayEnv() {
  return `# Gateway Service Configuration
GATEWAY_MNEMONIC="${gateway}"
MINT_URL="${MINT_URL}"
RELAY_URL="${RELAY_URL}"
NWC_URI="${NWC_URI}"
LOG_LEVEL="info"

# Optional: Override log levels
# GATEWAY_LOG_LEVEL="debug"
# GATEWAY_WALLET_LOG_LEVEL="off"
`;
}

if (printOnly) {
  if (service === "alice" || service === "all") {
    console.log("=== alice.env ===");
    console.log(generateAliceEnv());
  }
  if (service === "dealer" || service === "all") {
    console.log("=== dealer.env ===");
    console.log(generateDealerEnv());
  }
  if (service === "gateway" || service === "all") {
    console.log("=== gateway.env ===");
    console.log(generateGatewayEnv());
  }
  process.exit(0);
}

async function writeEnvFile(filename: string, content: string) {
  if (existsSync(filename) && !force) {
    console.error(`${filename} exists, use --force to overwrite`);
    return false;
  }
  await writeFile(filename, content, "utf-8");
  console.log(`\x1b[32m✓ Environment variables written to ${filename}\x1b[0m`);
  return true;
}

let success = true;

if (service === "alice" || service === "all") {
  success = (await writeEnvFile("alice.env", generateAliceEnv())) && success;
}

if (service === "dealer" || service === "all") {
  success = (await writeEnvFile("dealer.env", generateDealerEnv())) && success;
}

if (service === "gateway" || service === "all") {
  success = (await writeEnvFile("gateway.env", generateGatewayEnv())) && success;
}

if (!success) {
  process.exit(1);
}

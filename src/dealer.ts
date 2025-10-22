import type { BaseCommandContext } from "./cli";
import { getDealerConfig } from "./config";
import { initializeService, setupShutdownHandler, startCliServer } from "./service";
import type { Request, Response } from "./types";
import { createResponse, isRequestForMethod } from "./types";

// ============================================================================
// Dealer Service - Token Distribution Service
// ============================================================================
// The Dealer can distribute Cashu tokens and handle other dealer-specific
// protocol operations. Currently implements basic info endpoint.

const config = getDealerConfig();

const { wallet, keys, logger, nostr, db } = await initializeService({
  name: "Dealer",
  mintUrl: config.mintUrl,
  relayUrl: config.relayUrl,
  mnemonic: config.mnemonic,
  dbPath: "./data/dealer.db",
  port: 3002,
});

// Setup CLI server with base commands only (no custom commands yet)
const commandContext: BaseCommandContext = {
  wallet,
  keys,
  logger,
};

const { server } = startCliServer({
  port: 3002,
  logger,
  baseContext: commandContext,
});

// ============================================================================
// Dealer Protocol Handler
// ============================================================================

async function handleRequest(
  _senderPubkey: string,
  request: Request
): Promise<Response | undefined> {
  if (isRequestForMethod(request, "info")) {
    return createResponse<"info">({
      type: "dealer",
      name: "Dealer",
      timestamp: Date.now(),
    });
  }

  return {
    error: {
      code: -32601,
      message: `Method not found: ${request.method}`,
    },
  };
}

await nostr.listen(handleRequest);
logger.info("Ready");

setupShutdownHandler({ logger, server, wallet, db });

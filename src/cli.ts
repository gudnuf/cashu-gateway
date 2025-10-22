#!/usr/bin/env bun

import { getDecodedToken } from "@cashu/cashu-ts";
import type { Keys } from "./keys";
import type { NamedLogger } from "./logger";
import type { Wallet } from "./wallet";

export type ServiceName = "alice" | "dealer" | "gateway";

export type CommandRequest = {
  command: string;
  args: string[];
};

export type CommandResponse = {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
};

export type ArgType = "string" | "number" | "hex64" | "token" | "bolt11";

export type ArgumentDef = {
  name: string;
  type: ArgType;
  description: string;
  optional?: boolean;
};

export type CommandDef<TContext = unknown> = {
  description: string;
  args: ArgumentDef[];
  handler: (context: TContext, parsedArgs: Record<string, unknown>) => Promise<CommandResponse>;
};

export type BaseCommandContext = {
  wallet: Wallet;
  keys: Keys;
  logger: NamedLogger;
};

export type CommandRegistry<TContext = unknown> = Map<string, CommandDef<TContext>>;

export type CommandHandler = (command: string, args: string[]) => Promise<CommandResponse>;

const SERVICE_PORTS: Record<ServiceName, number> = {
  alice: 3001,
  dealer: 3002,
  gateway: 3003,
};

const SERVICE_COLORS: Record<ServiceName, string> = {
  alice: "\x1b[36m", // Cyan
  dealer: "\x1b[35m", // Magenta
  gateway: "\x1b[33m", // Yellow
};

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function parseArgument(
  value: string,
  argDef: ArgumentDef
): { success: boolean; value?: unknown; error?: string } {
  switch (argDef.type) {
    case "string":
      return { success: true, value };

    case "number": {
      const num = Number(value);
      if (Number.isNaN(num) || num <= 0) {
        return { success: false, error: `${argDef.name} must be a positive number` };
      }
      return { success: true, value: num };
    }

    case "hex64":
      if (value.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(value)) {
        return { success: false, error: `${argDef.name} must be a 64-character hex string` };
      }
      return { success: true, value };

    case "token":
      try {
        getDecodedToken(value);
        return { success: true, value };
      } catch {
        return { success: false, error: `${argDef.name} must be a valid Cashu token` };
      }
    case "bolt11":
      if (!value.toLowerCase().startsWith("ln")) {
        return { success: false, error: `${argDef.name} must be a valid BOLT11 invoice` };
      }
      return { success: true, value };

    default:
      return { success: false, error: `Unknown argument type: ${argDef.type}` };
  }
}

function parseArguments<TContext>(
  args: string[],
  commandDef: CommandDef<TContext>
): { success: boolean; parsed?: Record<string, unknown>; error?: string } {
  const parsed: Record<string, unknown> = {};
  const requiredArgs = commandDef.args.filter((arg) => !arg.optional);

  // Check if we have enough arguments
  if (args.length < requiredArgs.length) {
    const usage = commandDef.args
      .map((arg) => (arg.optional ? `[${arg.name}]` : `<${arg.name}>`))
      .join(" ");
    return {
      success: false,
      error: `Missing required arguments. Usage: ${usage}`,
    };
  }

  // Parse each argument
  for (let i = 0; i < commandDef.args.length; i++) {
    const argDef = commandDef.args[i];
    const argValue = args[i];

    // Skip optional arguments that weren't provided
    if (!argValue && argDef.optional) {
      continue;
    }

    const result = parseArgument(argValue, argDef);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    parsed[argDef.name] = result.value;
  }

  return { success: true, parsed };
}

export function createCommandHandlerFromRegistry<TContext>(
  registry: CommandRegistry<TContext>,
  context: TContext
): CommandHandler {
  return async (command: string, args: string[]): Promise<CommandResponse> => {
    const commandDef = registry.get(command);

    if (!commandDef) {
      const availableCommands = Array.from(registry.keys()).join(", ");
      return {
        success: false,
        error: `Unknown command: ${command}. Available commands: ${availableCommands}`,
      };
    }

    const parseResult = parseArguments(args, commandDef);
    if (!parseResult.success) {
      return {
        success: false,
        error: parseResult.error,
      };
    }

    try {
      const parsed = parseResult.parsed ?? {};
      return await commandDef.handler(context, parsed);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  };
}

export function createBaseCommands(): CommandRegistry<BaseCommandContext> {
  const commands: CommandRegistry<BaseCommandContext> = new Map();

  // balance command
  commands.set("balance", {
    description: "Get wallet balance",
    args: [],
    handler: async (context) => {
      const balance = context.wallet.getBalance();
      return {
        success: true,
        message: "Balance retrieved",
        data: { balance },
      };
    },
  });

  commands.set("receive", {
    description: "Receive a Cashu token",
    args: [
      {
        name: "token",
        type: "token",
        description: "Cashu token to receive",
      },
    ],
    handler: async (context, args) => {
      await context.wallet.receiveToken(args.token as string);
      const balance = context.wallet.getBalance();
      return {
        success: true,
        message: "Token received successfully",
        data: { balance },
      };
    },
  });

  commands.set("pk", {
    description: "Get public key",
    args: [],
    handler: async (context) => {
      return {
        success: true,
        message: "Public key retrieved",
        data: { publicKey: context.keys.getPublicKeyHex() },
      };
    },
  });

  return commands;
}

export function mergeCommandRegistries<TContext>(
  ...registries: CommandRegistry<TContext>[]
): CommandRegistry<TContext> {
  const merged: CommandRegistry<TContext> = new Map();

  for (const registry of registries) {
    for (const [command, def] of registry.entries()) {
      merged.set(command, def);
    }
  }

  return merged;
}

/**
 * Creates a CLI command server that listens for commands over HTTP
 * @param port - Port to listen on
 * @param logger - Logger instance for the service
 * @param commandHandler - Function that handles command execution
 * @returns Bun server instance
 */
export function createCliServer(port: number, logger: NamedLogger, commandHandler: CommandHandler) {
  const server = Bun.serve({
    port,
    async fetch(req) {
      try {
        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/command") {
          const body = (await req.json()) as CommandRequest;
          const { command, args } = body;

          logger.debug(`Received command: ${command} with args: ${args}`);

          const result = await commandHandler(command, args);

          if (result.success) {
            return Response.json(result);
          }
          return Response.json(result, { status: 400 });
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      } catch (error) {
        logger.error(`Error handling request: ${error}`);
        return Response.json(
          {
            success: false,
            error: String(error),
          } satisfies CommandResponse,
          { status: 500 }
        );
      }
    },
  });

  logger.info(`Command server listening on port ${port}`);

  return server;
}

async function sendCommand(service: ServiceName, command: string, args: string[] = []) {
  const port = SERVICE_PORTS[service];
  const url = `http://localhost:${port}/command`;
  const serviceColor = SERVICE_COLORS[service];

  try {
    const requestBody: CommandRequest = { command, args };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const data = (await response.json()) as CommandResponse;

    if (response.ok && data.success) {
      const serviceName = `${serviceColor}${service}${COLORS.reset}`;
      const checkmark = `${COLORS.green}✓${COLORS.reset}`;
      console.log(`${checkmark} ${serviceName} ${COLORS.gray}→${COLORS.reset} ${data.message}`);

      if (data.data) {
        console.log(`${COLORS.gray}╭─ Response Data${COLORS.reset}`);
        const dataStr = JSON.stringify(data.data, null, 2);
        for (const line of dataStr.split("\n")) {
          console.log(`${COLORS.gray}│${COLORS.reset} ${line}`);
        }
        console.log(`${COLORS.gray}╰─${COLORS.reset}`);
      }
    } else {
      const serviceName = `${serviceColor}${service}${COLORS.reset}`;
      const cross = `${COLORS.red}✗${COLORS.reset}`;
      console.error(
        `${cross} ${serviceName} ${COLORS.gray}→${COLORS.reset} ${COLORS.red}${data.error || "Unknown error"}${COLORS.reset}`
      );
      process.exit(1);
    }
  } catch (error) {
    const serviceName = `${serviceColor}${service}${COLORS.reset}`;
    const cross = `${COLORS.red}✗${COLORS.reset}`;
    console.error(
      `${cross} ${serviceName} ${COLORS.gray}→${COLORS.reset} ${COLORS.red}Failed to connect on port ${port}${COLORS.reset}`
    );
    console.error(`  ${COLORS.gray}Is the service running?${COLORS.reset}`);
    console.error(`  ${COLORS.gray}Error: ${error}${COLORS.reset}`);
    process.exit(1);
  }
}

function showUsage() {
  console.log(`
${COLORS.bold}Usage:${COLORS.reset} bun cli <service> <command> [args...]

${COLORS.bold}Services:${COLORS.reset}
  ${SERVICE_COLORS.alice}alice${COLORS.reset}     - Alice service (port 3001)
  ${SERVICE_COLORS.dealer}dealer${COLORS.reset}    - Dealer service (port 3002)
  ${SERVICE_COLORS.gateway}gateway${COLORS.reset}   - Gateway service (port 3003)

${COLORS.bold}Examples:${COLORS.reset}
  ${COLORS.gray}$${COLORS.reset} bun cli ${SERVICE_COLORS.alice}alice${COLORS.reset} receive
  ${COLORS.gray}$${COLORS.reset} bun cli ${SERVICE_COLORS.dealer}dealer${COLORS.reset} <command>
  ${COLORS.gray}$${COLORS.reset} bun cli ${SERVICE_COLORS.gateway}gateway${COLORS.reset} <command>
`);
  process.exit(1);
}

// Only run CLI client code if this file is executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    showUsage();
  }

  const service = args[0] as ServiceName;
  const command = args[1];
  const commandArgs = args.slice(2);

  if (!SERVICE_PORTS[service]) {
    const cross = `${COLORS.red}✗${COLORS.reset}`;
    console.error(`${cross} ${COLORS.red}Unknown service:${COLORS.reset} ${service}\n`);
    showUsage();
  }

  await sendCommand(service, command, commandArgs);
}

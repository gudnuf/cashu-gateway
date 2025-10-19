#!/usr/bin/env bun

import type { NamedLogger } from "./logger";

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

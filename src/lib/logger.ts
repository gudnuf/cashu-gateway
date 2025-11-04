import type { Logger, LogLevel } from "@cashu/cashu-ts";

type LogLevelWithOff = LogLevel | "off";

const LOG_LEVELS: Record<LogLevelWithOff, number> = {
  off: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  error: "\x1b[31m", // Red
  warn: "\x1b[93m", // Bright Yellow
  info: "\x1b[32m", // Green
  debug: "\x1b[34m", // Blue
  trace: "\x1b[90m", // Gray
};

const NAME_COLORS: Record<string, string> = {
  alice: "\x1b[36m", // Cyan
  gateway: "\x1b[33m", // Yellow
  dealer: "\x1b[35m", // Magenta
  cli: "\x1b[32m", // Green
  nostr: "\x1b[34m", // Blue
  "proof-state-subscription-manager": "\x1b[95m", // Bright Magenta
  wallet: "\x1b[36m", // Cyan
  service: "\x1b[33m", // Yellow
};

const RESET = "\x1b[0m";

function parseLogLevel(level: string | undefined, fallback: LogLevelWithOff): LogLevelWithOff {
  if (!level) return fallback;
  const normalized = level.toLowerCase();
  return (normalized in LOG_LEVELS ? normalized : fallback) as LogLevelWithOff;
}

function getLogLevel(moduleName: string): LogLevelWithOff {
  const envKey = `${moduleName.toUpperCase().replace(/-/g, "_")}_LOG_LEVEL`;
  const specificLevel = process.env[envKey];
  const globalLevel = process.env.LOG_LEVEL;

  return parseLogLevel(specificLevel, parseLogLevel(globalLevel, "info"));
}

function getModuleNameFromStack(): { service: string | null; module: string } {
  const stack = new Error().stack;
  if (!stack) return { service: null, module: "unknown" };

  const lines = stack.split("\n");
  const moduleNames: string[] = [];

  // Skip first 4 lines:
  // 1. Error constructor
  // 2. getModuleNameFromStack
  // 3. writeLog
  // 4. The public log method (error/warn/info/debug/trace)
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i];
    // Match file paths like /path/to/alice.ts or /path/to/alice.ts:123:45
    const match = line.match(/\/([^/]+)\.ts(?::\d+)?(?::\d+)?/);
    if (match) {
      const moduleName = match[1];
      // Skip logger.ts itself
      if (moduleName !== "logger") {
        moduleNames.push(moduleName);
      }
    }

    // Stop after finding 2 unique module names
    if (moduleNames.length >= 2) {
      break;
    }
  }

  if (moduleNames.length === 0) {
    return { service: null, module: "unknown" };
  } else if (moduleNames.length === 1) {
    // Only one module in stack, this is a direct call from a service
    return { service: null, module: moduleNames[0] };
  } else {
    // Two modules: service is the deeper one, module is the immediate caller
    return { service: moduleNames[1], module: moduleNames[0] };
  }
}

/**
 * Format a module name for display (capitalize first letter)
 */
function formatModuleName(moduleName: string): string {
  // Special case for hyphenated names
  if (moduleName.includes("-")) {
    return moduleName
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
  }
  return moduleName.charAt(0).toUpperCase() + moduleName.slice(1);
}

/**
 * Logger implementation that dynamically determines module name from call stack
 */
class DynamicLogger implements Logger {
  private serviceName: string | null = null;

  /**
   * Set the service name for this logger instance.
   * This should be called once at service startup.
   */
  setServiceName(name: string): void {
    this.serviceName = name;
  }

  private getModuleConfig(moduleName: string): {
    levelValue: number;
    nameColor: string;
    displayName: string;
  } {
    const logLevel = getLogLevel(moduleName);
    const levelValue = LOG_LEVELS[logLevel];
    const nameColor = NAME_COLORS[moduleName] || "\x1b[37m"; // Default to white
    const displayName = formatModuleName(moduleName);
    return { levelValue, nameColor, displayName };
  }

  private getTimestamp(): string {
    const now = new Date();
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const seconds = now.getSeconds().toString().padStart(2, "0");
    const milliseconds = now.getMilliseconds().toString().padStart(3, "0");
    return `${minutes}:${seconds}.${milliseconds}`;
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    stackInfo: { service: string | null; module: string }
  ): string {
    const timestamp = this.getTimestamp();
    const levelColor = LOG_LEVEL_COLORS[level];
    const levelStr = `${levelColor}${level.toUpperCase().padEnd(2)}${RESET}`;

    let nameStr: string;
    const showServiceName = process.env.SHOW_SERVICE_NAME_IN_LOGS === "true";

    if (showServiceName && stackInfo.service) {
      // Show both service and module with hierarchical separator
      const serviceColor = NAME_COLORS[stackInfo.service] || "\x1b[37m";
      const moduleColor = NAME_COLORS[stackInfo.module] || "\x1b[90m"; // Dim gray for submodules
      const serviceDisplay = formatModuleName(stackInfo.service);
      const moduleDisplay = formatModuleName(stackInfo.module);
      nameStr = `${serviceColor}${serviceDisplay}${RESET}${moduleColor}›${moduleDisplay}${RESET}`;
    } else {
      // Show only module
      const moduleColor = NAME_COLORS[stackInfo.module] || "\x1b[37m";
      const moduleDisplay = formatModuleName(stackInfo.module);
      nameStr = `${moduleColor}${moduleDisplay}${RESET}`;
    }

    return `[${levelStr}|${timestamp}] ${nameStr} → ${message}`;
  }

  private shouldLog(level: LogLevel, moduleName: string): boolean {
    const { levelValue } = this.getModuleConfig(moduleName);
    return LOG_LEVELS[level] <= levelValue;
  }

  private writeLog(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const stackInfo = getModuleNameFromStack();

    // If serviceName is set and it's different from the module, use it as the service
    // Otherwise, use the stack info
    let finalStackInfo = stackInfo;
    if (this.serviceName && this.serviceName !== stackInfo.module) {
      finalStackInfo = { service: this.serviceName, module: stackInfo.module };
    } else if (this.serviceName) {
      // Service is logging directly
      finalStackInfo = { service: null, module: this.serviceName };
    }

    // Use the immediate caller (module) for log level checking
    if (!this.shouldLog(level, finalStackInfo.module)) {
      return;
    }

    const formatted = this.formatMessage(level, message, finalStackInfo);

    if (level === "error") {
      if (context !== undefined) {
        console.error(formatted, context);
      } else {
        console.error(formatted);
      }
    } else {
      if (context !== undefined) {
        console.log(formatted, context);
      } else {
        console.log(formatted);
      }
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.writeLog("error", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.writeLog("warn", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.writeLog("info", message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.writeLog("debug", message, context);
  }

  trace(message: string, context?: Record<string, unknown>): void {
    this.writeLog("trace", message, context);
  }

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.writeLog(level, message, context);
  }
}

/**
 * Shortens a hex string (like pubkeys or nostr keys) for display.
 * Shows first 8 characters followed by ellipsis.
 */
export function shortenKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}...`;
}

/**
 * Single logger instance that automatically determines the calling module name.
 * Import and use directly in any module:
 *
 * ```ts
 * import { logger } from "./logger";
 *
 * // Set service name once at startup (optional)
 * logger.setServiceName("alice");
 *
 * logger.info("Starting service"); // Logs: 12:34.567 INFO  Alice  Starting service
 * logger.error("Something went wrong", { error });
 * ```
 *
 * The logger automatically detects the calling module from the stack trace.
 * If a service name is set, it will show both service and module names:
 * - Gateway › Nostr for logs from nostr.ts called by gateway.ts
 * - Gateway for direct logs from gateway.ts
 */
export const logger = new DynamicLogger();

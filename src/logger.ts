import type { Logger, LogLevel } from "@cashu/cashu-ts";

export type LogLevelWithOff = LogLevel | "off";

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
  Alice: "\x1b[36m", // Cyan
  Gateway: "\x1b[33m", // Yellow
  Dealer: "\x1b[35m", // Magenta
};

const RESET = "\x1b[0m";

function parseLogLevel(level: string | undefined, fallback: LogLevelWithOff): LogLevelWithOff {
  if (!level) return fallback;
  const normalized = level.toLowerCase();
  return (normalized in LOG_LEVELS ? normalized : fallback) as LogLevelWithOff;
}

function getLogLevel(name: string, suffix?: string): LogLevelWithOff {
  const envKey = suffix
    ? `${name.toUpperCase()}_${suffix.toUpperCase()}_LOG_LEVEL`
    : `${name.toUpperCase()}_LOG_LEVEL`;
  const specificLevel = process.env[envKey];
  const serviceLevel = suffix ? process.env[`${name.toUpperCase()}_LOG_LEVEL`] : undefined;
  const globalLevel = process.env.LOG_LEVEL;

  return parseLogLevel(
    specificLevel,
    parseLogLevel(serviceLevel, parseLogLevel(globalLevel, "info"))
  );
}

export class NamedLogger implements Logger {
  private name: string;
  private levelValue: number;
  private nameColor: string;

  constructor(name: string, suffix?: string) {
    this.name = name;
    const logLevel = getLogLevel(name, suffix);
    this.levelValue = LOG_LEVELS[logLevel];
    this.nameColor = NAME_COLORS[name] || "\x1b[37m"; // Default to white if not found
  }

  private formatMessage(level: LogLevel, message: string): string {
    const levelColor = LOG_LEVEL_COLORS[level];
    const nameStr = `${this.nameColor}[${this.name}]${RESET}`;
    const levelStr = `${levelColor}[${level.toUpperCase()}]${RESET}`;

    return `${levelStr} ${nameStr} ${message}`;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] <= this.levelValue;
  }

  private writeLog(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const formatted = this.formatMessage(level, message);

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
    if (this.shouldLog("error")) {
      this.writeLog("error", message, context);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      this.writeLog("warn", message, context);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      this.writeLog("info", message, context);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      this.writeLog("debug", message, context);
    }
  }

  trace(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("trace")) {
      this.writeLog("trace", message, context);
    }
  }

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog(level)) {
      this.writeLog(level, message, context);
    }
  }
}

/**
 * Simple file-based logger.
 * Port of Python's logging setup in agent_shell.py (Phase 17).
 */

import fs from "fs";
import path from "path";

export type LogLevel = "INFO" | "WARNING" | "ERROR";

/** Interface for logger consumers — allows injection of test doubles or alternative loggers. */
export interface LoggerLike {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  /** Returns a new logger that prepends [key=value] tags to every message. */
  withContext(tags: Record<string, string>): LoggerLike;
}

/** Lightweight wrapper that prefixes structured context tags to log messages. */
class ContextLogger implements LoggerLike {
  constructor(private readonly base: LoggerLike, private readonly prefix: string) {}
  info(msg: string)    { this.base.info(`${this.prefix} ${msg}`); }
  warning(msg: string) { this.base.warning(`${this.prefix} ${msg}`); }
  error(msg: string)   { this.base.error(`${this.prefix} ${msg}`); }
  withContext(tags: Record<string, string>): LoggerLike {
    const extra = Object.entries(tags).map(([k, v]) => `[${k}=${v}]`).join(" ");
    return new ContextLogger(this.base, `${this.prefix} ${extra}`);
  }
}

export class Logger implements LoggerLike {
  withContext(tags: Record<string, string>): LoggerLike {
    const prefix = Object.entries(tags).map(([k, v]) => `[${k}=${v}]`).join(" ");
    return new ContextLogger(this, prefix);
  }

  private filePath: string;
  private enabled: boolean;

  constructor(filePath: string, enabled = true) {
    this.filePath = filePath;
    this.enabled = enabled;
  }

  static initialize(logFile?: string | null): Logger {
    const resolved =
      logFile ??
      process.env["AGENT_LOG_FILE"] ??
      path.join("logs", "agent_shell.log");

    const absPath = path.isAbsolute(resolved)
      ? resolved
      : path.join(process.cwd(), resolved);

    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
    } catch {
      // If we can't create the log dir, disable logging
      return new Logger(absPath, false);
    }

    return new Logger(absPath, true);
  }

  private write(level: LogLevel, message: string): void {
    if (!this.enabled) return;
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const line = `${ts} [${level}] ${message}\n`;
    try {
      fs.appendFileSync(this.filePath, line, "utf-8");
    } catch {
      // Best-effort — swallow write errors
    }
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warning(message: string): void {
    this.write("WARNING", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }
}

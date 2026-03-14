/**
 * Simple file-based logger.
 * Port of Python's logging setup in agent_shell.py (Phase 17).
 */

import fs from "fs";
import path from "path";

export type LogLevel = "INFO" | "WARNING" | "ERROR";

export class Logger {
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

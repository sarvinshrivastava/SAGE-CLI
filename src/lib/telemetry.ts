/**
 * Structured telemetry utilities for the shell assistant.
 */

import fs from "fs";
import path from "path";
import type { Logger } from "./logger.js";

export interface TelemetryEvent {
  event: string;
  timestamp?: string;
  [key: string]: any;
}

export interface TelemetryEmitter {
  path: string;
  enabled: boolean;

  emit(payload: Record<string, any>): void;
  emitExecution(
    goal: string,
    sessionId: string | null,
    plannerInfo: Record<string, any>,
    commandEvent: Record<string, any>
  ): void;
  emitPlanCreated(
    goal: string,
    sessionId: string | null,
    plannerInfo: Record<string, any>,
    plan: Record<string, any>
  ): void;
  emitPlanUpdate(
    goal: string,
    sessionId: string | null,
    plannerInfo: Record<string, any>,
    plan: Record<string, any>,
    stepId: string | null,
    status: string | null
  ): void;
}

/**
 * Redacts common secret patterns from a string before it is persisted to the
 * telemetry log. Targets inline credentials that may appear in command strings
 * or error messages: KEY=value pairs, Authorization headers, -p<password>.
 */
function scrubSecrets(text: string): string {
  return text
    // KEY=value or KEY: value where KEY name looks like a credential
    .replace(
      /\b(password|passwd|token|api[_-]?key|secret|credential|private[_-]?key)s?\s*[=:]\s*\S+/gi,
      (_, key: string) => `${key}=[REDACTED]`
    )
    // Authorization header (Bearer / Basic / etc.)
    .replace(/\bAuthorization:\s*\S+(\s+\S+)?/gi, "Authorization: [REDACTED]")
    // MySQL-style -p<password> flag
    .replace(/(\s)-p\S+/g, "$1-p[REDACTED]");
}

export class TelemetryEmitterImpl implements TelemetryEmitter {
  path: string;
  enabled: boolean;
  private _logger: Logger | null = null;
  /** Tracks the last error message to avoid spamming the log on every emit. */
  private _lastErrorMsg: string | null = null;

  constructor(filePath: string, enabled: boolean = true) {
    this.path = filePath;
    this.enabled = enabled;
  }

  setLogger(logger: Logger): void {
    this._logger = logger;
  }

  static initialize(filePath?: string): TelemetryEmitterImpl {
    if (filePath === "") {
      return new TelemetryEmitterImpl(".", false);
    }

    let candidate = filePath || process.env.AGENT_TELEMETRY_FILE || "logs/telemetry.jsonl";
    
    // Ensure path is absolute
    const absolutePath = path.isAbsolute(candidate) ? candidate : path.join(process.cwd(), candidate);
    
    // Create parent directories
    const dir = path.dirname(absolutePath);
    fs.mkdirSync(dir, { recursive: true });
    
    return new TelemetryEmitterImpl(absolutePath, true);
  }

  emit(payload: Record<string, any>): void {
    if (!this.enabled) {
      return;
    }
    
    const record = { ...payload };
    if (record.timestamp == null) record.timestamp = new Date().toISOString();
    
    // Scrub secrets from all top-level string fields before persisting.
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(record)) {
      clean[k] = typeof v === "string" ? scrubSecrets(v) : v;
    }
    const line = JSON.stringify(clean) + "\n";
    try {
      // Open in append mode and capture pre-write size so we can roll back a
      // partial/corrupt write (e.g. mid-crash) by truncating to prevSize.
      const fd = fs.openSync(this.path, "a");
      try {
        const prevSize = fs.fstatSync(fd).size;
        try {
          fs.writeSync(fd, line);
        } catch (writeErr) {
          try { fs.ftruncateSync(fd, prevSize); } catch { /* best-effort rollback */ }
          throw writeErr;
        }
      } finally {
        fs.closeSync(fd);
      }
      this._lastErrorMsg = null; // clear dedup key on success
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg !== this._lastErrorMsg) {
        this._lastErrorMsg = msg;
        this._logger?.warning(`Telemetry write failed (${this.path}): ${msg}`);
      }
    }
  }

  emitExecution(
    goal: string,
    sessionId: string | null,
    plannerInfo: Record<string, any>,
    commandEvent: Record<string, any>
  ): void {
    if (!this.enabled) {
      return;
    }
    
    const event = {
      event: "execution",
      goal,
      session_id: sessionId,
      planner_info: plannerInfo,
      ...commandEvent,
    };
    
    this.emit(event);
  }

  emitPlanCreated(
    goal: string,
    sessionId: string | null,
    plannerInfo: Record<string, any>,
    plan: Record<string, any>
  ): void {
    if (!this.enabled) {
      return;
    }
    
    const event = {
      event: "plan_created",
      goal,
      session_id: sessionId,
      planner_info: plannerInfo,
      plan,
    };
    
    this.emit(event);
  }

  emitPlanUpdate(
    goal: string,
    sessionId: string | null,
    plannerInfo: Record<string, any>,
    plan: Record<string, any>,
    stepId: string | null,
    status: string | null
  ): void {
    if (!this.enabled) {
      return;
    }
    
    const event = {
      event: "plan_updated",
      goal,
      session_id: sessionId,
      planner_info: plannerInfo,
      plan,
      step_id: stepId,
      status,
    };
    
    this.emit(event);
  }
}


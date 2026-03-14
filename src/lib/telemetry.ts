/**
 * Structured telemetry utilities for the shell assistant.
 */

import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

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

export class TelemetryEmitterImpl implements TelemetryEmitter {
  path: string;
  enabled: boolean;

  constructor(filePath: string, enabled: boolean = true) {
    this.path = filePath;
    this.enabled = enabled;
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
    record.timestamp = new Date().toISOString();
    
    try {
      fs.appendFileSync(this.path, JSON.stringify(record) + "\n", "utf-8");
    } catch (error) {
      // Telemetry is best-effort; ignore write failures silently for now.
      return;
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


/**
 * Session persistence utilities for the shell assistant.
 */

import fs from "fs";
import path from "path";
import os from "os";

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export interface SessionManager {
  root: string;
  sessionId: string;
  enabled: boolean;
  path: string;
  startNew(sessionId?: string): SessionManager;
  describe(): string;
  recordGoal(
    goal: string,
    steps: Record<string, any>[],
    status: string,
    metadata?: Record<string, any> | null
  ): void;
}

export class SessionManagerImpl implements SessionManager {
  root: string;
  sessionId: string;
  enabled: boolean;

  constructor(root: string, sessionId: string, enabled: boolean = true) {
    this.root = root;
    this.sessionId = sessionId;
    this.enabled = enabled;
  }

  get path(): string {
    return path.join(this.root, `${this.sessionId}.jsonl`);
  }

  static initialize(
    directory: string | null,
    sessionId: string | null,
    persist: boolean
  ): SessionManagerImpl {
    if (!persist) {
      return new SessionManagerImpl(".", "ephemeral", false);
    }
    const base = path.resolve(expandHome(directory || "sessions"));
    fs.mkdirSync(base, { recursive: true });
    const sid = sessionId || SessionManagerImpl._generateId();
    return new SessionManagerImpl(base, sid, true);
  }

  startNew(sessionId?: string): SessionManagerImpl {
    if (!this.enabled) return this;
    return new SessionManagerImpl(
      this.root,
      sessionId || SessionManagerImpl._generateId(),
      true
    );
  }

  describe(): string {
    if (!this.enabled) return "Session persistence disabled.";
    return `Session ${this.sessionId} -> ${this.path}`;
  }

  recordGoal(
    goal: string,
    steps: Record<string, any>[],
    status: string,
    metadata: Record<string, any> | null = null
  ): void {
    if (!this.enabled) return;
    const entry = {
      timestamp: new Date().toISOString(),
      goal,
      status,
      steps: [...steps],
      metadata: metadata || {},
    };
    const line = JSON.stringify(entry) + "\n";
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
    } catch (exc: any) {
      console.warn(`Warning: failed to persist session data: ${exc.message}`);
    }
  }

  static _generateId(): string {
    const now = new Date();
    // Include milliseconds to avoid second-level collisions, plus a random
    // hex suffix for safety on rapid restarts within the same millisecond.
    const ts = now.toISOString().slice(0, 23).replace(/[-:.T]/g, "");
    const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
    return `${ts.slice(0, 8)}-${ts.slice(8, 14)}-${ts.slice(14)}${rand}`;
  }
}

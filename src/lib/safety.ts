/**
 * Safety policy engine for command risk evaluation.
 * Port of safety.py
 */

import fs from "fs";
import path from "path";
import os from "os";
import { SafetyDecision, SafetyRule as SafetyRuleInterface } from "./types.js";

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export class SafetyRule {
  pattern: string;
  level: string;
  requireConfirmation: boolean;
  allowedFlags: string[] | null;
  description: string | null;
  private regex: RegExp;

  constructor(opts: {
    pattern: string;
    level: string;
    requireConfirmation?: boolean;
    allowedFlags?: string[] | null;
    description?: string | null;
  }) {
    this.pattern = opts.pattern;
    this.level = opts.level;
    this.requireConfirmation = opts.requireConfirmation ?? false;
    this.allowedFlags = opts.allowedFlags ?? null;
    this.description = opts.description ?? null;
    this.regex = new RegExp(opts.pattern, "i");
  }

  matches(command: string): boolean {
    return this.regex.test(command);
  }

  evaluate(command: string): SafetyDecision {
    const notes: string[] = [];
    let requireConfirmation = this.requireConfirmation;

    if (this.allowedFlags) {
      if (!this.allowedFlags.some((flag) => command.includes(flag))) {
        notes.push(
          "Expected one of the following flags: " + this.allowedFlags.join(", ")
        );
        requireConfirmation = true;
      }
    }

    if (this.description) {
      notes.push(this.description);
    }

    return {
      level: this.level,
      requireConfirmation,
      notes: notes.length > 0 ? notes.join("\n") : null,
    };
  }
}

export class SafetyPolicy {
  private rules: SafetyRule[];

  constructor(rules: SafetyRule[]) {
    this.rules = rules;
  }

  static load(policyPath?: string | null): SafetyPolicy {
    const candidates: string[] = [];
    if (policyPath) candidates.push(policyPath);
    const envPath = process.env["AGENT_SAFETY_POLICY"];
    if (envPath) candidates.push(envPath);
    candidates.push("safety_policy.json");

    for (const candidate of candidates) {
      const resolved = path.resolve(expandHome(candidate));
      if (!fs.existsSync(resolved)) continue;

      let data: unknown;
      try {
        const content = fs.readFileSync(resolved, "utf-8");
        data = JSON.parse(content);
      } catch {
        continue;
      }

      if (typeof data !== "object" || data === null) continue;
      const rules = SafetyPolicy._rulesFromMapping(data as Record<string, unknown>);
      if (rules.length > 0) return new SafetyPolicy(rules);
    }

    return SafetyPolicy.default();
  }

  private static _rulesFromMapping(mapping: Record<string, unknown>): SafetyRule[] {
    const rawRules = mapping["rules"];
    if (!Array.isArray(rawRules)) return [];

    const rules: SafetyRule[] = [];
    for (const item of rawRules) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;

      const pattern = obj["pattern"];
      if (typeof pattern !== "string" || !pattern) continue;

      const levelRaw = (obj["level"] as string | undefined)?.toLowerCase() ?? "low";
      if (!["low", "medium", "high"].includes(levelRaw)) continue;

      const requireConfirmation = Boolean(obj["require_confirmation"] ?? false);

      let allowedFlags: string[] | null = null;
      if (Array.isArray(obj["allowed_flags"])) {
        allowedFlags = (obj["allowed_flags"] as unknown[])
          .filter((f): f is string => typeof f === "string" && f.length > 0);
        if (allowedFlags.length === 0) allowedFlags = null;
      }

      const description =
        typeof obj["description"] === "string" ? obj["description"] : null;

      rules.push(
        new SafetyRule({ pattern, level: levelRaw, requireConfirmation, allowedFlags, description })
      );
    }
    return rules;
  }

  static default(): SafetyPolicy {
    return new SafetyPolicy([
      new SafetyRule({ pattern: r`rm\s+-rf\s+/`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`:\(\)\s*{`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`\bdd\s+if=`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`\bmkfs\.\w*`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`>\s*/dev/sd[0-9a-z]`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`\bwipefs\b`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`\b(poweroff|shutdown|reboot|halt)\b`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`\buserdel\b`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`\bmkpart\b`, level: "high", requireConfirmation: true }),
      new SafetyRule({ pattern: r`\bsudo\b`, level: "medium" }),
      new SafetyRule({ pattern: r`\bapt(-get)?\s+remove\b`, level: "medium" }),
      new SafetyRule({ pattern: r`\bchown\s+-R\b`, level: "medium" }),
      new SafetyRule({ pattern: r`\bchmod\s+777\b`, level: "medium" }),
      new SafetyRule({ pattern: r`\bsystemctl\s+(stop|restart)\s+`, level: "medium" }),
      new SafetyRule({ pattern: r`\bkill\s+-9\b`, level: "medium" }),
      new SafetyRule({
        pattern: r`\bapt(-get)?\s+install\b`,
        level: "medium",
        allowedFlags: ["-y"],
        description: "Apt installs should include -y for non-interactive mode.",
      }),
    ]);
  }

  evaluate(command: string): SafetyDecision {
    const normalized = command.trim();
    if (!normalized) {
      return { level: "low", requireConfirmation: false };
    }

    // Decompose the command into atomic fragments so that chained dangerous
    // sub-commands (via |, &&, ||, ;, backticks, $()) are each evaluated
    // independently rather than only pattern-matching the whole string.
    const fragments = extractSubcommands(normalized);
    // Always include the full command too — catches patterns that span metacharacters
    const candidates = fragments.length > 1 ? [...fragments, normalized] : [normalized];

    let worst: SafetyDecision = { level: "low", requireConfirmation: false };
    for (const fragment of candidates) {
      if (!fragment) continue;
      for (const rule of this.rules) {
        if (rule.matches(fragment)) {
          const decision = rule.evaluate(fragment);
          if (riskRank(decision.level) > riskRank(worst.level)) {
            worst = decision;
          }
          break; // first matching rule wins for this fragment
        }
      }
    }

    return worst;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function riskRank(level: string): number {
  if (level === "high") return 2;
  if (level === "medium") return 1;
  return 0;
}

/**
 * Splits a shell command into atomic subcommand fragments by decomposing on
 * shell metacharacters (|, &&, ||, ;) and extracting backtick / $() subshells.
 * Quote-aware: characters inside single or double quotes are not treated as
 * metacharacters. The returned list contains every distinct string that should
 * be independently evaluated by the safety policy.
 */
function extractSubcommands(command: string): string[] {
  const fragments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  const pushCurrent = () => {
    const s = current.trim();
    if (s) fragments.push(s);
    current = "";
  };

  while (i < command.length) {
    const ch = command[i]!;

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      // Two-character operators first (&&, ||)
      if (
        (ch === "&" && command[i + 1] === "&") ||
        (ch === "|" && command[i + 1] === "|")
      ) {
        pushCurrent();
        i += 2;
        continue;
      }
      // Single | or ;
      if (ch === "|" || ch === ";") {
        pushCurrent();
        i++;
        continue;
      }
      // Backtick subshell: extract inner command as a separate fragment
      if (ch === "`") {
        const end = command.indexOf("`", i + 1);
        if (end > i) {
          const inner = command.slice(i + 1, end).trim();
          if (inner) fragments.push(inner);
          current += command.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      // $() subshell: extract inner command as a separate fragment
      if (ch === "$" && command[i + 1] === "(") {
        let depth = 1;
        let j = i + 2;
        while (j < command.length && depth > 0) {
          if (command[j] === "(") depth++;
          else if (command[j] === ")") depth--;
          j++;
        }
        const inner = command.slice(i + 2, j - 1).trim();
        if (inner) fragments.push(inner);
        current += command.slice(i, j);
        i = j;
        continue;
      }
    }

    current += ch;
    i++;
  }

  pushCurrent();
  return fragments;
}

// Template tag helper so we can write raw regex strings without double-escaping
function r(strings: TemplateStringsArray): string {
  return strings.raw[0]!;
}

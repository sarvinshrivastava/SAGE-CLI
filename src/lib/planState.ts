/**
 * Plan state management, history building, and result serialization.
 * Port of the relevant parts of agent_shell.py (Phases 8 + helpers).
 */

import type { CommandResult, PlannerPlan, PlannerTurn } from "./types.js";

// ---------------------------------------------------------------------------
// Output helpers (Bug Fix #2: sandwich compression)
// ---------------------------------------------------------------------------

export const OUTPUT_WHITELIST = new Set(["pwd", "ls", "whoami", "cat", "grep", "echo"]);

/** Join lines into a bounded string. Keeps first half + last half when truncated. */
export function compressOutput(lines: string[], maxChars = 4000): string {
  const joined = lines.join("");
  if (joined.length <= maxChars) return joined;
  const half = Math.floor(maxChars / 2);
  return joined.slice(0, half) + "\n...[truncated]...\n" + joined.slice(-half);
}

export function isWhitelistedCommand(command: string): boolean {
  if (!command) return false;
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return false;
  const base = parts[0]!.split("/").pop() ?? "";
  return OUTPUT_WHITELIST.has(base);
}

export function shouldSendFullOutput(result: CommandResult): boolean {
  if (result.returncode !== 0) return true;
  const command = result.executedCommand || result.suggestedCommand;
  return isWhitelistedCommand(command);
}

// ---------------------------------------------------------------------------
// PlanStepState
// ---------------------------------------------------------------------------

export class PlanStepState {
  id: string;
  title: string | null;
  command: string | null;
  description: string | null;
  status: string;
  historyIndices: number[];

  constructor(opts: {
    id: string;
    title?: string | null;
    command?: string | null;
    description?: string | null;
    status?: string;
    historyIndices?: number[];
  }) {
    this.id = opts.id;
    this.title = opts.title ?? null;
    this.command = opts.command ?? null;
    this.description = opts.description ?? null;
    this.status = opts.status ?? "pending";
    this.historyIndices = opts.historyIndices ?? [];
  }

  label(): string {
    if (this.title) return this.title;
    if (this.command) return this.command;
    return `Step ${this.id}`;
  }
}

// ---------------------------------------------------------------------------
// PlanState
// ---------------------------------------------------------------------------

export class PlanState {
  summary: string | null;
  steps: PlanStepState[];

  constructor(summary: string | null, steps: PlanStepState[]) {
    this.summary = summary;
    this.steps = steps;
  }

  currentStep(): PlanStepState | null {
    for (const step of this.steps) {
      if (step.status !== "completed") return step;
    }
    return null;
  }

  getStep(stepId: string): PlanStepState | null {
    return this.steps.find((s) => s.id === stepId) ?? null;
  }

  markRunning(stepId: string): void {
    const step = this.getStep(stepId);
    if (!step || step.status === "completed") return;
    step.status = "in_progress";
  }

  recordResult(stepId: string, success: boolean, historyIndex: number | null): void {
    const step = this.getStep(stepId);
    if (!step) return;
    if (historyIndex !== null) step.historyIndices.push(historyIndex);
    step.status = success ? "completed" : "failed";
  }

  toDict(): Record<string, unknown> {
    return {
      summary: this.summary,
      steps: this.steps.map((step) => ({
        id: step.id,
        title: step.title,
        command: step.command,
        label: step.label(),
        description: step.description,
        status: step.status,
        history: step.historyIndices,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// convertPlannerPlan
// ---------------------------------------------------------------------------

export function convertPlannerPlan(plan: PlannerPlan | null): PlanState | null {
  if (!plan) return null;
  const steps: PlanStepState[] = [];
  for (const raw of plan.steps) {
    const statusClean =
      typeof raw.status === "string" && raw.status.trim()
        ? raw.status.trim().toLowerCase()
        : "pending";
    steps.push(
      new PlanStepState({
        id: raw.id,
        title: raw.title,
        command: raw.command,
        description: raw.description,
        status: statusClean || "pending",
      })
    );
  }
  if (steps.length === 0) return null;
  return new PlanState(plan.summary, steps);
}

// ---------------------------------------------------------------------------
// buildPlannerHistory
// ---------------------------------------------------------------------------

export function buildPlannerHistory(
  results: CommandResult[],
  plan: PlanState | null = null
): PlannerTurn[] {
  const turns: PlannerTurn[] = [];
  const failureTally: Record<string, number> = {};

  for (const result of results) {
    const notes: string[] = [];

    if (result.returncode !== 0) {
      const key = result.suggestedCommand.trim();
      failureTally[key] = (failureTally[key] ?? 0) + 1;
      if (failureTally[key]! > 1) {
        notes.push(`AGENT_NOTE: command has failed ${failureTally[key]} times.`);
      }
    }

    if (result.riskLevel === "medium" || result.riskLevel === "high") {
      notes.push(`AGENT_NOTE: risk_level=${result.riskLevel.toUpperCase()}`);
    }

    if (result.safetyNotes) {
      notes.push(`AGENT_NOTE: safety_policy=${result.safetyNotes}`);
    }

    if (result.planStepId) {
      const statusLabel =
        result.planStepStatus ?? (result.returncode === 0 ? "completed" : "failed");
      notes.push(`AGENT_NOTE: plan_step=${result.planStepId} status=${statusLabel}`);
    }

    if (result.score) {
      const successes = (result.score["successes"] as number | undefined) ?? 0;
      const failures = (result.score["failures"] as number | undefined) ?? 0;
      const scoreVal =
        (result.score["score"] as number | undefined) ?? successes - failures;
      if (failures && failures >= successes) {
        notes.push(
          `AGENT_NOTE: command_history=${successes} success/${failures} failure (score ${scoreVal}).`
        );
      }
    }

    const includeOutput = shouldSendFullOutput(result);
    let stdoutText: string;
    let stderrText: string;

    if (includeOutput) {
      stdoutText = compressOutput(result.stdout);
      stderrText = compressOutput(result.stderr);
    } else {
      stdoutText = `Command exit code ${result.returncode} (output omitted).`;
      stderrText = "";
    }

    if (notes.length > 0) {
      const noteBlock = notes.join("\n");
      if (includeOutput) {
        stderrText = stderrText ? `${stderrText}\n${noteBlock}` : noteBlock;
      } else {
        stdoutText = stdoutText ? `${stdoutText}\n${noteBlock}` : noteBlock;
      }
    }

    turns.push({
      suggestedCommand: result.suggestedCommand,
      executedCommand: result.executedCommand,
      stdout: stdoutText,
      stderr: stderrText,
      exitCode: result.returncode,
    });
  }

  if (plan && turns.length > 0) {
    const nextStep = plan.currentStep();
    if (nextStep) {
      const pendingLabel = nextStep.label();
      const pendingNote = `AGENT_NOTE: plan_next=${nextStep.id} status=${nextStep.status} label=${pendingLabel}`;
      const lastTurn = turns[turns.length - 1]!;
      lastTurn.stderr = lastTurn.stderr
        ? `${lastTurn.stderr}\n${pendingNote}`
        : pendingNote;
    }
  }

  return turns;
}

// ---------------------------------------------------------------------------
// serializeResult + determineStatus
// ---------------------------------------------------------------------------

export function serializeResult(result: CommandResult): Record<string, unknown> {
  return {
    suggested_command: result.suggestedCommand,
    executed_command: result.executedCommand,
    stdout: result.stdout.join(""),
    stderr: result.stderr.join(""),
    exit_code: result.returncode,
    risk_level: result.riskLevel,
    context: result.context,
    safety_notes: result.safetyNotes,
    normalized_command: result.normalizedCommand,
    command_score: result.score,
    plan_step_id: result.planStepId,
    plan_step_status: result.planStepStatus,
  };
}

export function determineStatus(
  history: CommandResult[],
  plannerCompleted: boolean,
  plannerError: string | null,
  userCancelled: boolean
): string {
  if (plannerError) return "planner_error";
  if (userCancelled && history.length === 0) return "cancelled";
  if (
    plannerCompleted &&
    history.length > 0 &&
    history[history.length - 1]!.returncode === 0
  )
    return "completed";
  if (history.length > 0 && history[history.length - 1]!.returncode !== 0)
    return "failed";
  if (userCancelled) return "cancelled";
  if (plannerCompleted) return "completed";
  if (history.length > 0) return "incomplete";
  return "no_action";
}

export function truncateCommand(command: string, limit = 80): string {
  if (command.length <= limit) return command;
  return command.slice(0, limit - 3) + "...";
}

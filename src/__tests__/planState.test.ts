import { describe, it, expect } from "bun:test";
import {
  PlanState,
  PlanStepState,
  withMarkRunning,
  withRecordResult,
  mergePlan,
  buildPlannerHistory,
  determineStatus,
  convertPlannerPlan,
} from "../lib/planState.js";
import type { CommandResult } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(id: string, status = "pending"): PlanStepState {
  return new PlanStepState({ id, title: `Step ${id}`, status });
}

function makePlan(...statuses: string[]): PlanState {
  const steps = statuses.map((s, i) => makeStep(String(i + 1), s));
  return new PlanState("Test plan", steps);
}

function makeResult(cmd: string, exitCode: number): CommandResult {
  return {
    suggestedCommand: cmd,
    executedCommand: cmd,
    stdout: [`output of ${cmd}`],
    stderr: [],
    returncode: exitCode,
    riskLevel: "low",
    context: {},
  };
}

// ---------------------------------------------------------------------------
// withMarkRunning
// ---------------------------------------------------------------------------

describe("withMarkRunning", () => {
  it("returns a new PlanState instance (immutability)", () => {
    const plan = makePlan("pending");
    const updated = withMarkRunning(plan, "1");
    expect(updated).not.toBe(plan);
    expect(updated.steps[0]).not.toBe(plan.steps[0]);
  });

  it("sets the target step to in_progress", () => {
    const plan = makePlan("pending", "pending");
    const updated = withMarkRunning(plan, "1");
    expect(updated.steps[0]!.status).toBe("in_progress");
    expect(updated.steps[1]!.status).toBe("pending");
  });

  it("does not change a completed step", () => {
    const plan = makePlan("completed");
    const updated = withMarkRunning(plan, "1");
    expect(updated.steps[0]!.status).toBe("completed");
  });

  it("leaves other steps unchanged", () => {
    const plan = makePlan("pending", "pending", "pending");
    const updated = withMarkRunning(plan, "2");
    expect(updated.steps[0]!.status).toBe("pending");
    expect(updated.steps[1]!.status).toBe("in_progress");
    expect(updated.steps[2]!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// withRecordResult
// ---------------------------------------------------------------------------

describe("withRecordResult", () => {
  it("returns a new PlanState instance (immutability)", () => {
    const plan = makePlan("in_progress");
    const updated = withRecordResult(plan, "1", true, 0);
    expect(updated).not.toBe(plan);
  });

  it("marks step completed on success", () => {
    const plan = makePlan("in_progress");
    const updated = withRecordResult(plan, "1", true, 0);
    expect(updated.steps[0]!.status).toBe("completed");
  });

  it("marks step failed on failure", () => {
    const plan = makePlan("in_progress");
    const updated = withRecordResult(plan, "1", false, 0);
    expect(updated.steps[0]!.status).toBe("failed");
  });

  it("appends historyIndex when provided", () => {
    const plan = makePlan("in_progress");
    const updated = withRecordResult(plan, "1", true, 5);
    expect(updated.steps[0]!.historyIndices).toEqual([5]);
  });

  it("skips historyIndex when null", () => {
    const plan = makePlan("in_progress");
    const updated = withRecordResult(plan, "1", true, null);
    expect(updated.steps[0]!.historyIndices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PlanState.currentStep
// ---------------------------------------------------------------------------

describe("PlanState.currentStep", () => {
  it("returns the first non-completed step", () => {
    const plan = makePlan("completed", "pending", "pending");
    expect(plan.currentStep()?.id).toBe("2");
  });

  it("returns null when all steps are completed", () => {
    const plan = makePlan("completed", "completed");
    expect(plan.currentStep()).toBeNull();
  });

  it("treats failed as non-completed", () => {
    const plan = makePlan("completed", "failed", "pending");
    expect(plan.currentStep()?.id).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// mergePlan
// ---------------------------------------------------------------------------

describe("mergePlan", () => {
  it("increments revision", () => {
    const old = makePlan("completed", "pending");
    const { merged } = mergePlan(old, { summary: "revised", steps: [{ id: "a", title: "New", command: null, description: null, status: null }] });
    expect(merged.revision).toBe(1);
  });

  it("keeps completed steps from old plan", () => {
    const old = makePlan("completed", "completed", "pending");
    const { merged, keptCount } = mergePlan(old, { summary: "revised", steps: [{ id: "a", title: "New step", command: null, description: null, status: null }] });
    expect(keptCount).toBe(2);
    expect(merged.steps[0]!.status).toBe("completed");
    expect(merged.steps[1]!.status).toBe("completed");
  });

  it("replaces non-completed steps with new plan steps", () => {
    const old = makePlan("completed", "pending", "failed");
    const { merged, replacedCount } = mergePlan(old, {
      summary: "revised",
      steps: [
        { id: "x", title: "Step X", command: "echo x", description: null, status: null },
        { id: "y", title: "Step Y", command: "echo y", description: null, status: null },
      ],
    });
    expect(replacedCount).toBe(2);
    // New steps get prefixed IDs
    expect(merged.steps[1]!.id).toBe("r1-x");
    expect(merged.steps[2]!.id).toBe("r1-y");
  });

  it("uses new plan summary", () => {
    const old = makePlan("pending");
    const { merged } = mergePlan(old, { summary: "New strategy", steps: [{ id: "1", title: "T", command: null, description: null, status: null }] });
    expect(merged.summary).toBe("New strategy");
  });

  it("falls back to old summary when new summary is null", () => {
    const old = new PlanState("Original summary", [makeStep("1", "pending")]);
    const { merged } = mergePlan(old, { summary: null, steps: [{ id: "1", title: "T", command: null, description: null, status: null }] });
    expect(merged.summary).toBe("Original summary");
  });
});

// ---------------------------------------------------------------------------
// buildPlannerHistory
// ---------------------------------------------------------------------------

describe("buildPlannerHistory", () => {
  it("returns empty array for empty history", () => {
    expect(buildPlannerHistory([])).toEqual([]);
  });

  it("maps results to turns with exit codes", () => {
    const turns = buildPlannerHistory([makeResult("ls", 0)]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.exitCode).toBe(0);
    expect(turns[0]!.executedCommand).toBe("ls");
  });

  it("includes AGENT_NOTE for repeated failures", () => {
    const results = [makeResult("ls", 1), makeResult("ls", 1)];
    const turns = buildPlannerHistory(results);
    const lastTurnText = turns[1]!.stdout + turns[1]!.stderr;
    expect(lastTurnText).toContain("AGENT_NOTE");
    expect(lastTurnText).toContain("failed 2 times");
  });

  it("includes AGENT_NOTE for medium/high risk commands", () => {
    const result = { ...makeResult("rm -rf /tmp/foo", 0), riskLevel: "high" };
    const turns = buildPlannerHistory([result]);
    const text = turns[0]!.stdout + turns[0]!.stderr;
    expect(text).toContain("risk_level=HIGH");
  });

  it("injects plan_next note from active plan", () => {
    const plan = makePlan("completed", "pending");
    const turns = buildPlannerHistory([makeResult("echo done", 0)], plan);
    const lastText = turns[0]!.stderr;
    expect(lastText).toContain("plan_next=2");
  });
});

// ---------------------------------------------------------------------------
// determineStatus
// ---------------------------------------------------------------------------

describe("determineStatus", () => {
  it("returns planner_error when error message provided", () => {
    expect(determineStatus([], false, "timeout", false)).toBe("planner_error");
  });

  it("returns cancelled when user cancelled with no history", () => {
    expect(determineStatus([], false, null, true)).toBe("cancelled");
  });

  it("returns completed when planner completed and last exit was 0", () => {
    expect(determineStatus([makeResult("ls", 0)], true, null, false)).toBe("completed");
  });

  it("returns failed when last command exited non-zero", () => {
    expect(determineStatus([makeResult("ls", 1)], false, null, false)).toBe("failed");
  });

  it("returns no_action with empty history and no signals", () => {
    expect(determineStatus([], false, null, false)).toBe("no_action");
  });
});

// ---------------------------------------------------------------------------
// convertPlannerPlan
// ---------------------------------------------------------------------------

describe("convertPlannerPlan", () => {
  it("returns null for null input", () => {
    expect(convertPlannerPlan(null)).toBeNull();
  });

  it("returns null for empty steps array", () => {
    expect(convertPlannerPlan({ summary: "x", steps: [] })).toBeNull();
  });

  it("converts a valid plan", () => {
    const plan = convertPlannerPlan({
      summary: "Do things",
      steps: [{ id: "1", title: "First", command: "ls", description: null, status: "pending" }],
    });
    expect(plan).not.toBeNull();
    expect(plan!.summary).toBe("Do things");
    expect(plan!.steps[0]!.status).toBe("pending");
  });

  it("defaults missing status to pending", () => {
    const plan = convertPlannerPlan({
      summary: null,
      steps: [{ id: "1", title: "T", command: null, description: null, status: null }],
    });
    expect(plan!.steps[0]!.status).toBe("pending");
  });
});

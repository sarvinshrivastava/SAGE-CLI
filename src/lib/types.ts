/** 
 * Shared TypeScript types that mirror the Python dataclasses.
 */

// PlannerTurn represents one command execution cycle for planner feedback
export interface PlannerTurn {
  suggestedCommand: string;
  executedCommand: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// PlannerSuggestion indicates the chosen interaction mode
// thinkContent holds the raw <think>…</think> reasoning text when present
export type PlannerSuggestion =
  | { mode: "command"; command: string; thinkContent?: string }
  | { mode: "chat"; message: string; thinkContent?: string }
  | { mode: "plan"; plan: PlannerPlan; thinkContent?: string };

// PlanStep represents a single sub-goal within a planner-generated plan
export interface PlanStep {
  id: string;
  title: string | null;
  command: string | null;
  description: string | null;
  status: string | null;
}

// PlannerPlan encapsulates a multi-step planner strategy for complex goals
export interface PlannerPlan {
  summary: string | null;
  steps: PlanStep[];
}

// CommandResult captures suggested vs executed command details for history
export interface CommandResult {
  suggestedCommand: string;
  executedCommand: string;
  stdout: string[];
  stderr: string[];
  returncode: number;
  riskLevel: string;
  context: Record<string, unknown>;
  safetyNotes?: string | null;
  normalizedCommand?: string | null;
  score?: Record<string, number> | null;
  planStepId?: string | null;
  planStepStatus?: string | null;
}

// CommandStats tracks command execution statistics
export interface CommandStats {
  successes: number;
  failures: number;
}

// PlanStepState represents the state of a single step within a plan
export interface PlanStepState {
  id: string;
  title: string | null;
  command: string | null;
  description: string | null;
  status: string;
  historyIndices: number[];
}

// PlanState represents the overall state of a multi-step plan
export interface PlanState {
  summary: string | null;
  steps: PlanStepState[];
}

// SafetyDecision indicates the safety level and requirements for a command
export interface SafetyDecision {
  level: string;
  requireConfirmation: boolean;
  notes?: string | null;
}

// SafetyRule defines a rule for determining command safety
export interface SafetyRule {
  pattern: string;
  level: string;
  requireConfirmation?: boolean;
  allowedFlags?: string[] | null;
  description?: string | null;
}

// PlannerConfig holds the planner configuration settings
export interface PlannerConfig {
  backend: string;
  model: string | null;
  timeout: number | null;
  apiKey: string | null;
  referer: string | null;
  title: string | null;
  baseUrl: string | null;
  version: string | null;
}

// AppConfig holds the overall application configuration
export interface AppConfig {
  planner: PlannerConfig;
  sessionDir: string | null;
  sessionPersist: boolean;
  safetyPolicyPath: string | null;
}
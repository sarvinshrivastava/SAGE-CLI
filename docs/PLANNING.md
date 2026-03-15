# Planner & Plan Mode Reference

This document explains how the hierarchical planner interface is structured and how the REPL consumes and annotates planner output.

## Planner Response Modes

The planner always returns **valid JSON** with a `mode` field. Three schemas are supported:

### `command` — single shell command

```json
{ "mode": "command", "command": "sudo apt-get update -y" }
```

### `chat` — conversational reply (clarification or information)

```json
{ "mode": "chat", "message": "I need to know which distro you're targeting." }
```

The message is displayed in the persistent `OutputLog` immediately. If the model used chain-of-thought (`<think>…</think>`), the reasoning is surfaced in dimmed gray above the message.

### `plan` — multi-step strategy

```json
{
  "mode": "plan",
  "plan": {
    "summary": "Deploy nginx and host the demo app",
    "steps": [
      { "id": "1", "title": "Update package index", "command": "sudo apt-get update -y" },
      { "id": "2", "title": "Install nginx",        "command": "sudo apt-get install -y nginx" },
      { "id": "3", "title": "Deploy app",           "description": "Copy artefacts and reload nginx" }
    ]
  }
}
```

Step fields:

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | Unique string identifier within the plan |
| `title` | recommended | Short human label; falls back to `command` then `Step <id>` |
| `command` | optional | Suggested shell command for this step |
| `description` | optional | Free-text detail; shown in plan views |
| `status` | optional | `pending` by default; set by the runtime |

## Plan Lifecycle in the App

```
planner returns mode:"plan"
        │
        ▼
convertPlannerPlan() builds PlanState + PlanStepState[]
        │
        ▼
addLog({ type:"plan", summary, stepCount })   ← persisted to OutputLog
        │
        ▼
__plan_acknowledged__ pushed to goalHistory   ← prevents planner loop
        │
        ▼
showPlan phase (800ms) → planning phase resumes
        │
        ▼
reviewing phase: PlanStrip shown above CommandReview
   step = plan.currentStep() (first non-completed)
        │
        ▼
user accepts → executing phase
   plan.markRunning(step.id)              ← step → in_progress
        │
        ▼
command exits
   plan.recordResult(step.id, success, histIdx)  ← step → completed|failed
        │
        ▼
next planner call includes AGENT_NOTE: plan_next=<id>
```

## PlanStrip UI

During `reviewing` and `executing` phases, a horizontal strip renders above the active panel:

```
✓ 1. update pkgs  ─  ● 2. install nginx  ─  ○ 3. deploy app
```

Icon mapping:

| Icon | Color | Status |
|------|-------|--------|
| `○` | gray | pending |
| `●` | yellow | in_progress |
| `✓` | green | completed |
| `✗` | red | failed |

Maximum 6 steps visible; overflow shown as `+N more` in gray.

## Feedback to the Planner

`buildPlannerHistory()` in `src/lib/planState.ts` transforms `CommandResult[]` into `PlannerTurn[]` sent as conversation context on every `planner.suggest()` call. It injects `AGENT_NOTE:` annotations:

| Condition | Note injected |
|-----------|--------------|
| Command failed more than once | `AGENT_NOTE: command has failed N times.` |
| Risk level medium or high | `AGENT_NOTE: risk_level=MEDIUM` |
| Safety policy notes exist | `AGENT_NOTE: safety_policy=<notes>` |
| Plan step completed/failed | `AGENT_NOTE: plan_step=<id> status=<status>` |
| Command score shows failures ≥ successes | `AGENT_NOTE: command_history=N success/M failure` |
| Plan has a next step | `AGENT_NOTE: plan_next=<id> status=pending label=<title>` (appended to last turn's stderr) |

## Output Compression

Command output sent back to the planner is compressed to avoid consuming the model's context window. `compressOutput()` keeps the first 2 000 and last 2 000 characters with a `…[truncated]…` marker. Full output is only sent for:

- Failed commands (exit code ≠ 0).
- Whitelisted info commands: `pwd`, `ls`, `whoami`, `cat`, `grep`, `echo`.

## Repeated Failure Guard

Before the planner's command suggestion is accepted, `isRepeatedFailure()` scans the **full** goal history (not just the last two turns) and counts failures for the normalized command. If the same command has failed ≥ 2 times across any positions in history, the guard fires, injects a `buildRepeatFeedback()` note, and forces one retry. If the second attempt still returns the same command, a `PlannerError` is raised.

## think Block Handling

Models that emit `<think>…</think>` reasoning tokens (e.g. Qwen3, DeepSeek-R1) have the block extracted before JSON parsing. The raw text is stored as `thinkContent` on the `PlannerSuggestion` and surfaced in the `OutputLog` for `chat` responses, letting users inspect the model's reasoning without it interfering with command parsing.

## Extending Plan Mode

When adding new plan features:

1. Add new fields to `PlanStep` / `PlannerPlan` in `src/lib/types.ts`.
2. Update `convertPlannerPlan()` in `src/lib/planState.ts` to map the new fields into `PlanStepState`.
3. Thread metadata through `serializeResult()` and session persistence.
4. Update `emitPlanCreated` / `emitPlanUpdate` in `src/lib/telemetry.ts` if new fields should appear in telemetry.
5. Update the system prompt in `src/lib/planner.ts` (the `SYSTEM_PROMPT` constant) to inform the model of the new schema.
6. Document the change in `README.md` and this file.

## Persistence & Telemetry

- Sessions store the full plan dict (`plan.toDict()`) in goal metadata when a plan was active.
- `plan_created` telemetry event fires when `convertPlannerPlan()` succeeds.
- `plan_updated` fires after each `plan.recordResult()` call, capturing the full step array and the step that just transitioned.
- `execution` events include `plan_step_id` and `plan_step_status` for per-command provenance.

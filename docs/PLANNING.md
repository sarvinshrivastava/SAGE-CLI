# Planner & Plan Mode Reference

This document explains how the hierarchical planner interface is structured and how the REPL consumes and annotates planner output.

## Planner Response Modes

The planner returns JSON with a `mode` field:

- `command`: single shell command suggestion.
- `chat`: natural-language response to the user.
- `plan`: multi-step strategy containing a summary and ordered steps.

```json
{
  "mode": "plan",
  "plan": {
    "summary": "Deploy nginx and host the demo app",
    "steps": [
      {
        "id": "1",
        "title": "Update package index",
        "command": "sudo apt-get update -y"
      },
      {
        "id": "2",
        "title": "Install nginx",
        "command": "sudo apt-get install -y nginx"
      },
      {
        "id": "3",
        "title": "Deploy app",
        "description": "Copy artefacts and reload nginx"
      }
    ]
  }
}
```

### PlannerPrompt Highlights

- The system prompt enumerates the three schemas (`command`, `chat`, `plan`).
- It instructs the model to produce concise step titles, optional commands, and default statuses.
- The planner is reminded not to repeat failing commands and to use plan mode when multi-step execution is required.

## Shell Integration

1. **Broadcast**: When `mode:"plan"` arrives, `PlanState` is created and rendered for the user.
2. **Step Selection**: The earliest step not marked `completed` becomes `current_step`.
3. **Confirmation Context**: The command confirmation panel displays the step ID, title, description, and planned command for easy comparison.
4. **Execution Tracking**:
   - Before execution, the step transitions to `in_progress`.
   - When the command finishes, the step becomes `completed` or `failed` and captures the history index.
5. **Progress Rendering**: After each update the plan is re-rendered, showing status per step.

## Feedback to the Planner

- Every command result generates `AGENT_NOTE` entries when a plan step finishes or fails.
- The next planner turn includes the upcoming step (ID, label, status) so the model keeps track of unfinished work.
- Adaptive command scores are also serialized into planner history, helping the model avoid commands with repeated failures.

## Persistence & Telemetry

- Session metadata now stores `plan` with `summary`, `steps`, and per-step history indexes.
- Telemetry emits `plan_created` when a new plan is received and `plan_updated` after each step completion or failure.
- `execution` events include `plan_step_id` and `plan_step_status` so downstream analytics can correlate commands to plan steps.

## Extending Plan Mode

When enhancing plan features:

1. Update `PlannerPlan` / `PlanStep` dataclasses if new fields are needed.
2. Thread the metadata through `PlanState`, telemetry payloads, and session serialization.
3. Adjust planner prompts to reflect any new schema requirements.
4. Document the behaviour change in `README.md` and ensure `docs/PLANNING.md` lists new fields or rules.

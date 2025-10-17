# Telemetry Events

The CLI emits structured JSON Lines (one JSON object per line) to `logs/telemetry.jsonl` unless disabled. This document describes each event type and its payload.

## Common Fields

All events include:

| Field          | Type     | Description                                     |
| -------------- | -------- | ----------------------------------------------- |
| `event`        | `string` | Event type (`execution`, `plan_created`, etc.). |
| `goal`         | `string` | User-supplied high-level goal.                  |
| `session_id`   | `string` | Session identifier when persistence is enabled. |
| `planner_info` | `object` | Backend metadata (e.g., model, version).        |
| `timestamp`    | `string` | UTC ISO-8601 timestamp (injected on write).     |

## `execution`

Emitted after each command run.

```json
{
  "event": "execution",
  "goal": "Install nginx",
  "session_id": "2025-10-18-abc123",
  "planner_info": { "backend": "openrouter", "model": "deepseek/..." },
  "command": "sudo apt-get install -y nginx",
  "suggested_command": "sudo apt-get install -y nginx",
  "executed_command": "sudo apt-get install -y nginx",
  "risk_level": "medium",
  "risk_notes": "Apt installs should include -y for non-interactive mode.",
  "exit_code": 0,
  "duration_seconds": 5.41,
  "environment": { "cwd": "/srv", "user": "deploy" },
  "runtime": { "started_at": "2025-10-18T12:30:04Z", "exit_code": 0 },
  "normalized_command": "sudo apt-get install -y nginx",
  "command_score": { "successes": 1, "failures": 0, "score": 1 },
  "plan_step_id": "2",
  "plan_step_status": "completed"
}
```

### Field Notes

- `command` reflects the final text executed (post-edit).
- `normalized_command` is the scoreboard key (arguments normalized).
- `command_score` tracks successes/failures for the normalized command.
- Plan-aware fields are `plan_step_id` and `plan_step_status` (if a plan is active).

## `plan_created`

Emitted when the planner returns `mode:"plan"`.

```json
{
  "event": "plan_created",
  "goal": "Provision web stack",
  "session_id": "2025-10-18-abc123",
  "planner_info": { "backend": "openrouter", "model": "deepseek/..." },
  "plan": {
    "summary": "Deploy nginx with demo app",
    "steps": [
      {
        "id": "1",
        "title": "Update packages",
        "command": "sudo apt-get update -y",
        "status": "pending",
        "history": []
      },
      {
        "id": "2",
        "title": "Install nginx",
        "command": "sudo apt-get install -y nginx",
        "status": "pending",
        "history": []
      }
    ]
  }
}
```

## `plan_updated`

Emitted after each step transitions to `completed` or `failed`.

```json
{
  "event": "plan_updated",
  "goal": "Provision web stack",
  "session_id": "2025-10-18-abc123",
  "planner_info": { "backend": "openrouter", "model": "deepseek/..." },
  "plan": {
    "summary": "Deploy nginx with demo app",
    "steps": [
      {
        "id": "1",
        "title": "Update packages",
        "command": "sudo apt-get update -y",
        "status": "completed",
        "history": [0]
      },
      {
        "id": "2",
        "title": "Install nginx",
        "command": "sudo apt-get install -y nginx",
        "status": "pending",
        "history": []
      }
    ]
  },
  "step_id": "1",
  "status": "completed"
}
```

## Disabling Telemetry

- Launch without `--telemetry-file` and unset `AGENT_TELEMETRY_FILE` to disable writes.
- Telemetry writes are best-effort; failures to append a line do not crash the REPL.

## Analyzing Logs

Use tools like `jq` or Python scripts to aggregate event streams:

```bash
jq 'select(.event == "execution") | .exit_code' logs/telemetry.jsonl | sort | uniq -c
```

For time-series monitoring, ship the JSONL file into your favorite observability stack (e.g., Loki, Elasticsearch, BigQuery).

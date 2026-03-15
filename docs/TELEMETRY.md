# Telemetry Events

SAGE-CLI emits structured JSON Lines (one JSON object per line) to `logs/telemetry.jsonl` by default. This document describes each event type, its payload, and how to work with the log.

---

## Enabling & Disabling

| Method | Effect |
|--------|--------|
| Default (no flag) | Writes to `logs/telemetry.jsonl` relative to cwd |
| `--telemetry-file <path>` | Writes to the specified absolute or relative path |
| `--telemetry-file ""` | Disables telemetry entirely |
| `AGENT_TELEMETRY_FILE=<path>` | Same as `--telemetry-file` (CLI flag takes precedence) |
| `AGENT_TELEMETRY_FILE=""` | Disables telemetry via env var |

Telemetry writes are **best-effort** — a write failure does not crash the REPL.

---

## Common Fields

Every event includes:

| Field | Type | Description |
|-------|------|-------------|
| `event` | `string` | Event type identifier |
| `goal` | `string` | User-supplied natural-language goal |
| `session_id` | `string \| null` | Session ID when persistence is enabled, `null` otherwise |
| `planner_info` | `object` | Backend metadata — `backend`, optional `model`, optional `version` |
| `timestamp` | `string` | UTC ISO-8601 timestamp, injected on write |

---

## Event: `execution`

Emitted after **each command** finishes (exit code received).

```json
{
  "event": "execution",
  "goal": "Install nginx",
  "session_id": "20260314-102831",
  "planner_info": { "backend": "openrouter", "model": "deepseek/deepseek-r1-0528-qwen3-8b:free" },
  "command": "sudo apt-get install -y nginx",
  "suggested_command": "sudo apt-get install -y nginx",
  "executed_command": "sudo apt-get install -y nginx",
  "risk_level": "medium",
  "risk_notes": "Apt installs should include -y for non-interactive mode.",
  "exit_code": 0,
  "normalized_command": "sudo apt-get install -y nginx",
  "command_score": { "successes": 1, "failures": 0, "score": 1 },
  "plan_step_id": "2",
  "plan_step_status": "completed",
  "timestamp": "2026-03-14T10:28:45.123Z"
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `command` | Final text executed (may differ from `suggested_command` if user edited) |
| `suggested_command` | Original command returned by the planner |
| `executed_command` | Same as `command`; retained for backwards compatibility |
| `normalized_command` | Whitespace-collapsed version used as the scoreboard key |
| `command_score` | Cumulative stats for `normalized_command` across the session |
| `plan_step_id` | Present only when a plan was active |
| `plan_step_status` | Step status at the moment of command completion (`completed` or `failed`) |

---

## Event: `plan_created`

Emitted when the planner returns `mode: "plan"` and `convertPlannerPlan()` succeeds.

```json
{
  "event": "plan_created",
  "goal": "Provision nginx web stack",
  "session_id": "20260314-102831",
  "planner_info": { "backend": "ollama", "model": "qwen3:8b" },
  "plan": {
    "summary": "Deploy nginx with demo app",
    "steps": [
      { "id": "1", "title": "Update packages", "command": "sudo apt-get update -y",        "label": "Update packages", "description": null, "status": "pending", "history": [] },
      { "id": "2", "title": "Install nginx",   "command": "sudo apt-get install -y nginx", "label": "Install nginx",   "description": null, "status": "pending", "history": [] },
      { "id": "3", "title": "Deploy app",      "command": null,                            "label": "Deploy app",      "description": "Copy artefacts and reload nginx", "status": "pending", "history": [] }
    ]
  },
  "timestamp": "2026-03-14T10:28:32.000Z"
}
```

---

## Event: `plan_updated`

Emitted after **each step** transitions to `completed` or `failed` (triggered inside `recordResult()`).

```json
{
  "event": "plan_updated",
  "goal": "Provision nginx web stack",
  "session_id": "20260314-102831",
  "planner_info": { "backend": "ollama", "model": "qwen3:8b" },
  "plan": {
    "summary": "Deploy nginx with demo app",
    "steps": [
      { "id": "1", "title": "Update packages", "status": "completed", "history": [0] },
      { "id": "2", "title": "Install nginx",   "status": "pending",   "history": [] },
      { "id": "3", "title": "Deploy app",      "status": "pending",   "history": [] }
    ]
  },
  "step_id": "1",
  "status": "completed",
  "timestamp": "2026-03-14T10:28:44.000Z"
}
```

---

## Session Files

In addition to telemetry, session files (`sessions/<sessionId>.jsonl`) record each completed goal as a single JSON Lines entry:

```json
{
  "timestamp": "2026-03-14T10:29:00.000Z",
  "goal": "Install nginx",
  "status": "completed",
  "steps": [
    {
      "suggested_command": "sudo apt-get update -y",
      "executed_command": "sudo apt-get update -y",
      "exit_code": 0,
      "risk_level": "medium",
      "plan_step_id": "1",
      "plan_step_status": "completed"
    }
  ],
  "metadata": {
    "planner_completed": true,
    "user_cancelled": false,
    "planner_info": { "backend": "openrouter" },
    "risk_levels": ["medium"],
    "plan": { "summary": "...", "steps": [...] }
  }
}
```

Session ID format: `YYYYMMDD-HHMMSS` (e.g. `20260314-102831`). Override with `--session-id`.

---

## Analyzing Logs

```bash
# Count exit codes across all executions
jq 'select(.event == "execution") | .exit_code' logs/telemetry.jsonl | sort | uniq -c

# List all goals with their final status
jq 'select(.goal and .status) | {goal, status}' sessions/*.jsonl

# Find all high-risk commands
jq 'select(.event == "execution" and .risk_level == "high") | .command' logs/telemetry.jsonl

# Summarise plan step failure rates
jq 'select(.event == "plan_updated" and .status == "failed") | .step_id' logs/telemetry.jsonl | sort | uniq -c

# Tail live events during a session
tail -f logs/telemetry.jsonl | jq .
```

For time-series monitoring, ship the JSONL file to your observability stack (Loki, Elasticsearch, BigQuery, etc.).

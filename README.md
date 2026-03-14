# SAGE CLI - Smart Agent Goal Execution CLI

An interactive command-line REPL built with TypeScript and [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) that collaborates with a large language model to achieve high-level system goals safely. The assistant turns user intents into step-by-step shell commands, streams execution output, captures telemetry, and learns from feedback.

## Features

- **Goal-driven REPL**: send a high-level task, review/edit suggested commands, and let the planner iterate until the job completes, switching between chat or command responses as needed.
- **Hierarchical planning**: models can emit multi-step plans (`mode: "plan"`) with ordered sub-goals; the shell renders plan summaries, tracks step state, and resumes unfinished work.
- **Smart confirmation UI**: interactive prompt shows color-coded diffs, risk notes, adaptive history scores, and quick actions (A/E/S) before executing each command.
- **Safety policy engine**: configurable JSON rules plus built-in heuristics classify command risk, enforce confirmations, and log safety notes for audit trails.
- **Adaptive command memory**: a per-command scoreboard tracks successes vs failures, surfaces guidance during confirmation, and feeds corrective notes back to the planner.
- **Streaming observability**: live stdout/stderr, structured command telemetry, and persistent session logs capture runtime context, planner metadata, and plan progress.
- **Token-aware feedback**: planner history keeps detailed output only for failures or whitelisted utilities, reducing prompt bloat while still sharing critical diagnostics.
- **Extensible planner integration**: OpenRouter backend by default with Ollama and mock fallbacks, all controlled by CLI flags, environment variables, or `config.json`.

## Getting Started

```bash
git clone https://github.com/sarvinshrivastava/SAGE-CLI
cd SAGE-CLI
./setup.sh
```

Required setup:

- Node.js 18+
- OpenRouter API access with `OPENROUTER_API_KEY` stored in `.env`.
- (Optional) `.env` entries for `OPENROUTER_MODEL`, `OPENROUTER_TIMEOUT`, `OPENROUTER_SITE_URL`, or `OPENROUTER_SITE_NAME` to fine-tune requests.

```bash
# OpenRouter (default)
node dist/index.js

# Local Ollama
node dist/index.js --planner ollama --planner-model qwen3:8b

# Mock planner (no network needed)
node dist/index.js --planner mock
```

## Key CLI Options

- `--planner <name>` — `openrouter` | `ollama` | `mock`
- `--planner-model <model>` / `--planner-timeout <secs>` / `--planner-version <ver>`
- `--planner-api-key <key>` / `--planner-referer <url>` / `--planner-title <name>` / `--planner-base-url <url>`
- `--session-dir <dir>` / `--session-id <id>` / `--no-persist`
- `--config <path>` (JSON config file)
- `--allow-root` / `--safety-off` / `--safety-policy <path>`
- `--log-file <path>` / `--telemetry-file <path>`

Type `:new` to rotate sessions or `:session` to inspect the current log target.

## Configuration

Example `config.json`:

```json
{
  "planner": {
    "backend": "openrouter",
    "model": "deepseek/deepseek-r1-0528-qwen3-8b:free",
    "timeout": 120,
    "api_key": "${OPENROUTER_API_KEY}",
    "referer": "https://your-site.example",
    "title": "SAGE CLI",
    "base_url": "https://openrouter.ai/api/v1/chat/completions"
  },
  "session": {
    "directory": "~/agent-sessions",
    "persist": true
  },
  "safety": {
    "policy": "config/safety-policy.json"
  }
}
```

## Safety Policy

Safety rules are loaded from (in priority order):

1. `--safety-policy <path>`
2. `AGENT_SAFETY_POLICY` environment variable
3. `safety_policy.json` in working directory
4. Built-in defaults in `src/lib/safety.ts`

Example policy JSON:

```json
{
  "rules": [
    {
      "pattern": "\\bapt(-get)?\\s+install\\b",
      "level": "medium",
      "allowed_flags": ["-y"],
      "description": "Installs should include -y to avoid blocking prompts."
    },
    {
      "pattern": "rm -rf /",
      "level": "high",
      "require_confirmation": true
    }
  ]
}
```

## Telemetry & Analytics

Structured telemetry events are appended to `logs/telemetry.jsonl` by default. Three event types:

- `execution`: every command run, including risk level, normalized command signature, adaptive score, safety notes, and optional plan-step linkage.
- `plan_created`: the planner returned a multi-step plan; payload contains the plan summary and step definitions.
- `plan_updated`: a plan step finished; payload includes the latest plan snapshot and step status.

## Project Structure

```
src/
  index.tsx               Entry point — arg parsing, renders <App />
  App.tsx                 Top-level Ink component, REPL state machine
  components/
    GoalPrompt.tsx        "User> " text input
    CommandReview.tsx     Diff + risk info + A/E/S action bar
    PlanView.tsx          Multi-step plan with status colors
    GoalSummary.tsx       End-of-goal result table
    StreamOutput.tsx      Live stdout/stderr display
  hooks/
    usePlanner.ts         Async hook wrapping planner.suggest()
    useCommandExec.ts     Spawns child process, streams output
  lib/
    planner.ts            OpenRouterPlanner, OllamaPlanner, MockPlanner
    safety.ts             SafetyPolicy engine
    planState.ts          PlanState, buildPlannerHistory, compressOutput
    config.ts             AppConfig loader
    session.ts            SessionManager (JSONL)
    telemetry.ts          TelemetryEmitter (JSONL)
    scoreboard.ts         CommandScoreboard
    logger.ts             File logger
    types.ts              Shared TypeScript interfaces
    env.ts                .env loader
```

## Safety Notes

- Commands run under your user account; high-risk actions require explicit confirmation.
- Running as root is discouraged — use `--allow-root` only when you understand the implications.
- Planner prompts forbid declaring success when prior commands failed and annotate repeated failures/risk levels.

## Further Reading

- [Conversation Flow](docs/conversation-flow.md): step-by-step diagram of the REPL, planner, and execution pipeline.
- [Planner & Plan Mode Reference](docs/PLANNING.md): schema details and integration notes for hierarchical planning.
- [Telemetry Events](docs/TELEMETRY.md): field-by-field documentation for `execution`, `plan_created`, and `plan_updated` events.
- [Security & Safety Guidance](docs/SECURITY.md): best practices for safety policies, secrets management, and secure operations.
- [Contributing Guide](docs/CONTRIBUTING.md): workflow expectations, coding standards, and how to submit changes.

## License

This project is released under the MIT License. See [`LICENSE`](./LICENSE) for the complete terms, including permissions for reuse, modification, and distribution.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SAGE CLI (Smart Agent Goal Execution CLI) is an interactive terminal REPL built with TypeScript and Ink (React for CLIs). It takes natural-language goals from a user, sends them to an LLM planner (OpenRouter or local Ollama), and iteratively executes the suggested shell commands with safety checks, user confirmation, and telemetry.

## Setup & Running

```bash
npm install
npm run build
```

Requires `OPENROUTER_API_KEY` in a `.env` file at the project root.

```bash
# Run with OpenRouter (default)
node dist/index.js

# Run with local Ollama
node dist/index.js --planner ollama --planner-model qwen3:8b

# Run with mock planner (no network needed)
node dist/index.js --planner mock

# Run with config file
node dist/index.js --config config.json
```

## Validation (No Formal Test Suite)

```bash
# Type-check without building
npx tsc --noEmit

# Build
npm run build

# Smoke test with mock planner (requires interactive TTY)
node dist/index.js --planner mock
```

## Architecture

All source lives in `src/`. The entry point is `src/index.tsx`.

### Request/Response Cycle

The core state machine in `App.tsx` works like this:

1. **idle** — user types a goal at the `User>` prompt (`GoalPrompt`).
2. **planning** — `planner.suggest(goal, history)` is called; spinner shown.
3. Planner returns one of three modes:
   - `"plan"` — multi-step strategy; rendered via `PlanView`, then loops back to planning.
   - `"chat"` — informational reply; printed and loop ends.
   - `"command"` — shell command; enters `reviewing` phase.
4. **reviewing** — `CommandReview` shows diff, risk level, scoreboard history; user presses A/E/S.
5. **executing** — `useCommandExec` spawns the shell command; `StreamOutput` shows live output.
6. `CommandResult` (exit code, stdout, stderr, risk level) is appended to `goalHistory` and fed back to the planner.
7. Loop continues until planner says `DONE`, user skips, or a `PlannerError` occurs.
8. **summary** — `GoalSummary` shows the numbered result table; session is recorded.

### Planner Abstraction (`src/lib/planner.ts`)

- `CommandPlanner` — abstract base; `suggest()` returns a `PlannerSuggestion`.
- `OpenRouterPlanner` — calls OpenRouter's chat completions API via native `fetch()`.
- `OllamaPlanner` — subclass of `OpenRouterPlanner`; hits `localhost:11434`, no auth header.
- `MockCommandPlanner` — echoes the goal; used for offline testing.
- `createPlanner(name, opts)` — factory used by `index.tsx`.
- `parsePlannerReply()` strips `<think>` blocks, extracts JSON, handles malformed responses.

### Plan State (`src/lib/planState.ts`)

`PlanState` / `PlanStepState` track a multi-step plan's progress. `buildPlannerHistory()` injects `AGENT_NOTE:` annotations (plan step status, failure tallies, risk levels) into the feedback sent back to the planner.

### Safety Policy (`src/lib/safety.ts`)

`SafetyPolicy.evaluate(command)` returns a `SafetyDecision` (level: low/medium/high, `requireConfirmation`, notes). Rules are regex-based and loaded from JSON in priority order: `--safety-policy` flag → `AGENT_SAFETY_POLICY` env var → `safety_policy.json` → built-in defaults.

### Output Filtering

`shouldSendFullOutput()` controls how much command output is fed back to the planner. Full stdout/stderr is only sent for failed commands or those in `OUTPUT_WHITELIST` (`pwd`, `ls`, `whoami`, `cat`, `grep`, `echo`).

### Telemetry & Sessions

- `TelemetryEmitterImpl` — appends JSONL events to `logs/telemetry.jsonl` by default.
- `SessionManagerImpl` — persists goal runs as JSONL under `sessions/`.

### Configuration Priority

CLI flags > `config.json` > environment variables > built-in defaults.

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Required for OpenRouter backend |
| `OPENROUTER_MODEL` | Override model (default: `deepseek/deepseek-r1-0528-qwen3-8b:free`) |
| `OLLAMA_HOST` | Override Ollama base URL (default: `http://localhost:11434`) |
| `OLLAMA_MODEL` | Override Ollama model (default: `qwen3:8b`) |
| `AGENT_PLANNER` | Default planner backend (`openrouter`, `ollama`, `mock`) |
| `AGENT_SAFETY_POLICY` | Path to safety policy file |
| `AGENT_TELEMETRY_FILE` | Path for telemetry JSONL output |
| `AGENT_SESSION_DIR` | Override sessions directory |
| `AGENT_LOG_FILE` | Path for runtime log file |
| `AGENT_ALLOW_ROOT` | Set to `1` to bypass root check |
| `AGENT_DISABLE_SAFETY` | Set to `1` to skip safety checks |

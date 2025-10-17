# SAGE CLI - Smart Agent Goal Execution CLI

An interactive command-line REPL that collaborates with a large language model to achieve high-level system goals safely. The assistant turns user intents into step-by-step shell commands, streams execution output, captures telemetry, and learns from feedback.

## Features

- **Goal-driven loop**: send a high-level task, review/edit suggested commands, confirm execution, and let the planner iterate until the job completes.
- **Planner integration**: works with local Ollama models by default, with adapters for mock/testing backends and support for custom models/providers via CLI, environment, or JSON config.
- **Editable confirmation UI**: proposed commands appear in an editable prompt (powered by `prompt_toolkit`) before running.
- **Streaming execution**: live stdout/stderr with buffered history (rendered using `rich`).
- **Multi-step reasoning**: planner receives full command/output context and stops only after emitting `DONE`.
- **Session persistence**: optional JSONL logs per goal containing commands, outputs, statuses, and risk annotations; meta commands (`:new`, `:session`) manage sessions.
- **Safety guardrails**: root-run prevention, command risk classification, high-risk confirmations, and planner feedback when repeated failures occur.
- **Observability**: structured logging, configurable log destinations, and rich goal summaries for quick reviews.

## Getting Started

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 src/agent_shell.py --planner-timeout 90
```

Required services:

- **Ollama** running locally (default `http://localhost:11434`).
- `.env` (optional) for values like `OLLAMA_MODEL=deepseek-r1:8b`, `OLLAMA_TIMEOUT=120`.

Run with `--config ./config.json` to load defaults (planner model/timeout/providers, session directory, persistence preference). CLI flags always override config/environment.

## Key CLI Options

- `--planner MODEL` / `--planner-provider provider` / `--planner-timeout SEC`
- `--session-dir DIR` / `--session-id ID` / `--no-persist` / `--persist`
- `--config PATH` (JSON config file)
- `--allow-root` (skip root block) / `--safety-off` (disable risk prompts)
- `--log-file PATH` (write structured logs)

Type `:new` to rotate sessions or `:session` to inspect the current log target.

## Configuration

Example `config.json`:

```json
{
  "planner": {
    "backend": "ollama",
    "model": "deepseek-r1:8b",
    "timeout": 120,
    "providers": ["cpu"]
  },
  "session": {
    "directory": "~/agent-sessions",
    "persist": true
  }
}
```

## Project Structure

```
src/
  agent_shell.py   # main REPL orchestrator
  planner.py       # LLM command planner abstraction (Ollama + mock)
  session.py       # session persistence helpers
  config.py        # config loader and planner settings
```

## Safety Notes

- Commands run under your user account; high-risk actions require explicit confirmation.
- Running as root is discouraged—use `--allow-root` only when you understand the implications.
- Planner prompts forbid declaring success when prior commands failed and annotate repeated failures/risk levels.

## License

MIT License.

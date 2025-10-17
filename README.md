# SAGE CLI - Smart Agent Goal Execution CLI

An interactive command-line REPL that collaborates with a large language model to achieve high-level system goals safely. The assistant turns user intents into step-by-step shell commands, streams execution output, captures telemetry, and learns from feedback.

## Features

- **Goal-driven REPL**: send a high-level task, review/edit suggested commands, and let the planner iterate until the job completes, switching between chat or command responses as needed.
- **Hierarchical planning**: models can emit multi-step plans (`mode: "plan"`) with ordered sub-goals; the shell renders plan summaries, tracks step state, and resumes unfinished work.
- **Smart confirmation UI**: interactive prompt shows color-coded diffs, risk notes, adaptive history scores, and quick actions (A/E/S) before executing each command.
- **Safety policy engine**: configurable JSON/YAML rules plus built-in heuristics classify command risk, enforce confirmations, and log safety notes for audit trails.
- **Adaptive command memory**: a per-command scoreboard tracks successes vs failures, surfaces guidance during confirmation, and feeds corrective notes back to the planner.
- **Streaming observability**: live stdout/stderr via `rich`, structured command telemetry, and persistent session logs capture runtime context, planner metadata, and plan progress.
- **Token-aware feedback**: planner history keeps detailed output only for failures or whitelisted utilities, reducing prompt bloat while still sharing critical diagnostics.
- **Extensible planner integration**: OpenRouter backend by default with a mock fallback, all controlled by CLI flags, environment variables, or `config.json`.

## Getting Started

```bash
git clone https://github.com/sarvinshrivastava/SAGE-CLI
chmod 400 setup.sh
./setup.sh
```

Required setup:

- OpenRouter API access with `OPENROUTER_API_KEY` stored in `.env`.
- (Optional) `.env` entries for `OPENROUTER_MODEL`, `OPENROUTER_TIMEOUT`, `OPENROUTER_SITE_URL`, or `OPENROUTER_SITE_NAME` to fine-tune requests.
- (Optional) `AGENT_TELEMETRY_FILE` or `--telemetry-file` to choose where structured telemetry events are written (defaults to `logs/telemetry.jsonl`).

Run with `--config ./config.json` to load defaults (planner model/timeout, API key headers, session directory, persistence preference). CLI flags always override config/environment.

## Key CLI Options

- `--planner MODEL` / `--planner-timeout SEC` / `--planner-version VERSION`
- `--planner-api-key KEY` / `--planner-referer URL` / `--planner-title NAME` / `--planner-base-url URL`
- `--session-dir DIR` / `--session-id ID` / `--no-persist` / `--persist`
- `--config PATH` (JSON config file)
- `--allow-root` (skip root block) / `--safety-off` (disable risk prompts)
- `--safety-policy PATH` (override JSON/YAML policy file for risk rules)
- `--log-file PATH` (write structured logs)
- `--telemetry-file PATH` (emit structured JSONL telemetry; default `logs/telemetry.jsonl`)

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
    "base_url": "https://openrouter.ai/api/v1/chat/completions",
    "version": "2025.10"
  },
  "session": {
    "directory": "~/agent-sessions",
    "persist": true
  },
  "safety": {
    "policy": "config/safety-policy.yaml"
  }
}
```

## Safety Policy

Safety rules are loaded from (in priority order):

1. `--safety-policy PATH`
2. `AGENT_SAFETY_POLICY` environment variable
3. `config.json` → `safety.policy`
4. Built-in defaults in `src/safety.py`

Policies define regex-based rules with severity levels, optional confirmation requirements, and allowed flags. Both JSON and YAML formats are supported. Example snippet:

```yaml
rules:
  - pattern: "\\bsudo apt-get install\\b"
    level: medium
    allowed_flags: ["-y"]
    description: "Installs should include -y to avoid blocking prompts."
  - pattern: "rm -rf /"
    level: high
    require_confirmation: true
```

When a rule matches, the confirmation UI surfaces the note, records it in telemetry, and—if required—asks for an explicit `proceed` acknowledgement.

## Telemetry & Analytics

Structured telemetry events are appended to `logs/telemetry.jsonl` by default. Three event types are currently emitted:

- `execution`: every command run, including risk level, normalized command signature, adaptive score, safety notes, and optional plan-step linkage.
- `plan_created`: the planner returned a multi-step plan; payload contains the plan summary and step definitions.
- `plan_updated`: a plan step finished (success or failure); payload includes the latest plan snapshot and step status.

Point dashboards, data dog collectors, or custom scripts at this JSONL stream to monitor agent behavior across sessions.

## Project Structure

```
src/
  agent_shell.py   # main REPL orchestrator
  planner.py       # LLM command planner abstraction (OpenRouter + mock)
  session.py       # session persistence helpers
  config.py        # config loader and planner settings
  safety.py        # safety policy loader + rule evaluation
  telemetry.py     # structured telemetry emitter

## Further Reading

- [Conversation Flow](docs/conversation-flow.md): step-by-step diagram of the REPL, planner, and execution pipeline.
- [Planner & Plan Mode Reference](docs/PLANNING.md): schema details and integration notes for hierarchical planning.
- [Telemetry Events](docs/TELEMETRY.md): field-by-field documentation for `execution`, `plan_created`, and `plan_updated` events.
- [Security & Safety Guidance](docs/SECURITY.md): best practices for safety policies, secrets management, and secure operations.
- [Contributing Guide](docs/CONTRIBUTING.md): workflow expectations, coding standards, and how to submit changes.
```

## Safety Notes

- Commands run under your user account; high-risk actions require explicit confirmation.
- Running as root is discouraged—use `--allow-root` only when you understand the implications.
- Planner prompts forbid declaring success when prior commands failed and annotate repeated failures/risk levels.

## Further Reading

- [Conversation Flow](docs/conversation-flow.md): step-by-step diagram of the REPL, planner, and execution pipeline.
- [Planner & Plan Mode Reference](docs/PLANNING.md): schema details and integration notes for hierarchical planning.
- [Telemetry Events](docs/TELEMETRY.md): field-by-field documentation for `execution`, `plan_created`, and `plan_updated` events.
- [Security & Safety Guidance](docs/SECURITY.md): best practices for safety policies, secrets management, and secure operations.
- [Contributing Guide](docs/CONTRIBUTING.md): workflow expectations, coding standards, and how to submit changes.

## License

This project is released under the MIT License. See [`LICENSE`](./LICENSE) for the complete terms, including permissions for reuse, modification, and distribution.

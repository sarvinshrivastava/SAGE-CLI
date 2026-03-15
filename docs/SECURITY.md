# Security & Safety Guidance

SAGE-CLI executes AI-generated shell commands against your local machine. Read this document before running it in any environment that matters.

---

## Safety Policy Engine

Rules are evaluated in priority order (first match wins). Each rule specifies a `pattern` (regex), a `level` (`low` / `medium` / `high`), optional `require_confirmation`, optional `allowed_flags`, and an optional `description`.

**Load precedence (highest first):**

1. `--safety-policy <path>` CLI flag
2. `AGENT_SAFETY_POLICY` environment variable
3. `safety_policy.json` in the project root
4. Built-in defaults (compiled into `src/lib/safety.ts`)

**Rule JSON format:**

```json
{
  "rules": [
    {
      "pattern": "\\bwget\\b.*-O\\s*/",
      "level": "high",
      "require_confirmation": true,
      "description": "Writing wget output to an absolute path."
    },
    {
      "pattern": "\\bdocker\\s+run\\b",
      "level": "medium",
      "allowed_flags": ["--rm", "--read-only"],
      "description": "Prefer --rm and --read-only for ephemeral containers."
    }
  ]
}
```

**Important:** only JSON is supported for policy files. The policy file path is passed directly to `fs.readFileSync()` without path validation, and an invalid or unparseable file silently falls back to built-in defaults.

---

## Built-in High-Risk Patterns

The following patterns always require typing `proceed` to confirm (unless `--safety-off` is set):

| Pattern | Reason |
|---------|--------|
| `rm\s+-rf\s+/` | Recursive root delete |
| `:\(\)\s*{` | Fork bomb |
| `\bdd\s+if=` | Raw disk write |
| `\bmkfs\.\w*` | Filesystem format |
| `>\s*/dev/sd[0-9a-z]` | Direct block device write |
| `\bwipefs\b` | Wipe filesystem signatures |
| `\b(poweroff\|shutdown\|reboot\|halt)\b` | System state change |
| `\buserdel\b` | User deletion |
| `\bmkpart\b` | Partition creation |

---

## Running as Root

By default the CLI refuses to start when `geteuid() === 0`. Use `--allow-root` or `AGENT_ALLOW_ROOT=1` only in controlled environments (e.g. a container with no host mounts). Even with `--allow-root`, high-risk commands still require typed confirmation if a safety rule demands it.

---

## Safety-Off Mode

`--safety-off` or `AGENT_DISABLE_SAFETY=1` bypasses the rule engine. The risk level is always reported as `low` and no confirmation is ever required.

- The `⚠ safety off` indicator is shown inline in the `User›` prompt.
- All telemetry events include `"safety_disabled": true` in session metadata.
- Medium and high-risk patterns are still *displayed* to the user as informational labels in `CommandReview` — the disable flag only removes the confirmation gate, not the visual warning.

---

## Command Review Panel

Before any command executes, `CommandReview` shows:

- The suggested command with a `$ ` prefix in cyan.
- A risk badge: `[ LOW ]` green / `[ MEDIUM ]` yellow / `[ HIGH ]` red.
- Scoreboard history: prior successes and failures for this normalized command.
- Safety notes from the matching rule (e.g. "Apt installs should include -y").
- A word-level diff when the user has edited the command.

**Actions:**
- `A` — accept (skip confirmation for low/medium; prompt `proceed` for high-risk or `requireConfirmation: true`).
- `E` — edit the command inline before accepting.
- `S` — skip this command and end the goal.

Always read the diff panel before pressing `A`.

---

## Secrets & Credentials

- Store `OPENROUTER_API_KEY` in `.env` (project root) or in your shell environment — never hardcode it.
- The `.env` file must not be committed to version control (add it to `.gitignore`).
- The API key is passed to `OpenRouterPlanner` as a constructor argument. It is used in the `Authorization: Bearer` header and lives in memory for the process lifetime. It is **not** logged to any file.
- When using `--planner-api-key` on the CLI, be aware that the key may appear in your shell history.

---

## Telemetry & Session Files

Telemetry (`logs/telemetry.jsonl`) and session files (`sessions/*.jsonl`) capture:

- The goal text.
- Every command's `stdout`, `stderr`, and `exit_code` (compressed).
- Risk levels and safety notes.
- Plan structure and step statuses.

**These files may contain sensitive output** (file listings, usernames, partial secrets from command output). Ensure:

- The `logs/` and `sessions/` directories have restricted permissions (`chmod 700`).
- Files are rotated or deleted regularly — they grow without bound (no automatic rotation).
- If running in a shared environment, set `--session-dir` and `--telemetry-file` to paths only you can read.

To disable telemetry entirely: `--telemetry-file ""` or unset `AGENT_TELEMETRY_FILE`.

---

## Network Considerations

- Planner calls are made over HTTPS using Node.js's native `fetch()`. Certificate validation is performed by the underlying TLS stack.
- The `OllamaPlanner` communicates with `http://localhost:11434` by default — no credentials, no encryption. Override with `OLLAMA_HOST`.
- The `MockCommandPlanner` makes no network calls — safe for offline/air-gapped testing of safety policies and UI flows.

---

## Known Security Issues

The following are known limitations to be aware of:

| ID | Summary |
|----|---------|
| SEC-1 | `spawn(command, { shell: true })` — metacharacter injection |
| SEC-2 | stdin inherited — interactive commands freeze the UI |
| SEC-3 | Unbounded stdout/stderr buffers — OOM on verbose commands |
| SEC-4 | Session path unvalidated — path traversal via `--session-id` |
| SEC-5 | Safety policy path unvalidated + silent fallback on parse error |
| SEC-6 | Invalid regex in policy crashes process at startup |
| BUG-1 | `sudo` rule fires before `rm -rf /` rule — high-risk bypass |

---

## Reporting Vulnerabilities

Please open a private issue with the maintainers (or email the project owner directly) and avoid public disclosure until a fix is available and deployed.

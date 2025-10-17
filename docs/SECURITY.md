# Security & Safety Guidance

The Smart Agent Goal Execution CLI operates directly against your shell. Follow these practices to minimize risk.

## Safety Policies

- Policies load from (highest precedence first): `--safety-policy`, `AGENT_SAFETY_POLICY`, `config.json` (`safety.policy`), then built-in defaults.
- Rules support JSON or YAML with fields: `pattern` (regex), `level` (`low`/`medium`/`high`), optional `require_confirmation`, optional `allowed_flags`, and optional `description`.
- When a rule matches, the confirmation UI displays the notes, updates telemetry, and may require typing `proceed`.
- Keep custom patterns narrow to avoid unexpected matches. Test policies using dry-run commands before enabling in production environments.

## Running as Root

- By default the CLI prevents root execution. Use `--allow-root` only for controlled environments.
- Even with `--allow-root`, high-risk commands still require confirmation if a safety policy demands it.

## Environment Secrets

- Store `OPENROUTER_API_KEY` and other credentials inside `.env` or a secret manager, not in source control.
- Avoid printing API keys in telemetry by keeping telemetry files on secure storage and rotating them regularly.

## Network Considerations

- Planner calls are made over HTTPS to OpenRouter (or a configured proxy). Validate certificates in enterprise deployments.
- When using the mock planner (`--planner mock`) no network calls are made—ideal for offline testing of safety policies or telemetry.

## Command Review

- Always read the diff panel before executing. `A` accepts unchanged commands, `E` reopens the prompt, `S` skips.
- Medium/high-risk commands display warnings even when safety checks are disabled, serving as informational reminders.

## Telemetry Hygiene

- Telemetry captures command context (cwd, user, exit code) and optional plan information. Ensure the log directory is access-controlled.
- If telemetry is not desired, launch without `AGENT_TELEMETRY_FILE` and omit the `--telemetry-file` flag.

## Reporting Issues

If you discover a vulnerability, please open a private issue with maintainers (or email the project owner) and avoid disclosing publicly until a fix is available.

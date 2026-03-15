# Contributing Guide

Thanks for your interest in improving SAGE-CLI. This document captures expectations for code contributions, documentation updates, and release hygiene.

## Getting Started

1. **Fork & Clone**: Fork the repository, then `git clone` your fork locally.
2. **Install dependencies**: `bun install` (requires [Bun](https://bun.sh) ≥ 1.0).
3. **Configure OpenRouter access**: create a `.env` file at the project root with `OPENROUTER_API_KEY=<your key>` so planner features can be exercised.
4. **Build**: `bun run build` — bundles `src/index.tsx` → `dist/index.js` in ~7ms.

```bash
bun install
cp .env.example .env   # then fill in OPENROUTER_API_KEY
bun run build
bun dist/index.js --planner mock   # smoke test without network
```

## Development Workflow

1. Create a feature branch off `main`: `git checkout -b feature/my-change`.
2. Make incremental commits with clear messages that describe the *why* and *what*.
3. Run local checks before opening a PR:
   ```bash
   bun run typecheck   # tsc --noEmit  (Bun does not type-check at bundle time)
   bun run build       # must succeed with no errors
   bun dist/index.js --planner mock   # interactive smoke test
   ```
4. Update documentation in `README.md` or `docs/` whenever behaviour or UX changes.
5. Open a pull request with:
   - Summary of the change and motivation.
   - Testing performed (which phases exercised, which planners used).
   - Any follow-up work that remains.

## Coding Guidelines

- **TypeScript only** — all source lives in `src/`, entry point is `src/index.tsx`.
- **Ink/React for UI** — every visual element is a React component using `Box`/`Text`. Do not use `console.log` inside components.
- Keep the REPL responsive: the planning phase runs in an async `useEffect`; never block the React render loop with synchronous I/O.
- Extend types in `src/lib/types.ts` when adding new fields to `CommandResult`, `PlannerSuggestion`, or `PlannerTurn`; thread them through telemetry and session serialization.
- Treat safety policies as first-class: additions should propagate risk metadata through telemetry and planner history (`buildPlannerHistory`).
- Use `logger.info/warning/error()` — never `console.log/warn` — so output doesn't interfere with Ink's terminal rendering.
- Avoid `as any` type casts; prefer explicit type guards.

## Project Structure

```
src/
  index.tsx          # CLI entry: arg parsing, subsystem init, render(<App/>)
  App.tsx            # Phase state machine (idle/planning/reviewing/executing/summary)
  lib/
    types.ts         # Shared interfaces and union types
    planner.ts       # CommandPlanner base + OpenRouterPlanner, OllamaPlanner, Mock
    planState.ts     # PlanState, PlanStepState, buildPlannerHistory, compressOutput
    safety.ts        # SafetyPolicy, SafetyRule, regex rule engine
    scoreboard.ts    # CommandScoreboard — per-command success/failure tracking
    session.ts       # SessionManagerImpl — JSONL goal persistence
    telemetry.ts     # TelemetryEmitterImpl — JSONL event stream
    logger.ts        # Logger — file-based structured log
    config.ts        # AppConfig — config.json loader
    env.ts           # loadEnvironment — .env parser
  components/
    GoalPrompt.tsx   # TextInput for user goals
    CommandReview.tsx  # A/E/S action panel with diff and risk badge
    StreamOutput.tsx   # Live stdout/stderr display
    PlanView.tsx       # PlanStrip (horizontal) + PlanView (vertical)
    GoalSummary.tsx    # End-of-goal result table
    OutputLog.tsx      # Persistent scrollback log
  hooks/
    useCommandExec.ts  # spawn() wrapper with buffered streaming
```

## Tests & Validation

No formal test suite exists yet. Contributors are expected to:

- Pass `bun run typecheck` (zero TypeScript errors) before committing.
- Verify all five UI phases manually with the mock planner: `bun dist/index.js --planner mock`.
- For planner-path changes, test with `--planner ollama` (if Ollama is available) and with `--planner openrouter`.
- Verify telemetry output by tailing `logs/telemetry.jsonl` during a manual run:
  ```bash
  tail -f logs/telemetry.jsonl | jq .
  ```

## Documentation Standards

- Core behaviour and quick-start lives in `README.md`.
- Deep-dives live in `docs/`: design, security, telemetry contracts, safety policy, planning.
- Update diagrams in `docs/DESIGN-PRINCIPAL.md` and `docs/conversation-flow.md` when control flow changes.
- Include sample JSON payloads whenever new telemetry fields are introduced.

## Commit & PR Expectations

- Keep commits focused; separate refactors from feature additions when feasible.
- Reference related issues in the PR description.
- The PR description should name which phases / planners were manually tested.

## Code of Conduct

Be respectful and constructive. Harassment, discrimination, or disrespectful behaviour will not be tolerated. When in doubt, escalate concerns to the maintainers before conflicts grow.

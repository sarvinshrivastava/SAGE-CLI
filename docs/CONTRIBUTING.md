# Contributing Guide

Thanks for your interest in improving the Smart Agent Goal Execution CLI. This document captures the expectations for code contributions, documentation updates, and release hygiene.

## Getting Started

1. **Fork & Clone**: Fork the repository, then `git clone` your fork locally.
2. **Create a virtualenv**: `python -m venv .venv && source .venv/bin/activate`.
3. **Install dependencies**: `pip install -r requirements.txt`.
4. **Configure OpenRouter access**: populate `.env` with `OPENROUTER_API_KEY` (and optional model/timeout overrides) so planner features can be exercised.

## Development Workflow

1. Create a feature branch off `main`: `git checkout -b feature/my-change`.
2. Make incremental commits with clear messages that describe the “why” and “what”.
3. Run automated checks locally:
   - Lint/type hints (if configured) and `python -m compileall src` to catch syntax errors.
   - Manual smoke tests for the REPL when features touch planner/telemetry/safety logic.
4. Add or update documentation in `README.md` or `docs/` whenever functionality or UX changes.
5. Open a pull request with:
   - Summary of the change.
   - Testing performed.
   - Any follow-up work that remains.

## Coding Guidelines

- Favor clear, well-factored functions. Use succinct comments only when intent is non-obvious.
- Keep the REPL responsive: avoid blocking network calls on the main thread and stream output where possible.
- Extend dataclasses and telemetry structures in a backwards-compatible fashion; document new fields.
- Treat safety policies as first-class: additions should thread risk metadata through telemetry and planner history.
- Maintain ASCII formatting unless a file already uses Unicode.

## Tests & Validation

Although no formal test suite exists yet, contributors are expected to:

- Run `python -m compileall src` before committing.
- Exercise new planner responses using the mock backend (`--planner mock`) when network access is unavailable.
- Verify telemetry output by tailing `logs/telemetry.jsonl` during manual runs.

## Documentation Standards

- Core behavior belongs in `README.md`.
- Deep dives (hierarchical planning, telemetry contracts, safety policy definitions) live in `docs/`.
- Update diagrams or flow documents when control flow changes.
- Include sample configuration or JSON payloads whenever new fields are introduced.

## Commit & PR Expectations

- Keep commits focused; separate refactors from feature work when feasible.
- Reference related issues or roadmap items in the PR description.
- Ensure CI (when available) passes before request reviews.

## Code of Conduct

Be respectful and constructive. Harassment, discrimination, or disrespectful behavior will not be tolerated. When in doubt, escalate concerns to the maintainers before conflicts grow.

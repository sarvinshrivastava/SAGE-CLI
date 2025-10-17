# Conversation Flow

This project turns high-level goals into safe shell actions. The diagram below captures the decision path each goal travels through the REPL, planner, and executor.

```
┌──────────────────────────────────────────────────────────────┐
│ User launches `agent_shell.py`                               │
│ • loads `.env` + config                                      │
│ • session + logging initialized                              │
└──────────────┬───────────────────────────────────────────────┘
			   │
			   ▼
┌──────────────────────────────────────────────────────────────┐
│ Goal Prompt                                                  │
│ • user enters natural-language prompts or meta command       │
│ • `:new` / `:session` handled locally                        │
│ • exit keywords break loop                                   │
└──────────────┬───────────────────────────────────────────────┘
			   │
			   ▼
┌──────────────────────────────────────────────────────────────┐
│ Planner Request                                              │
│ • build history of past commands (stdout/stderr/exit codes)  │
│ • send goal + history to planner (OpenRouter by default)     │
│ • repeated-failure guard injects "do not repeat" note        │
└──────────────┬───────────────────────────────────────────────┘
		 	   │
		 	   ▼
┌────────────────────────────────────────────────────────────────┐
│ Planner Reply                                                	 │
│ JSON → `{"mode": ...}` parsed into:                          	 │
│   • chat mode  → `{message}`                                 	 │
│   • command mode → `{command}`                               	 │
│ empty/invalid replies raise `PlannerError`                   	 │
└──────┬─────────────────────────┬──────────────────────────────┬┘
	   │                         │                              │
	   │ chat                    │ plan                         │ command
	   ▼                         ▼                              ▼
┌───────────────────────────┐ ┌────────────────────────────────────────────┐ ┌─────────────────────────────────────────┐
│ Chat Response             │ │ Plan Broadcast                             │ │ Command Confirmation UI                 │
│ • print assistant message │ │ • parse `mode:"plan"` into steps           │ │ • suggested command pre-filled in prompt│
│ • log + persist metadata  │ │ • render summary + ordered sub-goals       │ │ • diff vs suggestion, show risk + score │
│ • goal loop completes     │ │ • set active step (pending → in progress)  │ │ • quick actions (A/E/S) before execution│
└─────────┬─────────────────┘ └──────────────┬─────────────────────────────┘ └──────────────┬──────────────────────────┘
	  │                                      │                                            	│
	  │                                      │                                            	▼
	  │                                      │                      ┌──────────────────────────────────────┐
	  │                                      │                      │ Safety & Risk Checks                 │
	  │                                      │                      │ • apply safety policy rules          │
	  │                                      │                      │ • warn medium; require "proceed" for │
	  │                                      │                      │   policy violations/high-risk ops    │
	  │                                      │                      └─────────────┬────────────────────────┘
	  │                                      │                                    │
	  │                                      │                                    ▼
	  │                                      │                      ┌──────────────────────────────────────┐
	  │                                      │                      │ Command Execution                    │
	  │                                      │                      │ • stream stdout/stderr (colored)     │
	  │                                      │                      │ • capture execution context + plan id│
	  │                                      │                      │ • append result to goal history      │
	  │                                      │                      └─────────────┬────────────────────────┘
	  │                                      │                                    │
	  │                                      │                                    ▼
	  │                                      │                      ┌──────────────────────────────────────┐
	  │                                      │                      │ Post-Execution Feedback              │
	  │                                      │                      │ • scoreboard updates success/failure │
	  │                                      │                      │ • plan step marked completed/failed  │
	  │                                      │                      │ • planner history receives notes     │
	  │                                      │                      └──────────────────────────────────────┘
	  │                                      │
	  │                                      |
	  │                                      │
	  ▼                                      ▼
┌──────────────────────────────────────────────────────────────┐
│ Goal Wrap-up                                                 │
│ • derive status (completed / failed / cancelled / etc.)      │
│ • persist goal summary to JSONL session (if enabled)         │
│ • print concise summary to console                           │
└──────────────────────────────────────────────────────────────┘
```

### Key Behaviors

- **Tri-modal planner**: outputs can be chat, command, or plan. Plans establish ordered sub-goals that the shell tracks until completion.
- **Adaptive execution**: the confirmation UI combines diffs, safety notes, and command scoreboards so users can quickly accept, edit, or skip.
- **Policy-driven safety**: configurable rules determine risk levels, enforce confirmations, and annotate telemetry for each command.
- **Feedback-aware planner**: repeated failures, plan step statuses, and risk notes become `AGENT_NOTE` entries, nudging the model away from unproductive loops.
- **Persistent observability**: session JSONL files and telemetry (`execution`, `plan_created`, `plan_updated`) provide a full audit trail with provenance metadata and token-aware output summaries.

Use this flow as the reference when proposing optimizations or adding providers—the agent’s contract with the planner and user should remain intact.

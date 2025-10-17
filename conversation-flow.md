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
┌──────────────────────────────────────────────────────────────┐
│ Planner Reply                                                │
│ JSON → `{"mode": ...}` parsed into:                          │
│   • chat mode  → `{message}`                                 │
│   • command mode → `{command}`                               │
│ empty/invalid replies raise `PlannerError`                   │
└──────┬───────────────────────────────┬───────────────────────┘
	   │                               │
	   │ chat                          │ command
	   ▼                               ▼
┌───────────────────────────┐   ┌─────────────────────────────────────────┐
│ Chat Response             │   │ Command Confirmation UI                 │
│ • print assistant message │   │ • suggested command pre-filled in prompt│
│ • log + persist metadata  │   │ • user can edit/blank to skip           │
│ • goal loop completes     │   │                                         │
└─────────┬─────────────────┘   └──────────────┬──────────────────────────┘
		  │                               	   │
		  │                               	   ▼
		  │                 ┌──────────────────────────────────────┐
		  │                 │ Safety & Risk Checks                 │
		  │                 │ • classify low / medium / high risk  │
		  │                 │ • warn medium; require "proceed" for │
		  │                 │   high-risk commands unless disabled │
		  │                 └─────────────┬────────────────────────┘
		  │                               │
		  │                               ▼
		  │                 ┌──────────────────────────────────────┐
		  │                 │ Command Execution                    │
		  │                 │ • stream stdout/stderr (colored)     │
		  │                 │ • capture exit code + buffers        │
		  │                 │ • append result to goal history      │
		  │                 └─────────────┬────────────────────────┘
		  │                               │
		  │                               ▼
		  │                 ┌──────────────────────────────────────┐
		  │                 │ Post-Execution Feedback              │
		  │                 │ • failed commands increment counter  │
		  │                 │ • planner told about repeats         │
		  │                 │ • loop continues with new request    │
		  │                 └──────────────────────────────────────┘
		  │
		  ▼
┌──────────────────────────────────────────────────────────────┐
│ Goal Wrap-up                                                 │
│ • derive status (completed / failed / cancelled / etc.)      │
│ • persist goal summary to JSONL session (if enabled)         │
│ • print concise summary to console                           │
└──────────────────────────────────────────────────────────────┘
```

### Key Behaviors

- **Dual interaction modes**: the planner decides when to respond conversationally versus issuing shell commands. Chat mode ends the loop; command mode feeds back into execution and iteration.
- **Failure-aware planning**: two identical failing commands trigger an intervention note and, on repetition, a `PlannerError`. This prevents infinite reruns of the same command.
- **Safety guardrails**: high-risk commands (e.g., `rm -rf /`) require explicit confirmation unless the user disables safety checks.
- **Persistence and observability**: every goal can be logged to `sessions/*.jsonl`, capturing commands, outputs, risk levels, completion status, and any chat messages so runs are auditable.

Use this flow as the reference when proposing optimizations or adding providers—the agent’s contract with the planner and user should remain intact.

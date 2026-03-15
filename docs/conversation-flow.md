# Conversation Flow

SAGE-CLI turns natural-language goals into safe, supervised shell actions. The diagram below captures the full decision path a goal travels through the startup, planning, review, execution, and wrap-up phases.

```mermaid
flowchart TD
    START["User launches SAGE-CLI\nbun dist/index.js [flags]"]
    INIT["index.tsx: startup sequence\n① loadEnvironment .env\n② parseArgs CLI flags\n③ ensureNotRoot\n④ AppConfig.load config.json\n⑤ Logger · Telemetry · Session\n⑥ SafetyPolicy.load\n⑦ createPlanner"]
    IDLE["GoalPrompt\nUser› _\n(idle phase)"]
    GOAL_INPUT{"User input"}
    EXIT["process.exit"]
    META["handleMeta()\n:new → new session\n:session → show info"]
    ADD_LOG_GOAL["addLog { type:goal }"]

    PLAN["planning phase\nspinner: thinking… or planning…"]
    SUGGEST["planner.suggest(goal, history)\nbuildPlannerHistory() → PlannerTurn[]"]
    LLM["LLM Backend\nOpenRouter · Ollama · Mock"]
    PARSE["parsePlannerReply()\nextract thinkContent\nstrip think block\nparse JSON"]

    MODE{"suggestion.mode"}

    CHAT["addLog { type:chat\nmessage + thinkContent }\nfinishGoal()"]

    PLAN_MODE["convertPlannerPlan()\nPlanState + PlanStepState[]"]
    PLAN_LOG["addLog { type:plan }"]
    PLAN_ACK["push __plan_acknowledged__\nto goalHistory"]
    SHOW_PLAN["showPlan phase 800ms\nPlanView rendered"]

    DONE_CHECK{"cmd == DONE\nand last exit=0?"}
    FINISH_DONE["plannerCompleted=true\nfinishGoal()"]
    REPLAN["startPlanning()\n(re-run loop)"]

    SAFETY["SafetyPolicy.evaluate(cmd)\nfirst-match regex rules"]
    REVIEW["reviewing phase\nPlanStrip + CommandReview\n[A] accept  [E] edit  [S] skip"]
    USER_ACTION{"user action"}
    SKIP["userCancelled=true\nfinishGoal()"]

    CONFIRM{"high-risk or\nrequireConfirmation?"}
    PROCEED["prompt: type 'proceed'"]
    EXEC["executing phase\nPlanStrip + StreamOutput\nspawn command\nstdin: inherited\nstdout/stderr streamed"]

    RESULT["command exits\nexitCode · stdout · stderr"]
    SCORE["scoreboard.record(cmd, success)"]
    PLAN_UPDATE["plan.recordResult(stepId, success)\ntelemetry.emitPlanUpdate()"]
    EXEC_LOG["addLog { type:command }"]
    TELEMETRY["telemetry.emitExecution()"]
    NEXT_PLAN["goalHistory.push(result)\nstartPlanning()\n→ spinnerLabel=planning"]

    FINISH["finishGoal(status)\naddLog { type:summary }\nsessionManager.recordGoal()"]
    SUMMARY["summary phase 1.5s\nGoalSummary table"]
    BACK_IDLE["→ idle phase"]

    START --> INIT --> IDLE
    IDLE --> GOAL_INPUT
    GOAL_INPUT -- "exit/quit" --> EXIT
    GOAL_INPUT -- ":cmd" --> META --> IDLE
    GOAL_INPUT -- "goal text" --> ADD_LOG_GOAL --> PLAN

    PLAN --> SUGGEST --> LLM --> PARSE --> MODE

    MODE -- "chat" --> CHAT --> FINISH
    MODE -- "plan" --> PLAN_MODE --> PLAN_LOG --> PLAN_ACK --> SHOW_PLAN --> PLAN
    MODE -- "command" --> DONE_CHECK

    DONE_CHECK -- "yes" --> FINISH_DONE --> FINISH
    DONE_CHECK -- "no" --> SAFETY --> REVIEW

    REVIEW --> USER_ACTION
    USER_ACTION -- "S skip" --> SKIP --> FINISH
    USER_ACTION -- "E edit" --> REVIEW
    USER_ACTION -- "A accept" --> CONFIRM

    CONFIRM -- "yes" --> PROCEED --> CONFIRM
    CONFIRM -- "no" --> EXEC

    EXEC --> RESULT --> SCORE --> PLAN_UPDATE --> EXEC_LOG --> TELEMETRY --> NEXT_PLAN --> PLAN

    FINISH --> SUMMARY --> BACK_IDLE --> IDLE
```

---

## Key Behaviours

**Tri-modal planner output**
The planner returns one of three modes on every call. `chat` responses are logged immediately and end the current goal loop. `plan` responses create a `PlanState` that tracks step progress. `command` responses drive the review/execute cycle.

**Persistent OutputLog**
All notable events (goal text, plan received, chat message, command result, goal summary) are appended to `outputLog[]` state. This list is rendered above the active phase on every render, giving users a complete scrollback history without leaving the REPL.

**spinnerLabel**
The loading spinner label adapts to context: `thinking…` on the first planning call (no commands executed yet); `planning…` on subsequent calls (at least one command in history).

**Adaptive planner feedback**
`buildPlannerHistory()` enriches the conversation context sent to the LLM with `AGENT_NOTE:` annotations — failure tallies, risk levels, safety policy notes, plan step statuses, and command scoreboard scores — so the model has full situational awareness without the raw stdout consuming its context window.

**Safety gate**
`SafetyPolicy` evaluates each planner-suggested command against a priority-ordered list of regex rules before the review panel is shown. High-risk or policy-flagged commands require typing `proceed` to execute. Users can always edit (`E`) or skip (`S`) regardless of risk level.

**Plan step tracking**
When a plan is active, each command execution is associated with the current plan step. The step transitions: `pending` → `in_progress` (before `spawn`) → `completed`|`failed` (after exit). The `PlanStrip` component reflects these transitions in real-time during both `reviewing` and `executing` phases.

**Session & telemetry**
Every command execution emits a `telemetry.jsonl` event. When a goal completes (any status), the full goal record is appended to the session's `.jsonl` file. Both are best-effort append-only writes.

---

Use this flow as the reference when proposing architectural changes — the agent's contract with the planner, the safety gate, and the user review step should remain intact.

# SAGE-CLI — Design Principals

**Smart Agent Goal Execution CLI** — an interactive terminal REPL that accepts natural-language goals, delegates planning to an LLM, and iteratively executes shell commands with safety checks, user review, and full session telemetry.

---

## 1. High-Level Architecture

```mermaid
graph TD
    User["👤 User (Terminal)"]
    CLI["index.tsx\nCLI Entry Point"]
    App["App.tsx\nState Machine (Ink/React)"]
    Planner["Planner Abstraction\nOpenRouter · Ollama · Mock"]
    LLM["☁ LLM Backend\n(OpenRouter API / Ollama local)"]
    Shell["🖥 Shell\nchild_process.spawn"]
    Safety["SafetyPolicy\nRegex Rule Engine"]
    Session["SessionManager\nJSONL Persistence"]
    Telemetry["TelemetryEmitter\nJSONL Event Log"]
    Logger["Logger\nFile-based log"]

    User -- "types goal" --> App
    App -- "suggest(goal, history)" --> Planner
    Planner -- "POST /chat/completions" --> LLM
    LLM -- "JSON mode/command/plan" --> Planner
    Planner -- "PlannerSuggestion" --> App
    App -- "evaluate(command)" --> Safety
    Safety -- "SafetyDecision" --> App
    App -- "user reviews\nA/E/S" --> User
    App -- "execute(command)" --> Shell
    Shell -- "stdout/stderr/exitCode" --> App
    App -- "recordGoal()" --> Session
    App -- "emit()" --> Telemetry
    App -- "info/error()" --> Logger

    CLI -- "initialises\nall subsystems" --> App
```

---

## 2. Layer Map

```mermaid
graph LR
    subgraph "Presentation Layer (Ink/React)"
        GP["GoalPrompt"]
        CR["CommandReview"]
        SO["StreamOutput"]
        PV["PlanView · PlanStrip"]
        GS["GoalSummary"]
        OL["OutputLog"]
    end

    subgraph "Application Layer"
        APP["App.tsx\nPhase State Machine"]
        HCE["useCommandExec\nProcess Hook"]
    end

    subgraph "Domain Layer"
        PL["planner.ts\nOpenRouter · Ollama · Mock"]
        SF["safety.ts\nSafetyPolicy · SafetyRule"]
        PS["planState.ts\nPlanState · PlanStepState"]
        SB["scoreboard.ts\nCommandScoreboard"]
    end

    subgraph "Infrastructure Layer"
        SM["session.ts\nSessionManagerImpl"]
        TE["telemetry.ts\nTelemetryEmitterImpl"]
        LG["logger.ts\nLogger"]
        CF["config.ts · env.ts\nConfig & Env Loading"]
    end

    subgraph "Persistence"
        F1["sessions/*.jsonl"]
        F2["logs/telemetry.jsonl"]
        F3["logs/sage.log"]
    end

    APP --> GP & CR & SO & PV & GS & OL
    APP --> HCE
    APP --> PL & SF & PS & SB
    APP --> SM & TE & LG
    SM --> F1
    TE --> F2
    LG --> F3
```

---

## 3. App Phase State Machine

The core of `App.tsx` is a strict linear state machine. Every user interaction and planner response drives a transition between exactly one active phase.

```mermaid
stateDiagram-v2
    [*] --> idle

    idle --> planning : user submits goal\nonGoal()

    planning --> showPlan : planner returns mode=plan
    planning --> reviewing : planner returns mode=command
    planning --> idle     : planner returns mode=chat\n(→ outputLog, finishGoal)
    planning --> summary  : planner returns DONE\nor planner error

    showPlan --> planning : 800ms auto-transition\n(plan added to outputLog)

    reviewing --> executing : user presses A (accept)\nor Enter
    reviewing --> editing   : user presses E
    reviewing --> summary   : user presses S (skip)
    editing --> reviewing   : user submits edited command

    executing --> planning  : command exits\n(result added to outputLog)

    summary --> idle : 1500ms auto-transition\n(summary added to outputLog)

    note right of reviewing
        PlanStrip shown above
        if activePlan exists
    end note

    note right of executing
        PlanStrip shown above
        step marked in_progress
    end note
```

---

## 4. Planning Loop — Sequence Diagram

One full iteration from user goal to command result:

```mermaid
sequenceDiagram
    actor User
    participant App
    participant Planner
    participant LLM
    participant Safety
    participant Shell

    User->>App: types goal → onGoal()
    App->>App: addLog(goal entry)
    App->>App: phase = planning, spinnerLabel = "thinking"

    App->>Planner: suggest(goal, [])
    Planner->>LLM: POST /chat/completions
    LLM-->>Planner: {mode:"plan", plan:{...}}
    Planner-->>App: PlannerSuggestion{mode:"plan"}

    App->>App: convertPlannerPlan() → activePlan
    App->>App: addLog(plan entry)
    App->>App: push __plan_acknowledged__ to history
    App->>App: phase = showPlan (800ms) → planning
    App->>App: spinnerLabel = "planning"

    App->>Planner: suggest(goal, [ack_turn])
    Planner->>LLM: POST /chat/completions
    LLM-->>Planner: {mode:"command", command:"apt-get update"}
    Planner-->>App: PlannerSuggestion{mode:"command"}

    App->>Safety: evaluate("apt-get update")
    Safety-->>App: {level:"medium", requireConfirmation:false}

    App->>App: phase = reviewing
    App->>User: CommandReview (PlanStrip + diff + risk badge)

    User->>App: presses A (accept)
    App->>App: phase = executing
    App->>Shell: spawn("apt-get update", {shell:true})
    Shell-->>App: stdout/stderr chunks (100ms flush)
    Shell-->>App: close(exitCode=0)

    App->>App: addLog(command result)
    App->>App: plan.recordResult(stepId, success=true)
    App->>App: scoreboard.record(cmd, true)
    App->>App: telemetry.emitExecution(...)
    App->>App: goalHistory.push(result)
    App->>App: phase = planning (repeat)
```

---

## 5. Planner Class Hierarchy

```mermaid
classDiagram
    class CommandPlanner {
        <<abstract>>
        +suggest(goal, history) PlannerSuggestion
    }

    class OpenRouterPlanner {
        #model: string
        #timeout: number
        #apiKey: string|null
        #baseUrl: string
        +suggest(goal, history) PlannerSuggestion
        #_chat(messages) Promise~Record~
        #_extractContent(payload) string
        #_buildMessages(goal, history) object[]
        #_resolveTimeout(provided?) number
    }

    class OllamaPlanner {
        -DEFAULT_HOST: string
        -DEFAULT_MODEL: string
        +suggest(goal, history) PlannerSuggestion
        #_chat(messages) Promise~Record~
        #_extractContent(payload) string
        -_resolveOllamaTimeout(provided?) number
    }

    class MockCommandPlanner {
        +suggest(goal, history) PlannerSuggestion
    }

    CommandPlanner <|-- OpenRouterPlanner
    OpenRouterPlanner <|-- OllamaPlanner
    CommandPlanner <|-- MockCommandPlanner

    class PlannerSuggestion {
        <<union type>>
        mode: "command" | "chat" | "plan"
        command?: string
        message?: string
        plan?: PlannerPlan
        thinkContent?: string
    }

    OpenRouterPlanner ..> PlannerSuggestion : returns
    OllamaPlanner ..> PlannerSuggestion : returns
    MockCommandPlanner ..> PlannerSuggestion : returns
```

---

## 6. Plan State Model

```mermaid
classDiagram
    class PlanState {
        +summary: string|null
        +steps: PlanStepState[]
        +currentStep() PlanStepState|null
        +getStep(id) PlanStepState|null
        +markRunning(id) void
        +recordResult(id, success, histIdx) void
        +toDict() Record
    }

    class PlanStepState {
        +id: string
        +title: string|null
        +command: string|null
        +description: string|null
        +status: "pending"|"in_progress"|"completed"|"failed"
        +historyIndices: number[]
        +label() string
    }

    PlanState "1" *-- "1..*" PlanStepState : steps

    class CommandResult {
        +suggestedCommand: string
        +executedCommand: string
        +stdout: string[]
        +stderr: string[]
        +returncode: number
        +riskLevel: "low"|"medium"|"high"
        +planStepId?: string
        +planStepStatus?: string
        +score?: Record
    }

    PlanStepState --> CommandResult : historyIndices point into\ngoalHistoryRef[]
```

---

## 7. Safety Policy Engine

```mermaid
flowchart TD
    CMD["command string"]
    NORM["normalize: trim()"]
    EMPTY{"empty?"}
    LOOP["iterate rules\nin priority order"]
    MATCH{"rule.regex\n.test(cmd)?"}
    FLAGS{"allowedFlags\ndefined?"}
    HASFLAG{"command\nincludes flag?"}
    NOTE["add flag warning\nrequireConfirmation = true"]
    DESC["append rule\ndescription to notes"]
    RETURN["return SafetyDecision\n{level, requireConfirmation, notes}"]
    DEFAULT["return {level:'low',\nrequireConfirmation:false}"]
    NEXT["next rule"]

    CMD --> NORM --> EMPTY
    EMPTY -- yes --> DEFAULT
    EMPTY -- no --> LOOP
    LOOP --> MATCH
    MATCH -- no --> NEXT --> LOOP
    MATCH -- yes --> FLAGS
    FLAGS -- yes --> HASFLAG
    HASFLAG -- no --> NOTE --> DESC --> RETURN
    HASFLAG -- yes --> DESC --> RETURN
    FLAGS -- no --> DESC --> RETURN
    LOOP -- exhausted --> DEFAULT
```

**Rule precedence (built-in defaults, highest to lowest):**

```mermaid
graph LR
    R1["rm -rf /\n HIGH · confirm"] --> R2
    R2["fork bomb :(){…\n HIGH · confirm"] --> R3
    R3["dd if=\n HIGH · confirm"] --> R4
    R4["mkfs · wipefs · mkpart\n HIGH · confirm"] --> R5
    R5["poweroff/shutdown/reboot\n HIGH · confirm"] --> R6
    R6["userdel\n HIGH · confirm"] --> R7
    R7["sudo\n MEDIUM"] --> R8
    R8["apt-get remove\n MEDIUM"] --> R9
    R9["chown -R · chmod 777\n MEDIUM"] --> R10
    R10["systemctl stop/restart\n MEDIUM"] --> R11
    R11["kill -9\n MEDIUM"] --> R12
    R12["apt-get install\n MEDIUM · needs -y"]
```

---

## 8. Output Log Data Flow

The `OutputLog` component provides the persistent scrollback history. Entries are appended to `outputLog[]` state as events occur and never removed.

```mermaid
flowchart LR
    subgraph "Events → Log Entries"
        E1["handleGoal()"] -- "type:goal" --> LOG
        E2["planner returns plan"] -- "type:plan" --> LOG
        E3["planner returns chat"] -- "type:chat\n+ thinkContent" --> LOG
        E4["command exits"] -- "type:command\nstdout·stderr·exitCode" --> LOG
        E5["finishGoal()"] -- "type:summary" --> LOG
        E6["planner error"] -- "type:error" --> LOG
    end

    LOG["outputLog: LogEntry[]\n(useState — never cleared)"]

    LOG --> OL["OutputLog component\nrenders all entries above\nactive phase"]
```

---

## 9. React Component Tree

```mermaid
graph TD
    INK["Ink render()"]
    APP["App.tsx\n(state machine)"]

    APP --> OL["OutputLog\n(always rendered)"]
    APP --> PHASE["renderPhase()"]

    PHASE --> IDLE["idle phase\n→ GoalPrompt"]
    PHASE --> PLAN["planning phase\n→ Spinner + spinnerLabel"]
    PHASE --> SHOW["showPlan phase\n→ PlanView"]
    PHASE --> REVIEW["reviewing phase\n→ Box > PlanStrip? + CommandReview"]
    PHASE --> EXEC["executing phase\n→ Box > PlanStrip? + StreamOutput"]
    PHASE --> SUM["summary phase\n→ GoalSummary"]

    REVIEW --> PS1["PlanStrip\n(if activePlan)"]
    REVIEW --> CR["CommandReview\n(mode: review|editing|confirm)"]
    CR --> TI1["TextInput (edit mode)"]
    CR --> TI2["TextInput (confirm mode)"]

    EXEC --> PS2["PlanStrip\n(if activePlan)"]
    EXEC --> SO["StreamOutput\n(Spinner while running)"]

    IDLE --> GP["GoalPrompt\n(sessionInfo · safetyDisabled)"]
    GP --> TI3["TextInput"]

    INK --> APP
```

---

## 10. Infrastructure & Persistence

```mermaid
flowchart TD
    subgraph "index.tsx — startup sequence"
        S1["1. loadEnvironment()\nparse .env file"] --> S2
        S2["2. parseArgs(argv)\nCLI flags"] --> S3
        S3["3. ensureNotRoot()\ngeteuid check"] --> S4
        S4["4. AppConfig.load()\nconfig.json merge"] --> S5
        S5["5. resolve final settings\nflags › config › env › defaults"] --> S6
        S6["6. Logger.initialize()"] --> S7
        S7["7. TelemetryEmitterImpl.initialize()"] --> S8
        S8["8. SessionManagerImpl.initialize()"] --> S9
        S9["9. SafetyPolicy.load()\npolicy.json or defaults"] --> S10
        S10["10. createPlanner()\nOpenRouter|Ollama|Mock"] --> S11
        S11["11. render(<App />)"]
    end

    subgraph "Configuration Priority"
        C1["CLI flags\n(highest)"] --> C2["config.json\n--config path"] --> C3["environment\nvariables"] --> C4["built-in\ndefaults"]
    end

    subgraph "File Outputs"
        F1["sessions/\nYYYYMMDD-HHMMSS.jsonl\none file per session"]
        F2["logs/telemetry.jsonl\nappend-only event stream"]
        F3["logs/sage.log\ninfo/warning/error lines"]
    end
```

---

## 11. Planner History Construction

Before each `planner.suggest()` call, `buildPlannerHistory()` transforms `CommandResult[]` into a `PlannerTurn[]` that forms the conversation context sent to the LLM.

```mermaid
flowchart TD
    HIST["goalHistoryRef\nCommandResult[]"]

    HIST --> LOOP["for each CommandResult"]

    LOOP --> FAIL{"returncode\n!= 0?"}
    FAIL -- yes --> TALLY["increment failureTally\nadd AGENT_NOTE if count > 1"]
    FAIL -- no --> RISK

    TALLY --> RISK{"riskLevel\nmedium|high?"}
    RISK -- yes --> RNOTE["add AGENT_NOTE: risk_level=X"]
    RISK -- no --> SAFETY

    RNOTE --> SAFETY{"safetyNotes\nexist?"}
    SAFETY -- yes --> SNOTE["add AGENT_NOTE: safety_policy=…"]
    SAFETY -- no --> STEPID

    SNOTE --> STEPID{"planStepId\nexist?"}
    STEPID -- yes --> PNOTE["add AGENT_NOTE: plan_step=X status=Y"]
    STEPID -- no --> SCORE

    PNOTE --> SCORE{"score shows\nfailures >= successes?"}
    SCORE -- yes --> SCNOTE["add AGENT_NOTE: command_history"]
    SCORE -- no --> FILTER

    SCNOTE --> FILTER{"shouldSendFullOutput?\n(failed OR whitelisted cmd)"}
    FILTER -- yes --> COMPRESS["compressOutput()\nhead 2000 + tail 2000"]
    FILTER -- no --> OMIT["stdout = 'exit N (omitted)'"]

    COMPRESS --> TURN["PlannerTurn\n{suggestedCmd, executedCmd,\nstdout, stderr, exitCode}"]
    OMIT --> TURN

    TURN --> PLAN{"activePlan\nexists?"}
    PLAN -- yes --> INJECT["inject plan_next AGENT_NOTE\ninto last turn's stderr"]
    PLAN -- no --> DONE["PlannerTurn[] ready\n→ planner.suggest()"]
    INJECT --> DONE
```

---

## 12. Key Design Decisions

```mermaid
mindmap
  root((SAGE-CLI\nDesign))
    Rendering
      Ink / React for terminal
      Single active phase rendered
      OutputLog persists all history
      PlanStrip always visible during review/exec
    Planning
      Abstract CommandPlanner base
      OpenRouter default backend
      Ollama for local / offline
      Mock for testing without network
      parsePlannerReply strips think blocks
      thinkContent surfaced to OutputLog
    Safety
      Regex rule engine JSON-configurable
      First-match wins priority ordering
      requireConfirmation for high-risk
      safetyDisabled bypass flag
      Root process blocked by default
    State
      PhaseState union drives renders
      Refs for cross-render mutable data
      goalHistoryRef never triggers re-render
      activePlanRef mutated in-place
      outputLog useState for scrollback
    Persistence
      JSONL append-only for all stores
      Session per sessionId file
      Telemetry event stream
      Logger best-effort file write
    Configuration
      CLI flags highest priority
      config.json second
      .env environment third
      Built-in defaults fallback
```

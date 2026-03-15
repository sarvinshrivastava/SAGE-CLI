/**
 * Top-level Ink component — main REPL state machine.
 * Phases 15 + 16: App state machine + full integration wiring.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";

import type { CommandPlanner } from "./lib/planner.js";
import { PlannerError } from "./lib/planner.js";
import type { SafetyDecision, CommandResult } from "./lib/types.js";
import { SafetyPolicy } from "./lib/safety.js";
import { SessionManagerImpl } from "./lib/session.js";
import { TelemetryEmitterImpl } from "./lib/telemetry.js";
import { Logger } from "./lib/logger.js";
import { CommandScoreboard } from "./lib/scoreboard.js";
import {
  PlanState,
  PlanStepState,
  buildPlannerHistory,
  convertPlannerPlan,
  determineStatus,
  serializeResult,
} from "./lib/planState.js";

import { GoalPrompt } from "./components/GoalPrompt.js";
import { StreamOutput } from "./components/StreamOutput.js";
import { PlanView, PlanStrip } from "./components/PlanView.js";
import { GoalSummary } from "./components/GoalSummary.js";
import { CommandReview, ReviewAction } from "./components/CommandReview.js";
import { OutputLog, LogEntry } from "./components/OutputLog.js";
import { useCommandExec } from "./hooks/useCommandExec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PhaseState =
  | { phase: "idle" }
  | { phase: "planning" }
  | { phase: "showPlan"; plan: PlanState }
  | {
      phase: "reviewing";
      suggestion: string;
      safetyDecision: SafetyDecision;
    }
  | {
      phase: "executing";
      command: string;
      originalSuggestion: string;
      safetyDecision: SafetyDecision;
    }
  | { phase: "summary"; status: string };

export interface AppProps {
  planner: CommandPlanner;
  policy: SafetyPolicy;
  telemetry: TelemetryEmitterImpl;
  sessionManager: SessionManagerImpl;
  logger: Logger;
  plannerInfo: Record<string, string>;
  safetyDisabled: boolean;
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export function App({
  planner,
  policy,
  telemetry,
  sessionManager: initialSessionManager,
  logger,
  plannerInfo,
  safetyDisabled,
}: AppProps) {
  const { exit } = useApp();

  // ---- Phase state ----
  const [phaseState, setPhaseState] = useState<PhaseState>({ phase: "idle" });
  // planningKey forces the planning effect to re-fire even when phase stays "planning"
  const [planningKey, setPlanningKey] = useState(0);
  // spinnerLabel drives the loading message shown during the planning phase
  const [spinnerLabel, setSpinnerLabel] = useState<"thinking" | "planning">("thinking");

  // ---- Persistent output log (survives phase transitions) ----
  const [outputLog, setOutputLog] = useState<LogEntry[]>([]);
  const addLog = useCallback((entry: LogEntry) => {
    setOutputLog((prev) => [...prev, entry]);
  }, []);

  // ---- Cross-goal state (refs — don't drive re-renders directly) ----
  const currentGoalRef = useRef("");
  const goalHistoryRef = useRef<CommandResult[]>([]);
  const activePlanRef = useRef<PlanState | null>(null);
  const scoreboardRef = useRef(new CommandScoreboard());
  const sessionManagerRef = useRef(initialSessionManager);
  const plannerCompletedRef = useRef(false);
  const userCancelledRef = useRef(false);
  const plannerErrorRef = useRef<string | null>(null);
  const conversationRef = useRef<string[]>([]);

  // ---- Command execution hook ----
  const cmdExec = useCommandExec();

  // ---- Helpers ----

  const resetGoalState = useCallback(() => {
    goalHistoryRef.current = [];
    activePlanRef.current = null;
    plannerCompletedRef.current = false;
    userCancelledRef.current = false;
    plannerErrorRef.current = null;
    conversationRef.current = [];
  }, []);

  const startPlanning = useCallback(() => {
    // "thinking" on the first call (no real commands yet); "planning" once commands have run
    const hasRealHistory = goalHistoryRef.current.some(
      (r) => r.suggestedCommand !== "__plan_acknowledged__"
    );
    setSpinnerLabel(hasRealHistory ? "planning" : "thinking");
    setPhaseState({ phase: "planning" });
    setPlanningKey((k) => k + 1);
  }, []);

  const finishGoal = useCallback(
    (status: string) => {
      const history = goalHistoryRef.current;
      const goal = currentGoalRef.current;

      if (
        history.length > 0 ||
        plannerErrorRef.current ||
        userCancelledRef.current ||
        conversationRef.current.length > 0 ||
        activePlanRef.current
      ) {
        // Session recording
        const serializedSteps = history.map(serializeResult);
        const metadata: Record<string, unknown> = {
          planner_completed: plannerCompletedRef.current,
          user_cancelled: userCancelledRef.current,
          planner_info: plannerInfo,
        };
        if (plannerErrorRef.current) metadata["planner_error"] = plannerErrorRef.current;
        if (history.length > 0) {
          metadata["risk_levels"] = history.map((r) => r.riskLevel);
          const safetyNotes = history
            .filter((r) => r.safetyNotes)
            .map((r) => r.safetyNotes);
          if (safetyNotes.length > 0) metadata["safety_notes"] = safetyNotes;
        }
        if (conversationRef.current.length > 0)
          metadata["conversation"] = conversationRef.current;
        if (safetyDisabled) metadata["safety_disabled"] = true;
        if (activePlanRef.current)
          metadata["plan"] = activePlanRef.current.toDict();

        sessionManagerRef.current.recordGoal(goal, serializedSteps, status, metadata);
        logger.info(`Goal completed status=${status}`);
      }

      // Add summary to the persistent log before transitioning
      if (history.length > 0) {
        addLog({ type: "summary", goal, history, status });
      }

      setPhaseState({ phase: "summary", status });
    },
    [plannerInfo, safetyDisabled, addLog, logger]
  );

  // ---- Planning effect ----
  useEffect(() => {
    if (phaseState.phase !== "planning") return;
    let cancelled = false;

    (async () => {
      const history = buildPlannerHistory(
        goalHistoryRef.current,
        activePlanRef.current
      );
      const goal = currentGoalRef.current;

      let suggestion;
      try {
        suggestion = await planner.suggest(goal, history);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        plannerErrorRef.current = msg;
        logger.error(`Planner error: ${msg}`);
        addLog({ type: "error", message: msg });
        const status = determineStatus(
          goalHistoryRef.current,
          plannerCompletedRef.current,
          msg,
          userCancelledRef.current
        );
        finishGoal(status);
        return;
      }

      if (cancelled) return;

      if (suggestion.mode === "plan") {
        const newPlan = convertPlannerPlan(suggestion.plan);
        if (newPlan) {
          activePlanRef.current = newPlan;
          // Add plan to persistent log
          addLog({ type: "plan", summary: newPlan.summary, stepCount: newPlan.steps.length });
          // Bug Fix #1: inject plan_acknowledged turn so planner knows plan was received
          goalHistoryRef.current = [
            ...goalHistoryRef.current,
            {
              suggestedCommand: "__plan_acknowledged__",
              executedCommand: "__plan_acknowledged__",
              stdout: [`Plan received: ${newPlan.summary ?? "no summary"}`],
              stderr: [],
              returncode: 0,
              riskLevel: "low",
              context: {},
            },
          ];
          // Telemetry
          telemetry.emitPlanCreated(
            goal,
            sessionManagerRef.current.enabled
              ? sessionManagerRef.current.sessionId
              : null,
            plannerInfo,
            newPlan.toDict()
          );
          logger.info(`Planner provided plan with ${newPlan.steps.length} steps`);
          setPhaseState({ phase: "showPlan", plan: newPlan });
        } else {
          logger.warning("Planner returned invalid plan payload");
          startPlanning();
        }
        return;
      }

      if (suggestion.mode === "chat") {
        const message = suggestion.message ?? "";
        // Add to persistent log immediately — no more 100ms flash
        addLog({ type: "chat", message, thinkContent: suggestion.thinkContent });
        conversationRef.current = [...conversationRef.current, message];
        plannerCompletedRef.current = true;
        logger.info(`Planner chat response: ${message}`);
        // Skip showChat phase entirely — log persists, go straight to finish
        const status = determineStatus(
          goalHistoryRef.current,
          plannerCompletedRef.current,
          plannerErrorRef.current,
          userCancelledRef.current
        );
        finishGoal(status);
        return;
      }

      // mode === "command"
      const cmd = suggestion.command.trim();

      if (cmd.toUpperCase() === "DONE") {
        const hist = goalHistoryRef.current;
        const lastResult = hist[hist.length - 1];
        if (!lastResult || lastResult.returncode === 0) {
          plannerCompletedRef.current = true;
          const status = determineStatus(hist, true, null, false);
          finishGoal(status);
        } else {
          // Planner tried to finish despite failure — re-plan
          logger.warning(
            "Planner attempted DONE despite failing command, re-planning"
          );
          startPlanning();
        }
        return;
      }

      // Show scoreboard warning if command has bad history
      const [, priorStats] = scoreboardRef.current.analyze(cmd);
      if (
        priorStats &&
        priorStats.failures >= Math.max(1, priorStats.successes)
      ) {
        logger.warning(
          `Command history warning: ${priorStats.successes}s/${priorStats.failures}f`
        );
      }

      const safetyDecision = safetyDisabled
        ? { level: "low" as const, requireConfirmation: false }
        : policy.evaluate(cmd);

      logger.info(`Command suggested risk=${safetyDecision.level}: ${cmd}`);
      setPhaseState({ phase: "reviewing", suggestion: cmd, safetyDecision });
    })();

    return () => {
      cancelled = true;
    };
  }, [planningKey]); // planningKey ensures re-fire even if phase was already "planning"

  // ---- showPlan -> planning auto-transition ----
  useEffect(() => {
    if (phaseState.phase !== "showPlan") return;
    // Brief display then resume planning
    const timer = setTimeout(() => startPlanning(), 800);
    return () => clearTimeout(timer);
  }, [phaseState]);

  // ---- Execute command when phase becomes "executing" ----
  useEffect(() => {
    if (phaseState.phase !== "executing") return;
    const { command } = phaseState;

    // Mark current plan step as in_progress BEFORE execution
    const activePlan = activePlanRef.current;
    const activeStep = activePlan?.currentStep() ?? null;
    if (activePlan && activeStep) {
      activePlan.markRunning(activeStep.id);
    }

    logger.info(`Executing command: ${command}`);
    cmdExec.execute(command);
  }, [phaseState]); // phaseState object identity changes each transition

  // ---- Handle command completion ----
  useEffect(() => {
    if (phaseState.phase !== "executing") return;
    if (cmdExec.running || cmdExec.exitCode === null) return;

    const { command, originalSuggestion, safetyDecision } = phaseState;

    const result: CommandResult = {
      suggestedCommand: originalSuggestion,
      executedCommand: command,
      stdout: cmdExec.stdout,
      stderr: cmdExec.stderr,
      returncode: cmdExec.exitCode,
      riskLevel: safetyDecision.level,
      context: {},
      safetyNotes: safetyDecision.notes ?? null,
    };

    // Scoreboard
    const [normKey, stats] = scoreboardRef.current.record(
      command,
      result.returncode === 0
    );
    result.normalizedCommand = normKey;
    result.score = stats.toDict();

    // Plan tracking
    const activePlan = activePlanRef.current;
    const activeStep = activePlan?.currentStep() ?? null;
    if (activePlan && activeStep) {
      const histIdx = goalHistoryRef.current.length;
      activePlan.recordResult(activeStep.id, result.returncode === 0, histIdx);
      result.planStepId = activeStep.id;
      result.planStepStatus = activeStep.status;

      // Telemetry: plan update
      telemetry.emitPlanUpdate(
        currentGoalRef.current,
        sessionManagerRef.current.enabled
          ? sessionManagerRef.current.sessionId
          : null,
        plannerInfo,
        activePlan.toDict(),
        activeStep.id,
        activeStep.status
      );
    }

    // Telemetry: execution
    telemetry.emitExecution(
      currentGoalRef.current,
      sessionManagerRef.current.enabled
        ? sessionManagerRef.current.sessionId
        : null,
      plannerInfo,
      {
        command,
        suggested_command: result.suggestedCommand,
        executed_command: result.executedCommand,
        risk_level: result.riskLevel,
        exit_code: result.returncode,
        risk_notes: result.safetyNotes,
        normalized_command: result.normalizedCommand,
        command_score: result.score,
        plan_step_id: result.planStepId,
        plan_step_status: result.planStepStatus,
      }
    );

    logger.info(
      `Command finished exit=${result.returncode} risk=${result.riskLevel}`
    );

    goalHistoryRef.current = [...goalHistoryRef.current, result];

    // Persist command output to the scrollback log
    addLog({
      type: "command",
      command: result.executedCommand,
      stdout: cmdExec.stdout,
      stderr: cmdExec.stderr,
      exitCode: result.returncode,
      riskLevel: result.riskLevel,
    });

    startPlanning();
  }, [phaseState, cmdExec.running, cmdExec.exitCode]);

  // ---- Review action handler ----
  const handleReviewAction = useCallback(
    (action: ReviewAction, command: string) => {
      if (action === "skip") {
        userCancelledRef.current = true;
        logger.info("Command skipped by user");
        const status = determineStatus(
          goalHistoryRef.current,
          plannerCompletedRef.current,
          plannerErrorRef.current,
          true
        );
        finishGoal(status);
        return;
      }

      // accept
      const safetyDecision =
        phaseState.phase === "reviewing" ? phaseState.safetyDecision : policy.evaluate(command);
      const originalSuggestion =
        phaseState.phase === "reviewing" ? phaseState.suggestion : command;
      setPhaseState({ phase: "executing", command, originalSuggestion, safetyDecision });
    },
    [phaseState, policy, finishGoal, logger]
  );

  // ---- Meta command handler ----
  const handleMeta = useCallback(
    (meta: string) => {
      if (["new", "new-session", "newsession"].includes(meta)) {
        sessionManagerRef.current = sessionManagerRef.current.startNew();
        logger.info(
          `Started new session id=${sessionManagerRef.current.sessionId}`
        );
      } else if (["session", "info"].includes(meta)) {
        // Info is displayed inline via the idle prompt area
      } else {
        logger.warning(`Unknown meta command: ${meta}`);
      }
    },
    [logger]
  );

  // ---- Goal submission ----
  const handleGoal = useCallback(
    (goal: string) => {
      currentGoalRef.current = goal;
      resetGoalState();
      addLog({ type: "goal", text: goal });
      logger.info(`Goal started: ${goal}`);
      startPlanning();
    },
    [resetGoalState, startPlanning, addLog, logger]
  );

  // ---- Summary -> idle transition ----
  // Summary data is already in outputLog; this phase just briefly shows GoalSummary
  // then returns to idle. Use a short but visible delay (1.5s).
  useEffect(() => {
    if (phaseState.phase !== "summary") return;
    const timer = setTimeout(() => setPhaseState({ phase: "idle" }), 1500);
    return () => clearTimeout(timer);
  }, [phaseState]);

  // showChat phase no longer used — chat responses go directly to outputLog.

  // ---- Render ----
  const renderPhase = () => {
    switch (phaseState.phase) {
      case "idle": {
        const sessionId = sessionManagerRef.current.enabled
          ? sessionManagerRef.current.sessionId
          : null;
        const sessionInfoParts = [
          sessionId ? `session ${sessionId}` : null,
          plannerInfo["backend"],
          plannerInfo["model"],
        ].filter(Boolean);
        const sessionInfo = sessionInfoParts.length > 0
          ? sessionInfoParts.join(" · ")
          : undefined;
        return (
          <Box flexDirection="column">
            {!sessionManagerRef.current.enabled && (
              <Text color="yellow">{"Session persistence disabled"}</Text>
            )}
            <GoalPrompt
              onGoal={handleGoal}
              onExit={() => {
                logger.info("User exited shell");
                exit();
              }}
              onMeta={(meta) => {
                handleMeta(meta);
              }}
              sessionInfo={sessionInfo}
              safetyDisabled={safetyDisabled}
            />
          </Box>
        );
      }

      case "planning":
        return (
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text color="cyan">{" "}{spinnerLabel}{"..."}</Text>
          </Box>
        );

      case "showPlan":
        return <PlanView plan={phaseState.plan} header="New plan received" />;

      case "reviewing": {
        const [, priorStats] = scoreboardRef.current.analyze(phaseState.suggestion);
        const activePlan = activePlanRef.current;
        const activeStep = activePlan?.currentStep() ?? null;
        return (
          <Box flexDirection="column">
            {activePlan && <PlanStrip plan={activePlan} />}
            <CommandReview
              suggested={phaseState.suggestion}
              safetyDecision={phaseState.safetyDecision}
              safetyDisabled={safetyDisabled}
              priorStats={priorStats}
              planStep={activeStep}
              onAction={handleReviewAction}
            />
          </Box>
        );
      }

      case "executing": {
        const activePlan = activePlanRef.current;
        return (
          <Box flexDirection="column">
            {activePlan && <PlanStrip plan={activePlan} />}
            <StreamOutput
              stdout={cmdExec.stdout}
              stderr={cmdExec.stderr}
              command={phaseState.command}
              exitCode={cmdExec.exitCode}
              running={cmdExec.running}
            />
          </Box>
        );
      }

      // showChat is no longer a rendered phase — chat goes straight to outputLog

      case "summary":
        // Summary is already in outputLog; show a brief flash of GoalSummary then idle
        return (
          <GoalSummary
            goal={currentGoalRef.current}
            history={goalHistoryRef.current}
            status={phaseState.status}
          />
        );
    }
  };

  return (
    <Box flexDirection="column">
      <OutputLog entries={outputLog} />
      {renderPhase()}
    </Box>
  );
}

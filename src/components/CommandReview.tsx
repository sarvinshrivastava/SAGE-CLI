/**
 * Command review UI — diff display, risk info, A/E/S action bar.
 * Replaces render_command_review() + prompt_for_action() + review_command_flow().
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { SafetyDecision } from "../lib/types.js";
import type { PlanStepState } from "../lib/planState.js";
import type { CommandStats } from "../lib/scoreboard.js";

export type ReviewAction = "accept" | "skip";

interface CommandReviewProps {
  suggested: string;
  safetyDecision: SafetyDecision;
  safetyDisabled: boolean;
  priorStats: CommandStats | null;
  planStep: PlanStepState | null;
  onAction: (action: ReviewAction, command: string) => void;
}

/** LCS-based word-level diff between two command strings. */
function wordDiff(original: string, edited: string) {
  const origWords = original.split(/\s+/);
  const editWords = edited.split(/\s+/);
  const m = origWords.length;
  const n = editWords.length;

  // Build LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (origWords[i] === editWords[j]) {
        dp[i]![j] = 1 + dp[i + 1]![j + 1]!;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // Traceback to produce tokens in order
  const tokens: Array<{ text: string; type: "same" | "added" | "removed" }> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (origWords[i] === editWords[j]) {
      tokens.push({ text: origWords[i]!, type: "same" });
      i++; j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      tokens.push({ text: origWords[i]!, type: "removed" });
      i++;
    } else {
      tokens.push({ text: editWords[j]!, type: "added" });
      j++;
    }
  }
  while (i < m) tokens.push({ text: origWords[i++]!, type: "removed" });
  while (j < n) tokens.push({ text: editWords[j++]!, type: "added" });
  return tokens;
}

type Mode = "review" | "editing" | "confirm";

export function CommandReview({
  suggested,
  safetyDecision,
  safetyDisabled,
  priorStats,
  planStep,
  onAction,
}: CommandReviewProps) {
  const [mode, setMode] = useState<Mode>("review");
  const [editValue, setEditValue] = useState(suggested);
  const [confirmValue, setConfirmValue] = useState("");
  const [activeCommand, setActiveCommand] = useState(suggested);

  const level = safetyDecision.level.toLowerCase();
  const riskColor = level === "high" ? "red" : level === "medium" ? "yellow" : "green";
  const riskLabel = `[ ${safetyDecision.level.toUpperCase()} RISK ]`;

  // Keypress handler for review mode
  useInput(
    (input, key) => {
      if (mode !== "review") return;
      const k = input.toLowerCase();
      if (k === "a" || key.return) {
        if (
          !safetyDisabled &&
          (level === "high" || safetyDecision.requireConfirmation)
        ) {
          setConfirmValue("");
          setMode("confirm");
        } else {
          onAction("accept", activeCommand);
        }
      } else if (k === "e") {
        setEditValue(activeCommand);
        setMode("editing");
      } else if (k === "s") {
        onAction("skip", activeCommand);
      }
    },
    { isActive: mode === "review" }
  );

  const handleEditSubmit = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) {
      onAction("skip", suggested);
      return;
    }
    setActiveCommand(trimmed);
    setMode("review");
  };

  const handleConfirmSubmit = (val: string) => {
    if (val.trim().toLowerCase() === "proceed") {
      onAction("accept", activeCommand);
    } else {
      setConfirmValue("");
    }
  };

  const diffTokens =
    activeCommand !== suggested ? wordDiff(suggested, activeCommand) : null;

  const notesText = safetyDecision.notes ?? "";

  // Build history line parts
  const successCount = priorStats?.successes ?? 0;
  const failureCount = priorStats?.failures ?? 0;
  const hasHistory = priorStats && priorStats.total > 0;

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Main command box */}
      <Box
        borderStyle="round"
        borderColor={mode === "confirm" ? "red" : "gray"}
        flexDirection="column"
        paddingX={1}
      >
        {/* Header row: label + risk badge */}
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="gray">{"COMMAND TO EXECUTE:"}</Text>
          <Text bold color={riskColor as any}>{riskLabel}</Text>
        </Box>

        {/* Command line */}
        <Text color="cyan">{"$ "}{activeCommand}</Text>

        {/* History / notes line */}
        {(hasHistory || notesText) && (
          <Box flexDirection="row">
            {hasHistory && (
              <>
                <Text color="gray">{"history: "}</Text>
                <Text color="green">{`${successCount} success`}</Text>
                <Text color="gray">{" / "}</Text>
                <Text color={failureCount > 0 ? "red" : "gray"}>{`${failureCount} failure`}</Text>
              </>
            )}
            {hasHistory && notesText && (
              <Text color="gray">{" | "}</Text>
            )}
            {notesText && (
              <Text color="gray">{notesText}</Text>
            )}
          </Box>
        )}
        {!hasHistory && !notesText && safetyDisabled && (
          <Text color="yellow">{"safety checks disabled"}</Text>
        )}
      </Box>

      {/* Diff view */}
      {diffTokens && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Text color="red">{"─ "}</Text>
            {diffTokens
              .filter((t) => t.type !== "added")
              .map((t, i) => (
                <Text key={i} color={t.type === "removed" ? "red" : undefined}>
                  {t.text}{" "}
                </Text>
              ))}
          </Box>
          <Box flexDirection="row">
            <Text color="green">{"+ "}</Text>
            {diffTokens
              .filter((t) => t.type !== "removed")
              .map((t, i) => (
                <Text key={i} color={t.type === "added" ? "green" : undefined}>
                  {t.text}{" "}
                </Text>
              ))}
          </Box>
        </Box>
      )}

      {/* Action bar */}
      {mode === "review" && (
        <Box marginTop={1} flexDirection="row">
          <Text bold>{"(A)"}</Text><Text color="cyan">{"ccept  "}</Text>
          <Text bold>{"(E)"}</Text><Text color="cyan">{"dit  "}</Text>
          <Text bold>{"(S)"}</Text><Text color="cyan">{"kip"}</Text>
        </Box>
      )}

      {mode === "editing" && (
        <Box marginTop={1}>
          <Text color="cyan">{"Command› "}</Text>
          <TextInput
            value={editValue}
            onChange={setEditValue}
            onSubmit={handleEditSubmit}
          />
        </Box>
      )}

      {mode === "confirm" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>{"Type 'proceed' to confirm:"}</Text>
          <Box>
            <Text color="red">{"Confirm› "}</Text>
            <TextInput
              value={confirmValue}
              onChange={setConfirmValue}
              onSubmit={handleConfirmSubmit}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}

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

/** Simple word-level diff between two command strings. */
function wordDiff(original: string, edited: string) {
  const origWords = original.split(/\s+/);
  const editWords = edited.split(/\s+/);
  const origSet = new Set(origWords);
  const editSet = new Set(editWords);

  const tokens: Array<{ text: string; type: "same" | "added" | "removed" }> =
    [];

  // Use a simple LCS-style approach: iterate edit words and mark
  let oi = 0;
  for (const word of editWords) {
    if (origSet.has(word) && oi < origWords.length && origWords[oi] === word) {
      tokens.push({ text: word, type: "same" });
      oi++;
    } else {
      tokens.push({ text: word, type: "added" });
    }
  }
  // Remaining original words are removed
  while (oi < origWords.length) {
    tokens.unshift({ text: origWords[oi]!, type: "removed" });
    oi++;
  }
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

  // Keypress handler for review mode
  useInput(
    (input, key) => {
      if (mode !== "review") return;
      const k = input.toLowerCase();
      if (k === "a" || key.return) {
        // Accept — check if high-risk needs confirmation
        if (
          !safetyDisabled &&
          safetyDecision.requireConfirmation &&
          level === "high"
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

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Plan step context */}
      {planStep && (
        <Box flexDirection="column">
          <Text color="cyan">
            {"Plan step "}{planStep.id}{": "}{planStep.label()}
          </Text>
          {planStep.description && (
            <Text color="cyan">{"Description: "}{planStep.description}</Text>
          )}
          {planStep.command && planStep.command !== suggested && (
            <Text color="cyan">{"Planned command: "}{planStep.command}</Text>
          )}
        </Box>
      )}

      {/* Diff display */}
      {diffTokens ? (
        <Box>
          <Text color="blue">{"Diff (green=added, red=removed): "}</Text>
          {diffTokens.map((t, i) => (
            <Text
              key={i}
              color={
                t.type === "added"
                  ? "green"
                  : t.type === "removed"
                  ? "red"
                  : undefined
              }
            >
              {t.text}{" "}
            </Text>
          ))}
        </Box>
      ) : (
        <Text color="green">{"No changes from planner suggestion."}</Text>
      )}

      {/* Risk level */}
      <Text>
        <Text color={riskColor}>{"Risk level: "}</Text>
        <Text color={riskColor}>{safetyDecision.level.toUpperCase()}</Text>
      </Text>

      {safetyDecision.notes && (
        <Text color={riskColor}>{`Notes: ${safetyDecision.notes}`}</Text>
      )}

      {safetyDisabled && (
        <Text color="yellow">
          {"Safety checks disabled — risk assessment is informational only."}
        </Text>
      )}

      {/* Scoreboard history */}
      {priorStats && priorStats.total > 0 && (
        <Box flexDirection="column">
          <Text
            color={
              priorStats.failures > priorStats.successes
                ? "red"
                : priorStats.failures === priorStats.successes
                ? "yellow"
                : "green"
            }
          >
            {`History: ${priorStats.successes} success / ${priorStats.failures} failure (score ${priorStats.score})`}
          </Text>
          {priorStats.failures > priorStats.successes && (
            <Text color="yellow">
              {"Planner has struggled with this command; consider editing further."}
            </Text>
          )}
        </Box>
      )}

      {/* Action bar or edit input */}
      {mode === "review" && (
        <Box marginTop={1}>
          <Text color="cyan">{"Actions: "}</Text>
          <Text>{"(A)ccept  (E)dit  (S)kip"}</Text>
        </Box>
      )}

      {mode === "editing" && (
        <Box>
          <Text color="cyan">{"Command> "}</Text>
          <TextInput
            value={editValue}
            onChange={setEditValue}
            onSubmit={handleEditSubmit}
          />
        </Box>
      )}

      {mode === "confirm" && (
        <Box flexDirection="column">
          <Text color="red" bold>
            {"HIGH RISK: Type 'proceed' to confirm execution"}
          </Text>
          <Box>
            <Text color="red">{"Confirm> "}</Text>
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

/**
 * End-of-goal result table.
 * Replaces render_goal_summary() from agent_shell.py.
 */

import React from "react";
import { Box, Text } from "ink";
import type { CommandResult } from "../lib/types.js";
import { truncateCommand } from "../lib/planState.js";

interface GoalSummaryProps {
  goal: string;
  history: CommandResult[];
  status: string;
}

const CMD_WIDTH = 36;
const DIVIDER = " " + "─".repeat(57);

export function GoalSummary({ goal, history, status }: GoalSummaryProps) {
  if (history.length === 0) return null;

  const statusColor = status === "success" ? "green" : status === "failed" ? "red" : "yellow";

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>
        {"Goal: "}{goal}{" ("}
        <Text color={statusColor as any}>{status}</Text>
        {")"}
      </Text>
      {/* Column headers */}
      <Text color="gray">
        {" #  "}
        {"Command".padEnd(CMD_WIDTH)}
        {"Exit  "}
        {"Risk      "}
        {"Outcome"}
      </Text>
      <Text color="gray">{DIVIDER}</Text>
      {history.map((result, idx) => {
        const outcome = result.returncode === 0 ? "ok" : "fail";
        const outcomeColor = result.returncode === 0 ? "green" : "red";
        const exitColor = result.returncode === 0 ? "green" : "red";
        const riskColor =
          result.riskLevel === "high"
            ? "red"
            : result.riskLevel === "medium"
            ? "yellow"
            : "green";
        const num = String(idx + 1).padStart(2);
        const cmd = truncateCommand(result.suggestedCommand).padEnd(CMD_WIDTH);
        const exit = String(result.returncode).padStart(4);
        const risk = result.riskLevel.toUpperCase().padEnd(10);

        return (
          <Box key={idx} flexDirection="row">
            <Text>{` ${num}  ${cmd}`}</Text>
            <Text color={exitColor as any}>{exit}</Text>
            <Text>{"  "}</Text>
            <Text color={riskColor as any}>{risk}</Text>
            <Text color={outcomeColor as any}>{outcome}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

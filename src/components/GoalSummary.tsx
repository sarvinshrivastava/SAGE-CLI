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

export function GoalSummary({ goal, history, status }: GoalSummaryProps) {
  if (history.length === 0) return null;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>{`Goal summary (${status}):`}</Text>
      {history.map((result, idx) => {
        const outcome = result.returncode === 0 ? "ok" : "fail";
        const outcomeColor = result.returncode === 0 ? "green" : "red";
        return (
          <Text key={idx}>
            {"  "}
            {idx + 1}. {truncateCommand(result.suggestedCommand)}
            {" | exit "}
            <Text color={outcomeColor}>{result.returncode}</Text>
            {" | risk "}
            <Text
              color={
                result.riskLevel === "high"
                  ? "red"
                  : result.riskLevel === "medium"
                  ? "yellow"
                  : "green"
              }
            >
              {result.riskLevel.toUpperCase()}
            </Text>
            {" | "}
            <Text color={outcomeColor}>{outcome}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

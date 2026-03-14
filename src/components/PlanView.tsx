/**
 * Renders a plan with step status colors.
 * Replaces render_plan() / render_plan_progress() from agent_shell.py.
 */

import React from "react";
import { Box, Text } from "ink";
import type { PlanState } from "../lib/planState.js";

const STATUS_COLORS: Record<string, string> = {
  pending: "white",
  in_progress: "yellow",
  completed: "green",
  failed: "red",
};

interface PlanViewProps {
  plan: PlanState;
  header?: string;
}

export function PlanView({ plan, header = "New plan received" }: PlanViewProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color="cyan">
        {header}
      </Text>
      {plan.summary && (
        <Text>
          <Text color="cyan">{"Summary: "}</Text>
          {plan.summary}
        </Text>
      )}
      {plan.steps.map((step) => {
        const color = STATUS_COLORS[step.status] ?? "white";
        return (
          <Box key={step.id} flexDirection="column">
            <Text color={color as any}>
              {"  "}
              {step.id} - {step.label()}
            </Text>
            {step.description && (
              <Text color="gray">{"     "}{step.description}</Text>
            )}
            {step.command && (
              <Text color="gray">{"     command: "}{step.command}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

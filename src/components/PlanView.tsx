/**
 * Renders a plan with step status colors.
 * Replaces render_plan() / render_plan_progress() from agent_shell.py.
 */

import React from "react";
import { Box, Text } from "ink";
import type { PlanState } from "../lib/planState.js";

const STATUS_ICON: Record<string, string> = {
  pending: "○",
  in_progress: "●",
  completed: "✓",
  failed: "✗",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "gray",
  in_progress: "yellow",
  completed: "green",
  failed: "red",
};

interface PlanViewProps {
  plan: PlanState;
  header?: string;
}

interface PlanStripProps {
  plan: PlanState;
}

/** Horizontal strip showing up to 6 plan steps with status icons. */
export function PlanStrip({ plan }: PlanStripProps) {
  const MAX_VISIBLE = 6;
  const steps = plan.steps;
  const visible = steps.slice(0, MAX_VISIBLE);
  const overflow = steps.length - MAX_VISIBLE;

  return (
    <Box flexDirection="row" marginBottom={1}>
      {visible.map((step, idx) => {
        const icon = STATUS_ICON[step.status] ?? "○";
        const color = STATUS_COLORS[step.status] ?? "gray";
        return (
          <Box key={step.id} flexDirection="row">
            {idx > 0 && <Text color="gray">{" ─ "}</Text>}
            <Text color={color as any}>
              {icon} {step.id}. {step.label()}
            </Text>
          </Box>
        );
      })}
      {overflow > 0 && (
        <Text color="gray">{` ─ +${overflow} more`}</Text>
      )}
    </Box>
  );
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
      <PlanStrip plan={plan} />
      {plan.steps.map((step) => {
        const color = STATUS_COLORS[step.status] ?? "white";
        return (
          <Box key={step.id} flexDirection="column">
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

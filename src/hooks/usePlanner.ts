/**
 * React hook wrapping planner.suggest().
 */

import { useState, useCallback } from "react";
import type { CommandPlanner } from "../lib/planner.js";
import type { PlannerSuggestion, PlannerTurn } from "../lib/types.js";

export interface PlannerHookState {
  loading: boolean;
  error: string | null;
  suggestion: PlannerSuggestion | null;
}

export function usePlanner(planner: CommandPlanner) {
  const [state, setState] = useState<PlannerHookState>({
    loading: false,
    error: null,
    suggestion: null,
  });

  const suggest = useCallback(
    async (
      goal: string,
      history: PlannerTurn[] = []
    ): Promise<PlannerSuggestion | null> => {
      setState({ loading: true, error: null, suggestion: null });
      try {
        const result = await planner.suggest(goal, history);
        setState({ loading: false, error: null, suggestion: result });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({ loading: false, error: msg, suggestion: null });
        return null;
      }
    },
    [planner]
  );

  return { ...state, suggest };
}

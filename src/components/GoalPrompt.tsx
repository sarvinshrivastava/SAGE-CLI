/**
 * Text input for user goals — replaces prompt_toolkit session.prompt("User> ").
 */

import React, { useState } from "react";
import { Text, Box } from "ink";
import TextInput from "ink-text-input";

interface GoalPromptProps {
  onGoal: (goal: string) => void;
  onExit: () => void;
  onMeta?: (meta: string) => void;
  sessionInfo?: string;
  safetyDisabled?: boolean;
}

export function GoalPrompt({ onGoal, onExit, onMeta, sessionInfo, safetyDisabled }: GoalPromptProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    setValue("");
    if (!trimmed) return;

    if (["exit", "quit", "e", "q"].includes(trimmed.toLowerCase())) {
      onExit();
      return;
    }

    if (trimmed.startsWith(":")) {
      const meta = trimmed.slice(1).trim().toLowerCase();
      onMeta?.(meta);
      return;
    }

    onGoal(trimmed);
  };

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold color="cyan">{"User› "}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
        {safetyDisabled && (
          <Text color="yellow">{"  ⚠ safety off"}</Text>
        )}
      </Box>
      {sessionInfo && (
        <Text color="gray">{sessionInfo}</Text>
      )}
    </Box>
  );
}

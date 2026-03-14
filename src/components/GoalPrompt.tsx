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
}

export function GoalPrompt({ onGoal, onExit, onMeta }: GoalPromptProps) {
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
    <Box>
      <Text color="cyan">{"User> "}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
    </Box>
  );
}

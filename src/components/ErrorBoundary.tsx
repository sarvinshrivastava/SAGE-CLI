/**
 * React error boundary for the Ink component tree.
 * Catches render/lifecycle exceptions and shows a recoverable error message
 * instead of crashing the whole CLI process.
 */

import React from "react";
import { Box, Text } from "ink";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Box flexDirection="column" marginY={1}>
        <Text color="red" bold>
          {"[SAGE] Fatal render error: "}
          {error.message}
        </Text>
        <Text color="gray">
          {"Restart SAGE CLI. If this persists, check the log file."}
        </Text>
      </Box>
    );
  }
}

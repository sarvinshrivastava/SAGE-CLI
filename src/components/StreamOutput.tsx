/**
 * Live stdout/stderr display — replaces stream_process_output() + rich.Console.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

interface StreamOutputProps {
  stdout: string[];
  stderr: string[];
  command: string;
  exitCode: number | null;
  running: boolean;
}

export function StreamOutput({
  stdout,
  stderr,
  command,
  exitCode,
  running,
}: StreamOutputProps) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {running ? (
          <Text color="cyan"><Spinner type="dots" /></Text>
        ) : (
          <Text color="cyan">{"▶"}</Text>
        )}
        <Text color="cyan">{" executing: "}</Text>
        <Text color="white">{command}</Text>
      </Box>
      {stdout.map((line, i) => (
        <Text key={`out-${i}`} color="green">
          {line.trimEnd()}
        </Text>
      ))}
      {stderr.map((line, i) => (
        <Text key={`err-${i}`} color="yellow">
          {line.trimEnd()}
        </Text>
      ))}
      {!running && exitCode !== null && (
        <Text color={exitCode === 0 ? "green" : "red"}>{`exit: ${exitCode}`}</Text>
      )}
    </Box>
  );
}

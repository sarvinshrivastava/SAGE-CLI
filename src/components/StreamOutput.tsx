/**
 * Live stdout/stderr display — replaces stream_process_output() + rich.Console.
 */

import React from "react";
import { Box, Text } from "ink";

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
      <Text color="cyan">{"Executing: "}<Text color="white">{command}</Text></Text>
      {stdout.map((line, i) => (
        <Text key={`out-${i}`} color="green">
          {line.trimEnd()}
        </Text>
      ))}
      {stderr.map((line, i) => (
        <Text key={`err-${i}`} color="red">
          {line.trimEnd()}
        </Text>
      ))}
      {!running && exitCode !== null && (
        <Text color="magenta">{`Exit code: ${exitCode}`}</Text>
      )}
    </Box>
  );
}

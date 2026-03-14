/**
 * React hook that spawns a child process and streams its output.
 */

import { useState, useCallback } from "react";
import { spawn } from "child_process";

export interface CommandExecState {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  running: boolean;
}

export function useCommandExec() {
  const [state, setState] = useState<CommandExecState>({
    stdout: [],
    stderr: [],
    exitCode: null,
    running: false,
  });

  const execute = useCallback((command: string) => {
    setState({ stdout: [], stderr: [], exitCode: null, running: true });

    const child = spawn(command, { shell: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      setState((prev) => ({ ...prev, stdout: [...prev.stdout, text] }));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      setState((prev) => ({ ...prev, stderr: [...prev.stderr, text] }));
    });

    child.on("close", (code) => {
      setState((prev) => ({
        ...prev,
        exitCode: code ?? 1,
        running: false,
      }));
    });

    child.on("error", (err) => {
      setState((prev) => ({
        ...prev,
        stderr: [...prev.stderr, `Process error: ${err.message}\n`],
        exitCode: 1,
        running: false,
      }));
    });
  }, []);

  return { ...state, execute };
}

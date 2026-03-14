/**
 * React hook that spawns a child process and streams its output.
 */

import { useState, useRef, useCallback } from "react";
import { spawn } from "child_process";

export interface CommandExecState {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  running: boolean;
}

export function useCommandExec() {
  // Accumulate chunks in refs (O(1) push) to avoid O(n²) array spreading on
  // every data event. State is synced on an interval and on close.
  const stdoutRef = useRef<string[]>([]);
  const stderrRef = useRef<string[]>([]);

  const [state, setState] = useState<CommandExecState>({
    stdout: [],
    stderr: [],
    exitCode: null,
    running: false,
  });

  const execute = useCallback((command: string) => {
    stdoutRef.current = [];
    stderrRef.current = [];
    setState({ stdout: [], stderr: [], exitCode: null, running: true });

    const child = spawn(command, { shell: true });

    // Flush accumulated output to state every 100 ms for live display.
    const flushInterval = setInterval(() => {
      setState((prev) => ({
        ...prev,
        stdout: [...stdoutRef.current],
        stderr: [...stderrRef.current],
      }));
    }, 100);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutRef.current.push(chunk.toString());
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrRef.current.push(chunk.toString());
    });

    child.on("close", (code) => {
      clearInterval(flushInterval);
      setState({
        stdout: [...stdoutRef.current],
        stderr: [...stderrRef.current],
        exitCode: code ?? 1,
        running: false,
      });
    });

    child.on("error", (err) => {
      clearInterval(flushInterval);
      stderrRef.current.push(`Process error: ${err.message}\n`);
      setState({
        stdout: [...stdoutRef.current],
        stderr: [...stderrRef.current],
        exitCode: 1,
        running: false,
      });
    });
  }, []);

  return { ...state, execute };
}

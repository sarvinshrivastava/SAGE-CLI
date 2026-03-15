/**
 * React hook that spawns a child process and streams its output.
 */

import { useState, useRef, useCallback } from "react";
import { spawn, type ChildProcess } from "child_process";

export interface CommandExecState {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  running: boolean;
}

/**
 * Module-level handle to the currently running child process killer.
 * Signal handlers in index.tsx use this to kill an active command on
 * SIGINT/SIGTERM without needing access to the React component tree.
 */
export let activeKill: (() => void) | null = null;

export function useCommandExec() {
  // Accumulate chunks in refs (O(1) push) to avoid O(n²) array spreading on
  // every data event. State is synced on an interval and on close.
  const stdoutRef = useRef<string[]>([]);
  const stderrRef = useRef<string[]>([]);
  const childRef = useRef<ChildProcess | null>(null);

  const [state, setState] = useState<CommandExecState>({
    stdout: [],
    stderr: [],
    exitCode: null,
    running: false,
  });

  const kill = useCallback(() => {
    const child = childRef.current;
    if (!child) return;
    child.kill("SIGTERM");
    // Escalate to SIGKILL if the process ignores SIGTERM
    setTimeout(() => child.kill("SIGKILL"), 3000);
  }, []);

  const execute = useCallback(
    (command: string, timeoutMs?: number) => {
      stdoutRef.current = [];
      stderrRef.current = [];
      setState({ stdout: [], stderr: [], exitCode: null, running: true });

      const child = spawn(command, { shell: true });
      childRef.current = child;
      activeKill = kill;

      // Optional hard deadline — sends SIGTERM then escalates to SIGKILL
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs && timeoutMs > 0) {
        killTimer = setTimeout(() => {
          stderrRef.current.push(
            `\nProcess killed: exceeded ${Math.round(timeoutMs / 1000)}s timeout\n`
          );
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 3000);
        }, timeoutMs);
      }

      const cleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        childRef.current = null;
        activeKill = null;
      };

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
        cleanup();
        clearInterval(flushInterval);
        setState({
          stdout: [...stdoutRef.current],
          stderr: [...stderrRef.current],
          exitCode: code ?? 1,
          running: false,
        });
      });

      child.on("error", (err) => {
        cleanup();
        clearInterval(flushInterval);
        stderrRef.current.push(`Process error: ${err.message}\n`);
        setState({
          stdout: [...stdoutRef.current],
          stderr: [...stderrRef.current],
          exitCode: 1,
          running: false,
        });
      });
    },
    [kill]
  );

  return { ...state, execute, kill };
}

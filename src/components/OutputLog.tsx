/**
 * Persistent scrollback log — accumulates entries across phase transitions
 * so users always see the full session history above the active zone.
 */

import React from "react";
import { Box, Text } from "ink";
import type { CommandResult } from "../lib/types.js";
import { truncateCommand } from "../lib/planState.js";

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

export type LogEntry =
  | { type: "goal"; text: string }
  | { type: "chat"; message: string; thinkContent?: string }
  | { type: "command"; command: string; stdout: string[]; stderr: string[]; exitCode: number; riskLevel: string }
  | { type: "plan"; summary: string | null; stepCount: number }
  | { type: "replan"; revision: number; summary: string | null; keptCount: number; replacedCount: number }
  | { type: "summary"; goal: string; history: CommandResult[]; status: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Individual entry renderers
// ---------------------------------------------------------------------------

const TAIL_LINES = 4;

function GoalEntry({ text }: { text: string }) {
  return (
    <Box marginTop={1}>
      <Text bold color="cyan">{"▸ "}</Text>
      <Text bold>{text}</Text>
    </Box>
  );
}

function ChatEntry({ message, thinkContent }: { message: string; thinkContent?: string }) {
  return (
    <Box flexDirection="column" marginY={1}>
      {thinkContent && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color="gray" dimColor>{"thinking:"}</Text>
          {thinkContent.split("\n").map((line, i) => (
            <Text key={i} color="gray" dimColor>{"  "}{line}</Text>
          ))}
        </Box>
      )}
      <Box>
        <Text color="green">{"Assistant: "}</Text>
        <Text>{message}</Text>
      </Box>
    </Box>
  );
}

function CommandEntry({
  command, stdout, stderr, exitCode, riskLevel,
}: {
  command: string;
  stdout: string[];
  stderr: string[];
  exitCode: number;
  riskLevel: string;
}) {
  const riskColor = riskLevel === "high" ? "red" : riskLevel === "medium" ? "yellow" : "green";
  const tail = stdout.slice(-TAIL_LINES);
  const hiddenCount = stdout.length - tail.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color="gray">{"$ "}</Text>
        <Text color="cyan">{truncateCommand(command)}</Text>
        <Text color="gray">{"  ["}</Text>
        <Text color={riskColor as any}>{riskLevel.toUpperCase()}</Text>
        <Text color="gray">{"]"}</Text>
      </Box>
      {hiddenCount > 0 && (
        <Text color="gray" dimColor>{"  … "}{hiddenCount}{" lines"}</Text>
      )}
      {tail.map((line, i) => (
        <Text key={i} color="green">{"  "}{line.trimEnd()}</Text>
      ))}
      {stderr.slice(-2).map((line, i) => (
        <Text key={i} color="yellow">{"  "}{line.trimEnd()}</Text>
      ))}
      <Text color={exitCode === 0 ? "green" : "red"}>{"  exit: "}{exitCode}</Text>
    </Box>
  );
}

function PlanEntry({ summary, stepCount }: { summary: string | null; stepCount: number }) {
  return (
    <Box marginTop={1}>
      <Text color="cyan">{"plan: "}</Text>
      <Text>{summary ?? "(no summary)"}</Text>
      <Text color="gray">{" — "}{stepCount}{" steps"}</Text>
    </Box>
  );
}

function ReplanEntry({
  revision, summary, keptCount, replacedCount,
}: {
  revision: number;
  summary: string | null;
  keptCount: number;
  replacedCount: number;
}) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box flexDirection="row">
        <Text color="yellow">{"↻ plan revised"}</Text>
        <Text color="gray">{" (revision "}{revision}{")"}</Text>
      </Box>
      {summary && <Text color="gray">{"  "}{summary}</Text>}
      <Text color="gray">
        {"  "}{keptCount}{" step"}{keptCount !== 1 ? "s" : ""}{" kept · "}
        {replacedCount}{" step"}{replacedCount !== 1 ? "s" : ""}{" replaced"}
      </Text>
    </Box>
  );
}

function SummaryEntry({
  goal, history, status,
}: {
  goal: string;
  history: CommandResult[];
  status: string;
}) {
  if (history.length === 0) return null;
  const statusColor = status === "success" ? "green" : status === "failed" ? "red" : "yellow";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        {"✓ done: "}{goal}{" ("}
        <Text color={statusColor as any}>{status}</Text>
        {")"}
      </Text>
      {history.map((r, i) => {
        const oc = r.returncode === 0 ? "green" : "red";
        return (
          <Text key={i} color="gray">
            {"  "}{i + 1}. {truncateCommand(r.suggestedCommand)}
            {" → exit "}
            <Text color={oc as any}>{r.returncode}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function ErrorEntry({ message }: { message: string }) {
  return (
    <Box marginTop={1}>
      <Text color="red">{"✗ error: "}</Text>
      <Text color="red">{message}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// OutputLog
// ---------------------------------------------------------------------------

interface OutputLogProps {
  entries: LogEntry[];
}

export function OutputLog({ entries }: OutputLogProps) {
  if (entries.length === 0) return null;
  return (
    <Box flexDirection="column">
      {entries.map((entry, i) => {
        switch (entry.type) {
          case "goal":
            return <GoalEntry key={i} text={entry.text} />;
          case "chat":
            return <ChatEntry key={i} message={entry.message} thinkContent={entry.thinkContent} />;
          case "command":
            return (
              <CommandEntry
                key={i}
                command={entry.command}
                stdout={entry.stdout}
                stderr={entry.stderr}
                exitCode={entry.exitCode}
                riskLevel={entry.riskLevel}
              />
            );
          case "plan":
            return <PlanEntry key={i} summary={entry.summary} stepCount={entry.stepCount} />;
          case "replan":
            return (
              <ReplanEntry
                key={i}
                revision={entry.revision}
                summary={entry.summary}
                keptCount={entry.keptCount}
                replacedCount={entry.replacedCount}
              />
            );
          case "summary":
            return <SummaryEntry key={i} goal={entry.goal} history={entry.history} status={entry.status} />;
          case "error":
            return <ErrorEntry key={i} message={entry.message} />;
        }
      })}
    </Box>
  );
}

import { describe, it, expect } from "bun:test";
import {
  parsePlannerReply,
  PlannerError,
  isRepeatedFailure,
} from "../lib/planner.js";
// Access internal helpers via the module's test surface
// (extractBalancedObjects and repairSimpleCommandJson are not exported, so we
//  test them indirectly through parsePlannerReply)

describe("parsePlannerReply — command mode", () => {
  it("parses a clean command response", () => {
    const s = parsePlannerReply('{"mode":"command","command":"ls -la"}');
    expect(s.mode).toBe("command");
    if (s.mode === "command") expect(s.command).toBe("ls -la");
  });

  it("parses command when mode field is absent", () => {
    const s = parsePlannerReply('{"command":"echo hello"}');
    expect(s.mode).toBe("command");
  });

  it("strips <think> block before parsing", () => {
    const s = parsePlannerReply(
      '<think>reasoning here</think>\n{"mode":"command","command":"pwd"}'
    );
    expect(s.mode).toBe("command");
    if (s.mode === "command") expect(s.command).toBe("pwd");
    expect(s.thinkContent).toBe("reasoning here");
  });

  it("parses command inside fenced code block", () => {
    const s = parsePlannerReply("```json\n{\"mode\":\"command\",\"command\":\"whoami\"}\n```");
    expect(s.mode).toBe("command");
  });

  it("parses command when preceded by preamble text", () => {
    const s = parsePlannerReply(
      'Sure, here is the next command:\n{"mode":"command","command":"uptime"}'
    );
    expect(s.mode).toBe("command");
    if (s.mode === "command") expect(s.command).toBe("uptime");
  });
});

describe("parsePlannerReply — chat mode", () => {
  it("parses a chat response", () => {
    const s = parsePlannerReply('{"mode":"chat","message":"What directory should I use?"}');
    expect(s.mode).toBe("chat");
    if (s.mode === "chat") expect(s.message).toBe("What directory should I use?");
  });

  it("accepts response/answer as fallback keys for message", () => {
    const s = parsePlannerReply('{"mode":"chat","response":"Got it"}');
    expect(s.mode).toBe("chat");
    if (s.mode === "chat") expect(s.message).toBe("Got it");
  });
});

describe("parsePlannerReply — plan mode", () => {
  const planJson = JSON.stringify({
    mode: "plan",
    plan: {
      summary: "Install and start nginx",
      steps: [
        { id: "1", title: "Update packages", command: "apt-get update -y" },
        { id: "2", title: "Install nginx", command: "apt-get install -y nginx" },
      ],
    },
  });

  it("parses a plan response with nested objects", () => {
    const s = parsePlannerReply(planJson);
    expect(s.mode).toBe("plan");
    if (s.mode === "plan") {
      expect(s.plan.summary).toBe("Install and start nginx");
      expect(s.plan.steps).toHaveLength(2);
      expect(s.plan.steps[0]!.id).toBe("1");
    }
  });

  it("handles plan nested inside preamble text (extractBalancedObjects)", () => {
    const s = parsePlannerReply("Here is my plan:\n" + planJson);
    expect(s.mode).toBe("plan");
  });
});

describe("parsePlannerReply — error cases", () => {
  it("throws PlannerError for completely unparseable input", () => {
    expect(() => parsePlannerReply("not json at all")).toThrow(PlannerError);
  });

  it("throws PlannerError when required fields are missing", () => {
    expect(() => parsePlannerReply('{"foo":"bar"}')).toThrow(PlannerError);
  });
});

describe("isRepeatedFailure", () => {
  it("returns false with empty history", () => {
    expect(isRepeatedFailure("ls", [])).toBe(false);
  });

  it("returns false when command failed only once", () => {
    const history = [
      { suggestedCommand: "ls", executedCommand: "ls", stdout: "", stderr: "", exitCode: 1 },
    ];
    expect(isRepeatedFailure("ls", history)).toBe(false);
  });

  it("returns true when command failed twice", () => {
    const history = [
      { suggestedCommand: "ls", executedCommand: "ls", stdout: "", stderr: "", exitCode: 1 },
      { suggestedCommand: "ls", executedCommand: "ls", stdout: "", stderr: "", exitCode: 1 },
    ];
    expect(isRepeatedFailure("ls", history)).toBe(true);
  });

  it("normalizes whitespace before comparing", () => {
    const history = [
      { suggestedCommand: "ls  -la", executedCommand: "ls  -la", stdout: "", stderr: "", exitCode: 1 },
      { suggestedCommand: "ls -la", executedCommand: "ls -la", stdout: "", stderr: "", exitCode: 1 },
    ];
    expect(isRepeatedFailure("ls -la", history)).toBe(true);
  });

  it("does not count successful executions as failures", () => {
    const history = [
      { suggestedCommand: "ls", executedCommand: "ls", stdout: "", stderr: "", exitCode: 0 },
      { suggestedCommand: "ls", executedCommand: "ls", stdout: "", stderr: "", exitCode: 1 },
    ];
    expect(isRepeatedFailure("ls", history)).toBe(false);
  });
});

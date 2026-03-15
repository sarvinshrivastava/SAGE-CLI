import { describe, it, expect } from "bun:test";
import { CommandScoreboard, CommandStats } from "../lib/scoreboard.js";

describe("CommandScoreboard._normalize", () => {
  it("collapses extra whitespace", () => {
    expect(CommandScoreboard._normalize("ls   -la")).toBe("ls -la");
  });

  it("trims leading/trailing whitespace", () => {
    expect(CommandScoreboard._normalize("  pwd  ")).toBe("pwd");
  });

  it("normalizes absolute paths to <path>", () => {
    expect(CommandScoreboard._normalize("cat /tmp/file.txt")).toBe("cat <path>");
    expect(CommandScoreboard._normalize("rm /home/user/data")).toBe("rm <path>");
  });

  it("normalizes home-relative paths to <path>", () => {
    expect(CommandScoreboard._normalize("cat ~/notes.txt")).toBe("cat <path>");
  });

  it("makes two commands with different paths match the same key", () => {
    const a = CommandScoreboard._normalize("cat /tmp/file1.txt");
    const b = CommandScoreboard._normalize("cat /tmp/file2.txt");
    expect(a).toBe(b);
  });

  it("normalizes --flag=value to --flag=<val>", () => {
    expect(CommandScoreboard._normalize("cmd --output=/tmp/x")).toBe("cmd --output=<val>");
    expect(CommandScoreboard._normalize("cmd --timeout=30")).toBe("cmd --timeout=<val>");
  });

  it("makes two commands differing only in flag value match the same key", () => {
    const a = CommandScoreboard._normalize("curl --timeout=30 https://example.com");
    const b = CommandScoreboard._normalize("curl --timeout=60 https://example.com");
    expect(a).toBe(b);
  });

  it("does not mangle simple commands with no paths or flags", () => {
    expect(CommandScoreboard._normalize("echo hello world")).toBe("echo hello world");
  });
});

describe("CommandScoreboard record/analyze", () => {
  it("returns null stats for unseen command", () => {
    const sb = new CommandScoreboard();
    const [, stats] = sb.analyze("ls");
    expect(stats).toBeNull();
  });

  it("records successes and failures correctly", () => {
    const sb = new CommandScoreboard();
    sb.record("ls", true);
    sb.record("ls", true);
    sb.record("ls", false);
    const [, stats] = sb.analyze("ls");
    expect(stats!.successes).toBe(2);
    expect(stats!.failures).toBe(1);
    expect(stats!.total).toBe(3);
    expect(stats!.score).toBe(1);
  });

  it("treats whitespace-normalized variants as the same command", () => {
    const sb = new CommandScoreboard();
    sb.record("ls  -la", true);
    const [, stats] = sb.analyze("ls -la");
    expect(stats!.successes).toBe(1);
  });

  it("treats commands with different absolute paths as the same key", () => {
    const sb = new CommandScoreboard();
    sb.record("cat /tmp/a.txt", false);
    sb.record("cat /tmp/b.txt", false);
    const [, stats] = sb.analyze("cat /tmp/c.txt");
    expect(stats!.failures).toBe(2);
  });

  it("returns a copy from analyze (not the live object)", () => {
    const sb = new CommandScoreboard();
    sb.record("pwd", true);
    const [, snapshot] = sb.analyze("pwd");
    sb.record("pwd", false);
    // snapshot should not reflect the new record
    expect(snapshot!.failures).toBe(0);
  });

  it("separate scoreboard instances do not share state", () => {
    const sb1 = new CommandScoreboard();
    const sb2 = new CommandScoreboard();
    sb1.record("ls", true);
    const [, stats] = sb2.analyze("ls");
    expect(stats).toBeNull();
  });
});

describe("CommandStats", () => {
  it("computes score as successes minus failures", () => {
    const s = new CommandStats(3, 1);
    expect(s.score).toBe(2);
  });

  it("computes total", () => {
    const s = new CommandStats(2, 3);
    expect(s.total).toBe(5);
  });

  it("serializes to dict", () => {
    const s = new CommandStats(1, 2);
    expect(s.toDict()).toEqual({ successes: 1, failures: 2, score: -1 });
  });
});

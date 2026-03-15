import { describe, it, expect } from "bun:test";
import { SafetyPolicy, SafetyRule } from "../lib/safety.js";

describe("SafetyPolicy.default()", () => {
  const policy = SafetyPolicy.default();

  it("returns low for a harmless command", () => {
    const d = policy.evaluate("ls -la");
    expect(d.level).toBe("low");
    expect(d.requireConfirmation).toBe(false);
  });

  it("returns medium for sudo", () => {
    const d = policy.evaluate("sudo systemctl status nginx");
    expect(d.level).toBe("medium");
  });

  it("returns high for rm -rf /", () => {
    const d = policy.evaluate("rm -rf /");
    expect(d.level).toBe("high");
    expect(d.requireConfirmation).toBe(true);
  });

  it("returns high for fork-bomb pattern", () => {
    const d = policy.evaluate(":() { :|:& };:");
    expect(d.level).toBe("high");
  });

  it("returns high for mkfs", () => {
    const d = policy.evaluate("mkfs.ext4 /dev/sdb1");
    expect(d.level).toBe("high");
  });

  it("returns medium for apt-get install without -y and sets requireConfirmation", () => {
    const d = policy.evaluate("apt-get install nginx");
    expect(d.level).toBe("medium");
    expect(d.requireConfirmation).toBe(true);
    expect(d.notes).toMatch(/-y/);
  });

  it("returns medium for apt-get install with -y and no requireConfirmation", () => {
    const d = policy.evaluate("apt-get install -y nginx");
    expect(d.level).toBe("medium");
    expect(d.requireConfirmation).toBe(false);
  });

  it("escalates to highest risk when chaining safe && dangerous commands", () => {
    const d = policy.evaluate("echo hello && rm -rf /");
    expect(d.level).toBe("high");
    expect(d.requireConfirmation).toBe(true);
  });

  it("detects dangerous command hidden in backtick subshell", () => {
    const d = policy.evaluate("echo `rm -rf /`");
    expect(d.level).toBe("high");
  });

  it("returns low for empty command", () => {
    const d = policy.evaluate("   ");
    expect(d.level).toBe("low");
  });
});

describe("SafetyPolicy with custom rules", () => {
  it("uses first matching rule (priority order)", () => {
    const policy = new SafetyPolicy([
      new SafetyRule({ pattern: "curl", level: "medium" }),
      new SafetyRule({ pattern: "curl", level: "high", requireConfirmation: true }),
    ]);
    const d = policy.evaluate("curl https://example.com");
    expect(d.level).toBe("medium");
  });

  it("includes description in notes", () => {
    const policy = new SafetyPolicy([
      new SafetyRule({ pattern: "wget", level: "medium", description: "Downloads from the internet" }),
    ]);
    const d = policy.evaluate("wget https://example.com/file");
    expect(d.notes).toContain("Downloads from the internet");
  });
});

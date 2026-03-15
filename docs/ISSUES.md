# SAGE-CLI — Issues, Security Audit & Production Readiness

Audited against the TypeScript/Ink codebase (post-migration from Python).
All file paths and line numbers reference `src/`.

---

## Critical Security Vulnerabilities

### SEC-1 · Command Injection via `shell: true`

**File:** `hooks/useCommandExec.ts:33`

```ts
const child = spawn(command, { shell: true });
```

**Issue:** Every command string — including edits typed by the user in `CommandReview` — is passed verbatim to `/bin/sh -c`. Shell metacharacters (`;`, `&&`, `|`, `$()`, backticks, redirection) are interpreted by the shell. A planner that returns `echo hi; rm -rf ~` or a user who edits the command field can execute arbitrary chained operations without any additional review step.

**Why it matters:** SAGE-CLI is an agent that executes AI-generated commands with explicit user confirmation. A single bypass via metacharacter injection removes that safety guarantee entirely.

**Root cause:** `shell: true` is convenient for passing full command strings, but makes the shell the parser — not the application.

**Fix options:**

| Option | Notes |
|--------|-------|
| A — `shell: false` + arg parser | Parse command into `[executable, ...args]` using a shell-words library (`shell-quote`). Eliminates injection surface. Breaks multi-command strings. |
| B — Metacharacter blocklist | Reject or warn if command contains `;`, `&&`, `\|\|`, `$()`, backticks, `>`, `<` unless the user explicitly approves in a second confirmation step. |
| C — Sandboxed execution | Run commands inside a container or restricted environment. Too heavy for CLI, but ideal for high-security deployments. |

**Recommended:** Option B as a short-term measure alongside a stricter safety rule, Option A for production.

---

### SEC-2 · Interactive Commands Block the Entire UI

**File:** `hooks/useCommandExec.ts:33`

```ts
const child = spawn(command, { shell: true });
// stdin is not configured — inherits parent
```

**Issue:** Any command that reads from stdin (`read`, `sudo` (first-time password prompt), `ssh`, `mysql`, `vim`, `python` REPL, etc.) will hang indefinitely. Because Ink owns the TTY for its rendering loop, the child process's stdin read competes with Ink, producing a frozen UI with no way to recover other than `Ctrl+C` killing the whole process.

**Root cause:** `stdio` defaults to `'pipe'` for stdout/stderr but `'inherit'` for stdin in some configurations, or the child attempts an isatty check and blocks.

**Fix:** Explicitly set `stdio: ['ignore', 'pipe', 'pipe']`. Add a check in the safety policy or planner output filter that warns when a command is likely interactive (heuristic: `vim`, `nano`, `read`, `ssh`, `less`, `man`, `top`, `htop`).

---

### SEC-3 · Unbounded Memory Growth in Command Output Buffers

**File:** `hooks/useCommandExec.ts:18-19`, `44-50`

```ts
const stdoutRef = useRef<string[]>([]);   // grows without limit
const stderrRef = useRef<string[]>([]);

child.stdout.on("data", (chunk: Buffer) => {
  stdoutRef.current.push(chunk.toString());  // no ceiling
});
```

**Issue:** A command producing continuous output (`tail -f`, `find /`, a build process, a runaway loop) pushes chunks indefinitely. Node.js heap grows until the process is OOM-killed. Additionally, the 100ms flush interval copies the full array into React state on every tick, creating O(n) allocations that accelerate GC pressure.

**Fix:** Cap total buffer size (e.g. 2 MB). When the cap is reached, drop the oldest chunks and flag the output as truncated in the UI:

```ts
const MAX_BYTES = 2 * 1024 * 1024;
let totalBytes = 0;

child.stdout.on("data", (chunk: Buffer) => {
  if (totalBytes >= MAX_BYTES) return;
  totalBytes += chunk.length;
  stdoutRef.current.push(chunk.toString());
  if (totalBytes >= MAX_BYTES) {
    stdoutRef.current.push("\n[output truncated — 2 MB limit reached]\n");
  }
});
```

---

### SEC-4 · Path Traversal in Session File Paths

**File:** `lib/session.ts:43`, `54-57`

```ts
get path(): string {
  return path.join(this.root, `${this.sessionId}.jsonl`);
}

static initialize(directory: string | null, sessionId: string | null, ...): SessionManagerImpl {
  const base = path.resolve(expandHome(directory || "sessions"));
  const sid = sessionId || SessionManagerImpl._generateId();
  return new SessionManagerImpl(base, sid, true);
}
```

**Issue:** `sessionId` and `directory` come from CLI flags (`--session-id`, `--session-dir`) with no validation. A value of `../../etc/cron.d/sage` as sessionId writes a JSONL file outside the intended directory. `--session-dir /tmp` combined with a crafted sessionId could write session data anywhere the process has write permission.

**Fix:** Validate `sessionId` against `^[a-zA-Z0-9_-]{1,64}$` and resolve the final path, then assert it starts with the expected base directory:

```ts
const resolved = path.resolve(this.root, `${this.sessionId}.jsonl`);
if (!resolved.startsWith(path.resolve(this.root) + path.sep)) {
  throw new Error(`Session path escapes root: ${resolved}`);
}
```

---

### SEC-5 · Safety Policy Loaded from Arbitrary User-Supplied Path

**File:** `lib/safety.ts:84-98`

```ts
for (const candidate of candidates) {
  const resolved = path.resolve(expandHome(candidate));
  if (!fs.existsSync(resolved)) continue;
  const content = fs.readFileSync(resolved, "utf-8");
  data = JSON.parse(content);
  ...
  return new SafetyPolicy(rules);
}
```

**Issue:** `--safety-policy` accepts any file path. An attacker who controls the filesystem (or a malicious `.env` setting `AGENT_SAFETY_POLICY`) could supply a policy that downgrades all commands to `level: "low"` and `requireConfirmation: false`, disabling all safety checks silently. The policy file is silently skipped if it fails JSON parse (line 93 `continue`) — an error in the file falls back to a different file, not the built-in defaults, potentially loading an attacker-controlled file lower in the candidates list.

**Fix:** Log a warning (to stderr, not just log file) when a policy file fails to parse. Never silently fall through to a lower-trust file. Consider locking the policy path to files within the project root or home directory.

---

### SEC-6 · Regex Compilation Error Crashes the Process at Startup

**File:** `lib/safety.ts:38`

```ts
this.regex = new RegExp(opts.pattern, "i");
```

**Issue:** `SafetyRule` constructor is called for every entry in a user-supplied `safety_policy.json`. If any `pattern` field is an invalid regex (e.g. `"(unclosed"`), `new RegExp()` throws a `SyntaxError` that is not caught anywhere in the call chain. This crashes the entire process during `SafetyPolicy.load()` before the UI renders, with a raw Node.js error — not a friendly message.

**Fix:**

```ts
try {
  this.regex = new RegExp(opts.pattern, "i");
} catch (e) {
  throw new Error(`Invalid regex pattern "${opts.pattern}" in safety rule: ${e}`);
}
```

And in `_rulesFromMapping`, wrap individual rule construction in try-catch to skip bad rules with a warning rather than aborting.

---

## High Severity Bugs

### BUG-1 · `setInterval` Leaks When Component Unmounts During Execution

**File:** `hooks/useCommandExec.ts:36-42`, `52-70`

```ts
const flushInterval = setInterval(() => { ... }, 100);

child.on("close", (code) => {
  clearInterval(flushInterval);  // Only cleared on close
  ...
});
child.on("error", (err) => {
  clearInterval(flushInterval);  // And on error
  ...
});
```

**Issue:** The interval is only cleared inside `child.on("close")` or `child.on("error")`. If the Ink component tree unmounts (e.g. the process receives SIGINT while a command is running), the interval keeps firing and calling `setState()` on an unmounted component. In React 18 strict mode this is a no-op, but in Node/Ink it can cause `Cannot update an unmounted component` warnings or silent state updates that interfere with the next render cycle. The child process itself also continues running.

**Fix:** Return a cleanup function from `useCallback` (or expose a `kill()` method) that clears the interval and calls `child.kill()`:

```ts
const cleanupRef = useRef<(() => void) | null>(null);

// Inside execute():
cleanupRef.current = () => {
  clearInterval(flushInterval);
  child.kill();
};

// Expose: { ...state, execute, kill: cleanupRef.current }
```

And in `App.tsx`, call `kill()` in a `useEffect` cleanup when transitioning away from the `executing` phase.

---

### BUG-2 · Safety Rules Miss Subcommand Injection in `sudo` Wrappers

**File:** `lib/safety.ts:149`

```ts
new SafetyRule({ pattern: r`\bsudo\b`, level: "medium" }),
```

**Issue:** `sudo` is flagged as medium risk, but dangerous commands preceded by `sudo` are not automatically elevated to high. A planner that returns `sudo rm -rf /` passes the safety check with `level: "medium"` — the `rm -rf /` rule never fires because safety evaluation stops at the first matching rule (line 169-172: `return rule.evaluate(normalized)` on first match). Rules are priority-ordered; `sudo` appears before `rm -rf /`.

**Root cause:** Safety rules are evaluated first-match-wins, and `\bsudo\b` matches before the destructive-command rules ever run.

**Fix:** Either evaluate all rules and take the highest level, or strip `sudo` (and other prefixes like `env`, `bash -c`, `sh -c`) before evaluating the command against high-risk patterns:

```ts
const stripped = normalized.replace(/^\s*(sudo|env\s+\S+=\S+\s*)+/, "").trim();
// Now evaluate stripped against all rules, then fall back to original
```

---

### BUG-3 · `parseFirstJson` Greedy Brace Matching Fails on Nested JSON

**File:** `lib/planner.ts:54`

```ts
const braceMatches = [...cleaned.matchAll(/\{[\s\S]*?\}/g)];
```

**Issue:** The non-greedy `*?` stops at the first `}`, which means any nested JSON object (e.g. a plan with `"steps": [{"id": "1", ...}]`) will only match up to the closing brace of the first nested object. The outer object is never found, causing `Could not parse JSON command from response` for all plan-mode responses.

**Why it works sometimes:** Plan responses usually pass the fenced code block path (lines 46-49) first. But if the model doesn't wrap in backticks, the brace-match path produces wrong results.

**Fix:** Use a proper brace-counting extractor instead of regex:

```ts
function extractJsonObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (text[i] === "}") { depth--; if (depth === 0 && start >= 0) results.push(text.slice(start, i + 1)); }
  }
  return results;
}
```

---

### BUG-4 · Concurrent `execute()` Calls Corrupt State

**File:** `hooks/useCommandExec.ts:28-72`

**Issue:** `execute()` is a `useCallback` with no guard against being called while already running. If `execute()` is called twice in quick succession (possible if a React re-render fires the `executing` useEffect twice), two child processes spawn and both write to the same `stdoutRef`/`stderrRef`. The second spawned process also owns the `flushInterval`, but the first process's `close` event will clear it, leaving the second process's output unflushed.

**Fix:** Add a running guard:

```ts
if (state.running) return;  // or: kill existing child first
```

---

### BUG-5 · `planState.ts` — `currentStep()` Returns Already-Failed Steps

**File:** `lib/planState.ts` (the `currentStep()` method)

**Issue:** `currentStep()` returns the first non-completed step. If a step has status `"failed"`, it is still "not completed" — so the planner will keep trying to execute the same failed step indefinitely. There is no retry limit or step-skip logic.

**Fix:** `currentStep()` should skip permanently-failed steps (those that have exceeded a retry threshold), or the planner history feedback should include a step-level `AGENT_NOTE: step N has failed; skip it or try alternatives`.

---

### BUG-6 · Output History (`outputLog`) Never Cleared Between Sessions

**File:** `App.tsx` — `outputLog` state

```ts
const [outputLog, setOutputLog] = useState<LogEntry[]>([]);
```

**Issue:** `resetGoalState()` clears all refs for a new goal but does NOT clear `outputLog`. Over a long session with many goals, the log grows unbounded in memory and the terminal output becomes very long. There is no way to clear it.

**Fix:** Add a `:clear` meta command that resets `outputLog`. Optionally auto-truncate log to the last N entries.

---

## Medium Severity

### MED-1 · Telemetry File Path Not Validated

**File:** `lib/telemetry.ts:50-65`

`AGENT_TELEMETRY_FILE` and `--telemetry-file` are used as-is to create directories and write files. Like SEC-4, an absolute path outside the project directory writes anywhere the process has permission. Apply the same path validation as SEC-4 fix.

---

### MED-2 · No Retry Backoff; API Rate Limits Cause Immediate Double-Request

**File:** `lib/planner.ts:357-381`

```ts
for (let attempt = 0; attempt < 2; attempt++) {
  const payload = await this._chat(messages);
  ...
}
```

The second attempt fires immediately if the first fails. For OpenRouter 429 (rate limit) responses, the retry makes the situation worse. Add exponential backoff with jitter: `await sleep(attempt * 1000 + Math.random() * 500)`.

---

### MED-3 · Goal Input Has No Length Limit

**File:** `components/GoalPrompt.tsx:31-34`

```ts
onGoal(trimmed);  // trimmed could be arbitrarily large
```

A goal of 100KB would be appended to the system prompt, potentially exceeding the model's context window and producing a cryptic API error instead of a friendly message. Cap at ~10 000 characters and show an inline warning.

---

### MED-4 · `CommandScoreboard` Grows Unbounded

**File:** `lib/scoreboard.ts`

The in-memory `Map<string, CommandStats>` accumulates every unique command seen across the session with no eviction. In a long-running session this is a slow memory leak. Cap at 1 000 entries with LRU eviction.

---

### MED-5 · `session.ts` Uses `Record<string, any>` in Public Interface

**File:** `lib/session.ts:25-27`

```ts
recordGoal(goal: string, steps: Record<string, any>[], ...): void
```

`any` defeats TypeScript's safety guarantees for the session persistence layer. Replace with the concrete `SerializedCommandResult` type from `planState.ts`.

---

### MED-6 · Safety Policy Falls Back Silently on Parse Error

**File:** `lib/safety.ts:92-93`

```ts
} catch {
  continue;  // Silently tries next candidate file
}
```

If the user's `safety_policy.json` has a typo, the engine silently loads the built-in defaults without any notification. The user believes their custom policy is active when it is not. Log a warning to stderr.

---

### MED-7 · Planner Output Not Compressed Before Feedback

**File:** `lib/planState.ts` — `buildPlannerHistory()`

Command stdout/stderr is fed back to the planner verbatim. For commands that produce large output (package installs, compilations), this can send tens of kilobytes in the conversation history, consuming most of the model's context window and pushing earlier plan steps out.

The Python codebase had `compress_output()` (sandwich head+tail). The TypeScript port does not implement equivalent compression.

**Fix:** Apply head+tail truncation in `buildPlannerHistory()`:

```ts
function compressOutput(text: string, maxChars = 3000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return text.slice(0, half) + "\n...[truncated]...\n" + text.slice(-half);
}
```

---

## Low Severity / Production Readiness

### LOW-1 · `console.warn` in Session Layer Should Use Logger

**File:** `lib/session.ts:91`

```ts
console.warn(`Warning: failed to persist session data: ${exc.message}`);
```

This prints directly to stdout/stderr and conflicts with Ink's terminal rendering. Use `logger.warning(...)` instead.

---

### LOW-2 · Ollama Host Not Validated as a URL

**File:** `lib/planner.ts:499-502`

```ts
const host = (process.env["OLLAMA_HOST"] ?? OllamaPlanner.DEFAULT_HOST).replace(/\/$/, "");
this.baseUrl = `${host}/v1/chat/completions`;
```

`OLLAMA_HOST=not-a-url` produces a confusing fetch error instead of a clear startup message. Validate with `new URL(host)` and throw a descriptive `PlannerError` on failure.

---

### LOW-3 · Session ID Generation Not Collision-Safe for Concurrent Processes

**File:** `lib/session.ts:95-98`

```ts
static _generateId(): string {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}
```

Two processes started within the same second share a session ID and append to the same file. Add 4 random hex characters as a suffix.

---

### LOW-4 · No Graceful Handling of SIGTERM / SIGINT During Execution

**File:** `src/index.tsx`

If the user presses `Ctrl+C` while a command is running, the Ink process exits but the child process may continue running in the background (especially if it spawned its own children). Add a SIGTERM/SIGINT handler that calls `child.kill('SIGTERM')` before exiting.

---

### LOW-5 · `as any` Color Casts Throughout Components

**Files:** `components/CommandReview.tsx`, `components/OutputLog.tsx`, `components/GoalSummary.tsx`

```tsx
<Text color={riskColor as any}>
```

Ink exports a `LiteralUnion<ForegroundColorName, string>` type for colors. Use it directly or define a typed helper to avoid `as any` bypassing the compiler.

---

### LOW-6 · Floating-Point Timeout Passed to `AbortSignal.timeout()`

**File:** `lib/planner.ts` (`_resolveTimeout`)

`parseFloat("120.5")` → `120.5` → `120500 ms`. While functional, `AbortSignal.timeout` expects an integer (DOMHighResTimeStamp). Use `Math.round()` on the result.

---

### LOW-7 · No `process.exitCode` Set on Fatal Errors

**File:** `src/index.tsx`

```ts
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

`err instanceof Error ? err.stack : String(err)` gives much better debug output. Also, set `process.exitCode = 1` before calling `exit()` to let any `beforeExit` handlers run.

---

## Security Audit — Quick Reference

| ID | File | Severity | Issue |
|----|------|----------|-------|
| SEC-1 | `useCommandExec.ts:33` | **Critical** | `shell: true` enables metacharacter injection |
| SEC-2 | `useCommandExec.ts:33` | **Critical** | stdin inherited; interactive commands freeze UI |
| SEC-3 | `useCommandExec.ts:18-50` | **Critical** | Unbounded output buffers → OOM |
| SEC-4 | `lib/session.ts:43` | **High** | Session path not validated → path traversal |
| SEC-5 | `lib/safety.ts:84-98` | **High** | Arbitrary safety policy path + silent fallback |
| SEC-6 | `lib/safety.ts:38` | **High** | Invalid regex in policy crashes process |
| BUG-2 | `lib/safety.ts:149` | **High** | `sudo` rule fires before `rm -rf /` rule |

---

## Production Readiness Checklist

| Area | Status | Notes |
|------|--------|-------|
| Command injection prevention | ❌ | `shell: true` — SEC-1 |
| Output buffer limits | ❌ | Unbounded — SEC-3 |
| Interactive command guard | ❌ | stdin not set to `'ignore'` — SEC-2 |
| Path traversal guards | ❌ | Session and telemetry paths — SEC-4, MED-1 |
| Output compression to planner | ❌ | Not implemented — MED-7 |
| Interval/process cleanup on exit | ❌ | Leak on unmount — BUG-1 |
| Retry backoff | ❌ | Immediate retry — MED-2 |
| Goal input validation | ❌ | No length limit — MED-3 |
| Safety policy parse error visible | ⚠️ | Silent `continue` — MED-6, SEC-6 |
| Session ID collision safety | ⚠️ | Second-precision only — LOW-3 |
| SIGINT/SIGTERM child cleanup | ❌ | Orphaned processes — LOW-4 |
| Logger used consistently | ⚠️ | `console.warn` in session.ts — LOW-1 |
| Regex compile guarded | ❌ | Crashes on bad pattern — SEC-6 |
| TypeScript `any` eliminated | ⚠️ | Several `as any` casts remain |
| Planner output schema validated | ⚠️ | Type assertions without checks |

---

## Recommended Fix Order

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| 1 | SEC-1 — command injection | Medium | Eliminates the core security risk |
| 2 | SEC-3 — output buffer cap | Low | Prevents OOM on any long-running command |
| 3 | SEC-2 — stdin ignore | Low | Prevents UI freeze on interactive commands |
| 4 | BUG-2 — `sudo` + `rm -rf` ordering | Low | Closes safety rule bypass |
| 5 | SEC-6 — regex compile guard | Low | Prevents startup crash on bad policy |
| 6 | MED-7 — output compression | Medium | Prevents context-window exhaustion |
| 7 | BUG-1 — interval cleanup | Low | Prevents memory leak on Ctrl+C |
| 8 | SEC-4 / MED-1 — path validation | Low | Closes path traversal |
| 9 | BUG-3 — JSON brace extraction | Medium | Fixes plan-mode parse failure edge case |
| 10 | BUG-6 — outputLog unbounded | Low | Prevents long-session memory growth |

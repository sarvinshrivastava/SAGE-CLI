/**
 * Command planners for the shell assistant.
 * Port of planner.py with bug fixes from Phase 19.
 */

import { PlannerTurn, PlannerSuggestion, PlannerPlan, PlanStep } from "./types.js";

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerError";
  }
}

// ---------------------------------------------------------------------------
// JSON Parser
// ---------------------------------------------------------------------------

export function parsePlannerReply(content: string): PlannerSuggestion {
  // Strip <think>...</think> blocks (qwen3 reasoning tokens)
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const data = parseFirstJson(cleaned);
  if (data === null) {
    throw new PlannerError(
      `Could not parse JSON command from response: ${cleaned.slice(0, 200)}`
    );
  }

  const suggestion = buildSuggestionFromDict(data);
  if (suggestion !== null) return suggestion;

  throw new PlannerError(`Planner response missing required fields: ${JSON.stringify(data)}`);
}

function parseFirstJson(cleaned: string): Record<string, unknown> | null {
  const candidates: string[] = [];

  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    candidates.push(cleaned);
  }

  // Fenced code blocks
  const fenceMatches = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const m of fenceMatches) {
    const block = m[1]!.trim();
    if (block) candidates.push(block);
  }

  // Any {...} span
  const braceMatches = [...cleaned.matchAll(/\{[\s\S]*?\}/g)];
  for (const m of braceMatches) {
    const snippet = m[0]!.trim();
    if (!candidates.includes(snippet)) candidates.push(snippet);
  }

  if (candidates.length === 0) candidates.push(cleaned);

  for (let candidate of candidates) {
    if (candidate.toLowerCase().startsWith("json")) {
      candidate = candidate.slice(4).trim();
    }
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      const repaired = repairSimpleCommandJson(candidate);
      if (repaired === null) continue;
      try {
        data = JSON.parse(repaired);
      } catch {
        continue;
      }
    }
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  }
  return null;
}

function buildSuggestionFromDict(
  data: Record<string, unknown>
): PlannerSuggestion | null {
  const modeRaw = data["mode"];
  const mode =
    typeof modeRaw === "string" ? modeRaw.trim().toLowerCase() : null;

  if (mode === "command" || (mode === null && "command" in data)) {
    const commandValue = data["command"];
    if (typeof commandValue === "string" && commandValue.trim()) {
      return { mode: "command", command: commandValue.trim() };
    }
    return null;
  }

  if (mode === "chat") {
    const msgValue =
      data["message"] ?? data["response"] ?? data["answer"];
    if (typeof msgValue === "string" && msgValue.trim()) {
      return { mode: "chat", message: msgValue.trim() };
    }
    return null;
  }

  if (mode === "plan" && "plan" in data) {
    const planObj = buildPlanFromMapping(data["plan"]);
    if (planObj !== null) {
      return { mode: "plan", plan: planObj };
    }
    return null;
  }

  return null;
}

function buildPlanFromMapping(rawPlan: unknown): PlannerPlan | null {
  if (typeof rawPlan !== "object" || rawPlan === null || Array.isArray(rawPlan)) {
    return null;
  }
  const raw = rawPlan as Record<string, unknown>;

  const summaryVal = raw["summary"];
  const summary =
    typeof summaryVal === "string" && summaryVal.trim()
      ? summaryVal.trim()
      : null;

  const stepsVal = raw["steps"];
  if (!Array.isArray(stepsVal)) return null;

  const steps: PlanStep[] = [];
  let index = 1;
  for (const rawStep of stepsVal) {
    if (typeof rawStep !== "object" || rawStep === null) {
      index++;
      continue;
    }
    const s = rawStep as Record<string, unknown>;

    const stepIdVal = s["id"];
    const stepId =
      typeof stepIdVal === "string" && stepIdVal.trim()
        ? stepIdVal.trim()
        : String(index);

    const titleVal = s["title"] ?? s["name"];
    const title =
      typeof titleVal === "string" && titleVal.trim()
        ? titleVal.trim()
        : null;

    const commandVal = s["command"];
    const command =
      typeof commandVal === "string" && commandVal.trim()
        ? commandVal.trim()
        : null;

    const descVal = s["description"] ?? s["detail"];
    const description =
      typeof descVal === "string" && descVal.trim()
        ? descVal.trim()
        : null;

    const statusVal = s["status"];
    const status =
      typeof statusVal === "string" && statusVal.trim()
        ? statusVal.trim()
        : null;

    steps.push({ id: stepId, title, command, description, status });
    index++;
  }

  if (steps.length === 0) return null;
  return { summary, steps };
}

function repairSimpleCommandJson(fragment: string): string | null {
  const match = fragment.match(/"command"\s*:\s*([^\s"}][^}\n]*)/);
  if (!match) return null;
  let value = match[1]!.trim().replace(/,$/, "").replace(/"$/, "");
  if (!value) return null;
  const repaired = fragment.replace(
    /"command"\s*:\s*([^\s"}][^}\n]*)/,
    `"command": "${value}"`
  );
  return repaired;
}

export function normalizeCommandText(command: string | null | undefined): string | null {
  if (typeof command !== "string") return null;
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized || null;
}

// ---------------------------------------------------------------------------
// Repeated Failure Guard (Bug Fix #3: scan full history, not just last 2)
// ---------------------------------------------------------------------------

export function isRepeatedFailure(
  candidate: string | null | undefined,
  history: PlannerTurn[]
): boolean {
  if (!candidate || history.length < 1) return false;
  const norm = normalizeCommandText(candidate);
  if (!norm) return false;

  let failCount = 0;
  for (const turn of history) {
    if (
      normalizeCommandText(turn.executedCommand) === norm &&
      turn.exitCode !== 0
    ) {
      failCount++;
    }
  }
  return failCount >= 2;
}

export function buildRepeatFeedback(history: PlannerTurn[]): {
  role: string;
  content: string;
} {
  const last = history[history.length - 1]!;
  const prev = history[history.length - 2]!;
  const commandDisplay =
    normalizeCommandText(last.executedCommand) ?? last.executedCommand;
  const note = `AGENT_NOTE: The command '${commandDisplay}' failed twice consecutively with exit codes ${prev.exitCode} and ${last.exitCode}. Provide a different next command that diagnoses the failure or prepares any missing prerequisites. Do not repeat the same command.`;
  return { role: "user", content: JSON.stringify({ agent_note: note }) };
}

// ---------------------------------------------------------------------------
// Planner base & Mock
// ---------------------------------------------------------------------------

export abstract class CommandPlanner {
  abstract suggest(
    goal: string,
    history?: PlannerTurn[]
  ): Promise<PlannerSuggestion>;
}

export class MockCommandPlanner extends CommandPlanner {
  async suggest(goal: string, _history?: PlannerTurn[]): Promise<PlannerSuggestion> {
    return { mode: "command", command: `echo Mock planner received goal: ${goal}` };
  }
}

// ---------------------------------------------------------------------------
// OpenRouter Planner
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "ROLE:\n" +
  "You are an expert Linux system administrator and AI command planner integrated inside a live terminal assistant. " +
  "Your role is to help the user achieve high-level Linux or DevOps goals by generating safe, step-by-step shell commands.\n\n" +
  "OUTPUT FORMAT:\n" +
  "Always respond ONLY in **valid JSON** (no markdown, no comments, no text outside JSON). " +
  "You must use exactly one of these schemas:\n" +
  "1️⃣  {\"mode\": \"command\", \"command\": \"<next_shell_command>\"}\n" +
  "2️⃣  {\"mode\": \"chat\", \"message\": \"<clarification_or_information>\"}\n" +
  "3️⃣  {\"mode\": \"plan\", \"plan\": {\"summary\": \"<strategy_overview>\", \"steps\": [" +
  "{\"id\": \"1\", \"title\": \"<step_title>\", \"command\": \"<suggested_command>\", \"description\": \"<optional_details>\"}]}}\n\n" +
  "RULES:\n" +
  "1. Clarify unclear goals or missing details using chat mode.\n" +
  "2. Use plan mode when the goal requires multiple coordinated steps. Provide 3-7 ordered steps with unique string IDs, concise titles, and optional commands/descriptions. Default step status is 'pending'.\n" +
  "3. When giving commands:\n" +
  "   - Prefer stable, idempotent, and widely supported tools.\n" +
  "   - Use `apt-get` instead of `apt`, `systemctl` instead of service scripts.\n" +
  "   - Avoid `sudo` or privileged operations unless absolutely necessary or explicitly allowed by the user.\n" +
  "4. After each command execution, you will receive `exit_code` and `output`:\n" +
  "   - If successful: plan the next logical step.\n" +
  "   - If failed: propose a diagnostic or remediation command.\n" +
  "   - Never repeat a failed command verbatim.\n" +
  "5. Reference the plan steps when applicable (e.g., include the planned command or mention the step ID in your reasoning).\n" +
  "6. Keep responses concise — one command per JSON.\n" +
  "7. When the user's high-level goal is fully completed, respond exactly with:\n" +
  "   {\"mode\": \"command\", \"command\": \"DONE\"}\n" +
  "8. Never include explanations, reasoning, or comments outside JSON. " +
  "This includes markdown formatting, backticks, or natural language text.\n" +
  "9. Maintain persistent awareness of prior steps, plan progress, outputs, and user intent throughout the session.\n" +
  "10. Assume commands will be executed in a real shell; always prioritize safety and reversibility.\n\n" +
  "EXAMPLES:\n" +
  "Goal: Install nginx and start the service\n" +
  "→ {\"mode\": \"command\", \"command\": \"sudo apt-get update -y && sudo apt-get install -y nginx\"}\n" +
  "→ {\"mode\": \"command\", \"command\": \"sudo systemctl start nginx && sudo systemctl enable nginx\"}\n" +
  "→ {\"mode\": \"command\", \"command\": \"DONE\"}\n\n" +
  "Goal: Provision a new web server stack\n" +
  "→ {\"mode\": \"plan\", \"plan\": {\"summary\": \"Deploy nginx with app code and SSL\", \"steps\": [" +
  "{\"id\": \"1\", \"title\": \"Update packages\", \"command\": \"sudo apt-get update -y\"}," +
  "{\"id\": \"2\", \"title\": \"Install nginx\", \"command\": \"sudo apt-get install -y nginx\"}," +
  "{\"id\": \"3\", \"title\": \"Deploy app\", \"description\": \"Sync app files and restart service\"}]}}\n\n" +
  "Your task is to plan and execute toward the goal step-by-step until completion. " +
  "Be precise, structured, and consistent — your responses drive a live terminal automation system.";

export interface PlannerOptions {
  model?: string;
  timeout?: number;
  apiKey?: string;
  referer?: string;
  title?: string;
  baseUrl?: string;
  version?: string;
}

export class OpenRouterPlanner extends CommandPlanner {
  protected model: string;
  protected timeout: number;
  protected apiKey: string | null;
  protected baseUrl: string;
  protected referer: string | null;
  protected title: string | null;
  protected version: string | null;

  constructor(opts: PlannerOptions = {}) {
    super();
    this.model =
      opts.model ??
      process.env["OPENROUTER_MODEL"] ??
      "deepseek/deepseek-r1-0528-qwen3-8b:free";
    this.timeout = this._resolveTimeout(opts.timeout);
    this.apiKey = opts.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? null;
    if (!this.apiKey) {
      throw new PlannerError(
        "OpenRouter API key missing; set OPENROUTER_API_KEY or use --planner-api-key"
      );
    }
    this.baseUrl =
      opts.baseUrl ??
      process.env["OPENROUTER_BASE_URL"] ??
      "https://openrouter.ai/api/v1/chat/completions";
    this.referer = opts.referer ?? process.env["OPENROUTER_SITE_URL"] ?? null;
    this.title = opts.title ?? process.env["OPENROUTER_SITE_NAME"] ?? null;
    this.version = opts.version ?? process.env["OPENROUTER_PLANNER_VERSION"] ?? null;
  }

  async suggest(goal: string, history: PlannerTurn[] = []): Promise<PlannerSuggestion> {
    const baseMessages = this._buildMessages(goal, history);
    let messages = [...baseMessages];

    for (let attempt = 0; attempt < 2; attempt++) {
      const payload = await this._chat(messages);
      const content = this._extractContent(payload);
      const suggestion = parsePlannerReply(content);

      if (suggestion.mode !== "command") return suggestion;
      if (!isRepeatedFailure(suggestion.command, history)) return suggestion;

      if (attempt === 0) {
        const guardFeedback = buildRepeatFeedback(history);
        messages = [...baseMessages, guardFeedback];
        continue;
      }

      throw new PlannerError(
        "Planner suggested a command that already failed twice consecutively"
      );
    }

    throw new PlannerError("Planner could not provide a non-repeated command");
  }

  protected async _chat(messages: object[]): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;

    const body = { model: this.model, messages };

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout * 1000),
      });
    } catch (err) {
      throw new PlannerError(`Failed to contact OpenRouter service: ${err}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new PlannerError(
        `OpenRouter returned status ${response.status}: ${text}`
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new PlannerError(`Invalid JSON response from OpenRouter`);
    }

    return data as Record<string, unknown>;
  }

  protected _extractContent(payload: Record<string, unknown>): string {
    if ("error" in payload) {
      throw new PlannerError(`OpenRouter error: ${JSON.stringify(payload["error"])}`);
    }
    const choices = payload["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new PlannerError("OpenRouter response missing choices array");
    }
    const firstChoice = choices[0];
    if (typeof firstChoice !== "object" || firstChoice === null) {
      throw new PlannerError("OpenRouter response contained unexpected choice format");
    }
    const message = (firstChoice as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null) {
      throw new PlannerError("OpenRouter response missing message content");
    }
    const content = (message as Record<string, unknown>)["content"];
    if (typeof content !== "string" || !content.trim()) {
      throw new PlannerError("OpenRouter message content was empty");
    }
    return content;
  }

  protected _buildMessages(goal: string, history: PlannerTurn[]): object[] {
    const messages: object[] = [{ role: "system", content: SYSTEM_PROMPT }];

    for (const turn of history) {
      messages.push({
        role: "assistant",
        content: JSON.stringify({ command: turn.suggestedCommand }),
      });
      messages.push({
        role: "user",
        content: JSON.stringify({
          executed_command: turn.executedCommand,
          stdout: turn.stdout,
          stderr: turn.stderr,
          exit_code: turn.exitCode,
        }),
      });
    }

    messages.push({ role: "user", content: goal });
    return messages;
  }

  protected _resolveTimeout(provided?: number): number {
    if (provided !== undefined) return provided;
    const envTimeout = process.env["OPENROUTER_TIMEOUT"];
    if (envTimeout) {
      const parsed = parseFloat(envTimeout);
      if (!isNaN(parsed)) return parsed;
    }
    return 120.0;
  }
}

// ---------------------------------------------------------------------------
// Ollama Planner
// ---------------------------------------------------------------------------

export class OllamaPlanner extends OpenRouterPlanner {
  private static readonly DEFAULT_HOST = "http://localhost:11434";
  private static readonly DEFAULT_MODEL = "qwen3:8b";

  constructor(opts: PlannerOptions = {}) {
    // Call super with a dummy api key to bypass requirement, then override
    const resolvedOpts: PlannerOptions = {
      ...opts,
      apiKey: opts.apiKey ?? "__ollama_no_key__",
    };
    super(resolvedOpts);

    // Override model/url for Ollama
    this.model =
      opts.model ??
      process.env["OLLAMA_MODEL"] ??
      OllamaPlanner.DEFAULT_MODEL;
    this.timeout = this._resolveOllamaTimeout(opts.timeout);
    this.apiKey = null;

    const host = (
      process.env["OLLAMA_HOST"] ?? OllamaPlanner.DEFAULT_HOST
    ).replace(/\/$/, "");
    this.baseUrl = opts.baseUrl ?? `${host}/v1/chat/completions`;
    this.version = opts.version ?? process.env["AGENT_PLANNER_VERSION"] ?? null;
  }

  protected async _chat(messages: object[]): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;

    const body = { model: this.model, messages };

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout * 1000),
      });
    } catch (err) {
      throw new PlannerError(`Failed to contact Ollama service: ${err}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new PlannerError(`Ollama returned status ${response.status}: ${text}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new PlannerError("Invalid JSON from Ollama");
    }
    return data as Record<string, unknown>;
  }

  protected _extractContent(payload: Record<string, unknown>): string {
    if ("error" in payload) {
      throw new PlannerError(`Ollama error: ${JSON.stringify(payload["error"])}`);
    }
    const choices = payload["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new PlannerError("Ollama response missing choices array");
    }
    const message = (choices[0] as Record<string, unknown>)["message"] ?? {};
    const content = (message as Record<string, unknown>)["content"];
    if (typeof content !== "string" || !content.trim()) {
      throw new PlannerError("Ollama returned empty content");
    }
    return content;
  }

  private _resolveOllamaTimeout(provided?: number): number {
    if (provided !== undefined) return provided;
    const envVal = process.env["OLLAMA_TIMEOUT"];
    if (envVal) {
      const parsed = parseFloat(envVal);
      if (!isNaN(parsed)) return parsed;
    }
    return 120.0;
  }
}

// ---------------------------------------------------------------------------
// Planner Factory
// ---------------------------------------------------------------------------

export function createPlanner(
  name?: string | null,
  opts: PlannerOptions = {}
): CommandPlanner {
  const selected = (
    name ?? process.env["AGENT_PLANNER"] ?? "openrouter"
  ).toLowerCase();

  if (selected === "mock") return new MockCommandPlanner();
  if (selected === "openrouter" || selected === "open-router")
    return new OpenRouterPlanner(opts);
  if (selected === "ollama") return new OllamaPlanner(opts);

  throw new PlannerError(`Unknown planner: ${JSON.stringify(selected)}`);
}

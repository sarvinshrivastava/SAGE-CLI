#!/usr/bin/env node
/**
 * Entry point — arg parsing, env loading, initialization, renders <App />.
 * Phase 14 (CLI args) + Phase 20 (shebang).
 */

import React from "react";
import { render } from "ink";
import os from "os";

import { loadEnvironment } from "./lib/env.js";
import { AppConfig } from "./lib/config.js";
import { TelemetryEmitterImpl } from "./lib/telemetry.js";
import { SessionManagerImpl } from "./lib/session.js";
import { SafetyPolicy } from "./lib/safety.js";
import { createPlanner, PlannerError } from "./lib/planner.js";
import { Logger } from "./lib/logger.js";
import { App } from "./App.js";

// ---------------------------------------------------------------------------
// Simple arg parser (no external dependency)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  planner?: string;
  plannerTimeout?: number;
  plannerModel?: string;
  plannerVersion?: string;
  plannerApiKey?: string;
  plannerReferer?: string;
  plannerTitle?: string;
  plannerBaseUrl?: string;
  config?: string;
  sessionId?: string;
  sessionDir?: string;
  noPersist?: boolean;
  allowRoot?: boolean;
  safetyOff?: boolean;
  safetyPolicy?: string;
  logFile?: string;
  telemetryFile?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = {};
  let i = 0;

  // Only consume the next token as a value if it exists and is not itself a flag.
  const next = (): string | undefined => {
    const val = args[i + 1];
    if (val === undefined || val.startsWith("-")) return undefined;
    return args[++i];
  };

  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--planner") result.planner = next();
    else if (arg === "--planner-timeout") {
      const val = next();
      const parsed = val !== undefined ? Number(val) : NaN;
      if (!isNaN(parsed)) result.plannerTimeout = parsed;
    }
    else if (arg === "--planner-model") result.plannerModel = next();
    else if (arg === "--planner-version") result.plannerVersion = next();
    else if (arg === "--planner-api-key") result.plannerApiKey = next();
    else if (arg === "--planner-referer") result.plannerReferer = next();
    else if (arg === "--planner-title") result.plannerTitle = next();
    else if (arg === "--planner-base-url") result.plannerBaseUrl = next();
    else if (arg === "--config") result.config = next();
    else if (arg === "--session-id") result.sessionId = next();
    else if (arg === "--session-dir") result.sessionDir = next();
    else if (arg === "--no-persist") result.noPersist = true;
    else if (arg === "--persist") result.noPersist = false;
    else if (arg === "--allow-root") result.allowRoot = true;
    else if (arg === "--safety-off") result.safetyOff = true;
    else if (arg === "--safety-policy") result.safetyPolicy = next();
    else if (arg === "--log-file") result.logFile = next();
    else if (arg === "--telemetry-file") result.telemetryFile = next();
    i++;
  }
  return result;
}

function printHelp() {
  console.log(`
Usage: sage [options]

Options:
  --planner <name>          Planner backend: openrouter | ollama | mock
  --planner-model <model>   Model to use
  --planner-timeout <secs>  Request timeout in seconds
  --planner-api-key <key>   API key (overrides env)
  --planner-referer <url>   HTTP-Referer header
  --planner-title <name>    X-Title header
  --planner-base-url <url>  Override API base URL
  --planner-version <ver>   Planner version tag
  --config <path>           Path to config.json
  --session-id <id>         Session ID to resume
  --session-dir <dir>       Session storage directory
  --no-persist              Disable session persistence
  --allow-root              Allow running as root
  --safety-off              Disable safety checks
  --safety-policy <path>    Path to safety policy file
  --log-file <path>         Path to log file
  --telemetry-file <path>   Path to telemetry JSONL file (empty to disable)
  -h, --help                Show this help
`);
}

// ---------------------------------------------------------------------------
// Root check
// ---------------------------------------------------------------------------

function ensureNotRoot(allowRoot: boolean) {
  // Prefer geteuid (effective UID) to catch setuid/sudo scenarios, fall back to getuid.
  const geteuid = (process as any).geteuid as (() => number) | undefined;
  const getuid = (process as any).getuid as (() => number) | undefined;
  const getEffectiveUid = geteuid ?? getuid;
  if (typeof getEffectiveUid === "function") {
    try {
      if (getEffectiveUid() === 0 && !allowRoot) {
        console.error(
          "Refusing to run as root. Use --allow-root or AGENT_ALLOW_ROOT=1 if you understand the risk."
        );
        process.exit(1);
      }
    } catch {
      // Not Unix — skip
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Load .env
  loadEnvironment();

  // 2. Parse CLI args
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // 3. Root check
  const allowRoot =
    args.allowRoot === true || process.env["AGENT_ALLOW_ROOT"] === "1";
  ensureNotRoot(allowRoot);

  // 4. Load config (CLI flags override config file)
  const config = AppConfig.load(args.config);

  // 5. Resolve final settings (flags > config > env > defaults)
  const plannerName =
    args.planner ?? config.planner.backend ?? "openrouter";
  const plannerModel = args.plannerModel ?? config.planner.model ?? undefined;
  const plannerTimeout =
    args.plannerTimeout ?? config.planner.timeout ?? undefined;
  const plannerApiKey = args.plannerApiKey ?? config.planner.apiKey ?? undefined;
  const plannerReferer =
    args.plannerReferer ?? config.planner.referer ?? undefined;
  const plannerTitle = args.plannerTitle ?? config.planner.title ?? undefined;
  const plannerBaseUrl =
    args.plannerBaseUrl ?? config.planner.baseUrl ?? undefined;
  const plannerVersion =
    args.plannerVersion ?? config.planner.version ?? undefined;

  const safetyDisabled =
    args.safetyOff === true || process.env["AGENT_DISABLE_SAFETY"] === "1";
  const policyPath =
    args.safetyPolicy ?? config.safetyPolicyPath ?? undefined;

  const sessionDir =
    args.sessionDir ?? config.sessionDir ?? undefined;
  const persist = !(
    args.noPersist === true ||
    process.env["AGENT_SESSION_PERSIST"] === "0"
  );
  const sessionId = args.sessionId ?? undefined;

  const telemetryFile =
    args.telemetryFile !== undefined
      ? args.telemetryFile
      : process.env["AGENT_TELEMETRY_FILE"] ?? undefined;
  const logFile = args.logFile ?? process.env["AGENT_LOG_FILE"] ?? undefined;

  // 6. Initialize subsystems
  const logger = Logger.initialize(logFile);
  const telemetry = TelemetryEmitterImpl.initialize(telemetryFile);
  const sessionManager = SessionManagerImpl.initialize(
    sessionDir ?? null,
    sessionId ?? null,
    persist
  );
  const policy = SafetyPolicy.load(policyPath);

  // 7. Create planner
  let plannerInstance;
  try {
    plannerInstance = createPlanner(plannerName, {
      model: plannerModel,
      timeout: plannerTimeout,
      apiKey: plannerApiKey,
      referer: plannerReferer,
      title: plannerTitle,
      baseUrl: plannerBaseUrl,
      version: plannerVersion,
    });
  } catch (err) {
    const msg = err instanceof PlannerError ? err.message : String(err);
    console.error(`Failed to create planner: ${msg}`);
    process.exit(1);
  }

  // 8. Build planner info for telemetry
  const plannerInfo: Record<string, string> = {
    backend: plannerName,
    ...(plannerModel ? { model: plannerModel } : {}),
    ...(plannerVersion ? { version: plannerVersion } : {}),
  };

  logger.info(`SAGE CLI starting — planner=${plannerName}`);
  logger.info(sessionManager.describe());

  // 9. Render app
  render(
    <App
      planner={plannerInstance}
      policy={policy}
      telemetry={telemetry}
      sessionManager={sessionManager}
      logger={logger}
      plannerInfo={plannerInfo}
      safetyDisabled={safetyDisabled}
    />
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

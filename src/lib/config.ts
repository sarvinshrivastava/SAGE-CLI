/**
 * Configuration loading utilities.
 */

import fs from "fs";
import path from "path";
import type { AppConfig as AppConfigShape, PlannerConfig } from "./types.js";

export function loadConfig(filePath?: string): AppConfigShape {
  const envPath = filePath || process.env["AGENT_CONFIG"] || "config.json";
  const configPath = path.resolve(envPath);

  try {
    if (!fs.existsSync(configPath)) {
      return defaultConfig();
    }

    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const plannerData = data.planner || {};
    const planner: PlannerConfig = {
      backend: plannerData.backend || "openrouter",
      model: plannerData.model || null,
      timeout: plannerData.timeout || null,
      apiKey: plannerData.api_key || null,
      referer: plannerData.referer || null,
      title: plannerData.title || null,
      baseUrl: plannerData.base_url || null,
      version: plannerData.version || null,
    };

    const sessionOpts = data.session || {};
    const persist = sessionOpts.persist !== undefined ? sessionOpts.persist : true;
    const sessionDir = sessionOpts.directory || null;

    const safetyOpts = data.safety || {};
    const policyPath = safetyOpts.policy || null;

    return { planner, sessionDir, sessionPersist: persist, safetyPolicyPath: policyPath };
  } catch {
    return defaultConfig();
  }
}

export function defaultConfig(): AppConfigShape {
  return {
    planner: {
      backend: "openrouter",
      model: "deepseek/deepseek-r1-0528-qwen3-8b:free",
      timeout: null,
      apiKey: null,
      referer: null,
      title: null,
      baseUrl: null,
      version: null,
    },
    sessionDir: null,
    sessionPersist: true,
    safetyPolicyPath: null,
  };
}

export const AppConfig = {
  load: loadConfig,
  default: defaultConfig,
};

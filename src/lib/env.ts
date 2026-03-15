/**
 * Environment variable loading utilities.
 */

import fs from "fs";
import path from "path";

/**
 * Load variables from a .env file if present.
 * Reads from the project root (or process.cwd()).
 * Parses KEY=VALUE lines, skips comments and blanks.
 * Uses process.env[key] ??= value to not overwrite existing vars.
 */
export function loadEnvironment(): void {
  const envPath = path.join(process.cwd(), ".env");
  
  if (!fs.existsSync(envPath)) {
    return;
  }

  try {
    const envFileContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envFileContent.split("\n")) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) {
        continue;
      }
      if (!stripped.includes("=")) {
        continue;
      }
      // Strip leading "export " so both `KEY=val` and `export KEY=val` work.
      const line2 = stripped.replace(/^export\s+/, "");
      const [key, value] = line2.split("=", 2);
      const keyStr = key.trim();
      let valueStr = value.trim();

      // Strip surrounding quotes and unescape \" inside double-quoted values.
      if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
        valueStr = valueStr.slice(1, -1).replace(/\\"/g, '"');
      } else if (valueStr.startsWith("'") && valueStr.endsWith("'")) {
        valueStr = valueStr.slice(1, -1);
      }

      // Only set if not already defined
      if (process.env[keyStr] === undefined) {
        process.env[keyStr] = valueStr;
      }
    }
  } catch (exc: any) {
    // Non-fatal; just log to stderr via console later if needed.
    console.warn(`Warning: failed to read .env file: ${exc.message}`);
  }
}
/**
 * SERVER-ONLY runtime access to config/risk-model.json.
 *
 * lib/risk-model.ts imports the JSON at BUILD time, so its constants freeze at build.
 * The settings UI writes the file at runtime, so anything that must reflect a saved
 * change — the report config stamp, the Methodology settings section — has to read the
 * file at REQUEST time. That is what this module does.
 *
 * ⚠️ Imports `node:fs`, so it must only be imported from server components and route
 * handlers. (The `server-only` package is not installed; the fs import is the practical
 * boundary — a client component importing this fails the build.)
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { type RiskModel, type ConfigStamp, buildConfigStamp } from "@/lib/risk-model";

const CONFIG_PATH = path.join(process.cwd(), "config", "risk-model.json");

/** Read + parse the live config from disk. Throws on missing/malformed file. */
export async function readRiskModel(): Promise<RiskModel> {
  const raw = await fs.readFile(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as RiskModel;
}

/** Overwrite the config file (pretty-printed, trailing newline — matches the repo). */
export async function writeRiskModel(model: RiskModel): Promise<void> {
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(model, null, 2)}\n`, "utf-8");
}

/**
 * The live config stamp (schema version + whole-config fingerprint + every composite's
 * version), read at request time. Used by every report render path so a printed report's
 * footer reflects the exact configuration that produced its numbers.
 */
export async function readRiskModelStamp(): Promise<ConfigStamp> {
  return buildConfigStamp(await readRiskModel());
}

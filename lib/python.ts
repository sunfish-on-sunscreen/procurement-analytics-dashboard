import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

import type { SensitivityData } from "@/lib/sensitivity";

export type PythonResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Resolve the python interpreter: prefer the project venv (python/.venv), then
 * fall back to the platform default ("python" on Windows, "python3" elsewhere).
 */
function resolvePythonExecutable(): string {
  const root = process.cwd();
  const isWindows = process.platform === "win32";
  const venvPython = isWindows
    ? path.join(root, "python", ".venv", "Scripts", "python.exe")
    : path.join(root, "python", ".venv", "bin", "python");
  if (existsSync(venvPython)) {
    return venvPython;
  }
  return isWindows ? "python" : "python3";
}

function runScript(
  args: string[],
  timeoutMs?: number,
  scriptName = "compute_analyses.py",
): Promise<PythonResult> {
  return new Promise((resolve) => {
    const root = process.cwd();
    const script = path.join(root, "python", scriptName);
    const child = spawn(resolvePythonExecutable(), [script, ...args], {
      cwd: root,
      detached: false,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => {
        stderr += `\n[python killed after ${timeoutMs}ms timeout]`;
        child.kill();
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(err)}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Mode A: compute + upsert AnalysisResult rows for a single period. `timeoutMs`
 * (optional) kills a hung Python after that long — passed by the recompute path so
 * a stuck compute can't hang the admin's request. The bulk-import caller omits it
 * (unchanged behaviour).
 */
export function runComputeAnalyses(periodId: string, timeoutMs?: number): Promise<PythonResult> {
  return runScript(["--period-id", periodId], timeoutMs);
}

/** The summary `seed_compute.py --json` prints on stdout when it succeeds. */
export type SeedComputeSummary = {
  ok: true;
  periods: string[];
  supplierMetricRows: number;
  analysisResultRows: number;
  processScore: { min: number; max: number; avg: number; distinct: number };
};

/**
 * THE recompute: `python/seed_compute.py --json`. Regenerates the per-period
 * SupplierMetric rows (scores.build_window_metrics), runs compute_analyses Mode A
 * for every period, and clears the range cache — the same pipeline the post-seed
 * step runs, so the math is reused rather than reimplemented.
 *
 * Note this does STRICTLY MORE than the old per-period `runComputeAnalyses` loop:
 * that one never rewrote SupplierMetric, which is why stored sub-scores used to lag
 * until a full import. Returns `summary: null` with a non-zero `code` on any failure
 * (Python error, timeout, or unparseable stdout).
 */
export function runSeedCompute(
  timeoutMs = 180_000,
): Promise<{ code: number; summary: SeedComputeSummary | null; stderr: string }> {
  return runScript(["--json"], timeoutMs, "seed_compute.py").then((res) => {
    if (res.code !== 0) {
      return { code: res.code, summary: null, stderr: res.stderr };
    }
    try {
      const parsed = JSON.parse(res.stdout.trim()) as SeedComputeSummary | { ok: false; error: string };
      if (!parsed.ok) {
        return { code: -1, summary: null, stderr: `${res.stderr}\n${parsed.error}` };
      }
      return { code: 0, summary: parsed, stderr: res.stderr };
    } catch (e) {
      return {
        code: -1,
        summary: null,
        stderr: `${res.stderr}\nJSON parse error: ${String(e)}`,
      };
    }
  });
}

/** Mode B: compute over a date range and return the analyses JSON on stdout. */
export function runComputeRange(
  startDate: string,
  endDate: string,
  timeoutMs = 30000,
): Promise<PythonResult> {
  return runScript(["--start-date", startDate, "--end-date", endDate], timeoutMs);
}

/**
 * Run the drop-one weight-sensitivity module (`python/sensitivity.py --json`) via the SAME
 * spawn path as the recompute (venv python, cwd=root, inherited env — that is how DATABASE_URL
 * reaches it). Read-only: the module monkeypatches + restores the config and never writes the
 * DB. ~30-60s (N+1 recomputes across 4 windows), so the default timeout is a generous backstop.
 * Returns parsed data, or null with a non-zero code on failure / unparseable output.
 */
export function runSensitivity(
  timeoutMs = 180_000,
): Promise<{ code: number; data: SensitivityData | null; stderr: string }> {
  return runScript(["--json"], timeoutMs, "sensitivity.py").then((res) => {
    if (res.code !== 0) {
      return { code: res.code, data: null, stderr: res.stderr };
    }
    try {
      const parsed = JSON.parse(res.stdout.trim()) as SensitivityData;
      if (!parsed || !Array.isArray(parsed.windows)) {
        return { code: -1, data: null, stderr: `${res.stderr}\nunexpected sensitivity payload` };
      }
      return { code: 0, data: parsed, stderr: res.stderr };
    } catch (e) {
      return { code: -1, data: null, stderr: `${res.stderr}\nJSON parse error: ${String(e)}` };
    }
  });
}

/**
 * SERVER-ONLY read/persist for the weight-sensitivity snapshot (imports prisma + spawns
 * Python, so must only be imported from server components / route handlers).
 *
 * The snapshot is a SINGLETON row (id = "singleton") stamped with the whole-config fingerprint
 * that produced it. The page compares that stamp to the current config fingerprint to decide
 * fresh / stale (see lib/sensitivity.sensitivityView). Persisting it is the deliberate
 * exception to recompute-on-read — justified because it costs ~60s and N+1 recomputes.
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma/client";
import { configFingerprint } from "@/lib/risk-model";
import { readRiskModel } from "@/lib/risk-model-server";
import { runSensitivity } from "@/lib/python";
import type { StoredSensitivity, SensitivityData } from "@/lib/sensitivity";

const SINGLETON_ID = "singleton";

/** The stored snapshot (or null if never computed under this deployment). */
export async function readSensitivity(): Promise<StoredSensitivity | null> {
  const row = await prisma.sensitivityResult.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return null;
  return {
    configFingerprint: row.configFingerprint,
    computedAt: row.computedAt.toISOString(),
    data: row.resultJson as unknown as SensitivityData,
  };
}

export type RunSensitivityResult =
  | { ok: true; configFingerprint: string }
  | { ok: false; error: string };

/**
 * Phase 2: compute the CURRENT whole-config fingerprint, run the sensitivity module against
 * the on-disk config (which phase 1's save already wrote), and persist the result stamped with
 * that fingerprint. The analytics side is read-only (the module monkeypatches + restores the
 * config, never writing); the only DB write is the single SensitivityResult upsert.
 */
export async function runAndPersistSensitivity(): Promise<RunSensitivityResult> {
  const model = await readRiskModel();
  const fingerprint = configFingerprint(model.composites, model.lookupTables);
  const { code, data, stderr } = await runSensitivity();
  if (code !== 0 || !data) {
    const detail = stderr.trim().slice(-800) || `exit code ${code}`;
    console.error("sensitivity failed:", detail);
    return { ok: false, error: detail };
  }
  const resultJson = data as unknown as Prisma.InputJsonValue;
  await prisma.sensitivityResult.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, configFingerprint: fingerprint, resultJson },
    update: { configFingerprint: fingerprint, resultJson, computedAt: new Date() },
  });
  return { ok: true, configFingerprint: fingerprint };
}

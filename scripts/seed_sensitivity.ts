import "dotenv/config";

import { runAndPersistSensitivity } from "@/lib/sensitivity-server";

/**
 * Seed the weight-sensitivity snapshot so a RESTORED database lands in a fresh state, not an
 * honest-but-empty one (otherwise every restore looks like sensitivity was never computed and
 * reads as a broken feature). Runs the drop-one analysis (~60s, N+1 recomputes) against the
 * current config and persists it stamped with the current whole-config fingerprint — the same
 * sanctioned path (runAndPersistSensitivity) a save's phase 2 uses.
 *
 * THE FINAL STEP OF THE RESTORE RECIPE, after `npx prisma db seed` and `seed_compute.py`.
 * `dotenv/config` loads DATABASE_URL from .env; the spawned Python inherits it.
 */
async function main() {
  console.log("Seeding weight-sensitivity snapshot (~60s, N+1 recomputes)…");
  const result = await runAndPersistSensitivity();
  if (!result.ok) {
    console.error(`sensitivity seed FAILED: ${result.error}`);
    process.exit(1);
  }
  console.log(`sensitivity snapshot seeded — stamped ${result.configFingerprint}`);
  process.exit(0);
}

void main();

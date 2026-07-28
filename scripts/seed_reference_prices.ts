import "dotenv/config";

import { prisma } from "@/lib/prisma";

/**
 * Seed the ReferencePrice table (Stage G) so a RESTORED database lands in a WORKING external
 * benchmark state, not an empty one. Seeds the roster's spend-weighted mean unit price per item
 * (the internal benchmark) as a neutral placeholder reference list — external/hybrid mode then
 * has data to read; a user uploads a real market list (MOPS / AME) to override it. Wholesale
 * replace (delete-all then insert), the same contract the upload uses.
 *
 * Part of the restore recipe (after seed_compute + seed_sensitivity). Reference prices are DATA,
 * not config, so they do NOT enter the fingerprint; unused at the default 'internal' benchmark
 * mode, so this seeding never changes a default-config score.
 */
async function main() {
  const rows = await prisma.$queryRaw<{ itemName: string; price: number | null }[]>`
    SELECT pl."itemName" AS "itemName",
           SUM(pl."unitPriceUsd" * pl."quantityOrdered") / NULLIF(SUM(pl."quantityOrdered"), 0) AS price
    FROM "PoLine" pl
    GROUP BY pl."itemName"`;
  const data = rows
    .filter((r) => r.price != null && Number.isFinite(Number(r.price)))
    .map((r) => ({ itemName: r.itemName, unitPriceUsd: Number(r.price), source: "internal-seed" }));
  await prisma.$transaction([
    prisma.referencePrice.deleteMany({}),
    prisma.referencePrice.createMany({ data }),
  ]);
  console.log(`Seeded ${data.length} reference prices (spend-weighted mean unit price per item).`);
  process.exit(0);
}

void main();

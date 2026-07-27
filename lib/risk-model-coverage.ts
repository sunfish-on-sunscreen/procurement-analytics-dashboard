/**
 * SERVER-ONLY roster inputs for lookup-table coverage (imports prisma, so must only be
 * imported from server components / route handlers).
 *
 * The lookup grid shows, per row, HOW MANY suppliers in the current roster it matches — so
 * a never-firing row (the ASEAN tier, the single-source rung) is visible while editing.
 * That count is derived here from the Supplier master roster and passed to the client, which
 * recomputes it against the draft (see lib/risk-model.lookupCoverage) as members are edited.
 */
import { prisma } from "@/lib/prisma";
import type { LookupCoverageInputs } from "@/lib/risk-model";

export async function getLookupCoverageInputs(): Promise<LookupCoverageInputs> {
  const suppliers = await prisma.supplier.findMany({
    select: { country: true, category: true },
  });

  const countryCounts: Record<string, number> = {};
  const categoryCounts: Record<string, number> = {};
  for (const s of suppliers) {
    const code = String(s.country ?? "").trim().toUpperCase();
    if (code) countryCounts[code] = (countryCounts[code] ?? 0) + 1;
    const cat = String(s.category ?? "");
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }

  // other-in-category = (# suppliers in the category) - 1, per supplier — the exact input
  // concentration_curve is keyed on (scores.py: max(0, roster_count[cat] - 1)).
  const concentrationDist: Record<number, number> = {};
  for (const s of suppliers) {
    const cat = String(s.category ?? "");
    const other = Math.max(0, (categoryCounts[cat] ?? 1) - 1);
    concentrationDist[other] = (concentrationDist[other] ?? 0) + 1;
  }

  return { totalSuppliers: suppliers.length, countryCounts, concentrationDist };
}

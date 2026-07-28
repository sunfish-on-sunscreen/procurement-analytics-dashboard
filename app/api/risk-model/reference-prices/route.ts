import { NextResponse } from "next/server";
import { z } from "zod";
import Papa from "papaparse";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readRiskModel } from "@/lib/risk-model-server";
import { recomputeAllPeriods } from "@/lib/recompute";

export const runtime = "nodejs";

/** GET: how many reference prices are stored (for the settings UI). */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const count = await prisma.referencePrice.count();
  return NextResponse.json({ count });
}

const Body = z.object({ csv: z.string().min(1) });

/**
 * POST { csv }: parse `itemName,unitPriceUsd[,source]`, validate server-side, and REPLACE the
 * ReferencePrice table WHOLESALE (delete-all then insert — never a partial merge, which would
 * leave nobody able to say which prices are current). Reference prices are DATA, not config, so
 * this does not touch the fingerprint; but under external/hybrid benchmark mode they change
 * cost_premium, so the analyses are recomputed (same contract as a config save). At internal mode
 * the upload changes no score, so the recompute is skipped.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Provide a non-empty `csv`." }, { status: 400 });

  const table = Papa.parse<Record<string, string>>(parsed.data.csv.trim(), {
    header: true,
    skipEmptyLines: true,
  });
  const rows: { itemName: string; unitPriceUsd: number; source: string | null }[] = [];
  const seen = new Set<string>();
  for (const [i, r] of table.data.entries()) {
    const itemName = (r.itemName ?? r.item ?? r.item_name ?? "").trim();
    const priceStr = String(r.unitPriceUsd ?? r.price ?? r.unit_price_usd ?? "").trim();
    if (!itemName) return NextResponse.json({ error: `Row ${i + 1}: missing itemName.` }, { status: 400 });
    const price = Number(priceStr);
    if (!Number.isFinite(price) || price <= 0) {
      return NextResponse.json({ error: `Row ${i + 1} (${itemName}): unitPriceUsd must be a positive number.` }, { status: 400 });
    }
    if (seen.has(itemName)) return NextResponse.json({ error: `Duplicate item "${itemName}".` }, { status: 400 });
    seen.add(itemName);
    rows.push({ itemName, unitPriceUsd: price, source: (r.source ?? "").trim() || null });
  }
  if (rows.length === 0) return NextResponse.json({ error: "No rows parsed — expected an itemName,unitPriceUsd header." }, { status: 400 });

  await prisma.$transaction([
    prisma.referencePrice.deleteMany({}),
    prisma.referencePrice.createMany({ data: rows }),
  ]);

  const model = await readRiskModel();
  const mode = model.variables?.cost_premium?.partition?.benchmarkMode ?? "internal";
  if (mode === "external" || mode === "hybrid") {
    const rc = await recomputeAllPeriods();
    if (!rc.ok) {
      return NextResponse.json(
        { error: `Prices saved (${rows.length}), but the recompute failed — re-upload to retry. ${rc.error}`, count: rows.length },
        { status: 500 },
      );
    }
  }
  return NextResponse.json({ count: rows.length });
}

#!/usr/bin/env python
"""READ-ONLY catalogue discrimination measure (Stage E).

For every USABLE variable in config/risk-model.json's `variables` catalogue, compute its
per-supplier value over the RANGE window THROUGH THE ACTUAL RESOLVER (the same lookup /
aggregate / cost_premium code scoring uses — not a re-implementation), then report one-way
ANOVA eta-squared against category and against country. This is the measure that exposed
risk_score's components as category/country in disguise (eta² 1.000); it is recorded on each
catalogue entry so the picker shows a variable's measured discrimination rather than inferring
it from a lookup/computed badge. High eta² is a FLAG, never a gate.

Run:  python scripts/measure_catalogue_eta.py        (prints id · eta²(cat) · eta²(ctry) · feedsBuiltin)
Never writes. Env: .env carries a UTF-8 BOM — DATABASE_URL is read with utf-8-sig.
"""
import os
import sys

import numpy as np
import pandas as pd
import psycopg2

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(ROOT, "python"))
import risk_config  # noqa: E402
import scores  # noqa: E402
import compute_analyses as ca  # noqa: E402

RANGE = ("2024-01-01 00:00:00", "2026-12-31 23:59:59")


def db_url():
    with open(os.path.join(ROOT, ".env"), encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').split("?")[0]
    raise SystemExit("baseline: DATABASE_URL not found")


def eta_squared(frame, value_col, group_col):
    """One-way ANOVA effect size SS_between / SS_total in [0,1]."""
    grand = frame[value_col].mean()
    ss_total = float(((frame[value_col] - grand) ** 2).sum())
    if ss_total <= 0:
        return float("nan")
    ss_between = sum(len(g) * (g[value_col].mean() - grand) ** 2 for _, g in frame.groupby(group_col))
    return float(ss_between / ss_total)


def resolve_variable(vid, var, pur_snake, suppliers, roster, cost_map, grand_spend):
    """{supplier_id -> float} for one catalogue variable via its real resolver."""
    kind = var["kind"]
    if kind == "aggregate":
        return scores.build_aggregate_map(pur_snake, var.get("source"), var["agg"], grand_spend)
    if kind == "computed":  # cost_premium partition
        return {sid: float(cost_map.get(sid, var.get("default", 0.0))) for sid in suppliers}
    # lookup: apply the table to each supplier's key field
    out = {}
    for sid, (country, category) in suppliers.items():
        if var["key"] == "country":
            out[sid] = risk_config.lookup_country(var["table"], country)
        else:  # roster_other_count
            other = max(0, int(roster.get(str(category), 1)) - 1)
            out[sid] = risk_config.lookup_numeric(var["table"], other)
    return out


def main():
    conn = psycopg2.connect(db_url())
    conn.set_session(readonly=True)
    po = pd.read_sql(
        'SELECT ep.*, s.country AS s_country FROM "EnrichedPurchase" ep '
        'JOIN "Supplier" s ON s.id = ep."supplierExternalId" '
        'WHERE ep."poDate" >= %s AND ep."poDate" <= %s',
        conn, params=RANGE,
    )
    sup_rows = pd.read_sql('SELECT id, country, category FROM "Supplier"', conn)
    roster = pd.read_sql('SELECT category, COUNT(*) n FROM "Supplier" GROUP BY category', conn)
    po_lines = ca.load_po_lines(conn, *RANGE)
    conn.close()

    roster_n = {str(c): int(n) for c, n in zip(roster.category, roster.n)}
    # suppliers that actually transacted in the window (the scored set)
    active = set(po["supplierExternalId"])
    suppliers = {r.id: (r.country, r.category) for r in sup_rows.itertuples() if r.id in active}
    pur_snake = scores.rename_purchase_columns(po.rename(columns={"s_country": "country"}))
    grand_spend = float(pur_snake["total_value_usd"].sum())
    cost_map = ca._cost_premium_points(po_lines)

    variables = risk_config.get_variables()
    print(f"catalogue eta-squared (RANGE, {len(suppliers)} scored suppliers)")
    print(f"{'variable':<22}{'eta2_category':>14}{'eta2_country':>14}   feedsBuiltin")
    print("-" * 68)
    results = {}
    for vid, var in variables.items():
        vmap = resolve_variable(vid, var, pur_snake, suppliers, roster_n, cost_map, grand_spend)
        rows = [{"v": vmap.get(sid, var.get("default", 0.0)), "category": cat, "country": ctry}
                for sid, (ctry, cat) in suppliers.items()]
        df = pd.DataFrame(rows)
        ec = round(eta_squared(df, "v", "category"), 3)
        eo = round(eta_squared(df, "v", "country"), 3)
        results[vid] = (ec, eo)
        print(f"{vid:<22}{ec:>14.3f}{eo:>14.3f}   {var.get('feedsBuiltin', '-')}")
    return results


if __name__ == "__main__":
    main()

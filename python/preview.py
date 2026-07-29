"""Formula PREVIEW + label IMPACT (Stage F) — READ-ONLY, never writes.

Reads a CANDIDATE composite from stdin as {"composite": {...}} (the whole composite the editor
is editing, with candidate formula/bounds/weights) and prints:
  - perSupplier: for each of the 55 scored suppliers, each enabled component's raw formula value
    -> normalized (bounded) value -> weighted contribution, and the resulting composite score;
  - impact: how many suppliers change Kraljic quadrant (supplyRisk) or performance zone
    (performanceRisk) if the candidate were saved, vs the LIVE config.

Computed by THE Python evaluator (formula_eval) so the preview matches what a saved report would
show — a second TypeScript evaluator would disagree on rounding (banker's vs half-up). The save
path never calls this; the editor calls it through /api/risk-model/preview. Impact reuses
sensitivity.py's window setup + get_composite monkeypatch (restored on exit).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import psycopg2  # noqa: E402
import compute_analyses as ca  # noqa: E402
import risk_config  # noqa: E402
import scores  # noqa: E402
import formula_eval  # noqa: E402
import sensitivity as sens  # noqa: E402


def _range_bounds(conn):
    cur = conn.cursor()
    cur.execute('SELECT MIN("startDate"), MAX("endDate") FROM "ReportingPeriod"')
    s, e = cur.fetchone()
    return s.strftime("%Y-%m-%d 00:00:00"), e.strftime("%Y-%m-%d 23:59:59")


def _candidate_env(candidate, suppliers, purchases):
    """(referenced vars, computed_maps, [(supplier_id, key_values)]) for the candidate composite,
    resolving env exactly as compute_supply_risk / compute_scores do (lookups on the supplier's
    key field; aggregates + cost_premium via computed maps over the window's PO frame)."""
    referenced = set()
    for c in candidate["components"]:
        if c.get("enabled", True) and c.get("formula"):
            referenced |= formula_eval.referenced_names(c["formula"])
    computed_maps = dict(
        scores.build_aggregate_maps(scores.rename_purchase_columns(purchases), referenced,
                                    risk_config.get_variables())
    )
    if "cost_premium" in referenced:
        if ca._PO_LINES is not None and "poId" in purchases.columns:
            po_ids = set(purchases["poId"].tolist())
            cost_input = ca._PO_LINES[ca._PO_LINES["poId"].isin(po_ids)]
        else:
            cost_input = purchases
        computed_maps["cost_premium"] = ca._cost_premium_points(cost_input)
    sup = suppliers.rename(columns={"externalId": "supplierExternalId"}).drop_duplicates(
        "supplierExternalId"
    )
    roster = ca._ROSTER_CAT_COUNTS or {}
    rows = []
    for _, r in sup.iterrows():
        sid = r["supplierExternalId"]
        other = max(0, int(roster.get(str(r["category"]), 1)) - 1)
        rows.append((sid, {"supplier_id": sid, "country": r["country"], "roster_other_count": other}))
    return referenced, computed_maps, rows


def preview_rows(candidate, suppliers, purchases, metrics):
    referenced, computed_maps, rows = _candidate_env(candidate, suppliers, purchases)
    weights = risk_config.resolve_effective_weights(candidate)
    invert = risk_config.invert_polarity(candidate)
    enabled = [c for c in candidate["components"] if c.get("enabled", True)]
    # A candidate carrying BUILTIN components (performanceComposite) needs the builtin sub-score
    # COLUMNS injected into each supplier's env — computed with the LIVE config (the candidate
    # changes only the BLEND, not the sub-scores) — so a builtin component reads its own column
    # (formula_or_id = id) and any formula component reads catalogue variables. Empty for the
    # all-formula risk composites (supplyRisk / performanceRisk).
    builtin_by_sid = {}
    if any(c.get("builtin") for c in candidate["components"]):
        builtin_ids = [c["id"] for c in candidate["components"] if c.get("builtin")]
        frame = sens.score_frame(purchases, suppliers, metrics)
        builtin_by_sid = {
            str(r["supplier_id"]): {bid: float(r[bid]) for bid in builtin_ids}
            for _, r in frame.iterrows()
        }
    out = []
    for sid, key_values in rows:
        # An unscored supplier (no POs in the window) has no sub-scores to blend — skip it when
        # the candidate needs builtin columns. All 55 range suppliers are scored, so this is
        # defensive rather than live.
        if builtin_by_sid and str(sid) not in builtin_by_sid:
            continue
        env = risk_config.resolve_env(referenced, key_values, computed_maps)
        env.update(builtin_by_sid.get(str(sid), {}))
        comps, total = [], 0.0
        for c in enabled:
            b = c.get("bounds", {"lo": 0.0, "hi": 100.0})
            formula_or_id = c.get("formula") or c["id"]  # builtin -> its own injected column
            raw = formula_eval.evaluate_formula(formula_or_id, env)
            norm = formula_eval.normalize_to_bounds(raw, b["lo"], b["hi"])
            contrib = weights[c["id"]] * norm
            total += contrib
            comps.append({"id": c["id"], "raw": round(raw, 4),
                          "normalized": round(norm, 2), "contribution": round(contrib, 2)})
        out.append({"supplier_id": str(sid), "score": round(float(risk_config.combine_score(total, invert)), 2),
                    "components": comps})
    return out


def impact_of(candidate, suppliers, purchases, metrics, lsm):
    """Label churn vs the live config. Patches get_composite to the candidate for the recompute,
    then restores it. supplyRisk -> Kraljic quadrant; performanceRisk OR performanceComposite ->
    performance zone (a composite-blend change moves performance zones, not Kraljic quadrants)."""
    cid = candidate["id"]
    real = risk_config.get_composite

    def patched(x):
        return candidate if x == cid else real(x)

    def diff(base, cand, label):
        movers = [s for s in base if s in cand and base[s] != cand[s]]
        return {"kind": label, "changed": len(movers), "total": len(base),
                "movers": [{"supplier_id": str(s), "from": base[s], "to": cand[s]} for s in movers[:20]]}

    if cid == "supplyRisk":
        base_q = sens.quadrants(lsm, sens.supply_risk_map(purchases, suppliers, metrics))
        risk_config.get_composite = patched
        try:
            cand_q = sens.quadrants(lsm, sens.supply_risk_map(purchases, suppliers, metrics))
        finally:
            risk_config.get_composite = real
        return diff(base_q, cand_q, "Kraljic quadrant")

    base_zone = sens.zones(lsm, {s: v[1] for s, v in sens.window_metrics(purchases, suppliers, metrics).items()})
    risk_config.get_composite = patched
    try:
        cand_zone = sens.zones(lsm, {s: v[1] for s, v in sens.window_metrics(purchases, suppliers, metrics).items()})
    finally:
        risk_config.get_composite = real
    return diff(base_zone, cand_zone, "performance zone")


def main():
    try:
        candidate = json.load(sys.stdin)["composite"]
        sens._ensure_database_url()
        ca.load_env()
        conn = psycopg2.connect(ca.get_dsn())
        conn.set_session(readonly=True)
        try:
            start, end = _range_bounds(conn)
            suppliers, purchases, metrics = sens.setup_window(conn, start, end)
            lsm = sens.log_spend_map(purchases)
            result = {"perSupplier": preview_rows(candidate, suppliers, purchases, metrics),
                      "impact": impact_of(candidate, suppliers, purchases, metrics, lsm)}
        finally:
            conn.close()
        print(json.dumps(result))
        return 0
    except Exception as exc:  # noqa: BLE001 — surface as a structured error the API can show
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 0


if __name__ == "__main__":
    sys.exit(main())

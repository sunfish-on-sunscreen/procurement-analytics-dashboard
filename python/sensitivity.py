"""Weight-sensitivity analysis (drop-one, per window) — the CALLABLE module.

Promoted from scripts/risk_weight_sensitivity.py so the save path can invoke it (Stage C).
COMPUTE ONLY, read-only: it disables ONE component at a time via the SHARED
risk_config.get_composite (monkeypatched here, then restored), lets the real scoring code
renormalize the survivors, and measures (1) the Spearman rank correlation vs the default
ranking, and (2) the % of suppliers whose Kraljic quadrant / performance zone changes.
Nothing is written to the DB.

  supplyRisk           : supply_concentration 0.50 / cost_premium 0.25 / import_friction 0.25
  performanceRisk      : country_distance 0.60 / roster_concentration 0.40 (composite Risk sub-score)
  performanceComposite : quality 0.30 / delivery 0.30 / process 0.22 / risk 0.18

Run (human tables):   python python/sensitivity.py
Run (structured):     python python/sensitivity.py --json   (the save path uses this)
"""
import argparse
import contextlib
import copy
import io
import json
import os
import sys

import numpy as np
import psycopg2
from scipy.stats import spearmanr

import compute_analyses as ca
import risk_config
import scores

HERE = os.path.dirname(os.path.abspath(__file__))


def _ensure_database_url():
    """Standalone runs read DATABASE_URL from .env (BOM-tolerant); a spawned run inherits
    it from the Node process env, in which case this is a no-op."""
    if os.environ.get("DATABASE_URL"):
        return
    env_path = os.path.join(HERE, "..", ".env")
    for line in io.open(env_path, encoding="utf-8-sig"):
        if line.strip().startswith("DATABASE_URL="):
            os.environ["DATABASE_URL"] = line.strip().split("=", 1)[1].strip().strip('"')
            return


# --------------------------------------------------------------------------- #
# Config-variant context manager (restore on exit). NO scoring logic changes.
# --------------------------------------------------------------------------- #
@contextlib.contextmanager
def component_disabled(composite_id, component_id):
    """Disable ONE component of a composite for the duration. The real
    compute_supply_risk / compute_scores read this via risk_config.get_composite and
    renormalize the survivors through the real resolve_effective_weights."""
    real = risk_config.get_composite
    variant = copy.deepcopy(real(composite_id))
    for c in variant["components"]:
        if c["id"] == component_id:
            c["enabled"] = False
    risk_config.get_composite = lambda cid: variant if cid == composite_id else real(cid)
    try:
        yield
    finally:
        risk_config.get_composite = real


# --------------------------------------------------------------------------- #
# Window setup + scoring wrappers (mirror compute_analyses.main / build_live_composite_map)
# --------------------------------------------------------------------------- #
def setup_window(conn, start_ts, end_ts):
    ca._ROSTER_CAT_COUNTS = ca.load_roster_category_counts(conn)
    ca._ALL_METHOD_CYCLES = ca.load_all_method_cycles(conn)
    ca._SOURCING_EVENTS = ca.load_sourcing_events(conn)
    ca._CALLOFF_FRAMEWORKS = ca.load_calloff_frameworks(conn)
    suppliers, purchases, metrics = ca.load_frames(conn, start_ts, end_ts)
    ca._PO_LINES = ca.load_po_lines(conn, start_ts, end_ts)
    ca._REFERENCE_PRICES = ca.load_reference_prices_if_needed(conn)  # Stage G (external/hybrid)
    return suppliers, purchases, metrics


def log_spend_map(purchases):
    spend = purchases.groupby("supplierExternalId")["totalValueUsd"].sum()
    return {sid: float(np.log1p(v)) for sid, v in spend.items()}


def supply_risk_map(purchases, suppliers, metrics):
    """Current-config (or patched) supply_risk_score per supplier (unrounded float —
    the value assign_kraljic_quadrants actually uses)."""
    risk_map, _comp, _components = ca.compute_supply_risk(purchases, suppliers, metrics)
    return risk_map


def window_metrics(purchases, suppliers, metrics):
    """Per-supplier scored frame via the REAL scores.build_window_metrics (reads the
    live/patched performanceRisk + performanceComposite config). Returns {sid:
    (risk_score, composite_score)}."""
    pur = scores.rename_purchase_columns(purchases)
    country_by_sid = (
        suppliers.rename(columns={"externalId": "supplierExternalId"})
        .drop_duplicates("supplierExternalId")
        .set_index("supplierExternalId")["country"].to_dict()
    )
    soft = (
        metrics.drop_duplicates("supplierExternalId")
        .rename(columns={"supplierExternalId": "supplier_id", "supplierName": "supplier_name"})[
            ["supplier_id", "supplier_name", "category"]].copy()
    )
    soft["country"] = soft["supplier_id"].map(country_by_sid).fillna("")
    wm = scores.build_window_metrics(soft, pur, ca._ROSTER_CAT_COUNTS or {})
    return {
        str(r["supplier_id"]): (float(r["risk_score"]), float(r["composite_score"]))
        for _, r in wm.iterrows()
    }


def quadrants(lsm, risk_map):
    sids = [s for s in lsm if s in risk_map]
    quad, _sm, _rm = ca.assign_kraljic_quadrants(
        {s: lsm[s] for s in sids}, {s: risk_map[s] for s in sids}
    )
    return quad


def zones(lsm, composite_map):
    """Performance-zone median split (mirrors compute_analyses' zone_of exactly:
    strict > on both log-spend and composite)."""
    sids = [s for s in lsm if s in composite_map and composite_map[s] is not None]
    if not sids:
        return {}
    spend_med = float(np.median([lsm[s] for s in sids]))
    perf_med = float(np.median([composite_map[s] for s in sids]))
    out = {}
    for s in sids:
        hi_s, hi_p = lsm[s] > spend_med, composite_map[s] > perf_med
        out[s] = ("Stars" if hi_s and hi_p else "Critical Issues" if hi_s and not hi_p
                  else "Hidden Gems" if not hi_s and hi_p else "Long Tail")
    return out


def spearman(default_map, variant_map):
    sids = sorted(set(default_map) & set(variant_map))
    a = [default_map[s] for s in sids]
    b = [variant_map[s] for s in sids]
    rho, _p = spearmanr(a, b)
    return float(rho), len(sids)


def pct_changed(map_a, map_b):
    sids = sorted(set(map_a) & set(map_b))
    if not sids:
        return 0.0, 0, 0
    changed = sum(1 for s in sids if map_a[s] != map_b[s])
    return 100.0 * changed / len(sids), changed, len(sids)


# --------------------------------------------------------------------------- #
def analyze_window(conn, label, start_ts, end_ts):
    suppliers, purchases, metrics = setup_window(conn, start_ts, end_ts)
    lsm = log_spend_map(purchases)

    out = {"label": label, "supplyRisk": [], "performanceRisk": [], "composite": []}

    # ---- supplyRisk: score IS the Kraljic Y-axis ----
    base_risk = supply_risk_map(purchases, suppliers, metrics)
    base_quad = quadrants(lsm, base_risk)
    out["n_kraljic"] = len(base_quad)
    for comp in ["supply_concentration", "cost_premium", "import_friction"]:
        with component_disabled("supplyRisk", comp):
            v_risk = supply_risk_map(purchases, suppliers, metrics)
        rho, n = spearman(base_risk, v_risk)
        q_pct, q_ch, q_n = pct_changed(base_quad, quadrants(lsm, v_risk))
        out["supplyRisk"].append({"dropped": comp, "rho": rho, "n": n,
                                  "quad_pct": q_pct, "quad_changed": q_ch, "quad_n": q_n})

    # ---- performanceRisk: composite Risk sub-score -> composite -> zone ----
    base_wm = window_metrics(purchases, suppliers, metrics)
    base_risk_score = {s: v[0] for s, v in base_wm.items()}
    base_comp = {s: v[1] for s, v in base_wm.items()}
    base_zone = zones(lsm, base_comp)
    out["n_zone"] = len(base_zone)
    for comp in ["country_distance", "roster_concentration"]:
        with component_disabled("performanceRisk", comp):
            v_wm = window_metrics(purchases, suppliers, metrics)
        v_risk_score = {s: v[0] for s, v in v_wm.items()}
        v_comp = {s: v[1] for s, v in v_wm.items()}
        rho, n = spearman(base_risk_score, v_risk_score)
        # Kraljic quadrant is driven by supply_risk_score (unchanged) -> 0% by construction; verify.
        kq_pct, _c, _n = pct_changed(base_quad, quadrants(lsm, base_risk))  # both default supply risk
        z_pct, z_ch, z_n = pct_changed(base_zone, zones(lsm, v_comp))
        out["performanceRisk"].append({"dropped": comp, "rho": rho, "n": n,
                                       "kraljic_pct": kq_pct, "zone_pct": z_pct,
                                       "zone_changed": z_ch, "zone_n": z_n})

    # ---- top-level composite: Q/D/P/R ----
    for dim in ["quality_score", "delivery_score", "process_score", "risk_score"]:
        with component_disabled("performanceComposite", dim):
            v_wm = window_metrics(purchases, suppliers, metrics)
        v_comp = {s: v[1] for s, v in v_wm.items()}
        rho, n = spearman(base_comp, v_comp)
        z_pct, z_ch, z_n = pct_changed(base_zone, zones(lsm, v_comp))
        out["composite"].append({"dropped": dim, "rho": rho, "n": n,
                                 "zone_pct": z_pct, "zone_changed": z_ch, "zone_n": z_n})
    return out


def compute_sensitivity(conn):
    """The structured result: one entry per window (2024/2025/2026 + RANGE), each with the
    composite / supplyRisk / performanceRisk drop-one measures. This is what the save path
    persists (as resultJson) and the Methodology page renders. `schema` guards the shape."""
    cur = conn.cursor()
    cur.execute('SELECT name, "startDate", "endDate" FROM "ReportingPeriod" ORDER BY "startDate"')
    periods = cur.fetchall()
    windows = [(n, s.strftime("%Y-%m-%d 00:00:00"), e.strftime("%Y-%m-%d 23:59:59"))
               for n, s, e in periods]
    windows.append(("RANGE",
                    min(p[1] for p in periods).strftime("%Y-%m-%d 00:00:00"),
                    max(p[2] for p in periods).strftime("%Y-%m-%d 23:59:59")))
    return {"schema": 1, "windows": [analyze_window(conn, lbl, s, e) for lbl, s, e in windows]}


# --------------------------------------------------------------------------- #
# Human-readable tables (the manual-run experience), rendered FROM the structured result.
# --------------------------------------------------------------------------- #
def print_tables(data):
    results = data["windows"]
    print("=" * 78)
    print("RISK-WEIGHT SENSITIVITY (drop-one, per window)")
    print("=" * 78)

    print("\n### HEADLINE: % of suppliers whose KRALJIC QUADRANT changes (supplyRisk drop-one)\n")
    print(f"  {'window':<7} {'n':>3}  {'drop concentration':>20}  {'drop cost_premium':>18}  {'drop import_friction':>20}")
    for r in results:
        cells = {x["dropped"]: x for x in r["supplyRisk"]}

        def cell(c):
            x = cells[c]
            return f"{x['quad_pct']:5.1f}% ({x['quad_changed']}/{x['quad_n']})"
        print(f"  {r['label']:<7} {r['n_kraljic']:>3}  {cell('supply_concentration'):>20}  "
              f"{cell('cost_premium'):>18}  {cell('import_friction'):>20}")

    print("\n### supplyRisk — Spearman rho (default vs drop-one supply_risk_score ranking)\n")
    print(f"  {'window':<7}  {'drop concentration':>19}  {'drop cost_premium':>17}  {'drop import_friction':>20}")
    for r in results:
        cells = {x["dropped"]: x for x in r["supplyRisk"]}
        print(f"  {r['label']:<7}  {cells['supply_concentration']['rho']:>19.4f}  "
              f"{cells['cost_premium']['rho']:>17.4f}  {cells['import_friction']['rho']:>20.4f}")

    print("\n### performanceRisk — Spearman rho (risk_score) + Kraljic % + performance-zone %\n")
    for r in results:
        print(f"  [{r['label']}]  (n_zone={r['n_zone']})")
        for x in r["performanceRisk"]:
            print(f"    drop {x['dropped']:<20} rho={x['rho']:.4f}  "
                  f"Kraljic-change={x['kraljic_pct']:.1f}%  "
                  f"zone-change={x['zone_pct']:.1f}% ({x['zone_changed']}/{x['zone_n']})")

    print("\n### top-level composite — Spearman rho (default vs drop-one composite ranking)\n")
    print(f"  {'window':<7}  {'drop quality':>13}  {'drop delivery':>13}  {'drop process':>13}  {'drop risk':>13}")
    for r in results:
        cells = {x["dropped"]: x for x in r["composite"]}
        print(f"  {r['label']:<7}  {cells['quality_score']['rho']:>13.4f}  "
              f"{cells['delivery_score']['rho']:>13.4f}  {cells['process_score']['rho']:>13.4f}  "
              f"{cells['risk_score']['rho']:>13.4f}")

    print("\n### top-level composite — % performance-zone change (drop-one)\n")
    for r in results:
        cells = {x["dropped"]: x for x in r["composite"]}
        parts = [f"{d.split('_')[0]} {cells[d]['zone_pct']:.1f}% ({cells[d]['zone_changed']}/{cells[d]['zone_n']})"
                 for d in ["quality_score", "delivery_score", "process_score", "risk_score"]]
        print(f"  {r['label']:<7}  " + " | ".join(parts))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Drop-one weight-sensitivity analysis (read-only).")
    ap.add_argument("--json", action="store_true", help="print the structured result as JSON")
    args = ap.parse_args(argv)

    _ensure_database_url()
    ca.load_env()
    conn = psycopg2.connect(ca.get_dsn())
    conn.set_session(readonly=True)
    try:
        data = compute_sensitivity(conn)
    finally:
        conn.close()

    if args.json:
        print(json.dumps(data))
    else:
        print_tables(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())

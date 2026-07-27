#!/usr/bin/env python
"""READ-ONLY baseline verification harness for the procurement analytics dataset.

THE load-bearing gate for the risk-model-config work: it reproduces every baseline
figure and a full per-supplier score dump straight from the live data, prints a
canonical md5 of that dump, and can diff against a saved dump to name exactly which
suppliers moved. "Verified byte-identical" is only reproducible by anyone if this
script — not a scratch throwaway — is what produced the numbers.

WHY IT NEVER WRITES
  - Raw scalars come from plain SELECTs on the EnrichedPurchase view + base tables.
  - Every per-supplier score is recomputed by shelling out to compute_analyses.py in
    MODE B (--start-date/--end-date), which prints JSON to stdout and NEVER upserts
    (Mode A, --period-id, is the only write path and is never invoked here).
  - The four composite sub-scores (quality/delivery/process/risk) are not in any Mode-B
    payload, so they are recomputed IN PROCESS via scores.build_window_metrics — a pure
    function — mirroring compute_analyses.build_live_composite_map's frame prep exactly.
  - A per-supplier assert (composite_score == performance_score) proves the in-process
    path agrees with the authoritative Mode-B path on the same window.

CACHE-INDEPENDENT BY DESIGN
  Mode B computes fresh from the current config; it does not read AnalysisResult. So the
  harness reflects what the config produces RIGHT NOW, even immediately after a recompute
  has cleared the range cache. That is the correct gate semantics.

GRAINS: 2024, 2025, 2026 (single-year windows, byte-identical to the stored Mode-A rows)
  and RANGE = all years [2024-01-01 .. 2026-12-31] (byte-identical to the 55-supplier
  cached range row).

USAGE
  python scripts/baseline_harness.py                 # report + md5; exit 0
  python scripts/baseline_harness.py --save dump.json# also write the canonical dump
  python scripts/baseline_harness.py --diff dump.json# diff vs a saved dump; exit 1 on drift
  python scripts/baseline_harness.py --json          # print the full canonical dump to stdout

EXIT CODES: 0 = ok / no drift · 1 = drift vs --diff baseline · 2 = usage / runtime error
  (bad args, DB or Mode-B subprocess failure, a null analysis from a broken config) ·
  3 = internal inconsistency (composite != performance, or the reproduction sources
  disagree on the supplier set — a degraded/half-recomputed DB, or a harness bug).

ENV: .env carries a UTF-8 BOM that breaks python-dotenv, so DATABASE_URL is read here with
  utf-8-sig and injected into the Mode-B subprocess env explicitly.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
PYTHON_DIR = os.path.join(ROOT, "python")
COMPUTE = os.path.join(PYTHON_DIR, "compute_analyses.py")
ENV_PATH = os.path.join(ROOT, ".env")

sys.path.insert(0, PYTHON_DIR)
import psycopg2  # noqa: E402
import scores  # noqa: E402  (python/scores.py — pure score engine)
import compute_analyses as ca  # noqa: E402  (load_frames / load_roster_category_counts)

# Single-year windows reproduce the stored Mode-A rows; RANGE spans all years and
# reproduces the canonical 55-supplier cached range row. Mode B wraps a --end-date of
# YYYY-12-31 to 23:59:59, which matches each ReportingPeriod.endDate exactly.
GRAINS = [
    ("2024", "2024-01-01", "2024-12-31"),
    ("2025", "2025-01-01", "2025-12-31"),
    ("2026", "2026-01-01", "2026-12-31"),
    ("RANGE", "2024-01-01", "2026-12-31"),
]

# Fixed per-supplier field order in the dump. The four operational sub-scores are
# config-INDEPENDENT (pure aggregates); risk_score / composite_score / supply_risk_score
# / risk_components / quadrant / zone are what a config change can move.
SCORE_FIELDS = [
    "quality_score", "delivery_score", "process_score", "risk_score",
    "composite_score", "supply_risk_score", "quadrant", "zone",
    "log_spend", "total_spend_usd",
]
RISK_COMPONENT_KEYS = ["supply_concentration", "cost_premium", "import_friction"]


# --------------------------------------------------------------------------- #
# Environment / connection (read-only)
# --------------------------------------------------------------------------- #
def read_database_url():
    """DATABASE_URL from .env, tolerating the UTF-8 BOM. libpq form (drop ?schema=)."""
    with open(ENV_PATH, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').split("?")[0]
    sys.stderr.write("baseline_harness: DATABASE_URL not found in .env\n")
    raise SystemExit(2)  # runtime/config error, NOT drift (exit 1)


def connect(url):
    conn = psycopg2.connect(url)
    conn.set_session(readonly=True)  # belt-and-braces: the session itself refuses writes
    return conn


# --------------------------------------------------------------------------- #
# Canonicalization (stable md5 / diff independent of float repr)
# --------------------------------------------------------------------------- #
def canon(obj):
    """Recursively canonicalize for hashing/diffing: floats -> fixed 6dp strings,
    dict keys sorted, so the fingerprint depends only on values, never on float repr
    jitter or key order."""
    if isinstance(obj, dict):
        return {k: canon(obj[k]) for k in sorted(obj)}
    if isinstance(obj, list):
        return [canon(x) for x in obj]
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        return f"{obj:.6f}"
    return obj


def dump_md5(dump):
    blob = json.dumps(canon(dump), sort_keys=True, separators=(",", ":"))
    return hashlib.md5(blob.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Raw DB scalars (config-independent baseline figures)
# --------------------------------------------------------------------------- #
def raw_figures(conn):
    cur = conn.cursor()

    def one(sql):
        cur.execute(sql)
        return cur.fetchone()

    total_spend, po_count = one('select sum("totalValueUsd"), count(*) from "EnrichedPurchase"')
    cur.execute('select period, count(*), sum("totalValueUsd") from "EnrichedPurchase" '
                'group by period order by period')
    by_period = {str(p): {"pos": int(c), "spend": round(float(s), 2)} for p, c, s in cur.fetchall()}
    match_pass, match_fail = one(
        'select sum(case when "threeWayMatchPass" then 1 else 0 end), '
        'sum(case when not "threeWayMatchPass" then 1 else 0 end) from "EnrichedPurchase"')
    suppliers = one('select count(*) from "Supplier"')[0]
    supplier_metric = one('select count(*) from "SupplierMetric"')[0]
    cat_country = one('select count(*) from (select distinct category, country from "Supplier") t')[0]
    cur.close()
    return {
        "total_spend": round(float(total_spend), 2),
        "purchase_orders": int(po_count),
        "by_period": by_period,
        "match_pass": int(match_pass),
        "match_fail": int(match_fail),
        "suppliers": int(suppliers),
        "supplier_metric_rows": int(supplier_metric),
        "distinct_category_country": int(cat_country),
    }


# --------------------------------------------------------------------------- #
# Per-grain compute — Mode B (subprocess) + in-process sub-scores
# --------------------------------------------------------------------------- #
def run_mode_b(start_date, end_date, db_url):
    """Invoke compute_analyses.py Mode B (read-only; prints JSON, no writes). Inject
    DATABASE_URL because the .env BOM defeats the script's own dotenv load."""
    env = dict(os.environ)
    env["DATABASE_URL"] = db_url
    proc = subprocess.run(
        [sys.executable, COMPUTE, "--start-date", start_date, "--end-date", end_date],
        capture_output=True, text=True, env=env, cwd=PYTHON_DIR,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.stderr.write(f"baseline_harness: Mode B failed for {start_date}..{end_date}\n")
        raise SystemExit(2)  # runtime error, NOT drift (exit 1)
    return json.loads(proc.stdout)


def inprocess_subscores(conn, start_date, end_date, roster):
    """Recompute the six scores per supplier via scores.build_window_metrics over the
    same window, mirroring compute_analyses.build_live_composite_map's frame prep. Pure;
    no DB write. Returns {supplier_id -> {quality/delivery/process/risk/composite_score}}."""
    start_ts, end_ts = f"{start_date} 00:00:00", f"{end_date} 23:59:59"
    suppliers, purchases, metrics = ca.load_frames(conn, start_ts, end_ts)
    if len(purchases) == 0 or len(metrics) == 0:
        return {}
    pur = scores.rename_purchase_columns(purchases)
    country_by_sid = (
        suppliers.rename(columns={"externalId": "supplierExternalId"})
        .drop_duplicates("supplierExternalId")
        .set_index("supplierExternalId")["country"].to_dict()
    )
    soft = (
        metrics.drop_duplicates("supplierExternalId")
        .rename(columns={"supplierExternalId": "supplier_id", "supplierName": "supplier_name"})
        [["supplier_id", "supplier_name", "category"]].copy()
    )
    soft["country"] = soft["supplier_id"].map(country_by_sid).fillna("")
    wm = scores.build_window_metrics(soft, pur, roster)
    out = {}
    for _, r in wm.iterrows():
        out[str(r["supplier_id"])] = {
            "quality_score": round(float(r["quality_score"]), 2),
            "delivery_score": round(float(r["delivery_score"]), 2),
            "process_score": round(float(r["process_score"]), 2),
            "risk_score": round(float(r["risk_score"]), 2),
            "composite_score": round(float(r["composite_score"]), 2),
        }
    return out


def grain_dump(conn, name, start_date, end_date, roster, db_url):
    """Merge Mode-B kraljic + performance_spend with the in-process sub-scores into one
    per-supplier map for this grain, plus the grain's summary figures."""
    payload = run_mode_b(start_date, end_date, db_url)
    # Fail CLOSED: a null analysis means Mode B's compute raised for the current config
    # (e.g. a composite with every component disabled) — main() catches per-analysis
    # exceptions and still prints JSON + exits 0. Absorbing that as an empty grain would
    # let a broken config pass a plain run and poison a --save baseline, so surface it.
    for required in ("kraljic", "performance_spend"):
        if payload.get(required) is None:
            sys.stderr.write(
                f"baseline_harness: Mode B returned null '{required}' for grain {name} "
                f"({start_date}..{end_date}) — compute failed for the current config\n"
            )
            raise SystemExit(2)
    kr = payload["kraljic"]
    ps = payload["performance_spend"]

    kr_by_sid = {q["supplier_id"]: q for q in kr.get("quadrant_assignments", [])}
    ps_by_sid = {row["supplier_id"]: row for row in ps.get("suppliers", [])}
    sub = inprocess_subscores(conn, start_date, end_date, roster)

    # Fail CLOSED: the three reproduction sources must cover the SAME supplier set. If
    # they diverge (a supplier scored by one path but not another — reachable only in a
    # degraded/half-recomputed DB) a merged row would silently carry a real log_spend
    # with total_spend_usd defaulted to 0, and the composite==performance guard below
    # would be skipped. In a healthy recomputed DB the three sets are identical.
    if not (set(kr_by_sid) == set(ps_by_sid) == set(sub)):
        only_kr = sorted(set(kr_by_sid) - set(ps_by_sid) - set(sub))
        only_ps = sorted(set(ps_by_sid) - set(kr_by_sid))
        only_sub = sorted(set(sub) - set(kr_by_sid))
        sys.stderr.write(
            f"baseline_harness: grain {name} supplier-set mismatch across sources — "
            f"kraljic-only={only_kr} perf-only={only_ps} subscore-only={only_sub}\n"
        )
        raise SystemExit(3)

    suppliers = {}
    inconsistencies = []
    for sid in sorted(kr_by_sid):
        q = kr_by_sid[sid]
        p = ps_by_sid.get(sid, {})
        s = sub.get(sid, {})
        composite = s.get("composite_score")
        perf = p.get("performance_score")
        # Guard: the two independent reproduction paths must agree on the live composite.
        if composite is not None and perf is not None and round(composite, 2) != round(float(perf), 2):
            inconsistencies.append((sid, composite, float(perf)))
        rc = q.get("risk_components", {})
        suppliers[sid] = {
            "quality_score": s.get("quality_score"),
            "delivery_score": s.get("delivery_score"),
            "process_score": s.get("process_score"),
            "risk_score": s.get("risk_score"),
            "composite_score": composite,
            "supply_risk_score": round(float(q["supply_risk_score"]), 2),
            "risk_components": {k: round(float(rc.get(k, 0.0)), 2) for k in RISK_COMPONENT_KEYS},
            "quadrant": q.get("quadrant"),
            "zone": p.get("zone"),
            "log_spend": round(float(q["log_spend"]), 4),
            "total_spend_usd": round(float(p.get("total_spend_usd", 0.0)), 2),
        }

    if inconsistencies:
        for sid, c, perf in inconsistencies:
            sys.stderr.write(f"INCONSISTENT {name}/{sid}: composite {c} != performance {perf}\n")
        raise SystemExit(3)

    srs = {row["supply_risk_score"] for row in suppliers.values()}
    figures = {
        "scored": len(suppliers),
        "risk_median": kr.get("axis_thresholds", {}).get("risk_median"),
        "log_spend_median": kr.get("axis_thresholds", {}).get("spend_median"),
        "performance_median": ps.get("axis_thresholds", {}).get("performance_median"),
        "distinct_supply_risk_score": len(srs),
    }
    return figures, suppliers


# --------------------------------------------------------------------------- #
# Build the full dump
# --------------------------------------------------------------------------- #
def build_dump():
    db_url = read_database_url()
    conn = connect(db_url)
    try:
        roster = ca.load_roster_category_counts(conn)
        figures = {"raw": raw_figures(conn), "grains": {}}
        suppliers = {}
        for name, start_date, end_date in GRAINS:
            gfig, gsup = grain_dump(conn, name, start_date, end_date, roster, db_url)
            figures["grains"][name] = gfig
            suppliers[name] = gsup
    finally:
        conn.close()
    return {"figures": figures, "suppliers": suppliers}


# --------------------------------------------------------------------------- #
# Reporting + diffing
# --------------------------------------------------------------------------- #
def print_report(dump):
    raw = dump["figures"]["raw"]
    bp = raw["by_period"]
    print("=" * 68)
    print("BASELINE HARNESS — raw DB figures (config-independent)")
    print("=" * 68)
    print(f"  Total spend               ${raw['total_spend']:,.2f}")
    order = [k for k in ("2024", "2025", "2026") if k in bp]
    print(f"  Purchase orders           {raw['purchase_orders']}  "
          f"({' / '.join(str(bp[k]['pos']) for k in order)})")
    print(f"  Match pass / fail         {raw['match_pass']} / {raw['match_fail']}")
    print(f"  Suppliers                 {raw['suppliers']}")
    print(f"  SupplierMetric rows       {raw['supplier_metric_rows']}")
    print(f"  distinct (category,country) {raw['distinct_category_country']}")
    print("-" * 68)
    print("Per-grain computed figures (Mode B, live from config)")
    print(f"  {'grain':<7}{'scored':>7}{'risk_median':>14}{'log_spend_med':>15}"
          f"{'perf_median':>13}{'dist.SRS':>10}")
    for name, _, _ in GRAINS:
        g = dump["figures"]["grains"][name]
        print(f"  {name:<7}{g['scored']:>7}{_fmt(g['risk_median']):>14}"
              f"{_fmt(g['log_spend_median']):>15}{_fmt(g['performance_median']):>13}"
              f"{g['distinct_supply_risk_score']:>10}")
    print("-" * 68)
    print(f"  DUMP MD5: {dump_md5(dump)}")
    print("=" * 68)


def _fmt(v):
    return f"{v:.4f}" if isinstance(v, float) else str(v)


def _flatten_supplier(row):
    """Flatten one supplier row to {field -> value}, expanding risk_components."""
    flat = {}
    for k, v in row.items():
        if k == "risk_components" and isinstance(v, dict):
            for ck, cv in v.items():
                flat[f"risk_components.{ck}"] = cv
        else:
            flat[k] = v
    return flat


def diff_dumps(current, saved):
    """Return (n_diffs, lines). Compares raw figures, per-grain figures, and every
    per-supplier field, counting movers per axis and naming them."""
    lines = []
    n = 0
    cc, sc = canon(current), canon(saved)

    # 1) raw + per-grain figures
    def walk(a, b, path):
        nonlocal n
        keys = sorted(set(a) | set(b)) if isinstance(a, dict) else []
        for k in keys:
            av, bv = (a or {}).get(k), (b or {}).get(k)
            if isinstance(av, dict) or isinstance(bv, dict):
                walk(av or {}, bv or {}, f"{path}.{k}")
            elif av != bv:
                n += 1
                lines.append(f"  FIGURE {path}.{k}: {bv} -> {av}")

    walk(cc["figures"], sc["figures"], "figures")

    # 2) per-supplier, per-field, per-grain — counted per axis
    axis_movers = {}  # field -> list of "grain/sid: old -> new"
    grains = sorted(set(cc["suppliers"]) | set(sc["suppliers"]))
    for g in grains:
        cur_g, sav_g = cc["suppliers"].get(g, {}), sc["suppliers"].get(g, {})
        sids = sorted(set(cur_g) | set(sav_g))
        for sid in sids:
            if sid not in cur_g:
                axis_movers.setdefault("<supplier present>", []).append(f"{g}/{sid}: in baseline, gone now")
                n += 1
                continue
            if sid not in sav_g:
                axis_movers.setdefault("<supplier present>", []).append(f"{g}/{sid}: new, not in baseline")
                n += 1
                continue
            fa, fb = _flatten_supplier(cur_g[sid]), _flatten_supplier(sav_g[sid])
            for field in sorted(set(fa) | set(fb)):
                if fa.get(field) != fb.get(field):
                    n += 1
                    axis_movers.setdefault(field, []).append(
                        f"{g}/{sid}: {fb.get(field)} -> {fa.get(field)}")

    if axis_movers:
        lines.append("  Per-supplier drift by axis (count · movers):")
        for field in sorted(axis_movers):
            movers = axis_movers[field]
            lines.append(f"    {field}: {len(movers)}")
            for m in movers[:40]:
                lines.append(f"        {m}")
            if len(movers) > 40:
                lines.append(f"        … +{len(movers) - 40} more")
    return n, lines


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="Read-only baseline verification harness.")
    ap.add_argument("--save", metavar="PATH", help="write the canonical dump JSON to PATH")
    # --diff (gate) and --json (raw dump to stdout) are distinct intents; mutually
    # exclusive so `--json --diff x` can't silently skip the gate (argparse -> exit 2).
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--diff", metavar="PATH", help="diff current dump against a saved dump")
    mode.add_argument("--json", action="store_true", help="print the full canonical dump to stdout")
    args = ap.parse_args()

    # Map any uncaught runtime failure (DB connect, Mode-B subprocess, missing/malformed
    # --diff file) to the documented exit 2 so a gate never mistakes it for drift (exit 1).
    # Intentional SystemExit(2)/(3) from the guards above are BaseException, not Exception,
    # so they propagate with their codes intact.
    try:
        dump = build_dump()

        if args.json:
            print(json.dumps(dump, indent=2, sort_keys=True))
            return 0

        print_report(dump)

        if args.save:
            with open(args.save, "w", encoding="utf-8") as f:
                json.dump(dump, f, indent=2, sort_keys=True)
            print(f"  saved dump -> {args.save}")

        if args.diff:
            with open(args.diff, encoding="utf-8") as f:
                saved = json.load(f)
            n, lines = diff_dumps(dump, saved)
            print("-" * 68)
            if n == 0:
                print(f"  DIFF vs {args.diff}: MATCH (md5 {dump_md5(dump)})")
                return 0
            print(f"  DIFF vs {args.diff}: {n} difference(s)")
            for line in lines:
                print(line)
            return 1

        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"baseline_harness: {type(exc).__name__}: {exc}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())

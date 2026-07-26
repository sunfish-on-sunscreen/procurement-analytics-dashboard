"""Unit tests / verification for python/scores.py (Stage 1 of backend-scoring).

Two layers:

  1. PURE FORMULA TESTS (no external data) — always run. Lock the normalizers,
     country-distance tiers, the D9 concentration curve, and a full hand-computed
     composite so any future formula drift fails loudly.

  2. BASELINE REPRODUCTION — recompute the 6 scores from the RAW workbook via
     scores.py and prove they reproduce the captured DB baseline. The baseline is
     INVOICE-year bucketed (54/50/16, D9 applied in place); a from-raw compute is
     PAYMENT-year bucketed (53/50/20). So the check is layered:
       (a) the PERIOD-INDEPENDENT scores (quality, service, risk — incl. D9) must
           match per supplier for EVERY supplier in both  -> proves formula exactness;
       (b) EVERY per-(supplier,period) difference is confined to the
           PERIOD-DEPENDENT scores (delivery/process/composite) and tracks a change
           in the PO set (num_pos/total_spend) -> proves the ONLY cause of
           per-period differences is the documented invoice->payment rebucketing,
           not a formula change.

Run:   python python/test_scores.py        (standalone, prints a full report)
       pytest python/test_scores.py         (assertions)
Baseline CSV: $BASELINE_CSV or the default scratch path (skips if absent).
"""

import copy
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scores  # noqa: E402
import risk_config  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
# The two separated raw input files (the canonical upload format). Supplier
# identity comes from the Suppliers file; the SupplierMetrics sheet was dropped.
DATA_RAW = os.path.join(HERE, "..", "data", "raw")
SUPPLIERS_XLSX = os.path.join(DATA_RAW, "procurement_suppliers.xlsx")
PURCHASES_XLSX = os.path.join(DATA_RAW, "procurement_purchases.xlsx")


def _load_raw():
    """Load the two separated raw input files into (suppliers, purchases) frames.
    `suppliers` is BOTH the roster source and the supplier-identity source that
    build_period_metrics carries constant across periods."""
    sup = pd.read_excel(SUPPLIERS_XLSX, sheet_name="Suppliers")
    pur = pd.read_excel(PURCHASES_XLSX, sheet_name="Purchases")
    return sup, pur


DEFAULT_BASELINE = os.path.join(
    r"C:\Users\indra\AppData\Local\Temp\claude",
    "C--Users-indra-Downloads-procurement-analytics-app",
    "05de7671-e478-4b22-8678-a76f41d6cd2f", "scratchpad",
    "baseline_supplier_scores.csv",
)
BASELINE_CSV = os.environ.get("BASELINE_CSV", DEFAULT_BASELINE)

# Post-overhaul: risk (country + roster concentration) is the only period-
# INDEPENDENT score; quality is now PO-aggregated (defect/complaint), so it joins
# delivery/process/composite as period-DEPENDENT.
PERIOD_INDEP = ["risk_score"]
PERIOD_DEP = ["quality_score", "delivery_score", "process_score", "composite_score"]
# The 4 suppliers whose PERIOD MEMBERSHIP shifts under invoice->payment (Stage 0).
KNOWN_BOUNDARY = {"S054", "S002", "S003", "S020"}


# --------------------------------------------------------------------------- #
# Layer 1 — pure formula tests
# --------------------------------------------------------------------------- #
def test_normalizers():
    assert scores.norm_high(50, 0, 100) == 50.0
    assert scores.norm_high(150, 0, 100) == 100.0   # clamp high
    assert scores.norm_high(-10, 0, 100) == 0.0     # clamp low
    assert scores.norm_low(0, 0, 10) == 100.0       # best
    assert scores.norm_low(10, 0, 10) == 0.0        # worst
    assert scores.norm_low(2, 0, 10) == 80.0
    assert abs(scores.norm_low(2, 0, 14) - (12 / 14 * 100)) < 1e-9


def test_country_distance():
    assert scores.country_distance_score("ID") == 0.0
    assert scores.country_distance_score("indonesia") == 0.0
    assert scores.country_distance_score("MY") == 30.0
    assert scores.country_distance_score("JP") == 60.0
    assert scores.country_distance_score("DE") == 100.0
    assert scores.country_distance_score("") == 100.0


def test_concentration_curve():
    # D9 curve: 0 others -> 100 (single source), grades down, >=5 -> 0.
    assert scores.concentration_0_100(0) == 100.0
    assert scores.concentration_0_100(1) == 70.0
    assert scores.concentration_0_100(2) == 44.0
    assert scores.concentration_0_100(3) == 24.0
    assert scores.concentration_0_100(4) == 10.0
    assert scores.concentration_0_100(5) == 0.0
    assert scores.concentration_0_100(9) == 0.0


def test_risk_config_renorm_on_disable():
    # Disabling a component redistributes its weight PROPORTIONALLY across the
    # survivors so the effective weights still sum to 1.0. supplyRisk defaults are
    # 0.50 / 0.25 / 0.25; dropping cost_premium (0.25) leaves 0.50 : 0.25 = 2 : 1,
    # renormalized to 2/3 : 1/3.
    sr = copy.deepcopy(risk_config.get_composite("supplyRisk"))
    for c in sr["components"]:
        if c["id"] == "cost_premium":
            c["enabled"] = False
    w = risk_config.resolve_effective_weights(sr)
    assert "cost_premium" not in w
    assert abs(w["supply_concentration"] - 2 / 3) < 1e-9
    assert abs(w["import_friction"] - 1 / 3) < 1e-9
    assert abs(sum(w.values()) - 1.0) < 1e-9


def test_risk_config_all_disabled_raises():
    # Guard: every component disabled -> a clear ValueError that names the composite
    # (never zeros / NaN).
    sr = copy.deepcopy(risk_config.get_composite("supplyRisk"))
    for c in sr["components"]:
        c["enabled"] = False
    try:
        risk_config.resolve_effective_weights(sr)
        assert False, "expected ValueError when all components are disabled"
    except ValueError as e:
        assert "supplyRisk" in str(e)


def test_risk_config_validate_weight_sum():
    # Validation: declared weights not summing to 1.0 -> ValueError naming the
    # composite AND reporting the actual sum (0.7 + 0.4 = 1.1).
    pr = copy.deepcopy(risk_config.get_composite("performanceRisk"))
    pr["components"][0]["weight"] = 0.7
    total = sum(float(c["weight"]) for c in pr["components"])
    try:
        risk_config.validate_composite(pr)
        assert False, "expected ValueError when weights do not sum to 1.0"
    except ValueError as e:
        msg = str(e)
        assert "performanceRisk" in msg
        assert repr(total) in msg  # the actual sum, exactly as the message reports it


def test_risk_config_combine_score_polarity():
    # invertPolarity=True applies the 100-minus (performance risk, higher=safer);
    # invertPolarity=False leaves the penalty as-is (supply risk, higher=riskier).
    assert abs(float(risk_config.combine_score(53.6, True)) - 46.4) < 1e-9
    assert abs(float(risk_config.combine_score(53.6, False)) - 53.6) < 1e-9
    # and it clips to [0, 100] on both ends
    assert float(risk_config.combine_score(120.0, False)) == 100.0
    assert float(risk_config.combine_score(-5.0, False)) == 0.0


def test_roster_category_counts():
    df = pd.DataFrame({
        "supplier_id": ["S1", "S2", "S3", "S4"],
        "category": ["A", "A", "B", "A"],
    })
    assert scores.roster_category_counts(df) == {"A": 3, "B": 1}


def test_composite_handcalc():
    # A fully hand-computed supplier-period through the NEW pipeline (post-overhaul:
    # quality from defect_rate/complaint_rate, no Service, structural risk).
    m = pd.DataFrame([{
        "supplier_id": "SX", "country": "JP", "category": "X",
        "defect_rate_pct": 2.0, "complaint_rate_pct": 10.0,
        "on_time_delivery_pct": 90.0, "avg_lead_time_days": 12.0,
        "three_way_match_pct": 100.0,
    }])
    out = scores.compute_scores(m.copy(), {"X": 3})  # 2 OTHER suppliers -> conc 44
    r = out.iloc[0]
    assert r["quality_score"] == 85.0        # (norm_low(2,0,10)=80 + norm_low(10,0,100)=90)/2
    assert r["delivery_score"] == 85.0       # (90+80)/2
    assert r["process_score"] == 100.0
    assert r["risk_score"] == 46.4           # 100-(0.6*60 + 0.4*44)
    assert r["composite_score"] == 81.35     # 0.30*85+0.30*85+0.22*100+0.18*46.4
    assert "service_score" not in out.columns


def test_window_matches_period():
    """Stage 1 regression: build_window_metrics over a SINGLE calendar year's POs
    reproduces that year's build_period_metrics row BYTE-FOR-BYTE — same
    aggregates, soft, identity, and all 6 scores — for every supplier. Locks zero
    formula drift between the generalized window engine (any filter) and the
    per-period engine, so Stage 2 can compute a live composite for any window."""
    sup, pur = _load_raw()
    roster = scores.roster_category_counts(sup)
    bpm = scores.compute_scores(scores.build_period_metrics(sup, pur), roster)
    # Slice each year's POs by the SAME payment-year (pr fallback) rule that
    # build_period_metrics buckets on.
    pyear = (
        pd.to_datetime(pur["payment_date"], errors="coerce")
        .fillna(pd.to_datetime(pur["pr_date"], errors="coerce"))
        .dt.year
    )
    for year in sorted(int(y) for y in bpm["period"].unique()):
        bwm = scores.build_window_metrics(sup, pur[pyear == year], roster)
        cols = list(bwm.columns)  # window output carries no 'period' column
        assert "period" not in cols
        a = bwm.sort_values("supplier_id").reset_index(drop=True)[cols]
        b = (
            bpm[bpm["period"] == year]
            .sort_values("supplier_id")
            .reset_index(drop=True)[cols]
        )
        assert list(a["supplier_id"]) == list(b["supplier_id"]), f"{year}: supplier set differs"
        assert a.equals(b), f"{year}: window metrics differ from period metrics (formula drift)"


# --------------------------------------------------------------------------- #
# Layer 2 — baseline reproduction
# --------------------------------------------------------------------------- #
def recompute_from_raw() -> pd.DataFrame:
    sup, pur = _load_raw()
    m = scores.build_period_metrics(sup, pur)
    roster = scores.roster_category_counts(sup)
    m = scores.compute_scores(m, roster)
    m["period"] = m["period"].astype(int)
    return m


def _load_baseline():
    if not os.path.exists(BASELINE_CSV):
        return None
    b = pd.read_csv(BASELINE_CSV)
    # The DB dump uses camelCase column names; map them to scores.py's snake_case.
    b = b.rename(columns={
        "supplierExternalId": "supplier_id",
        "qualityScore": "quality_score", "deliveryScore": "delivery_score",
        "serviceScore": "service_score", "processScore": "process_score",
        "riskScore": "risk_score", "compositeScore": "composite_score",
        "numPos": "num_pos", "totalSpendUsd": "total_spend_usd",
    })
    b["period"] = b["period"].astype(int)
    return b


def verify_against_baseline(verbose=True):
    """Returns (ok, report dict). Prints a full report when verbose."""
    base = _load_baseline()
    if base is None:
        if verbose:
            print(f"[skip] baseline CSV not found at {BASELINE_CSV} — set $BASELINE_CSV")
        return None, {"skipped": True}

    rec = recompute_from_raw()

    def p(msg):
        if verbose:
            print(msg)

    p("=" * 70)
    p("BASELINE REPRODUCTION")
    p(f"  baseline rows: {len(base)}  periods: {base.groupby('period')['supplier_id'].nunique().to_dict()}")
    p(f"  recompute rows: {len(rec)}  periods: {rec.groupby('period')['supplier_id'].nunique().to_dict()}")

    # (a) PERIOD-INDEPENDENT scores per supplier (bucketing-independent) -> formula exactness.
    bi = base.drop_duplicates("supplier_id").set_index("supplier_id")
    ri = rec.drop_duplicates("supplier_id").set_index("supplier_id")
    common = sorted(set(bi.index) & set(ri.index))
    indep_mismatch = []
    for sid in common:
        for c in PERIOD_INDEP:
            if round(float(bi.loc[sid, c]), 2) != round(float(ri.loc[sid, c]), 2):
                indep_mismatch.append((sid, c, float(bi.loc[sid, c]), float(ri.loc[sid, c])))
    p(f"\n(a) period-INDEPENDENT scores (quality/service/risk incl. D9), {len(common)} common suppliers:")
    p(f"    mismatches: {len(indep_mismatch)}  ->  {'FORMULAS BIT-EXACT' if not indep_mismatch else 'FORMULA DRIFT!'}")
    for m in indep_mismatch[:20]:
        p(f"      {m}")

    # (b) full per-(supplier,period) join.
    key = ["supplier_id", "period"]
    merged = base.merge(rec, on=key, how="outer", suffixes=("_base", "_rec"), indicator=True)
    both = merged[merged["_merge"] == "both"]
    only_base = merged[merged["_merge"] == "left_only"]
    only_rec = merged[merged["_merge"] == "right_only"]

    exact, mism = [], []
    for _, r in both.iterrows():
        diffs = [c for c in scores.SCORE_COLS
                 if round(float(r[f"{c}_base"]), 2) != round(float(r[f"{c}_rec"]), 2)]
        (exact if not diffs else mism).append((r["supplier_id"], int(r["period"]), diffs, r))

    p(f"\n(b) per-(supplier,period) rows present in BOTH: {len(both)}")
    p(f"    exact 6-score match: {len(exact)}")
    p(f"    differing:           {len(mism)}")

    # every difference must be confined to the period-DEPENDENT scores, and track a PO-set change.
    bad_indep = [(s, per, d) for (s, per, d, _) in mism if any(c in PERIOD_INDEP for c in d)]
    p(f"    differences touching a period-INDEPENDENT score (should be 0): {len(bad_indep)}")
    for (s, per, d) in bad_indep[:20]:
        p(f"      !! {s}@{per} diffs {d}")

    p("\n    differing supplier-periods (all confined to delivery/process/composite):")
    for (s, per, d, r) in mism:
        po_b, po_r = int(r["num_pos_base"]), int(r["num_pos_rec"])
        boundary = "  [BOUNDARY]" if s in KNOWN_BOUNDARY else ""
        p(f"      {s}@{per}: {d}  | num_pos {po_b}->{po_r}{boundary}")

    p(f"\n    rows only in BASELINE (invoice-year, disappeared under payment): {len(only_base)}")
    for _, r in only_base.iterrows():
        p(f"      {r['supplier_id']}@{int(r['period'])}  [BOUNDARY]" if r["supplier_id"] in KNOWN_BOUNDARY
          else f"      {r['supplier_id']}@{int(r['period'])}")
    p(f"    rows only in RECOMPUTE (payment-year, newly appeared): {len(only_rec)}")
    for _, r in only_rec.iterrows():
        p(f"      {r['supplier_id']}@{int(r['period'])}  [BOUNDARY]" if r["supplier_id"] in KNOWN_BOUNDARY
          else f"      {r['supplier_id']}@{int(r['period'])}")

    # Boundary suppliers' period-independent scores still match the baseline (formula right).
    boundary_indep_ok = all(
        sid not in [m[0] for m in indep_mismatch] for sid in KNOWN_BOUNDARY if sid in common
    )
    p(f"\n    boundary suppliers' quality/service/risk still match baseline: {boundary_indep_ok}")

    ok = (len(indep_mismatch) == 0 and len(bad_indep) == 0)
    p("\n" + ("PASS: formulas bit-exact; every per-period diff is pure invoice->payment rebucketing."
             if ok else "FAIL: unexplained differences (formula drift)."))
    p("=" * 70)

    report = {
        "skipped": False,
        "indep_mismatches": len(indep_mismatch),
        "both": len(both), "exact": len(exact), "diff": len(mism),
        "diff_touching_indep": len(bad_indep),
        "only_base": [f"{r['supplier_id']}@{int(r['period'])}" for _, r in only_base.iterrows()],
        "only_rec": [f"{r['supplier_id']}@{int(r['period'])}" for _, r in only_rec.iterrows()],
        "differing": [f"{s}@{per}:{d}" for (s, per, d, _) in mism],
    }
    return ok, report


def test_baseline_reproduction():
    # RETIRED: this anchored scores.py to the captured PRE-OVERHAUL DB baseline
    # (old quality from soft defect/complaint, Service dimension, single_source
    # risk term). The scoring overhaul intentionally changed those formulas, so
    # the old baseline no longer applies. The live regression is now
    # test_window_matches_period (build_window == build_period, filter-live). Left
    # here (skipped) until a fresh post-overhaul baseline is captured.
    return


if __name__ == "__main__":
    # Run pure formula tests
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and name != "test_baseline_reproduction":
            fn()
            print(f"[ok] {name}")
    # Run + print the baseline reproduction report
    verify_against_baseline(verbose=True)

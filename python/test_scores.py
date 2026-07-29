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


def test_formula_evaluator():
    import formula_eval as fe
    E = fe.evaluate_formula

    # arithmetic, precedence, parens, unary, division
    assert E("2 + 3 * 4", {}) == 14.0
    assert E("(2 + 3) * 4", {}) == 20.0
    assert E("-5 + 2", {}) == -3.0
    assert E("10 / 4", {}) == 2.5
    # variables from env
    assert E("a + b * c", {"a": 1, "b": 2, "c": 3}) == 7.0
    assert E("supply_concentration", {"supply_concentration": 44.0}) == 44.0
    assert E("0.5 * a + 0.5 * b", {"a": 60.0, "b": 100.0}) == 80.0
    # whitelisted functions
    assert E("min(a, b, 3)", {"a": 5, "b": 2}) == 2.0
    assert E("max(a, b)", {"a": 5, "b": 2}) == 5.0
    assert E("abs(0 - 7)", {}) == 7.0
    assert E("sqrt(16)", {}) == 4.0

    def rejects(expr, env=None, needle=None):
        try:
            E(expr, env or {})
        except fe.FormulaError as e:
            if needle:
                assert needle in str(e), (expr, str(e))
            return
        assert False, f"expected FormulaError for {expr!r}"

    rejects("", needle="empty")
    rejects("   ")
    rejects("a + 1", needle="unknown variable")            # name not in env
    rejects("1 / 0", needle="division by zero")
    rejects("x / y", {"x": 1, "y": 0}, needle="division by zero")
    rejects("sqrt(0 - 1)", needle="sqrt of a negative")
    rejects("1e308 * 10", needle="non-finite")             # overflow -> inf
    # default-deny: anything outside the whitelist is rejected by construction
    rejects("a.b", {"a": 1})                                # attribute access
    rejects("a[0]", {"a": 1})                               # subscript
    rejects("a < b", {"a": 1, "b": 2})                      # comparison
    rejects("a and b", {"a": 1, "b": 1})                    # boolean op
    rejects("pow(2, 3)")                                    # non-whitelisted call
    rejects("(lambda: 1)()")                                # lambda
    rejects("True", needle="numeric")                       # bool literal

    # reserved function names may not be variable ids (requirement #2)
    assert all(fe.is_reserved_name(n) for n in ("min", "max", "abs", "sqrt"))
    assert not fe.is_reserved_name("supply_concentration")

    # normalize_to_bounds: (0,100) is a BIT-EXACT identity (scale 1.0), for the re-expression gate
    for v in (0.0, 10.0, 24.0, 44.0, 62.5, 100.0, 37.837291):
        assert fe.normalize_to_bounds(v, 0, 100) == v, v
    assert fe.normalize_to_bounds(150.0, 0, 100) == 100.0   # clamp high
    assert fe.normalize_to_bounds(-5.0, 0, 100) == 0.0      # clamp low
    assert abs(fe.normalize_to_bounds(30.0, 0, 60) - 50.0) < 1e-9  # scaled bounds
    try:
        fe.normalize_to_bounds(1.0, 5, 5)                   # degenerate bounds
        assert False, "expected FormulaError for hi <= lo"
    except fe.FormulaError:
        pass


def test_evaluate_composite_order():
    # GUARD 2: evaluate_composite must iterate components in DECLARED config order, because float
    # addition is not associative and a reorder would drift the md5 with no obvious cause. The
    # contributions dict preserves insertion order, so it witnesses the iteration order — a
    # future refactor to a dict comprehension / sorted / set would flip it and fail here.
    composite = {
        "id": "t", "invertPolarity": False,
        "components": [
            {"id": "zeta", "formula": "zeta", "bounds": {"lo": 0, "hi": 100}, "enabled": True, "weight": 0.5},
            {"id": "alpha", "formula": "alpha", "bounds": {"lo": 0, "hi": 100}, "enabled": True, "weight": 0.5},
        ],
    }
    score, contributions = risk_config.evaluate_composite(composite, {"zeta": 40.0, "alpha": 60.0})
    assert list(contributions.keys()) == ["zeta", "alpha"], list(contributions.keys())
    assert abs(score - 50.0) < 1e-9, score


def test_variable_validation():
    import copy
    base = risk_config.load_risk_model()
    risk_config.validate_variables(base)  # the shipped config is valid

    def rejects(mutate, needle):
        m = copy.deepcopy(base)
        mutate(m)
        try:
            risk_config.validate_variables(m)
            assert False, f"expected ValueError ({needle})"
        except ValueError as e:
            assert needle in str(e), (needle, str(e))

    # a variable id may not shadow a reserved function name
    rejects(lambda m: m["variables"].__setitem__("max", {"kind": "computed", "default": 0.0}), "reserved")
    # the concentration one-signal invariant: the two must share (table, key)
    rejects(lambda m: m["variables"]["roster_concentration"].__setitem__("table", "country_distance"), "SAME")
    # a formula may only reference known variables
    def break_ref(m):
        for c in m["composites"]:
            if c["id"] == "supplyRisk":
                c["components"][0]["formula"] = "nonexistent_var"
    rejects(break_ref, "unknown variable")
    # (Prerequisite P dropped component.lookupTable; table references now derive from
    # formula -> variables -> table, so there is no lookupTable/formula check to exercise.)
    # Stage E: an aggregate variable needs a valid agg (risk_config.AGG_FUNCS).
    rejects(
        lambda m: m["variables"].__setitem__(
            "bad_agg", {"kind": "aggregate", "source": "quantity", "agg": "nope", "default": 0.0}),
        "agg",
    )

    # Stage F: a formula may not reference a LOCKED variable (a measured-dead field).
    def break_locked(m):
        for c in m["composites"]:
            if c["id"] == "supplyRisk":
                c["components"][0]["formula"] = "supply_concentration + cycle_time_cv"
    rejects(break_locked, "LOCKED")


def test_aggregate_resolver():
    # Stage E: the generic aggregate resolver reproduces the operational aggregates from a
    # snake_case PO frame, and build_aggregate_maps builds ONLY the aggregate variables in the
    # referenced set (lookups/computed resolved elsewhere).
    pur = pd.DataFrame({
        "supplier_id": ["A", "A", "B"],
        "on_time_delivery": [True, False, True],
        "po_to_delivery_days": [10.0, 20.0, 30.0],
        "total_cycle_days": [40.0, 60.0, 80.0],
        "three_way_match_pass": [True, True, False],
        "complaint_count": [0, 1, 2],
        "defect_count": [2, 0, 5],
        "quantity": [50.0, 50.0, 100.0],
        "total_value_usd": [100.0, 300.0, 600.0],
    })

    def agg(src, a, grand=0.0):
        return scores.build_aggregate_map(pur, src, a, grand)

    assert agg("on_time_delivery", "rate_pct") == {"A": 50.0, "B": 100.0}
    assert agg("po_to_delivery_days", "mean") == {"A": 15.0, "B": 30.0}
    assert agg("total_cycle_days", "mean") == {"A": 50.0, "B": 80.0}
    assert agg("three_way_match_pass", "rate_pct") == {"A": 100.0, "B": 0.0}
    assert agg("complaint_count", "share_ge1_pct") == {"A": 50.0, "B": 100.0}
    assert agg("defect_count", "defect_ratio_pct") == {"A": 2.0, "B": 5.0}  # 2/100, 5/100 x100
    assert agg("total_value_usd", "spend_share_pct", 1000.0) == {"A": 40.0, "B": 60.0}

    maps = scores.build_aggregate_maps(
        pur, {"on_time_rate", "country_distance"},
        {"on_time_rate": {"kind": "aggregate", "source": "on_time_delivery", "agg": "rate_pct"},
         "country_distance": {"kind": "lookup"}},
    )
    assert set(maps) == {"on_time_rate"}  # only the aggregate id is built


def test_cost_premium_partition():
    # Stage G: the general partition path reproduces the byte-identical default; thresholds +
    # below-minimum behaviour respond to config. Pure (synthetic frames, no DB).
    import compute_analyses as ca
    pur = pd.DataFrame({
        "supplierExternalId": ["A", "A", "B", "B", "C"],
        "itemName": ["x", "x", "x", "x", "y"],
        "unitPriceUsd": [100.0, 110.0, 90.0, 95.0, 50.0],
        "quantity": [10.0, 10.0, 10.0, 10.0, 10.0],
    })
    default = ca._cost_premium_default(pur)
    general = ca._cost_premium_general(pur, dict(ca._COST_PREMIUM_DEFAULTS))
    assert default == general, (default, general)
    # item x has 2 suppliers (A, B); raising minGroupMembers to 3 makes it non-benchmarkable.
    g3 = ca._cost_premium_general(pur, {**ca._COST_PREMIUM_DEFAULTS, "minGroupMembers": 3})
    assert "A" not in g3 and "B" not in g3, g3
    # raising minPosPerSupplierItem to 3 drops A/B (each has 2 POs of item x).
    g_pos = ca._cost_premium_general(pur, {**ca._COST_PREMIUM_DEFAULTS, "minPosPerSupplierItem": 3})
    assert "A" not in g_pos and "B" not in g_pos, g_pos
    # 'mean' benchmark is a different statistic than the default 'spend_weighted_mean'.
    g_mean = ca._cost_premium_general(pur, {**ca._COST_PREMIUM_DEFAULTS, "benchmarkStat": "mean"})
    assert isinstance(g_mean, dict)


def test_builtin_input_block():
    # Stage E structural double-count block, graph-derived. The shipped config passes;
    # a builtin-input variable in performanceRisk is rejected; the same in supplyRisk is
    # allowed; a non-builtin behavioural variable in performanceRisk is allowed.
    base = risk_config.load_risk_model()
    risk_config.validate_builtin_input_block(base)  # shipped config: no block

    def perf_risk_formula(model, formula):
        m = copy.deepcopy(model)
        for c in m["composites"]:
            if c["id"] == "performanceRisk":
                c["components"][0]["formula"] = formula
        return m

    # on_time_rate feeds delivery_score -> BLOCKED in performanceRisk (produces risk_score)
    try:
        risk_config.validate_builtin_input_block(
            perf_risk_formula(base, "country_distance + on_time_rate"))
        assert False, "expected a block for a builtin-input variable in performanceRisk"
    except ValueError as e:
        assert "BLOCKED" in str(e) and "on_time_rate" in str(e), str(e)

    # cycle_time has no feedsBuiltin -> allowed in performanceRisk
    risk_config.validate_builtin_input_block(perf_risk_formula(base, "country_distance + cycle_time"))

    # the same builtin-input variable in supplyRisk (produces no builtin) -> allowed
    m2 = copy.deepcopy(base)
    for c in m2["composites"]:
        if c["id"] == "supplyRisk":
            c["components"][0]["formula"] = "supply_concentration + on_time_rate"
    risk_config.validate_builtin_input_block(m2)

    # DIRECT SIBLING case (the performanceComposite prerequisite): a FORMULA component added
    # to performanceComposite that references a builtin-input variable double-counts the builtin
    # sitting DIRECTLY alongside it — the same guard, the other case.
    def add_pc_formula(model, formula):
        m = copy.deepcopy(model)
        for c in m["composites"]:
            if c["id"] == "performanceComposite":
                c["components"].append({
                    "id": "custom_x", "formula": formula, "bounds": {"lo": 0, "hi": 100},
                    "enabled": True, "weight": 0.1})
        return m

    # on_time_rate feeds delivery_score, a builtin IN performanceComposite -> BLOCKED (direct)
    try:
        risk_config.validate_builtin_input_block(add_pc_formula(base, "on_time_rate"))
        assert False, "expected a DIRECT-sibling block for a builtin-input variable in performanceComposite"
    except ValueError as e:
        assert "BLOCKED" in str(e) and "on_time_rate" in str(e), str(e)

    # cost_premium has no feedsBuiltin -> allowed as a performanceComposite formula component
    risk_config.validate_builtin_input_block(add_pc_formula(base, "cost_premium"))


def test_lookup_table_validation():
    # The default config's three tables are valid (load_risk_model already validated
    # them, but re-assert directly).
    m = risk_config.load_risk_model()
    assert set(m["lookupTables"]) == {"concentration_curve", "country_distance", "import_friction"}
    for tid, table in m["lookupTables"].items():
        risk_config.validate_lookup_table(tid, table)  # must not raise

    # count table: keys must be CONTIGUOUS from 0 (a gap would fall through to default).
    try:
        risk_config.validate_lookup_table("t", {
            "input": "count", "default": 0.0,
            "rows": [{"key": 0, "value": 100.0}, {"key": 1, "value": 70.0}, {"key": 3, "value": 24.0}],
        })
        assert False, "expected a contiguity error for a count-key gap"
    except ValueError as e:
        assert "contiguous" in str(e)

    # country table: members must be DISJOINT across rows (case-insensitively).
    try:
        risk_config.validate_lookup_table("t", {
            "input": "country", "default": 100.0,
            "rows": [{"key": "a", "value": 0.0, "members": ["ID"]},
                     {"key": "b", "value": 30.0, "members": ["id"]}],
        })
        assert False, "expected a disjointness error for an overlapping member"
    except ValueError as e:
        assert "disjoint" in str(e)

    # values (rows + default) must be in [0,100].
    try:
        risk_config.validate_lookup_table("t", {
            "input": "count", "default": 0.0, "rows": [{"key": 0, "value": 150.0}]})
        assert False, "expected a range error"
    except ValueError as e:
        assert "outside [0,100]" in str(e)

    # a REQUIRED explicit default.
    try:
        risk_config.validate_lookup_table("t", {"input": "count", "rows": [{"key": 0, "value": 0.0}]})
        assert False, "expected a missing-default error"
    except ValueError as e:
        assert "default" in str(e)


def test_sensitivity_shape_and_gate():
    """python/sensitivity.py is LOAD-BEARING — the save path (phase 2) invokes it. Lock its
    output SHAPE and the published DEFAULT-config figures BY NAME, so a refactor that silently
    changes what it emits fails here instead of quietly re-publishing different numbers on the
    Methodology page. Skips gracefully when no DB / scipy is reachable (the pure tests above
    need neither); the assertions require the config to be at its shipped defaults."""
    try:
        import psycopg2
        import compute_analyses as ca
        import sensitivity
        sensitivity._ensure_database_url()
        ca.load_env()
        conn = psycopg2.connect(ca.get_dsn())
    except Exception as e:  # noqa: BLE001 — no DB/scipy here: skip, don't fail the suite
        print(f"[skip] test_sensitivity_shape_and_gate: unavailable ({type(e).__name__})")
        return

    try:
        conn.set_session(readonly=True)
        data = sensitivity.compute_sensitivity(conn)
    finally:
        conn.close()

    # --- output shape ---
    assert data["schema"] == 1, data.get("schema")
    by_label = {w["label"]: w for w in data["windows"]}
    assert set(by_label) == {"2024", "2025", "2026", "RANGE"}, sorted(by_label)
    for w in data["windows"]:
        assert {d["dropped"] for d in w["composite"]} == {
            "quality_score", "delivery_score", "process_score", "risk_score"}
        assert {d["dropped"] for d in w["supplyRisk"]} == {
            "supply_concentration", "cost_premium", "import_friction"}
        assert {d["dropped"] for d in w["performanceRisk"]} == {
            "country_distance", "roster_concentration"}
        for group in ("composite", "supplyRisk", "performanceRisk"):
            for d in w[group]:
                assert "rho" in d and "n" in d, (group, d)

    # --- named-dimension gate at DEFAULT config (RANGE), asserted BY NAME, never positionally ---
    rng = by_label["RANGE"]
    comp_rho = {d["dropped"]: round(d["rho"], 2) for d in rng["composite"]}
    assert comp_rho == {
        "quality_score": 0.97, "delivery_score": 0.86,
        "process_score": 0.94, "risk_score": 0.72}, comp_rho
    comp_zone = {d["dropped"]: round(d["zone_pct"], 1) for d in rng["composite"]}
    assert comp_zone == {
        "quality_score": 3.6, "delivery_score": 10.9,
        "process_score": 7.3, "risk_score": 36.4}, comp_zone
    sr_rho = {d["dropped"]: round(d["rho"], 2) for d in rng["supplyRisk"]}
    assert sr_rho == {
        "supply_concentration": 0.84, "cost_premium": 0.92,
        "import_friction": 0.81}, sr_rho


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

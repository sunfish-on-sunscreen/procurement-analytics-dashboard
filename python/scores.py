"""Shared, pure supplier-score computation (Stage 1 of the backend-scoring rebuild).

This module is the SINGLE SOURCE OF TRUTH for the derived supplier scores. The
formulas were extracted VERBATIM from ``scripts/transform_dataset.py`` (which now
imports them from here) so the offline transformer and the future server-side
import path compute identical values.

Everything here is PURE and deterministic — functions take DataFrames / dicts in
and return computed values out. No file I/O, no DB, no ``rng``. Fixed industry
bounds (not population min/max) so scores are stable when data changes.

Derived fields (per active supplier-period/window). defect_rate + complaint_rate
are aggregated from per-PO defect_count / complaint_count over the filtered POs:
  defect_rate_pct    = sum(defect_count) / sum(quantity) * 100   (quantity-based)
  complaint_rate_pct = orders_with_complaint / num_pos * 100     (per-order, 0-100)
  quality  = mean(norm_low(defect_rate_pct,0,10), norm_low(complaint_rate_pct,0,100))
  delivery = mean(norm_high(otd_pct,0,100), norm_low(avg_lead_time,0,60))
  process  = norm_high(three_way_match_pct,0,100)
  risk     = 100 - (0.6*country_distance + 0.4*concentration_0_100(roster))  [structural]
  composite = 0.30*quality + 0.30*delivery + 0.22*process + 0.18*risk
The Service dimension and single_source_risk were removed. All rounded to 2 dp.
"""

import numpy as np
import pandas as pd

import risk_config  # config/risk-model.json weights: performanceRisk + performanceComposite
import formula_eval  # the whitelisted formula evaluator (Stage D)

# Composite weights now live in config/risk-model.json (the `performanceComposite`
# composite). This module-level dict is DERIVED from that config so the offline
# re-export (scripts/transform_dataset re-exports scores.WEIGHTS) keeps working and can
# never drift from the authoritative weights. It is NOT the compute source of truth:
# compute_scores reads the composite FRESH from risk_config on every call (mirroring the
# risk sub-score), so a settings-UI edit or a sensitivity-run monkeypatch of
# risk_config.get_composite takes effect without touching this snapshot.
WEIGHTS = risk_config.resolve_effective_weights(
    risk_config.get_composite("performanceComposite")
)

SCORE_COLS = [
    "quality_score", "delivery_score",
    "process_score", "risk_score", "composite_score",
]

# Identity carried CONSTANT across a supplier's periods (from the SupplierMetrics
# sheet); the purchase-derived inputs are recomputed per period/window. There are
# no soft-survey columns any more — quality now comes from per-PO defect_count /
# complaint_count (aggregated over the filtered POs), and the Service dimension +
# single_source_risk were removed.
IDENTITY_COLS = [
    "supplier_id", "supplier_name", "country", "category",
]
SOFT_COLS = []


# --- Score helpers (methodology rebuild) ---------------------------------- #
# Geographic supply distance + roster concentration were coarse hardcoded lookups
# here; Stage A moved them into config/risk-model.json (lookupTables) and these thin
# wrappers now delegate to the ONE loader, python/risk_config.py — so scores.py and
# compute_analyses.py read the SAME tables (no second load path). The country tiers
# (0 = domestic … 100 = far; India in Asia-Pacific by geography) live in the
# `country_distance` table; its trade-bloc counterpart is the SEPARATE `import_friction`
# table in compute_analyses.py — deliberately different scales (India is 60 here, 100
# there). Signatures unchanged, so every call site (incl. transform_dataset's re-export)
# is untouched.
def country_distance_score(code: str) -> float:
    """Geographic supply-distance tier (config lookupTables.country_distance)."""
    return risk_config.lookup_country("country_distance", code)


# Roster-based supply concentration (D9-note): the SAME `concentration_curve` the
# Kraljic supply-risk term reads (compute_supply_risk), so composite and Kraljic share
# ONE signal. The config stores the already-doubled 0-100 axis {0:100, 1:70, 2:44,
# 3:24, 4:10, >=5:0}; the old `_CONC_POINTS * 2` fold is baked into the stored values,
# bit-identical (every product is an exact integer-valued double). 0 alternatives (true
# single source) -> 100, >=5 -> 0; the middle is graded.
def concentration_0_100(other_in_category: int) -> float:
    """Roster-based supply concentration on the composite's 0-100 axis
    (config lookupTables.concentration_curve)."""
    return risk_config.lookup_numeric("concentration_curve", int(other_in_category))


# Fixed-bound min-max normalization, clamped to [0,100] so inputs outside the
# documented bounds can't produce negative or >100 scores (Decision B/D).
def norm_high(value: float, lo: float, hi: float) -> float:
    """Higher input → higher score."""
    return float(np.clip((float(value) - lo) / (hi - lo), 0.0, 1.0) * 100.0)


def norm_low(value: float, lo: float, hi: float) -> float:
    """Lower input → higher score."""
    return float(np.clip((hi - float(value)) / (hi - lo), 0.0, 1.0) * 100.0)


def roster_category_counts(suppliers: pd.DataFrame) -> dict:
    """Full-roster supplier count per category (all known suppliers, active or
    not) from the Suppliers master sheet — the roster basis A1 (Kraljic) and the
    D9 composite concentration term share. `suppliers` must carry `category` +
    `supplier_id`."""
    counts = suppliers.groupby("category")["supplier_id"].nunique().to_dict()
    return {str(k): int(v) for k, v in counts.items()}


def _aggregate_purchase_group(g: pd.DataFrame) -> dict:
    """Purchase-derived operational aggregates over ONE group of POs (snake_case
    columns). The SINGLE definition of these formulas, shared by
    build_period_metrics (grouped by supplier-period) and build_window_metrics
    (grouped by supplier over an arbitrary filtered window) — so the window
    aggregation can never drift from the per-period one. Returned in the stable
    column order both builders rely on."""
    npos = int(len(g))
    spend = float(g["total_value_usd"].sum())
    qty = float(g["quantity"].sum())
    defects = float(g["defect_count"].sum())
    complaint_orders = int((g["complaint_count"] >= 1).sum())
    return {
        "total_spend_usd": round(spend, 2),
        "num_pos": npos,
        "avg_po_value_usd": round(spend / npos, 2) if npos else 0.0,
        "avg_lead_time_days": round(float(g["po_to_delivery_days"].mean()), 2),
        "avg_cycle_time_days": round(float(g["total_cycle_days"].mean()), 2),
        "on_time_delivery_pct": round(float(g["on_time_delivery"].mean()) * 100, 2),
        "three_way_match_pct": round(float(g["three_way_match_pass"].mean()) * 100, 2),
        # Quality inputs, aggregated over the PO group (filter-live like delivery/
        # process). defect_rate = defective units / units ordered (quantity-based);
        # complaint_rate = share of orders with >=1 complaint (per-order, 0-100%).
        "defect_rate_pct": round((defects / qty) * 100, 2) if qty > 0 else 0.0,
        "complaint_rate_pct": round((complaint_orders / npos) * 100, 2) if npos else 0.0,
    }


def build_period_metrics(metrics: pd.DataFrame, purchases: pd.DataFrame) -> pd.DataFrame:
    """Expand the per-supplier snapshot into one row per active supplier-period.

    Purchase-derived inputs are re-aggregated per period (payment-year, with a
    pr_date fallback — mirrors the import route's period tag); soft + identity
    inputs are carried constant from the supplier's snapshot row. Aggregation
    formulas reproduce the snapshot definitions exactly, so summing across all
    of a supplier's periods reconciles with the original snapshot."""
    soft_by_sid = metrics.set_index("supplier_id")

    pu = purchases.copy()
    pay = pd.to_datetime(pu["payment_date"], errors="coerce")
    pr = pd.to_datetime(pu["pr_date"], errors="coerce")
    pu["period"] = pay.fillna(pr).dt.year.astype("Int64")

    rows = []
    for (sid, year), g in pu.groupby(["supplier_id", "period"], sort=True):
        if pd.isna(sid) or pd.isna(year) or sid not in soft_by_sid.index:
            continue  # purchase with no matching supplier metric — skip
        snap = soft_by_sid.loc[sid]  # supplier_id is now the index, not a column
        row = {"supplier_id": sid}
        for c in IDENTITY_COLS:
            if c != "supplier_id":
                row[c] = snap[c]
        row["period"] = int(year)
        row.update(_aggregate_purchase_group(g))  # shared aggregation formulas
        for c in SOFT_COLS:
            row[c] = snap[c]
        rows.append(row)

    return pd.DataFrame(rows)


def compute_scores(m: pd.DataFrame, roster_cat_counts: dict, agg_maps: dict = None) -> pd.DataFrame:
    """Add the five derived score columns IN PLACE-ish (returns m). Fixed bounds;
    fully deterministic. `roster_cat_counts` = category -> full-roster supplier
    count (all known suppliers, active or not), used for the roster-based
    concentration term in risk_score. `agg_maps` (Stage E) = {var_id -> {supplier_id ->
    float}} for any AGGREGATE variable the performanceRisk formula references; None/{} for
    the shipped config (which references only lookups), so the default path is unchanged.

    Quality now comes from the per-PO-derived defect_rate_pct + complaint_rate_pct;
    the Service dimension was removed; risk is PURELY STRUCTURAL (country distance +
    roster concentration, no performance/complaint term)."""
    m["quality_score"] = np.round([
        (norm_low(r["defect_rate_pct"], 0, 10) + norm_low(r["complaint_rate_pct"], 0, 100)) / 2
        for _, r in m.iterrows()
    ], 2)
    m["delivery_score"] = np.round([
        (norm_high(r["on_time_delivery_pct"], 0, 100) + norm_low(r["avg_lead_time_days"], 0, 60)) / 2
        for _, r in m.iterrows()
    ], 2)
    m["process_score"] = np.round([
        norm_high(r["three_way_match_pct"], 0, 100) for _, r in m.iterrows()
    ], 2)
    # performanceRisk weights + polarity come from config/risk-model.json. Structural
    # only — country distance + roster concentration, both already normalized to 0-100.
    # invertPolarity=true applies the 100-minus (higher = safer). With both components
    # enabled and 0.6 + 0.4 == 1.0, resolve_effective_weights divides by exactly 1.0 (a
    # bit-for-bit no-op), so this reproduces 100 - (0.6*country + 0.4*concentration).
    _cfg = risk_config.get_composite("performanceRisk")
    # The variables the enabled formulas reference (single-atom today): country_distance keys on
    # the supplier country, roster_concentration on the roster other-in-category count — both via
    # their lookup tables. Byte-identical to the old 100 - (0.6*country + 0.4*concentration):
    # single-atom formulas + (0,100) bounds make normalize_to_bounds a x1.0 identity,
    # evaluate_composite sums in declared component order, and combine_score applies
    # invertPolarity=true (the 100-minus).
    _referenced = set()
    for _comp in _cfg["components"]:
        if _comp.get("enabled", True):
            _referenced |= formula_eval.referenced_names(_comp["formula"])
    new_risk = []
    for _, r in m.iterrows():
        cat = str(r.get("category", ""))
        other = max(0, int(roster_cat_counts.get(cat, 1)) - 1)
        key_values = {
            "supplier_id": r.get("supplier_id", ""),
            "country": r.get("country", ""),
            "roster_other_count": other,
        }
        env = risk_config.resolve_env(_referenced, key_values, agg_maps or {})
        score, _contrib = risk_config.evaluate_composite(_cfg, env)
        new_risk.append(score)
    m["risk_score"] = np.round(new_risk, 2)
    # Composite weights + polarity come from config (performanceComposite), through the
    # SAME shared resolve_effective_weights + combine_score the risk composites use — no
    # second renormalization path. Read fresh each call so a config edit / sensitivity
    # monkeypatch of risk_config.get_composite takes effect. With all four enabled and
    # 0.30 + 0.30 + 0.22 + 0.18 == 1.0 exactly (verified), the divisor is 1.0 and
    # invertPolarity=false makes combine_score a clip-only no-op, so this reproduces the
    # old raw-weight sum bit-for-bit. The _pw iteration order is the config component
    # order (quality/delivery/process/risk), matching the old WEIGHTS dict order.
    _pc = risk_config.get_composite("performanceComposite")
    _pw = risk_config.resolve_effective_weights(_pc)
    _pinvert = risk_config.invert_polarity(_pc)
    _composite = sum(m[col] * _pw[col] for col in _pw)
    m["composite_score"] = np.round(risk_config.combine_score(_composite, _pinvert), 2)
    return m


# camelCase (DB "Purchase") -> snake_case (engine) column names. compute_analyses
# loads Purchase via SELECT * (camelCase); a Stage-2 caller normalizes the frame
# with rename_purchase_columns() before calling build_window_metrics, so the
# engine stays snake_case-only (one boundary, not renames scattered everywhere).
_PURCHASE_CAMEL_TO_SNAKE = {
    "supplierExternalId": "supplier_id",
    "totalValueUsd": "total_value_usd",
    "poToDeliveryDays": "po_to_delivery_days",
    "totalCycleDays": "total_cycle_days",
    "onTimeDelivery": "on_time_delivery",
    "threeWayMatchPass": "three_way_match_pass",
    "defectCount": "defect_count",
    "complaintCount": "complaint_count",
    "paymentDate": "payment_date",
    "prDate": "pr_date",
    # (`quantity` is already snake-safe — same name in DB and engine.)
}


def rename_purchase_columns(purchases: pd.DataFrame) -> pd.DataFrame:
    """Normalize a DB (camelCase) Purchase frame to the snake_case columns the
    score engine reads. `rename` ignores absent keys, so this is a safe no-op on
    an already-snake_case frame (e.g. the raw-xlsx path). The single camel/snake
    boundary adapter — keeps build_window_metrics / build_period_metrics
    snake_case-only."""
    return purchases.rename(columns=_PURCHASE_CAMEL_TO_SNAKE)


# --------------------------------------------------------------------------- #
# Aggregate variable resolver (Stage E). A catalogue `aggregate` variable declares a
# `source` (snake_case PO column) + an `agg`; this GENERIC resolver produces its
# {supplier_id -> float} map from the window's PO frame — so adding an aggregate variable
# to the catalogue is a CONFIG edit, never a new resolver. The evaluator never sees a PO
# row (Stage D contract): the map is built here and injected into env via resolve_env.
# INERT until a formula references the variable: build_aggregate_maps only builds maps for
# ids in the `referenced` set, and no shipped formula references an aggregate variable, so
# the scoring path is byte-identical (harness md5 unchanged).
_AGG_FUNCS = risk_config.AGG_FUNCS  # single source of the allowed aggregations


def build_aggregate_map(purchases: pd.DataFrame, source: str, agg: str,
                        grand_spend: float = 0.0) -> dict:
    """One aggregate variable's {supplier_id -> float} over a snake_case PO frame grouped
    by supplier. `mean` = column mean; `rate_pct` = boolean-column share x100; `share_ge1_pct`
    = share of POs with source>=1 x100; `defect_ratio_pct` = sum(defect_count)/sum(quantity)x100
    (source ignored — the ratio is fixed); `spend_share_pct` = supplier spend / portfolio spend
    x100. No rounding — the composite rounds once at the end."""
    g = purchases.groupby("supplier_id", sort=True)
    if agg == "mean":
        s = g[source].mean()
    elif agg == "rate_pct":
        s = g[source].mean() * 100.0
    elif agg == "share_ge1_pct":
        s = g[source].apply(lambda x: float((x >= 1).mean())) * 100.0
    elif agg == "defect_ratio_pct":
        def _ratio(x):
            q = float(x["quantity"].sum())
            return (float(x["defect_count"].sum()) / q * 100.0) if q > 0 else 0.0
        s = g.apply(_ratio)
    elif agg == "spend_share_pct":
        denom = grand_spend if grand_spend else 1.0
        s = g[source].sum() / denom * 100.0
    else:
        raise ValueError(f"unknown aggregate agg {agg!r} (allowed: {_AGG_FUNCS})")
    return {str(k): float(v) for k, v in s.items()}


def build_aggregate_maps(purchases: pd.DataFrame, referenced_ids, variables: dict) -> dict:
    """Build the {supplier_id -> float} maps for the AGGREGATE variables in `referenced_ids`
    (lookups + computed are resolved elsewhere). Empty when no aggregate variable is
    referenced — the shipped-config case, so this is a no-op on the default scoring path."""
    if not len(purchases):
        return {}
    grand = float(purchases["total_value_usd"].sum())
    maps = {}
    for vid in referenced_ids:
        var = variables.get(vid)
        if var and var.get("kind") == "aggregate":
            maps[vid] = build_aggregate_map(purchases, var.get("source"), var["agg"], grand)
    return maps


def _performance_risk_aggregate_maps(purchases: pd.DataFrame) -> dict:
    """Aggregate maps for the AGGREGATE variables the performanceRisk formula references,
    built from this window's (snake_case) PO frame. Empty for the shipped config (its
    performanceRisk references only lookup variables)."""
    cfg = risk_config.get_composite("performanceRisk")
    referenced = set()
    for comp in cfg["components"]:
        if comp.get("enabled", True):
            referenced |= formula_eval.referenced_names(comp["formula"])
    return build_aggregate_maps(purchases, referenced, risk_config.get_variables())


def build_window_metrics(
    metrics: pd.DataFrame, purchases: pd.DataFrame, roster_cat_counts: dict
) -> pd.DataFrame:
    """Per-supplier SCORED metrics aggregated over the ENTIRE passed-in purchase
    set — i.e. build_period_metrics with the period dimension collapsed to
    whatever window the caller has already filtered `purchases` to (a single
    year, a range, any filter). The purchase-derived inputs (delivery / process /
    spend) re-aggregate over those POs via the SHARED _aggregate_purchase_group;
    soft + identity inputs are carried constant from `metrics`; then
    compute_scores produces the 6 scores.

    There is no `period` column — the window IS the period. Because the
    aggregation and scoring reuse the exact same code build_period_metrics uses, a
    SINGLE-YEAR window reproduces that year's build_period_metrics row
    byte-for-byte (locked in test_scores). `metrics` / `purchases` are snake_case;
    DB (camelCase) callers pass purchases through rename_purchase_columns() first.
    """
    soft_by_sid = metrics.set_index("supplier_id")
    rows = []
    for sid, g in purchases.groupby("supplier_id", sort=True):
        if pd.isna(sid) or sid not in soft_by_sid.index:
            continue  # purchase with no matching supplier metric — skip
        snap = soft_by_sid.loc[sid]
        row = {"supplier_id": sid}
        for c in IDENTITY_COLS:
            if c != "supplier_id":
                row[c] = snap[c]
        row.update(_aggregate_purchase_group(g))  # shared aggregation formulas
        for c in SOFT_COLS:
            row[c] = snap[c]
        rows.append(row)

    # Stage E: aggregate maps for any AGGREGATE variable performanceRisk references, built
    # from THIS window's PO frame (empty for the shipped config). Passed to compute_scores so
    # risk_score can read a behavioural field if a formula composes one.
    agg_maps = _performance_risk_aggregate_maps(purchases)
    return compute_scores(pd.DataFrame(rows), roster_cat_counts, agg_maps)

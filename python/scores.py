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

import risk_config  # config/risk-model.json weights for the performanceRisk composite

# Composite weights (Batch 3a spec).
WEIGHTS = {
    "quality_score": 0.30,
    "delivery_score": 0.30,
    "process_score": 0.22,
    "risk_score": 0.18,
}

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
# Geographic supply risk, coarse tiers 0 (safest) … 100 (riskiest) (Decision C).
# The ASEAN tier lists ALL nine non-Indonesian ASEAN members (was missing BN/MM/LA/KH),
# and NZ joins the Asia-Pacific tier alongside AU (was scoring 100). India stays in
# Asia-Pacific — it is geographically Asia-Pacific; its RCEP exit (2019) only affects
# import_friction's trade-bloc list, which is a separate, deliberately different scale.
def country_distance_score(code: str) -> float:
    c = str(code).strip().upper()
    if c in ("ID", "INDONESIA"):
        return 0.0
    if c in ("SG", "MY", "TH", "VN", "PH", "BN", "MM", "LA", "KH"):  # ASEAN regional
        return 30.0
    if c in ("CN", "JP", "KR", "AU", "NZ", "IN"):  # Asia-Pacific
        return 60.0
    return 100.0  # other international


# Roster-based supply concentration (D9-note). This MIRRORS the Kraljic
# supply-risk `_CONC` step curve in python/compute_analyses.py
# (compute_supply_risk): points on the # of OTHER suppliers in the same category
# across the FULL roster (all known suppliers, active or not). There it maxes at
# 50 (single source); here the composite's risk_score concentration term lives on
# a 0-100 axis (it replaces the old single_source_risk*100 term), so we scale the
# same curve x2. Endpoints reconcile with the old flag: 0 alternatives (true
# single source) -> 100 (== old single_source_risk=1), >=5 alternatives -> 0
# (== old single_source_risk=0); the middle is now graded instead of binary, and
# it uses the SAME roster signal Kraljic uses so composite and Kraljic agree.
_CONC_POINTS = {0: 50.0, 1: 35.0, 2: 22.0, 3: 12.0, 4: 5.0}


def concentration_0_100(other_in_category: int) -> float:
    """Roster-based supply concentration on the composite's 0-100 axis."""
    return _CONC_POINTS.get(int(other_in_category), 0.0) * 2.0


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


def compute_scores(m: pd.DataFrame, roster_cat_counts: dict) -> pd.DataFrame:
    """Add the five derived score columns IN PLACE-ish (returns m). Fixed bounds;
    fully deterministic. `roster_cat_counts` = category -> full-roster supplier
    count (all known suppliers, active or not), used for the roster-based
    concentration term in risk_score.

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
    _w = risk_config.resolve_effective_weights(_cfg)  # THE shared renorm; guards all-disabled
    _invert = risk_config.invert_polarity(_cfg)
    new_risk = []
    for _, r in m.iterrows():
        country = country_distance_score(r.get("country", ""))
        # Roster-based concentration (same signal Kraljic uses): count OTHER
        # suppliers in the same category across the FULL roster; single-source
        # (0 others) -> 100.
        cat = str(r.get("category", ""))
        other_in_category = max(0, int(roster_cat_counts.get(cat, 1)) - 1)
        concentration = concentration_0_100(other_in_category)
        penalty = (
            _w.get("country_distance", 0.0) * country
            + _w.get("roster_concentration", 0.0) * concentration
        )
        new_risk.append(float(risk_config.combine_score(penalty, _invert)))
    m["risk_score"] = np.round(new_risk, 2)
    m["composite_score"] = np.round(
        sum(m[col] * w for col, w in WEIGHTS.items()), 2
    )
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

    return compute_scores(pd.DataFrame(rows), roster_cat_counts)

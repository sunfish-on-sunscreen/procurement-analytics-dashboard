#!/usr/bin/env python3
"""Compute the 4 fixed procurement analyses over a DATE RANGE.

Two modes:
  Mode A (cache):   --period-id <id>
      Looks up the period's start/end dates, computes, and UPSERTs each analysis
      into AnalysisResult (one row per analysisType per period).
  Mode B (on-the-fly):  --start-date YYYY-MM-DD --end-date YYYY-MM-DD
      Computes over the date span and prints a single JSON object
      {spend_overview, abc, cycle_time, performance_spend, kraljic,
      recommendations, sourcing_coverage} to STDOUT. No DB writes.
      ⚠️ SEVEN keys. This list is the de-facto contract for lib/range-analyses.ts
      RANGE_TYPES — keep them in step when adding an analysis.

Data is filtered by PurchaseOrder ORDER DATE (poDate) — the same basis a PO's period
is tagged by — so a period's compute covers exactly the rows tagged to it. (This was
payment date, COALESCE(paymentDate, prDate), before the normalized-data migration.)
Suppliers and metrics are derived from the suppliers that appear in the filtered
purchases.
Progress logs go to STDERR so Mode B's stdout stays pure JSON.

Methodology is FIXED (ABC 80/95, Mann-Whitney U, Kraljic median split) per scope.
"""

import os
import sys
import json
import uuid
import argparse
import warnings
import traceback

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from dotenv import load_dotenv
import psycopg2

from scipy.stats import mannwhitneyu, norm

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scores  # shared score engine (single source of truth for the 6 formulas)
import risk_config  # config/risk-model.json weights for the two risk composites
import formula_eval  # the whitelisted formula evaluator (Stage D)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def load_env():
    here = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(here, "..", ".env"))


def get_dsn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set in the environment / .env")
    return url.split("?")[0]  # strip Prisma's ?schema=public for libpq


def num(value, ndigits=4):
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, (np.integer, int)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        if np.isnan(f) or np.isinf(f):
            return None
        return round(f, ndigits)
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    return value


def json_default(obj):
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Type not serializable: {type(obj)}")


def _df(conn, query, params):
    with conn.cursor() as cur:
        cur.execute(query, params)
        columns = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=columns).infer_objects()


def load_frames(conn, start_ts, end_ts):
    """Load purchases in [start_ts, end_ts] plus the suppliers/metrics for the
    suppliers that appear in those purchases (deduped across periods).

    The PO-grain "purchases" frame is the derived EnrichedPurchase VIEW — its
    columns are byte-identical to the old flat Purchase, so every downstream
    analysis + scores.rename_purchase_columns is unchanged. Period membership is
    now ORDER YEAR: filter by "poDate" (which converges exactly with the
    PurchaseOrder.period column) instead of the old payment-date bucketing."""
    purchases = _df(
        conn,
        'SELECT * FROM "EnrichedPurchase" '
        'WHERE "poDate" >= %s AND "poDate" <= %s '
        # Deterministic order: float addition is not associative, so an unordered
        # read would make the aggregates depend on physical row order.
        'ORDER BY "poId"',
        (start_ts, end_ts),
    )
    # Supplier master columns needed downstream, aliased id -> externalId so the
    # analyses (compute_supply_risk / build_live_composite_map) read them unchanged.
    _SUP_COLS = 'id AS "externalId", "supplierName", country, category'
    if len(purchases) == 0:
        suppliers = _df(conn, f'SELECT {_SUP_COLS} FROM "Supplier" WHERE false', ())
        metrics = _df(conn, 'SELECT * FROM "SupplierMetric" WHERE false', ())
        return suppliers, purchases, metrics

    supplier_ids = tuple(sorted(set(purchases["supplierExternalId"].tolist())))
    suppliers = _df(
        conn,
        f'SELECT {_SUP_COLS} FROM "Supplier" WHERE id IN %s ORDER BY id',
        (supplier_ids,),
    )
    # Per-period (P2): SupplierMetric now holds one row per supplier-period.
    # Pick the row(s) whose period falls inside [start_ts, end_ts]. In Mode A the
    # window IS one period's bounds, so exactly that period's metrics load. In
    # Mode B (range) several periods qualify; DISTINCT ON keeps the LATEST one
    # per supplier (period scores trend, latest = current snapshot for the
    # range's spend/Kraljic analyses; the panel computes a true range composite
    # separately).
    metrics = _df(
        conn,
        'SELECT DISTINCT ON (m."supplierExternalId") m.* '
        'FROM "SupplierMetric" m '
        'JOIN "ReportingPeriod" rp ON rp.id = m."periodId" '
        'WHERE m."supplierExternalId" IN %s '
        'AND rp."startDate" >= %s AND rp."endDate" <= %s '
        'ORDER BY m."supplierExternalId", rp."startDate" DESC',
        (supplier_ids, start_ts, end_ts),
    )
    return suppliers, purchases, metrics


# Full-roster category sizes: supplier count per category across ALL known
# suppliers (active or not), loaded once in main() from the Supplier master
# table. A1: supply_concentration counts category alternatives against this
# roster — an inactive-but-qualified supplier is still an available alternative —
# NOT just the period-active set. None => fall back to the period-scoped supplier
# set (only if this was never loaded, e.g. a direct unit-test call).
_ROSTER_CAT_COUNTS = None


def load_roster_category_counts(conn):
    """Supplier count per category across the FULL roster (all known suppliers,
    active or not) from the Supplier master table. Feeds A1's supply_concentration
    so the availability of alternatives reflects the whole roster, not just the
    period-active supplier set."""
    # Supplier is now a clean master (one row per supplier, no period-scoping);
    # its PK `id` is the supplier external id (e.g. "S0001"). Aliased to
    # "externalId" so the downstream groupby is unchanged.
    roster = _df(
        conn,
        'SELECT id AS "externalId", category FROM "Supplier"',
        (),
    )
    if len(roster) == 0:
        return {}
    counts = roster.groupby("category")["externalId"].nunique()
    return {str(k): int(v) for k, v in counts.items()}


# Window-scoped PO LINE frame: one row per PoLine for the POs in [start_ts,
# end_ts], loaded once in main() after load_frames. The cost_premium term
# (compute_supply_risk / _cost_premium_points) benchmarks item unit prices, which
# are LINE-level in the normalized model — the PO-grain EnrichedPurchase view
# cannot carry them — so cost_premium reads the actual lines here. Columns match
# what _cost_premium_points selects (supplierExternalId, itemName, unitPriceUsd,
# quantity) plus poId so each compute_supply_risk call can scope to its PO subset.
# None => fall back to the PO-grain frame (e.g. a direct unit-test call).
# ALL cycle rows with their buying method + order year, loaded ONCE in main() from
# the whole EnrichedPurchase view (which already carries the void exclusion), so the
# year-over-year mix decomposition is WINDOW-INDEPENDENT. Same convention as
# _ROSTER_CAT_COUNTS above. This makes a transition's numbers identical no matter
# which period is selected — they move only when the DATA moves, which removes the
# "closed periods become mutable" concern rather than introducing it. None => fall
# back to the window frame (a direct unit-test call).
_ALL_METHOD_CYCLES = None


def load_all_method_cycles(conn):
    """Every PO's order-year, buying method, cycle days, VALUE and CATEGORY — the
    whole table, no window filter. Reads the EnrichedPurchase VIEW, so voided orders
    are already excluded and no new void-filter site is created.

    Two consumers, both needing the same window-independent whole-table read:
    cycle_time's mix-adjusted trend (period x method x cycle days) and
    sourcing_coverage's mix decomposition (period x category x method x value).
    ⚠️ `totalValueUsd` + `category` were ADDED for the second consumer. This is inert
    for the first: _mix_adjusted_trend reads only `period`, `_method`, `_cycle` and
    `_internal`, all derived from columns that were already here, so widening the
    SELECT cannot move the cycle_time payload (proven by its unchanged md5)."""
    return _df(
        conn,
        'SELECT "poId", period, "buyingMethod", "totalCycleDays", "prToPoDays", '
        '"deliveryToInvoiceDays", "invoiceToPaymentDays", "totalValueUsd", category '
        'FROM "EnrichedPurchase" ORDER BY "poId"',
        (),
    )


# Sourcing bid graph + call-off framework windows. Both are keyed by poId and are
# intersected against the WINDOW FRAME's poIds inside the emitter.
#
# ⚠️ NEITHER QUERY CARRIES A VOID FILTER, BY DESIGN. The window frame comes from the
# EnrichedPurchase view and is therefore already void-excluded, so intersecting
# against its poIds INHERITS the exclusion. Spelling `NOT EXISTS
# "PurchaseOrderVoid"` here would create a FIFTH void-filter site — the exact trap
# CLAUDE.md flags on load_po_lines ("THE EASY ONE TO MISS"), where a missed site
# leaves a voided order moving one number while absent from every other. Four sites
# is the documented count; keep it there.
_SOURCING_EVENTS = None


def load_sourcing_events(conn):
    """Per-EVENT bid aggregates, joined to the PO(s) each event fed.

    Aggregated PER EVENT rather than per bid row so an event feeding more than one
    PO is still counted as ONE competitive process. The seeded data is 1:1 (226
    events, 226 sourced POs) but the schema permits 1:N, and a bid-grain join would
    silently double-count bids if it ever became so."""
    return _df(
        conn,
        'SELECT po.id AS "poId", se.id AS "eventId", '
        'agg.n_bids, agg.min_quote, agg.max_quote '
        'FROM "SourcingEvent" se '
        'JOIN "PurchaseOrder" po ON po."sourcingEventId" = se.id '
        'JOIN (SELECT "sourcingEventId" AS eid, COUNT(*) AS n_bids, '
        '             MIN("quotedUnitPriceUsd") AS min_quote, '
        '             MAX("quotedUnitPriceUsd") AS max_quote '
        '      FROM "Response" GROUP BY 1) agg ON agg.eid = se.id '
        'ORDER BY se.id, po.id',
        (),
    )


_CALLOFF_FRAMEWORKS = None


def load_calloff_frameworks(conn):
    """Call-off POs with a flag for whether the order fell outside its framework's
    validity window. LEFT JOIN so a call-off with no framework is still returned
    (it would be a data defect, and one worth being able to count)."""
    return _df(
        conn,
        'SELECT po.id AS "poId", po."frameworkId", '
        '(po."poDate" < f."startDate" OR po."poDate" > f."endDate") AS "outsideWindow" '
        'FROM "PurchaseOrder" po '
        'LEFT JOIN "Framework" f ON f.id = po."frameworkId" '
        "WHERE po.\"buyingMethod\" = 'call_off' "
        'ORDER BY po.id',
        (),
    )


_PO_LINES = None


def load_po_lines(conn, start_ts, end_ts):
    """PoLine rows for the POs in the window (order-year filter on poDate). `quantity`
    is the per-line quantity_ordered — the price×qty basis cost_premium expects.

    Correction lines (signed quantity + correctsLineId) fold onto the ORIGINAL line's
    itemName, so cost_premium benchmarks the corrected item rather than treating a
    reversal as a separate product. The signed quantity then nets into that item's
    spend-weighted average price. Formula unchanged.

    ⚠️ VOIDED ORDERS ARE EXCLUDED HERE SEPARATELY. This is one of only two analytics
    readers that joins PoLine to PurchaseOrder directly instead of going through the
    EnrichedPurchase view (the other is lib/po-lines.ts), so the view's void filter
    does NOT reach it. Without this clause a voided order would keep moving
    cost_premium — a supply-risk term — and therefore keep shifting Kraljic quadrant
    assignment, while disappearing from every other number."""
    return _df(
        conn,
        'SELECT po.id AS "poId", po."supplierId" AS "supplierExternalId", '
        'COALESCE(orig."itemName", pl."itemName") AS "itemName", '
        'pl."unitPriceUsd", pl."quantityOrdered" AS "quantity" '
        'FROM "PoLine" pl JOIN "PurchaseOrder" po ON po.id = pl."poId" '
        'LEFT JOIN "PoLine" orig ON orig.id = pl."correctsLineId" '
        'WHERE po."poDate" >= %s AND po."poDate" <= %s '
        'AND NOT EXISTS (SELECT 1 FROM "PurchaseOrderVoid" v WHERE v."poId" = po.id) '
        'ORDER BY pl.id',
        (start_ts, end_ts),
    )


# Live composite map (Stage 2): {supplier_id -> composite} computed from THIS
# window's filtered POs, set once in main() after load_frames. The three perf_of
# functions read this instead of the stored SupplierMetric.compositeScore, so
# performance zones / avg_performance / recommendations respond to the time
# filter. None => fall back to the stored composite (e.g. a direct unit-test call
# that never set it), mirroring the _ROSTER_CAT_COUNTS convention.
_LIVE_COMPOSITE_MAP = None


def build_live_composite_map(purchases, suppliers, metrics):
    """Per-supplier composite computed LIVE from the filtered `purchases` via
    scores.build_window_metrics — re-aggregate delivery/process over THIS window's
    POs and score, instead of reading the stored per-period composite. Returns
    {supplier_id -> composite_score}.

    Prepares the snake_case inputs the engine needs (Stage-1 boundary): renames
    the camelCase Purchase columns, and builds a snake_case soft/identity frame
    with `country` JOINED IN from the Supplier frame (SupplierMetric has no
    country column — it lives on Supplier)."""
    if len(purchases) == 0 or len(metrics) == 0:
        return {}
    pur = scores.rename_purchase_columns(purchases)
    country_by_sid = (
        suppliers.rename(columns={"externalId": "supplierExternalId"})
        .drop_duplicates("supplierExternalId")
        .set_index("supplierExternalId")["country"]
        .to_dict()
    )
    # Identity only — quality now comes from per-PO defect_count/complaint_count
    # (in `purchases`), so there are no soft-survey columns to carry.
    soft = (
        metrics.drop_duplicates("supplierExternalId")
        .rename(columns={"supplierExternalId": "supplier_id",
                         "supplierName": "supplier_name"})[
            ["supplier_id", "supplier_name", "category"]]
        .copy()
    )
    soft["country"] = soft["supplier_id"].map(country_by_sid).fillna("")
    wm = scores.build_window_metrics(soft, pur, _ROSTER_CAT_COUNTS or {})
    return {
        str(sid): float(c)
        for sid, c in zip(wm["supplier_id"], wm["composite_score"])
    }


# --------------------------------------------------------------------------- #
# a) Spend overview
# --------------------------------------------------------------------------- #
def spend_overview(purchases, suppliers, metrics):
    total_spend = purchases["totalValueUsd"].sum()
    cat = purchases.groupby("category")["totalValueUsd"].sum().sort_values(ascending=False)
    by_category = [{"category": str(c), "total": num(t)} for c, t in cat.head(8).items()]
    if len(cat) > 8:
        by_category.append({"category": "Other", "total": num(cat.iloc[8:].sum())})

    sup = (
        purchases.groupby(["supplierExternalId", "supplierName"])["totalValueUsd"]
        .sum().sort_values(ascending=False).head(10)
    )
    top_suppliers = [
        {"supplier_id": str(s), "supplier_name": str(n), "total": num(t)}
        for (s, n), t in sup.items()
    ]

    # Per-category top suppliers (visibility-only drill-down for the Overview
    # chart's category filter). Same {supplier_name, total} shape as the overall
    # top_suppliers so the frontend feeds them to the same chart. Up to 10 per
    # category, fewer if the category has fewer suppliers (no zero-padding).
    cat_sup = (
        purchases.groupby(["category", "supplierExternalId", "supplierName"])[
            "totalValueUsd"
        ]
        .sum()
        .reset_index()
    )
    top_suppliers_by_category = {}
    for c, grp in cat_sup.groupby("category"):
        rows = grp.sort_values("totalValueUsd", ascending=False).head(10)
        top_suppliers_by_category[str(c)] = [
            {
                "supplier_id": str(r["supplierExternalId"]),
                "supplier_name": str(r["supplierName"]),
                "total": num(r["totalValueUsd"]),
            }
            for _, r in rows.iterrows()
        ]

    # Spend is bucketed by PAYMENT date (matches the period tag). Rows without a
    # payment date are excluded from the trend only — they still count toward
    # every other aggregation above.
    pm = purchases.copy()
    pm["_pay"] = pd.to_datetime(pm["paymentDate"], errors="coerce")
    pm = pm.dropna(subset=["_pay"])
    pm["month"] = pm["_pay"].dt.strftime("%Y-%m")
    mt = pm.groupby("month")["totalValueUsd"].sum().sort_index()
    mc = pm.groupby("month").size()
    monthly_trend = [
        {"month": str(m), "total": num(t), "po_count": int(mc[m])}
        for m, t in mt.items()
    ]

    return {
        "total_spend": num(total_spend),
        "total_pos": int(len(purchases)),
        "active_suppliers": int(purchases["supplierExternalId"].nunique()),
        "avg_cycle_time": num(purchases["totalCycleDays"].mean()),
        # DISTINCT REAL category count for this window — the true number of
        # categories, NOT len(by_category). `by_category` is capped at the top-8
        # by spend PLUS a synthetic "Other" rollup for the donut, so its length
        # (≤ 9) understates reality. `cat` is the full per-category groupby, so
        # len(cat) is every real category and "Other" is never one of them. The
        # display layer reads THIS to count/label categories.
        "total_categories": int(len(cat)),
        "by_category": by_category,
        "top_suppliers": top_suppliers,
        "top_suppliers_by_category": top_suppliers_by_category,
        "monthly_trend": monthly_trend,
    }


# --------------------------------------------------------------------------- #
# b) ABC / Pareto  (fixed thresholds 0.80 / 0.95)
# --------------------------------------------------------------------------- #
def abc_analysis(purchases, suppliers, metrics):
    spend = (
        purchases.groupby(["supplierExternalId", "supplierName"], as_index=False)["totalValueUsd"]
        .sum().rename(columns={"totalValueUsd": "total"})
        .sort_values("total", ascending=False).reset_index(drop=True)
    )
    spend["rank"] = spend.index + 1
    grand = spend["total"].sum()
    spend["pct"] = spend["total"] / grand if grand else 0.0
    spend["cumulative_pct"] = spend["pct"].cumsum()

    def classify(c):
        if c <= 0.80:
            return "A"
        if c <= 0.95:
            return "B"
        return "C"

    spend["abc_class"] = spend["cumulative_pct"].apply(classify)

    classifications = [
        {
            "supplier_id": str(r["supplierExternalId"]),
            "supplier_name": str(r["supplierName"]),
            "total": num(r["total"]),
            "rank": int(r["rank"]),
            "pct": num(r["pct"], 6),
            "cumulative_pct": num(r["cumulative_pct"], 6),
            "abc_class": r["abc_class"],
        }
        for _, r in spend.iterrows()
    ]

    summary = {}
    for cls in ["A", "B", "C"]:
        sub = spend[spend["abc_class"] == cls]
        st = sub["total"].sum()
        summary[cls] = {
            "n": int(len(sub)),
            "pct_of_spend": num((st / grand) if grand else 0.0, 6),
        }

    return {
        "classifications": classifications,
        "summary": summary,
    }


# --------------------------------------------------------------------------- #
# c) Cycle time — process-health monitoring + date-driven period comparison
#    Metric = total_cycle_days. Replaces the old pre/post "automation impact"
#    test (the automation_period label was removed in Batch 5). Emits ongoing
#    monitoring (monthly trend + 3-mo rolling average, distribution, stage
#    decomposition, per-Kraljic-quadrant descriptives, Z-score anomalies) plus
#    a Mann-Whitney U comparison between the two halves of the selected period
#    (a fixed midpoint split).
# --------------------------------------------------------------------------- #
def _coalesced_date(purchases):
    """Payment date when present, else PR date — the CASH-BASIS date, used for the
    monthly money/cycle trends.

    ⚠️ This is NOT the period tag. Period membership and the compute window are
    ORDER-YEAR (`poDate`) since the normalized-model migration. Do NOT use this to
    partition a window into sub-groups: bucketing by payment date inside an
    order-date window selects short-cycle orders into the earlier group BY
    CONSTRUCTION (an order can only be paid early if its cycle was short), which
    manufactures a spurious "cycle time worsened" result. That was a real defect in
    the period comparison — see _comparison_block."""
    pay = pd.to_datetime(purchases["paymentDate"], errors="coerce")
    pr = pd.to_datetime(purchases["prDate"], errors="coerce")
    return pay.fillna(pr)


def _desc_stats(values):
    """mean/median/IQR descriptives over a numeric series (NaNs dropped)."""
    a = pd.to_numeric(pd.Series(values), errors="coerce").dropna()
    if len(a) == 0:
        return {"mean": None, "median": None, "p25": None, "p75": None, "n": 0}
    return {
        "mean": num(a.mean()),
        "median": num(a.median()),
        "p25": num(a.quantile(0.25)),
        "p75": num(a.quantile(0.75)),
        "n": int(len(a)),
    }


def _effect_label(r):
    a = abs(r)
    if a < 0.1:
        return "negligible"
    if a < 0.3:
        return "small"
    if a < 0.5:
        return "medium"
    return "large"


def _mde_a(n1, n2, alpha=0.05, power=0.80):
    """Minimum detectable effect for a two-sided Mann-Whitney, expressed as the
    probability of superiority A = P(X > Y) + ½P(X = Y). Noether's normal
    approximation. Makes a NULL result informative: "no detectable change; it would
    take A >= 0.57 to detect at 80% power" says far more than silence."""
    if n1 < 1 or n2 < 1:
        return None
    lam = norm.ppf(1 - alpha / 2) + norm.ppf(power)
    return num(0.5 + lam / np.sqrt(12 * n1 * n2 / (n1 + n2 + 1)))


def _comparison_block(a_vals, b_vals, a_bounds, b_bounds, excluded_n=0):
    """Two-sided Mann-Whitney U + rank-biserial r between two cycle-day samples.

    ⚠️ The caller MUST partition on the same date basis the window is filtered by
    (poDate / order date). Splitting an order-date window by PAYMENT date selects
    short-cycle orders into the earlier group by construction and produced a
    spurious "significant worsening" in every period.

    `skip_reason` distinguishes the two ways a test can be unavailable:
      "empty_group" — one side has no orders at all, so no comparison EXISTS
                      (e.g. every order in the window was placed in the first half);
      "too_few"     — both sides exist but one is under the 10-observation floor.
    Either way no p-value is emitted. `mde_a` is reported whenever both sides are
    non-empty so a null can be read as "underpowered" vs "genuinely flat", and
    `excluded_n` records any window rows outside both groups (0 by construction
    under a partition — reported so it can never go silently non-zero again)."""
    a = pd.to_numeric(pd.Series(a_vals), errors="coerce").dropna().to_numpy()
    b = pd.to_numeric(pd.Series(b_vals), errors="coerce").dropna().to_numpy()
    empty = len(a) == 0 or len(b) == 0
    too_few = not empty and (len(a) < 10 or len(b) < 10)
    block = {
        "period_a": {"start": a_bounds[0], "end": a_bounds[1], "n": int(len(a))},
        "period_b": {"start": b_bounds[0], "end": b_bounds[1], "n": int(len(b))},
        "mannwhitney_u": None,
        "p_value": None,
        "rank_biserial_r": None,
        "effect_size_label": None,
        "median_a": num(np.median(a)) if len(a) else None,
        "median_b": num(np.median(b)) if len(b) else None,
        "insufficient_data": empty or too_few,
        "skip_reason": "empty_group" if empty else ("too_few" if too_few else None),
        "mde_a": None if empty else _mde_a(len(a), len(b)),
        "excluded_n": int(excluded_n),
    }
    if block["insufficient_data"]:
        return block
    u_stat, p_value = mannwhitneyu(a, b, alternative="two-sided")
    r_rb = 1 - (2 * u_stat) / (len(a) * len(b))
    block.update(
        {
            "mannwhitney_u": float(u_stat),
            "p_value": float(p_value),
            "rank_biserial_r": num(r_rb),
            "effect_size_label": _effect_label(r_rb),
        }
    )
    return block


def _method_significance(pmeth, periods, alpha=0.05, min_power=0.80):
    """Per-buying-method period-over-period Mann-Whitney, BH-corrected, POWER-GATED.

    Why per method and not pooled: pooled cycle time is a five-population mixture,
    so its within-group variance is inflated (pooled IQR ~63d vs 13-29d per method)
    and the pooled test is blind — on this data every pooled period-vs-period test
    is null while real per-method effects exist. Pooling also makes the location-shift
    reading incoherent (pooled is bimodal, each method is unimodal).

    ⚠️ This is deliberately NOT a general significance surface. Testing 5 methods x
    each transition is a multiplicity problem, and at these cell sizes (n 23-83) most
    cells can only detect very large effects. So a finding is emitted ONLY if it
    clears BOTH gates: Benjamini-Hochberg q < alpha AND observed power >= min_power.
    On the current data exactly ONE of ten tests survives. Everything else is
    reported as no-detectable-change by omission — `tested` and `alpha` are emitted
    so the UI can say how many tests were run rather than implying only one existed.

    Metric is TOTAL cycle only, which keeps the correction family well defined (one
    family per transition set) and matches the headline the dashboard shows.
    """
    out = {
        "tested": 0,
        "alpha": alpha,
        "min_power": min_power,
        "correction": "benjamini-hochberg",
        "findings": [],
    }
    if len(periods) < 2:
        return out
    methods = sorted(pmeth["_method"].dropna().unique())
    raw = []
    for a, b in zip(periods, periods[1:]):
        ga = pmeth[pmeth["period"].astype(str) == a]
        gb = pmeth[pmeth["period"].astype(str) == b]
        for m in methods:
            xa = pd.to_numeric(ga[ga["_method"] == m]["_cycle"], errors="coerce").dropna().to_numpy()
            xb = pd.to_numeric(gb[gb["_method"] == m]["_cycle"], errors="coerce").dropna().to_numpy()
            if len(xa) < 10 or len(xb) < 10:
                continue
            u, pv = mannwhitneyu(xa, xb, alternative="two-sided")
            a_sup = u / (len(xa) * len(xb))  # P(X>Y)+½P(X=Y)
            lam = abs(a_sup - 0.5) * np.sqrt(12 * len(xa) * len(xb) / (len(xa) + len(xb) + 1))
            pw = float(norm.cdf(lam - norm.ppf(1 - alpha / 2)))
            raw.append({
                "method": m, "from": a, "to": b,
                "n_from": int(len(xa)), "n_to": int(len(xb)),
                "median_from": num(np.median(xa)), "median_to": num(np.median(xb)),
                "p_value": float(pv), "power": num(pw), "_p": float(pv),
            })
    out["tested"] = len(raw)
    if not raw:
        return out
    # Benjamini-Hochberg across the whole family.
    raw.sort(key=lambda r: r["_p"])
    k = len(raw)
    for i, r in enumerate(raw, start=1):
        r["q_value"] = num(min(1.0, r["_p"] * k / i))
    for r in raw:
        if (r["q_value"] is not None and r["q_value"] < alpha
                and r["power"] is not None and r["power"] >= min_power):
            direction = "faster" if (r["median_to"] or 0) < (r["median_from"] or 0) else "slower"
            out["findings"].append({
                "method": r["method"], "from": r["from"], "to": r["to"],
                "n_from": r["n_from"], "n_to": r["n_to"],
                "median_from": r["median_from"], "median_to": r["median_to"],
                "p_value": num(r["p_value"], 5), "q_value": r["q_value"],
                "power": r["power"], "direction": direction,
            })
    return out


def _mix_adjusted_trend(pmeth, window_periods=None):
    """Shift-share decomposition of the pooled cycle-time change per period pair.

    pooled(b) - pooled(a) == MIX effect + WITHIN effect, exactly:
        mix    = sum_m (w_b[m] - w_a[m]) * rate_a[m]     (composition moved)
        within = sum_m  w_b[m] * (rate_b[m] - rate_a[m]) (each method itself moved)
    The identity is exact because sum(w*rate) IS the pooled mean. A method absent
    from one side takes the other side's rate, which attributes its whole
    contribution to mix (a method appearing/vanishing IS a composition change)
    and keeps the identity exact.

    ⚠️ WINDOW-INDEPENDENT. `pmeth` is the WHOLE table (_ALL_METHOD_CYCLES), not the
    selected window, so every transition carries identical numbers no matter which
    period is selected — they move only when the data moves. `window_periods` is
    carried through purely as a DISPLAY hint: the UI shows transitions that END
    inside the selected window (2024 -> none, 2025 -> 2024→2025, 2026 -> 2025→2026,
    a full range -> both). Filtering in the UI rather than the compute keeps the
    numbers stable and puts the "what am I looking at" decision where the window is.

    ⚠️ DECOMPOSITION ONLY — deliberately no p-values per row. Shift-share is an
    arithmetic identity with no distributional assumptions, so nothing here can be
    misread as inference. Per-cell tests would put ten hypotheses in a table where
    nineteen of twenty are null after correction and every cell would read as a
    finding; the one result that survives correction lives in the glance with its
    q-value and power.

    `pooled_misleading` marks the cases the UI must not report naively: a SIGN
    REVERSAL (pooled says better, methods say worse) or MAGNITUDE MASKING (pooled
    looks flat while the methods moved materially). Each day figure also carries a
    percentage of the earlier period's pooled mean, so "+4.96d" reads as "+5.7%"
    and the reader gets a sense of scale without any inference.
    """
    periods = sorted(str(x) for x in pmeth["period"].dropna().unique())
    out = {
        "insufficient_data": len(periods) < 2,
        "periods": periods,
        "window_periods": sorted(str(x) for x in (window_periods or [])),
        "metrics": {},
    }
    if len(periods) < 2:
        return out

    methods = sorted(pmeth["_method"].dropna().unique())
    for metric_key, col in (("total", "_cycle"), ("internal", "_internal")):
        by_period = {}
        for per in periods:
            g = pmeth[pmeth["period"].astype(str) == per]
            n = int(len(g))
            rates, shares = {}, {}
            for m in methods:
                gm = g[g["_method"] == m]
                v = pd.to_numeric(gm[col], errors="coerce").dropna()
                shares[m] = (len(gm) / n) if n else 0.0
                rates[m] = float(v.mean()) if len(v) else None
            v_all = pd.to_numeric(g[col], errors="coerce").dropna()
            by_period[per] = {
                "n": n,
                "pooled": float(v_all.mean()) if len(v_all) else None,
                "rates": rates,
                "shares": shares,
            }

        transitions = []
        for a, b in zip(periods, periods[1:]):
            A, B = by_period[a], by_period[b]
            if A["pooled"] is None or B["pooled"] is None:
                continue
            mix = within = 0.0
            per_method = []
            for m in methods:
                ra, rb = A["rates"][m], B["rates"][m]
                if ra is None and rb is None:
                    continue
                # absent on one side -> take the other's rate (keeps the identity exact)
                ra_e = ra if ra is not None else rb
                rb_e = rb if rb is not None else ra
                wa, wb = A["shares"][m], B["shares"][m]
                mix += (wb - wa) * ra_e
                within += wb * (rb_e - ra_e)
                per_method.append({
                    "method": m,
                    "from_mean": num(ra, 2),
                    "to_mean": num(rb, 2),
                    "within_change": num(rb_e - ra_e, 2),
                    "from_share_pct": num(wa * 100, 1),
                    "to_share_pct": num(wb * 100, 1),
                })
            pooled_change = B["pooled"] - A["pooled"]
            # Sign reversal, or a pooled move less than half the within-method move.
            sign_flip = (pooled_change * within) < 0 and abs(within) >= 1.0
            masked = (
                not sign_flip
                and abs(within) >= 1.0
                and abs(pooled_change) < abs(within) / 2
            )
            # Scale: each effect as a share of the EARLIER period's pooled mean.
            base = A["pooled"] or 0.0
            as_pct = (lambda v: num(v / base * 100, 1)) if base else (lambda v: None)
            transitions.append({
                "from": a,
                "to": b,
                "from_pooled_mean": num(A["pooled"], 2),
                "to_pooled_mean": num(B["pooled"], 2),
                "pooled_change": num(pooled_change, 2),
                "mix_effect": num(mix, 2),
                "within_effect": num(within, 2),
                "pooled_change_pct": as_pct(pooled_change),
                "mix_effect_pct": as_pct(mix),
                "within_effect_pct": as_pct(within),
                "pooled_misleading": bool(sign_flip or masked),
                "reason": "sign_reversal" if sign_flip else ("magnitude_masked" if masked else None),
                "per_method": per_method,
            })

        out["metrics"][metric_key] = {
            "per_period": {
                per: {
                    "n": by_period[per]["n"],
                    "pooled_mean": num(by_period[per]["pooled"], 2),
                    "shares_pct": {m: num(by_period[per]["shares"][m] * 100, 1) for m in methods},
                    "means": {m: num(by_period[per]["rates"][m], 2) for m in methods},
                }
                for per in periods
            },
            "transitions": transitions,
        }
    return out


def cycle_time_analysis(
    purchases, suppliers, metrics, range_start, range_end
):
    p = purchases.copy()
    p["_date"] = _coalesced_date(p)
    cycle = pd.to_numeric(p["totalCycleDays"], errors="coerce")
    p["_cycle"] = cycle
    # INTERNAL cycle = the org-controlled portion. PO->Delivery is physical supplier
    # lead time, excluded for the same reason the slow-stage flag excludes it.
    p["_internal"] = (
        pd.to_numeric(p["prToPoDays"], errors="coerce")
        + pd.to_numeric(p["deliveryToInvoiceDays"], errors="coerce")
        + pd.to_numeric(p["invoiceToPaymentDays"], errors="coerce")
    )

    # --- monthly trend + trailing 3-month rolling average ---------------- #
    pm = p.dropna(subset=["_date"]).copy()
    pm["month"] = pm["_date"].dt.strftime("%Y-%m")
    grp = pm.groupby("month")["_cycle"]
    monthly = grp.mean().sort_index()
    medians = grp.median()
    counts = grp.size()
    monthly_trend = [
        {
            "month": str(m),
            "avg_cycle_days": num(v),
            "median_cycle_days": num(medians[m]),
            "po_count": int(counts[m]),
        }
        for m, v in monthly.items()
    ]
    roll = monthly.rolling(window=3).mean().dropna()
    rolling_avg_trend = [
        {"month": str(m), "rolling_3mo": num(v)} for m, v in roll.items()
    ]

    # --- overall distribution ------------------------------------------- #
    c = cycle.dropna()
    if len(c):
        q1, q3 = float(c.quantile(0.25)), float(c.quantile(0.75))
        distribution = {
            "median": num(c.median()),
            "p25": num(q1),
            "p75": num(q3),
            "iqr": num(q3 - q1),
            "min": num(c.min()),
            "max": num(c.max()),
            "mean": num(c.mean()),
            "n": int(len(c)),
        }
    else:
        distribution = {
            "median": None, "p25": None, "p75": None, "iqr": None,
            "min": None, "max": None, "mean": None, "n": 0,
        }

    # --- stage decomposition (single population) ------------------------ #
    stage_breakdown = {
        "pr_to_po": _desc_stats(p["prToPoDays"]),
        "po_to_delivery": _desc_stats(p["poToDeliveryDays"]),
        "delivery_to_invoice": _desc_stats(p["deliveryToInvoiceDays"]),
        "invoice_to_payment": _desc_stats(p["invoiceToPaymentDays"]),
    }

    # --- Z-score anomalies (cycle time > 2σ above the mean) ------------- #
    # One-sided: slow outliers are the operational concern (right-skewed data,
    # so z < -2 effectively never occurs). Emit the COMPLETE z>2 set, z-descending
    # — the supplier "Has outlier POs" flag count + the flagged-supplier roster are
    # derived from this list (lib/cycle-flags), so it must be complete for those
    # counts to be truthful; the display paginates ("View all N"). (A prior .head(15)
    # cap silently dropped the tail — 24 POs / 14 suppliers exceed z>2 on the full
    # range, not 15 / 11.)
    anomalies = []
    mean_c = float(c.mean()) if len(c) else 0.0
    std_c = float(c.std(ddof=1)) if len(c) > 1 else 0.0
    if std_c > 0:
        pz = p.copy()
        pz["_z"] = (pz["_cycle"] - mean_c) / std_c
        flagged = pz[pz["_z"] > 2].sort_values("_z", ascending=False)
        for _, r in flagged.iterrows():
            d = r["_date"]
            anomalies.append(
                {
                    "po_id": str(r["poId"]),
                    "supplier_id": str(r["supplierExternalId"]),
                    "supplier_name": str(r["supplierName"]),
                    "invoice_date": d.strftime("%Y-%m-%d") if pd.notna(d) else None,
                    "cycle_days": int(r["_cycle"]) if pd.notna(r["_cycle"]) else None,
                    "z_score": num(r["_z"], 2),
                }
            )

    # --- period comparison (midpoint split of the selected window) ------------ #
    # ⚠️ SPLIT ON poDate — the SAME basis the window is filtered by. This used to
    # split on _date (payment date), which is a different basis from the window's
    # own membership rule and biased the result: an order can only be PAID in the
    # first half if its cycle was short, so group A was selected for speed by
    # construction. It reported a "significant worsening" in all three periods
    # (2024 p=0.0002, 2025 p=0.0001, 2026 p=5e-10) that disappears entirely on the
    # correct basis (2024 p=0.386, 2025 p=0.246 — both null; 2026 has no second
    # group at all). It also silently dropped orders whose payment fell outside the
    # window (32 in 2024, 38 in 2025). Partitioning on poDate covers every row.
    start_ts = pd.to_datetime(range_start)
    end_ts = pd.to_datetime(range_end)
    mid = (start_ts + (end_ts - start_ts) / 2).normalize()
    po_date = pd.to_datetime(p["poDate"], errors="coerce")
    in_a = po_date <= mid
    in_b = po_date > mid
    # A partition leaves nothing out; counted anyway so a future regression is loud.
    excluded_n = int(len(p) - int(in_a.sum()) - int(in_b.sum()))

    fmt = lambda t: t.strftime("%Y-%m-%d")
    period_comparison = _comparison_block(
        p[in_a]["_cycle"],
        p[in_b]["_cycle"],
        (fmt(start_ts.normalize()), fmt(mid)),
        (fmt(mid + pd.Timedelta(days=1)), fmt(end_ts.normalize())),
        excluded_n=excluded_n,
    )

    # --- per-Kraljic-quadrant descriptives (single population) ---------- #
    quad_map = {}
    if suppliers is not None and metrics is not None and len(suppliers):
        risk_map, _c, _components = compute_supply_risk(p, suppliers, metrics)
        spend_raw = p.groupby("supplierExternalId")["totalValueUsd"].sum()
        log_spend_map = {sid: float(np.log1p(v)) for sid, v in spend_raw.items()}
        krj_sids = [s for s in log_spend_map if s in risk_map]
        if krj_sids:
            quad_map, _sm, _rm = assign_kraljic_quadrants(
                {s: log_spend_map[s] for s in krj_sids},
                {s: risk_map[s] for s in krj_sids},
            )

    pq = p.copy()
    pq["quadrant"] = pq["supplierExternalId"].map(quad_map)
    cycle_by_quadrant = {}
    match_raw = {}
    for q in ["Strategic", "Leverage", "Bottleneck", "Routine"]:
        sub = pq[pq["quadrant"] == q]
        cycle_by_quadrant[q] = _desc_stats(sub["_cycle"])
        n_pos = int(len(sub))
        pass_rate = (
            num(sub["threeWayMatchPass"].astype(bool).mean() * 100) if n_pos else None
        )
        match_raw[q] = {"pass_rate_pct": pass_rate, "n": n_pos}

    # is_worst = the quadrant with the LOWEST pass rate among those with POs.
    candidates = [
        (q, m["pass_rate_pct"])
        for q, m in match_raw.items()
        if m["n"] > 0 and m["pass_rate_pct"] is not None
    ]
    worst_q = min(candidates, key=lambda x: x[1])[0] if candidates else None
    three_way_match_by_quadrant = {
        q: {**m, "is_worst": (q == worst_q)} for q, m in match_raw.items()
    }

    # --- cycle by BUYING METHOD + mix-adjusted trend ---------------------- #
    # Cycle time is near-deterministic in buying method (spot_buy ~44d ->
    # direct ~130d), so the pooled mean is a WEIGHTED MIXTURE. A shift in method
    # mix can move the pooled number while every method individually goes the
    # other way — measured on this data in BOTH transitions, so the pooled trend
    # alone is not a safe read. cycle_by_method mirrors cycle_by_quadrant's shape
    # (mean/median/p25/p75/n at the top level) so it reuses the same rendering,
    # with internal-cycle + per-stage detail nested underneath.
    cycle_by_method = {}
    mix_adjusted_trend = {"insufficient_data": True, "periods": [], "metrics": {}}
    method_significance = {
        "tested": 0, "alpha": 0.05, "min_power": 0.80,
        "correction": "benjamini-hochberg", "findings": [],
    }
    if "buyingMethod" in p.columns:
        pmeth = p.copy()
        pmeth["_method"] = pmeth["buyingMethod"].astype(str)
        for m in sorted(pmeth["_method"].dropna().unique()):
            sub = pmeth[pmeth["_method"] == m]
            cycle_by_method[m] = {
                **_desc_stats(sub["_cycle"]),
                "internal": _desc_stats(sub["_internal"]),
                "stage_breakdown": {
                    "pr_to_po": _desc_stats(sub["prToPoDays"]),
                    "po_to_delivery": _desc_stats(sub["poToDeliveryDays"]),
                    "delivery_to_invoice": _desc_stats(sub["deliveryToInvoiceDays"]),
                    "invoice_to_payment": _desc_stats(sub["invoiceToPaymentDays"]),
                },
            }
        window_periods = sorted(str(x) for x in pmeth["period"].dropna().unique())
        # ⚠️ The decomposition runs over the WHOLE table (window-independent), so a
        # transition reads the same on every window; `window_periods` only tells the
        # UI which rows to show. Falls back to the window frame for a direct
        # unit-test call that never set the global (the _ROSTER_CAT_COUNTS
        # convention).
        if _ALL_METHOD_CYCLES is not None and len(_ALL_METHOD_CYCLES) > 0:
            allm = _ALL_METHOD_CYCLES.copy()
            allm["_method"] = allm["buyingMethod"].astype(str)
            allm["_cycle"] = pd.to_numeric(allm["totalCycleDays"], errors="coerce")
            allm["_internal"] = (
                pd.to_numeric(allm["prToPoDays"], errors="coerce")
                + pd.to_numeric(allm["deliveryToInvoiceDays"], errors="coerce")
                + pd.to_numeric(allm["invoiceToPaymentDays"], errors="coerce")
            )
        else:
            allm = pmeth
        mix_adjusted_trend = _mix_adjusted_trend(allm, window_periods=window_periods)
        # Significance stays WINDOW-scoped: it is inference, and its multiplicity
        # family must match what the reader is actually looking at.
        method_significance = _method_significance(pmeth, window_periods)

    return {
        "monthly_trend": monthly_trend,
        "rolling_avg_trend": rolling_avg_trend,
        "distribution": distribution,
        "stage_breakdown": stage_breakdown,
        "anomalies": anomalies,
        "period_comparison": period_comparison,
        "cycle_by_quadrant": cycle_by_quadrant,
        "cycle_by_method": cycle_by_method,
        "mix_adjusted_trend": mix_adjusted_trend,
        "method_significance": method_significance,
        "three_way_match_by_quadrant": three_way_match_by_quadrant,
    }


# --------------------------------------------------------------------------- #
# d) Performance vs Spend diagnostic  (median split on log_spend x performance)
#    Crosses spend volume against the supplier compositeScore and tags each
#    supplier with its PERIOD-ACCURATE Kraljic quadrant (recomputed here via the
#    same helpers kraljic_analysis uses) for cross-reference colouring.
# --------------------------------------------------------------------------- #
def performance_spend_analysis(purchases, suppliers, metrics):
    spend_raw = purchases.groupby("supplierExternalId")["totalValueUsd"].sum()
    total_spend_map = {sid: float(v) for sid, v in spend_raw.items()}
    log_spend_map = {sid: float(np.log1p(v)) for sid, v in spend_raw.items()}

    # Period-accurate Kraljic quadrant (mirrors kraljic_analysis's setup).
    risk_map, _comp, _components = compute_supply_risk(purchases, suppliers, metrics)
    krj_sids = [s for s in log_spend_map if s in risk_map]
    quad_map, _sm, _rm = assign_kraljic_quadrants(
        {s: log_spend_map[s] for s in krj_sids},
        {s: risk_map[s] for s in krj_sids},
    )

    sup_meta = (
        suppliers.rename(columns={"externalId": "supplierExternalId"})
        .drop_duplicates("supplierExternalId")
        .set_index("supplierExternalId")
    )
    comp_score = (
        metrics.drop_duplicates("supplierExternalId").set_index("supplierExternalId")
        if len(metrics)
        else pd.DataFrame()
    )

    def name_of(s):
        return str(sup_meta.loc[s, "supplierName"]) if s in sup_meta.index else s

    def perf_of(s):
        # Stage 2: LIVE composite for this filter's POs; stored is the fallback.
        if _LIVE_COMPOSITE_MAP is not None:
            v = _LIVE_COMPOSITE_MAP.get(s)
            return float(v) if v is not None else None
        if len(comp_score) and s in comp_score.index:
            v = comp_score.loc[s, "compositeScore"]
            return float(v) if pd.notna(v) else None
        return None

    empty = {
        "suppliers": [],
        "zone_profiles": [],
        "axis_thresholds": {"spend_median": 0, "performance_median": 0},
        "top_critical_issues": [],
        "top_hidden_gems": [],
    }

    # Suppliers needing both spend AND a performance score (and a quadrant).
    sids = [s for s in krj_sids if perf_of(s) is not None]
    if not sids:
        return empty

    spend_med = float(np.median([log_spend_map[s] for s in sids]))
    perf_med = float(np.median([perf_of(s) for s in sids]))

    def zone_of(s):
        hi_spend = log_spend_map[s] > spend_med
        hi_perf = perf_of(s) > perf_med
        if hi_spend and hi_perf:
            return "Stars"
        if hi_spend and not hi_perf:
            return "Critical Issues"
        if not hi_spend and hi_perf:
            return "Hidden Gems"
        return "Long Tail"

    rows = [
        {
            "supplier_id": s,
            "supplier_name": name_of(s),
            "log_spend": num(log_spend_map[s]),
            "total_spend_usd": num(total_spend_map[s]),
            "performance_score": num(perf_of(s)),
            "kraljic_quadrant": quad_map[s],
            "zone": zone_of(s),
        }
        for s in sids
    ]

    grand_total = sum(total_spend_map[s] for s in sids) or 1.0
    zone_profiles = []
    for z in ["Stars", "Critical Issues", "Hidden Gems", "Long Tail"]:
        members = [s for s in sids if zone_of(s) == z]
        tot = sum(total_spend_map[s] for s in members)
        perfs = [perf_of(s) for s in members]
        zone_profiles.append(
            {
                "zone": z,
                "n_suppliers": len(members),
                "total_spend_usd": num(tot),
                "pct_of_total_spend": num((tot / grand_total) * 100),
                "avg_performance": num(np.mean(perfs)) if perfs else None,
            }
        )

    top_critical_issues = sorted(
        [r for r in rows if r["zone"] == "Critical Issues"],
        key=lambda r: r["total_spend_usd"],
        reverse=True,
    )[:5]
    top_hidden_gems = sorted(
        [r for r in rows if r["zone"] == "Hidden Gems"],
        key=lambda r: r["performance_score"],
        reverse=True,
    )[:5]

    return {
        "suppliers": rows,
        "zone_profiles": zone_profiles,
        "axis_thresholds": {
            "spend_median": num(spend_med),
            "performance_median": num(perf_med),
        },
        "top_critical_issues": top_critical_issues,
        "top_hidden_gems": top_hidden_gems,
    }


# ⚠️ The ANALYSES list moved DOWN, to just after sourcing_coverage's definition —
# it holds function OBJECTS, so every member must already be defined when the module
# executes this statement. It used to sit here (right after the last of its three
# members); adding a fourth that is defined further down made that position a
# NameError at import.


# --------------------------------------------------------------------------- #
# d) Kraljic matrix  (supply-risk score + quadrant assignment)
# --------------------------------------------------------------------------- #
def _import_friction_points(country):
    """Import friction NORMALIZED to 0..100 by trade-agreement coverage. Stage A moved
    the tiers into config/risk-model.json (lookupTables.import_friction); this thin
    wrapper delegates to the ONE loader, risk_config — the SAME path scores.py's country
    lookup uses (no second table). Complete + robust: any unmapped / unknown / empty code
    falls through to the table's explicit `default` (100), so it never errors or returns
    None. Values unchanged — ID -> 0, AFTA/ASEAN -> 32, RCEP non-ASEAN -> 64, else -> 100
    (the supplyRisk weight 0.25 scales it onto the old 0..25 contribution). Deliberately
    SEPARATE from scores.country_distance_score: trade blocs, not geography — India is
    outside RCEP (100) here but Asia-Pacific (60) there.
    """
    return risk_config.lookup_country("import_friction", country)


def _cost_premium_points(purchases):
    """Period-scoped cost premium NORMALIZED to 0..100 per supplier, from Purchase prices.

    For each item, the benchmark is the spend-weighted average unit price across
    ALL suppliers selling it within the period (item_avg = sum(price*qty)/sum(qty)).
    A supplier's premium on an item = its own spend-weighted avg unit price / item_avg
    - 1, COUNTED only when that supplier x item has >= 2 POs (n=1 excluded as noise)
    AND the item has >= 2 suppliers (single-source items have no benchmark -> neutral).
    The supplier's overall premium is the spend-weighted average of its qualifying
    item premiums (weight = the supplier's spend on each item); normalized points =
    clip(premium * 250, 0, 100). The supplyRisk weight (0.25) scales this back onto the
    old 0..25 contribution (0.25 * clip(premium*250,0,100) == clip(premium*62.5,0,25):
    +8% -> 5, +20% -> 12.5, +40%+ -> 25; at/below market -> 0, never negative). Both the
    factor 250/62.5 = 4 and 0.25 = 1/4 are powers of two, so the round-trip is exact.
    Suppliers with no qualifying items -> 0 (returned absent).
    """
    if purchases is None or len(purchases) == 0:
        return {}
    p = purchases[["supplierExternalId", "itemName", "unitPriceUsd", "quantity"]].copy()
    p["spend"] = p["unitPriceUsd"].astype(float) * p["quantity"].astype(float)
    p["qty"] = p["quantity"].astype(float)

    # supplier x item: total spend, qty, PO count, spend-weighted avg unit price.
    g = (
        p.groupby(["itemName", "supplierExternalId"])
        .agg(spend=("spend", "sum"), qty=("qty", "sum"), po=("unitPriceUsd", "size"))
        .reset_index()
    )
    g = g[g["qty"] > 0].copy()
    g["avg_price"] = g["spend"] / g["qty"]

    # item benchmark: spend-weighted avg unit price across all suppliers of the item.
    item = (
        g.groupby("itemName")
        .agg(item_spend=("spend", "sum"), item_qty=("qty", "sum"), n_sup=("supplierExternalId", "nunique"))
        .reset_index()
    )
    item = item[item["item_qty"] > 0].copy()
    item["item_avg"] = item["item_spend"] / item["item_qty"]
    g = g.merge(item[["itemName", "item_avg", "n_sup"]], on="itemName", how="inner")

    g["premium"] = g["avg_price"] / g["item_avg"] - 1.0
    # qualifying rows: supplier has >=2 POs of the item AND the item is benchmarkable.
    qual = g[(g["po"] >= 2) & (g["n_sup"] >= 2)]

    out = {}
    for sid, grp in qual.groupby("supplierExternalId"):
        wsum = float(grp["spend"].sum())
        if wsum <= 0:
            continue
        prem = float((grp["premium"] * grp["spend"]).sum() / wsum)
        out[sid] = float(np.clip(prem * 250.0, 0.0, 100.0))
    return out


def compute_supply_risk(purchases, suppliers, metrics):
    """Return (risk_map, competition_map, components_map) over the supplier set.

    risk = supply_concentration(0-50) + cost_premium(0-25)
         + import_friction(0/8/16/25), clipped to [0,100].
    `purchases` is the period/range-scoped Purchase frame — it drives the
    period-scoped cost_premium benchmark. supply_concentration MERGES the former
    single_source (a stored flag that contradicted the roster for ~91% of flagged
    suppliers) and category_competition into ONE roster-derived component, so it
    can never disagree with the actual supplier set. `metrics` is no longer read
    here (the singleSourceRisk flag is dropped from supply risk; its use in the
    performance composite's risk_score is separate and unchanged).
    """
    sup = suppliers.rename(columns={"externalId": "supplierExternalId"}).drop_duplicates(
        "supplierExternalId"
    )
    df = sup[["supplierExternalId", "category", "country"]].copy()

    # OTHER suppliers in the same category. A1: count against the FULL supplier
    # roster (active or not) — an inactive-but-qualified supplier is still an
    # available alternative — so a category with 2 suppliers where 1 is inactive
    # this period counts as 2 (concentration ~35), not 1 (~50). Falls back to the
    # period-scoped set only if the roster was never loaded.
    if _ROSTER_CAT_COUNTS:
        cat_size = df["category"].map(
            lambda c: _ROSTER_CAT_COUNTS.get(str(c), 0)
        )
        # a scored supplier is always in the roster, so its category size >= 1;
        # clip guards against a category somehow missing from the roster map.
        df["other_in_category"] = (cat_size - 1).clip(lower=0).astype(int)
    else:
        cat_size = df.groupby("category")["supplierExternalId"].transform("size")
        df["other_in_category"] = (cat_size - 1).astype(int)

    # Weights come from config/risk-model.json (supplyRisk). Each component is
    # normalized to 0-100 below; the resolved weight scales it onto the old point
    # ceiling (concentration 0.50->50, cost_premium 0.25->25, import_friction 0.25->25).
    # With every component enabled and the declared weights summing to 1.0,
    # resolve_effective_weights divides by exactly 1.0 (a bit-for-bit no-op), so each
    # weighted contribution reproduces the old points and their sum reproduces the old
    # supply_risk_score. All three scale factors (0.5, 0.25, x2, /4) are powers of two,
    # so the round-trip is exact — no float drift.
    _cfg = risk_config.get_composite("supplyRisk")

    # Resolver input for the `cost_premium` COMPUTED variable: its map is period-scoped at LINE
    # grain (lock C) — the PO-grain EnrichedPurchase view carries no per-item price, so read the
    # window's PoLine frame scoped to the POs in THIS call's `purchases` subset; fall back to the
    # PO-grain frame only if the line frame was never loaded (e.g. a direct unit-test call).
    if _PO_LINES is not None and "poId" in purchases.columns:
        po_ids = set(purchases["poId"].tolist())
        cost_input = _PO_LINES[_PO_LINES["poId"].isin(po_ids)]
    else:
        cost_input = purchases
    computed_maps = {"cost_premium": _cost_premium_points(cost_input)}

    # The variables the composite's enabled formulas reference (single-atom today: each formula
    # is its component's own variable id). supply_concentration / import_friction resolve via
    # their lookup tables on the supplier's key field; cost_premium via the computed map above.
    referenced = set()
    for comp in _cfg["components"]:
        if comp.get("enabled", True):
            referenced |= formula_eval.referenced_names(comp["formula"])

    # Evaluate the supplyRisk composite per supplier through THE formula evaluator (env resolved
    # outside it). Byte-identical to the old vectorized weight*normalized sum: single-atom
    # formulas + (0,100) bounds make normalize_to_bounds a x1.0 identity, and evaluate_composite
    # sums the weighted contributions in declared component order (concentration 0-50, cost 0-25,
    # friction 0-25), so a 2dp display total still reconciles with the 2dp component bars.
    risk_map, competition_map, components_map = {}, {}, {}
    for _, r in df.iterrows():
        sid = r["supplierExternalId"]
        other = int(r["other_in_category"])
        key_values = {"supplier_id": sid, "country": r["country"], "roster_other_count": other}
        env = risk_config.resolve_env(referenced, key_values, computed_maps)
        score, contributions = risk_config.evaluate_composite(_cfg, env)
        risk_map[sid] = score
        competition_map[sid] = other
        components_map[sid] = {k: float(v) for k, v in contributions.items()}
    return risk_map, competition_map, components_map


def assign_kraljic_quadrants(spend_map, risk_map):
    """Median split on log_spend (x) and supply_risk (y) as the crossing point."""
    sids = list(spend_map.keys())
    spend_med = float(np.median([spend_map[s] for s in sids])) if sids else 0.0
    risk_med = float(np.median([risk_map[s] for s in sids])) if sids else 0.0
    quad = {}
    for s in sids:
        hi_spend = spend_map[s] > spend_med
        # B5: the supply-risk score is DISCRETE (step-curve concentration + a few
        # friction/premium levels) so many suppliers tie exactly at the median. A
        # strict `>` shoved every tied-at-median supplier into low-risk; `>=` puts
        # ties on the high-risk side, giving a balanced split. Spend is continuous
        # (log-spend, effectively no ties) so it keeps `>` — the asymmetry is
        # intentional and only affects the discrete axis.
        hi_risk = risk_map[s] >= risk_med
        if hi_spend and hi_risk:
            quad[s] = "Strategic"
        elif hi_spend and not hi_risk:
            quad[s] = "Leverage"
        elif not hi_spend and hi_risk:
            quad[s] = "Bottleneck"
        else:
            quad[s] = "Routine"
    return quad, spend_med, risk_med


def kraljic_analysis(purchases, suppliers, metrics):
    """Build the KraljicResult and return (result, risk_map, comp_map, quad_map)."""
    spend_raw = purchases.groupby("supplierExternalId")["totalValueUsd"].sum()
    total_spend_map = {sid: float(v) for sid, v in spend_raw.items()}
    spend_map = {sid: float(np.log1p(v)) for sid, v in spend_raw.items()}

    risk_map, comp_map, components_map = compute_supply_risk(purchases, suppliers, metrics)

    # Only suppliers with both spend (purchases) and a computed risk.
    sids = [s for s in spend_map if s in risk_map]
    spend_map = {s: spend_map[s] for s in sids}
    risk_map = {s: risk_map[s] for s in sids}
    comp_map = {s: comp_map.get(s, 0) for s in sids}

    quad_map, spend_med, risk_med = assign_kraljic_quadrants(spend_map, risk_map)

    sup_meta = (
        suppliers.rename(columns={"externalId": "supplierExternalId"})
        .drop_duplicates("supplierExternalId")
        .set_index("supplierExternalId")
    )
    comp_score = (
        metrics.drop_duplicates("supplierExternalId").set_index("supplierExternalId")
        if len(metrics)
        else pd.DataFrame()
    )

    def name_of(s):
        return str(sup_meta.loc[s, "supplierName"]) if s in sup_meta.index else s

    def perf_of(s):
        # Stage 2: LIVE composite for this filter's POs; stored is the fallback.
        if _LIVE_COMPOSITE_MAP is not None:
            v = _LIVE_COMPOSITE_MAP.get(s)
            return float(v) if v is not None else None
        if len(comp_score) and s in comp_score.index:
            v = comp_score.loc[s, "compositeScore"]
            return float(v) if pd.notna(v) else None
        return None

    def risk_breakdown(s):
        """4 components + their 2dp sum. The total IS the sum of the rounded
        components, so the detail panel's Supply-risk breakdown bars reconcile
        exactly with the supply_risk_score plotted on the scatter (no drift)."""
        c = components_map.get(s, {})
        cc = round(float(c.get("supply_concentration", 0.0)), 2)
        cp = round(float(c.get("cost_premium", 0.0)), 2)
        cf = round(float(c.get("import_friction", 0.0)), 2)
        return round(cc + cp + cf, 2), {
            "supply_concentration": cc,
            "cost_premium": cp,
            "import_friction": cf,
        }

    quadrant_assignments = []
    for s in sids:
        risk_total, risk_components = risk_breakdown(s)
        quadrant_assignments.append(
            {
                "supplier_id": s,
                "supplier_name": name_of(s),
                "log_spend": num(spend_map[s]),
                "supply_risk_score": risk_total,
                "risk_components": risk_components,
                "quadrant": quad_map[s],
            }
        )

    grand_total = sum(total_spend_map[s] for s in sids) or 1.0
    quadrant_profiles = []
    for q in ["Strategic", "Leverage", "Bottleneck", "Routine"]:
        members = [s for s in sids if quad_map[s] == q]
        tot = sum(total_spend_map[s] for s in members)
        perfs = [perf_of(s) for s in members if perf_of(s) is not None]
        quadrant_profiles.append(
            {
                "quadrant": q,
                "n_suppliers": len(members),
                "total_spend": num(tot),
                "pct_of_total_spend": num((tot / grand_total) * 100),
                "avg_performance_score": num(np.mean(perfs)) if perfs else None,
            }
        )

    result = {
        "quadrant_assignments": quadrant_assignments,
        "quadrant_profiles": quadrant_profiles,
        "axis_thresholds": {"spend_median": num(spend_med), "risk_median": num(risk_med)},
    }
    return result, risk_map, comp_map, quad_map


# --------------------------------------------------------------------------- #
# f) Competitive sourcing coverage  (how the spend reached the market)
# --------------------------------------------------------------------------- #
# ⚠️ THREE BUCKETS, NOT TWO — and `framework` is PERMANENT, never folded into
# either side. A call-off draws against a Framework agreement that in real
# procurement was competed once, at framework award. But `Framework` carries NO
# sourcing linkage in this schema — no awarded event, no responses, nothing — so
# the data CANNOT say whether it was. Collapsing to a competed/uncompeted binary
# would be wrong by the entire call-off share (44.78% of spend on the seeded data)
# in whichever direction it were folded. That inability to verify is emitted as a
# first-class finding (`unverifiable_share`), because naming the schema gap is more
# actionable than any single coverage number.
#
# ⚠️ THIS DICT IS THE SINGLE DEFINITION of which method belongs to which bucket —
# the same discipline SOURCED_METHODS/isSourcedMethod carries on the TS side. Never
# re-inline a `method == "rfq"` style test; ask the map.
COVERAGE_BUCKETS = {
    "rfq": "competed",
    "tender": "competed",
    "call_off": "framework",
    "direct": "uncompeted",
    "spot_buy": "uncompeted",
}
BUCKET_ORDER = ("competed", "framework", "uncompeted")


def _split(spend, pos, total_spend, total_pos):
    """One bucket/slice as {spend, pos, spend_pct, pos_pct}."""
    return {
        "spend": num(float(spend), 2),
        "pos": int(pos),
        "spend_pct": num((float(spend) / total_spend * 100) if total_spend else 0.0, 2),
        "pos_pct": num((pos / total_pos * 100) if total_pos else 0.0, 2),
    }


def _empty_coverage():
    """A structurally complete, all-zero payload.

    ⚠️ LOAD-BEARING. Mode A's success gate is `succeeded == len(all_types)`, so an
    emitter that throws (or returns None) on a thin window turns EVERY recompute
    into exit 1 — which would break supplier CRUD, imports, corrections and voids,
    none of which are related to this analysis. Every early-out here returns a valid
    payload instead of raising."""
    zero = {"spend": 0, "pos": 0, "spend_pct": 0, "pos_pct": 0}
    return {
        "total_spend": 0,
        "total_pos": 0,
        "by_bucket": {b: dict(zero) for b in BUCKET_ORDER},
        "by_method": {},
        "by_category": [],
        "by_supplier": [],
        "bidding": {
            "events": 0, "responses": 0, "avg_bids": None,
            "min_bids": None, "max_bids": None, "bids_distribution": {},
            "avg_quote_spread_pct": None, "median_quote_spread_pct": None,
        },
        "framework_leakage": {
            "calloffs": 0, "with_framework": 0,
            "outside_window": 0, "outside_window_spend": 0,
        },
        "unverifiable_share": {
            "spend": 0, "spend_pct": 0, "pos": 0,
            "reason": "framework_has_no_sourcing_linkage",
        },
        "unclassified": {"spend": 0, "pos": 0},
        "mix_adjusted_coverage": {
            "insufficient_data": True, "periods": [], "window_periods": [], "metrics": {},
        },
    }


def _coverage_mix_shift(frame, window_periods=None):
    """Shift-share of each bucket's SHARE OF SPEND, decomposed by CATEGORY.

    For bucket k:  pooled_k = spend_k / spend_total = sum_c w_c * rate_c
        w_c    = category c's share of the period's spend
        rate_c = bucket k's share of category c's spend
    The identity is exact because sum_c (spend_c/total) * (spend_ck/spend_c)
    collapses to sum_c spend_ck / total. Hence:

        mix    = sum_c (w_b[c] - w_a[c]) * rate_a[c]      (WHAT we bought changed)
        within = sum_c  w_b[c] * (rate_b[c] - rate_a[c])  (HOW we bought it changed)
        mix + within == pooled_b - pooled_a, exactly.

    This is the whole point of the metric. Competitive coverage is strongly
    ASSOCIATED with category (proprietary OEM items are bought direct because they
    cannot be competed, not because anyone chose not to), so some part of any
    year-over-year move is just a change in what was bought. The decomposition says
    HOW MUCH — and the answer must be read, never assumed.

    ⚠️ On this data it is NOT mostly mix. The 9.89-point fall in competed share in
    2025 splits -3.51 MIX / -6.37 WITHIN, so roughly two thirds of it is a real
    change in how the same categories were bought; the 2026 recovery (+7.43) is
    almost entirely within (mix -0.02). An earlier draft of this very comment
    asserted the opposite — that the move was "mostly a purchasing-mix shift" —
    and the emitter it documents disproves it. That is exactly why the split is
    computed instead of the intuition being stated as a finding. Do not
    re-introduce a claim about which side dominates without re-reading the output.

    A category absent from one side takes the other side's rate, which attributes
    its whole contribution to MIX (a category appearing or vanishing IS a
    composition change) and keeps the identity exact.

    ⚠️ WINDOW-INDEPENDENT. `frame` is the WHOLE table, so a transition reads the
    same number on every period selection; `window_periods` is carried purely as a
    DISPLAY hint (show transitions ENDING inside the selection). Same contract as
    _mix_adjusted_trend.

    ⚠️ PARALLEL to _mix_adjusted_trend, deliberately NOT a refactor of it. That one
    is COUNT-weighted over a per-PO numeric mean, keyed by METHOD; this one is
    SPEND-weighted over a categorical share, keyed by CATEGORY. Extracting a shared
    generic would put a verified, shipped cycle-time payload on the regression
    surface to save a few dozen lines — the same call already made for
    CorrectionCard vs RecordPurchaseCard.

    ⚠️ DECOMPOSITION ONLY — an arithmetic identity, no distributional assumptions,
    so no p-values and nothing here can be misread as inference. Effects are in
    PERCENTAGE POINTS of spend share, since the metric is itself a share.
    """
    # A frame missing any input column degrades to "insufficient" instead of
    # raising. The caller's own no-buyingMethod branch is only honest if this
    # cannot throw behind it.
    needed = ("period", "_value", "_cat", "_bucket")
    if any(col not in frame.columns for col in needed):
        return {
            "insufficient_data": True, "periods": [],
            "window_periods": sorted(str(x) for x in (window_periods or [])),
            "metrics": {},
        }
    periods = sorted(str(x) for x in frame["period"].dropna().unique())
    out = {
        "insufficient_data": len(periods) < 2,
        "periods": periods,
        "window_periods": sorted(str(x) for x in (window_periods or [])),
        "metrics": {},
    }
    if len(periods) < 2:
        return out

    cats = sorted(str(x) for x in frame["_cat"].dropna().unique())
    for bucket in BUCKET_ORDER:
        by_period = {}
        for per in periods:
            g = frame[frame["period"].astype(str) == per]
            tot = float(g["_value"].sum())
            rates, shares = {}, {}
            for c in cats:
                gc = g[g["_cat"].astype(str) == c]
                cat_spend = float(gc["_value"].sum())
                shares[c] = (cat_spend / tot) if tot else 0.0
                if cat_spend:
                    rates[c] = float(gc[gc["_bucket"] == bucket]["_value"].sum()) / cat_spend
                else:
                    rates[c] = None
            pooled = (
                float(g[g["_bucket"] == bucket]["_value"].sum()) / tot if tot else None
            )
            by_period[per] = {"pooled": pooled, "rates": rates, "shares": shares,
                              "spend": tot, "n": int(len(g))}

        transitions = []
        for a, b in zip(periods, periods[1:]):
            A, B = by_period[a], by_period[b]
            if A["pooled"] is None or B["pooled"] is None:
                continue
            mix = within = 0.0
            per_category = []
            for c in cats:
                ra, rb = A["rates"][c], B["rates"][c]
                if ra is None and rb is None:
                    continue
                ra_e = ra if ra is not None else rb
                rb_e = rb if rb is not None else ra
                wa, wb = A["shares"][c], B["shares"][c]
                mix += (wb - wa) * ra_e
                within += wb * (rb_e - ra_e)
                per_category.append({
                    "category": c,
                    "from_rate_pct": num(ra * 100, 2) if ra is not None else None,
                    "to_rate_pct": num(rb * 100, 2) if rb is not None else None,
                    "within_change_pct": num((rb_e - ra_e) * 100, 2),
                    "from_share_pct": num(wa * 100, 2),
                    "to_share_pct": num(wb * 100, 2),
                })
            pooled_change = B["pooled"] - A["pooled"]
            # Sign reversal, or a pooled move under half the within-category move.
            # Threshold is 1.0 PERCENTAGE POINT of spend share (the cycle-time
            # sibling uses 1.0 DAY) — below that the decomposition is noise either way.
            sign_flip = (pooled_change * within) < 0 and abs(within * 100) >= 1.0
            masked = (
                not sign_flip
                and abs(within * 100) >= 1.0
                and abs(pooled_change) < abs(within) / 2
            )
            # ⚠️ THIRD CASE, and the one this whole feature exists to prevent: a large
            # pooled move that is almost entirely COMPOSITION. Without it, a coverage
            # drop caused purely by buying more OEM equipment reads as a decline in
            # buying discipline — the precise misreading the decomposition was built
            # to stop. The other two branches only catch the pooled number being too
            # SMALL; this catches it being real but attributable to the wrong cause.
            # Inert on current data (no live transition is mix-dominated).
            mix_dominated = (
                not sign_flip and not masked
                and abs(pooled_change * 100) >= 1.0
                and abs(mix) >= 2 * abs(within)
            )
            # Exact by construction, EXCEPT where a category's period spend nets to
            # zero while it still holds bucket spend (only reachable with signed
            # values that cancel). Emitted rather than assumed: a silent residual
            # would be a wrong decomposition wearing a correct-looking total, so it
            # is surfaced the same way `unclassified` surfaces an unknown method.
            residual = pooled_change - (mix + within)
            transitions.append({
                "from": a,
                "to": b,
                "from_pooled_pct": num(A["pooled"] * 100, 2),
                "to_pooled_pct": num(B["pooled"] * 100, 2),
                "pooled_change_pct": num(pooled_change * 100, 2),
                "mix_effect_pct": num(mix * 100, 2),
                "within_effect_pct": num(within * 100, 2),
                "residual_pct": num(residual * 100, 4),
                "pooled_misleading": bool(sign_flip or masked or mix_dominated),
                "reason": (
                    "sign_reversal" if sign_flip
                    else "magnitude_masked" if masked
                    else "mix_dominated" if mix_dominated
                    else None
                ),
                "per_category": per_category,
            })

        out["metrics"][bucket] = {
            "per_period": {
                per: {
                    "n": by_period[per]["n"],
                    "spend": num(by_period[per]["spend"], 2),
                    "pooled_pct": num(by_period[per]["pooled"] * 100, 2)
                    if by_period[per]["pooled"] is not None else None,
                    "shares_pct": {c: num(by_period[per]["shares"][c] * 100, 2) for c in cats},
                    "rates_pct": {
                        c: (num(by_period[per]["rates"][c] * 100, 2)
                            if by_period[per]["rates"][c] is not None else None)
                        for c in cats
                    },
                }
                for per in periods
            },
            "transitions": transitions,
        }
    return out


def sourcing_coverage(purchases, suppliers, metrics):
    """Competitive-sourcing coverage: how much spend reached the market through a
    competitive process, how much drew on a framework, and how much did neither.

    ⚠️ DESCRIPTIVE, NOT AN INDICTMENT. High-value spend concentrates in the
    sole-source OEM and framework channels (median PO value: spot_buy $57.8k, rfq
    $608.5k, tender $1.21M, direct $2.08M, call_off $2.37M). That is NOT evidence of
    weak buyer discipline: every `direct` order on this data carries a
    proprietary/OEM sole-source justification, and an OEM part genuinely cannot be
    competed. The emitter therefore reports the SHAPE of the portfolio and leaves it
    at that — no scoring, no ranking, no recommendation.

    ⚠️ SEVERAL OBVIOUS-LOOKING METRICS ARE DELIBERATELY ABSENT because they are
    degenerate on this data. Verified before building, not assumed:
      · award-to-cheapest      — 226/226 awards went to price rank 1; all-pass.
      · single-bid exposure    — minimum bid count per event is 2; permanently zero.
      · bid response rate      — invited always equals responded; permanently 100%.
      · quote-spread CUTS      — spread is an order statistic of the bid count
        (2 bids 9.22% / 3 bids 12.80% / 4 bids 13.06%). Holding bid count at 3, the
        category (11.15-13.44), period (12.85/12.71/12.84) and supplier cuts all go
        FLAT within sampling noise. A category breakdown would report the bid-count
        mix wearing a category label. The PORTFOLIO number is emitted; no cut is.
      · savings vs the field   — the award is always the minimum, so this is a
        deterministic re-expression of the spread. It also has a scoping trap: a
        Response carries ONE quoted price matching ONE PO line, and that line is
        only ~65% of PO value on average, so any dollar figure invites being scaled
        onto the full competed spend and overstating by ~1.5x.
      · uncompeted price premium — computable on the 26 items bought both ways, and
        pure noise: mean +4.58%, median -6.98%, sd 61.96%, with 14 of the 26 items
        CHEAPER uncompeted against only 12 dearer. The scatter is ~13x the effect,
        so the sign of the "premium" is decided by which items you happen to pick.
    The Methodology page carries the full version of this list and the evidence for
    each exclusion; keep the two in sync if either changes."""
    if len(purchases) == 0:
        return _empty_coverage()

    p = purchases.copy()
    p["_value"] = pd.to_numeric(p["totalValueUsd"], errors="coerce").fillna(0.0)
    if "buyingMethod" in p.columns:
        p["_method"] = p["buyingMethod"].astype(str)
    else:
        # Pre-migration view (no buyingMethod column). Everything lands in
        # `unclassified` rather than being silently attributed to a bucket.
        p["_method"] = ""
    p["_bucket"] = p["_method"].map(COVERAGE_BUCKETS)

    total_spend = float(p["_value"].sum())
    total_pos = int(len(p))

    by_bucket = {}
    for b in BUCKET_ORDER:
        g = p[p["_bucket"] == b]
        by_bucket[b] = _split(g["_value"].sum(), len(g), total_spend, total_pos)

    # An unknown/blank method is unreachable — both import paths reject the
    # vocabulary — but it is COUNTED rather than absorbed, so a regression that
    # introduced one would be visible instead of silently inflating a bucket.
    # Mirrors PeriodComparison.excluded_n.
    unk = p[p["_bucket"].isna()]
    unclassified = {"spend": num(float(unk["_value"].sum()), 2), "pos": int(len(unk))}

    by_method = {}
    for m in sorted(p["_method"].dropna().unique()):
        g = p[p["_method"] == m]
        vals = g["_value"]
        by_method[str(m)] = {
            **_split(vals.sum(), len(g), total_spend, total_pos),
            "bucket": COVERAGE_BUCKETS.get(str(m)),
            "median_po_value": num(float(vals.median()), 2) if len(vals) else None,
            "avg_po_value": num(float(vals.mean()), 2) if len(vals) else None,
        }

    # ⚠️ COMPLETE, never capped — the compute layer emits the full set and the
    # DISPLAY decides what to truncate. Capping here is the documented trap that
    # poisoned three separate displayed counts (.head(15) outliers, head(8)+Other
    # categories, [:5] recommendations).
    # ⚠️ A NULL category is STRUCTURALLY POSSIBLE — the view reaches `category` through
    # `LEFT JOIN dom_cat`, so a PO carrying no lines would arrive with it unset (and
    # with a NULL value too). Zero such rows exist today and no sanctioned write path
    # can make one (every writer requires at least one line), but dropping NULLs here
    # would silently shrink by_category below total_spend — the same silent-drop shape
    # the compute-layer cap trap produced three times. Bucketed explicitly instead, so
    # the rows always re-sum to the total.
    if "category" in p.columns:
        p["_cat"] = p["category"].where(p["category"].notna(), "(uncategorized)").astype(str)
    else:
        p["_cat"] = "(uncategorized)"
    by_category = []
    for c in sorted(str(x) for x in p["_cat"].unique()):
        g = p[p["_cat"] == c]
        cs = float(g["_value"].sum())
        row = {"category": c, "spend": num(cs, 2), "pos": int(len(g))}
        for b in BUCKET_ORDER:
            gb = g[g["_bucket"] == b]
            row[f"{b}_pct"] = num(
                (float(gb["_value"].sum()) / cs * 100) if cs else 0.0, 2
            )
        by_category.append(row)
    by_category.sort(key=lambda r: (-(r["spend"] or 0), r["category"]))

    name_by_sid = {}
    if len(p):
        name_by_sid = (
            p.drop_duplicates("supplierExternalId")
            .set_index("supplierExternalId")["supplierName"]
            .to_dict()
        )
    by_supplier = []
    for sid in sorted(str(x) for x in p["supplierExternalId"].dropna().unique()):
        g = p[p["supplierExternalId"].astype(str) == sid]
        ss = float(g["_value"].sum())
        row = {
            "supplier_id": sid,
            "supplier_name": str(name_by_sid.get(sid, sid)),
            "spend": num(ss, 2),
            "pos": int(len(g)),
            "methods_used": int(g["_method"].nunique()),
        }
        for b in BUCKET_ORDER:
            gb = g[g["_bucket"] == b]
            row[f"{b}_pct"] = num(
                (float(gb["_value"].sum()) / ss * 100) if ss else 0.0, 2
            )
        by_supplier.append(row)
    by_supplier.sort(key=lambda r: (-(r["spend"] or 0), r["supplier_id"]))

    # --- bidding descriptives (PORTFOLIO ONLY — see the docstring on cuts) ----- #
    win_pos = set(p["poId"].astype(str))
    bidding = dict(_empty_coverage()["bidding"])
    if _SOURCING_EVENTS is not None and len(_SOURCING_EVENTS) > 0:
        se = _SOURCING_EVENTS[_SOURCING_EVENTS["poId"].astype(str).isin(win_pos)]
        # Per EVENT, not per PO: an event feeding two POs is one competitive process.
        se = se.drop_duplicates("eventId")
        if len(se) > 0:
            nb = pd.to_numeric(se["n_bids"], errors="coerce").dropna()
            lo = pd.to_numeric(se["min_quote"], errors="coerce")
            hi = pd.to_numeric(se["max_quote"], errors="coerce")
            spread = ((hi - lo) / lo * 100).where(lo > 0).dropna()
            dist = nb.astype(int).value_counts().sort_index()
            bidding = {
                "events": int(len(se)),
                "responses": int(nb.sum()) if len(nb) else 0,
                "avg_bids": num(float(nb.mean()), 2) if len(nb) else None,
                "min_bids": int(nb.min()) if len(nb) else None,
                "max_bids": int(nb.max()) if len(nb) else None,
                "bids_distribution": {str(int(k)): int(v) for k, v in dist.items()},
                "avg_quote_spread_pct": num(float(spread.mean()), 2) if len(spread) else None,
                "median_quote_spread_pct": num(float(spread.median()), 2) if len(spread) else None,
            }

    # --- framework leakage ---------------------------------------------------- #
    # A call-off placed outside its framework's validity window: the one genuine
    # exception the sourcing data carries. CLAUDE.md records the 15 seeded cases as
    # a deliberate property (the date window is intentionally NOT enforced at
    # write time), so this is a live check demonstrating on known data.
    leakage = dict(_empty_coverage()["framework_leakage"])
    calloff = p[p["_bucket"] == "framework"]
    leakage["calloffs"] = int(len(calloff))
    if _CALLOFF_FRAMEWORKS is not None and len(_CALLOFF_FRAMEWORKS) > 0 and len(calloff):
        cf = _CALLOFF_FRAMEWORKS[_CALLOFF_FRAMEWORKS["poId"].astype(str).isin(win_pos)]
        if len(cf) > 0:
            value_by_po = dict(zip(p["poId"].astype(str), p["_value"]))
            has_fw = cf[cf["frameworkId"].notna()]
            outside = cf[cf["outsideWindow"].fillna(False).astype(bool)]
            leakage["with_framework"] = int(len(has_fw))
            leakage["outside_window"] = int(len(outside))
            leakage["outside_window_spend"] = num(
                float(sum(value_by_po.get(str(x), 0.0) for x in outside["poId"])), 2
            )

    # --- THE DATA GAP, as a finding ------------------------------------------- #
    # Not a caveat buried in a footnote: the share of spend whose competitive basis
    # CANNOT BE ESTABLISHED from this schema, stated as a number. It names a
    # concrete schema improvement (link Framework to the sourcing event that
    # awarded it) and is more actionable than any coverage percentage.
    fw = by_bucket["framework"]
    unverifiable = {
        "spend": fw["spend"],
        "spend_pct": fw["spend_pct"],
        "pos": fw["pos"],
        "reason": "framework_has_no_sourcing_linkage",
    }

    # --- window-independent mix decomposition --------------------------------- #
    window_periods = (
        sorted(str(x) for x in p["period"].dropna().unique())
        if "period" in p.columns else []
    )
    if _ALL_METHOD_CYCLES is not None and len(_ALL_METHOD_CYCLES) > 0:
        allm = _ALL_METHOD_CYCLES.copy()
        allm["_value"] = pd.to_numeric(allm["totalValueUsd"], errors="coerce").fillna(0.0)
        allm["_cat"] = allm["category"].astype(str)
        allm["_bucket"] = allm["buyingMethod"].astype(str).map(COVERAGE_BUCKETS)
    else:
        # Direct unit-test call that never set the global (the _ROSTER_CAT_COUNTS
        # convention) — fall back to the window frame.
        # ⚠️ REUSE the columns already derived above (_value / _cat / _bucket) rather
        # than re-deriving from raw ones. Re-deriving made this path depend on raw
        # columns the caller may not carry, so the "everything lands in unclassified"
        # branch above promised a graceful degradation that this line then defeated
        # with a KeyError 150 lines later. Found by adversarial review; the two
        # skeptics that examined it BOTH judged it unreachable and both were wrong —
        # it reproduces on a plain drop(columns=["buyingMethod"]) call.
        allm = p
    mix_adjusted_coverage = _coverage_mix_shift(allm, window_periods=window_periods)

    return {
        "total_spend": num(total_spend, 2),
        "total_pos": total_pos,
        "by_bucket": by_bucket,
        "by_method": by_method,
        "by_category": by_category,
        "by_supplier": by_supplier,
        "bidding": bidding,
        "framework_leakage": leakage,
        "unverifiable_share": unverifiable,
        "unclassified": unclassified,
        "mix_adjusted_coverage": mix_adjusted_coverage,
    }


# cycle_time, kraljic and recommendations are computed separately in main()
# because they need extra arguments beyond the (purchases, suppliers, metrics)
# signature this loop uses.
ANALYSES = [
    ("spend_overview", spend_overview),
    ("abc", abc_analysis),
    ("performance_spend", performance_spend_analysis),
    ("sourcing_coverage", sourcing_coverage),
]


# --------------------------------------------------------------------------- #
# g) Recommendations engine  (synthesizes all 4 analyses into ranked actions)
#    Self-contained: recomputes its own intermediate data via the shared 11A
#    helpers so it never depends on execution order. All impact scores are
#    normalized to [0, 100] so the global ranking is comparable across the
#    categories, while each remains proportional to its category's key metric.
# --------------------------------------------------------------------------- #
# Concentration (resilience) threshold — a spend CATEGORY whose share of total
# spend exceeds this is surfaced as a structural-exposure item. Concentration is
# now CATEGORY-LEVEL ONLY; supplier-level criticality (the old >10% supplier
# branch) moved to the Critical Spend (A-items) category to de-dupe the two.
CATEGORY_CONC_THRESHOLD = 0.30  # a spend category > 30% of total
# Tail-spend threshold — a supplier under this share of total spend counts as
# "tail" (a long-tail consolidation candidate).
TAIL_SPEND_SHARE = 0.01  # a single supplier < 1% of total


def recommendations_analysis(purchases, suppliers, metrics, period_label=""):
    spend_raw = purchases.groupby("supplierExternalId")["totalValueUsd"].sum()
    total_spend_map = {sid: float(v) for sid, v in spend_raw.items()}
    log_spend_map = {sid: float(np.log1p(v)) for sid, v in spend_raw.items()}
    max_log = max(log_spend_map.values()) if log_spend_map else 1.0
    total_spend = float(spend_raw.sum())

    # Reuse the existing ABC/Pareto tiers (80/95 cumulative split) — do NOT
    # re-implement the classify. The A-tier drives Critical Spend; the tail
    # (sub-1% suppliers) drives Tail spend; the A-count feeds the Spend finding.
    abc = abc_analysis(purchases, suppliers, metrics)

    risk_map, comp_map, _components = compute_supply_risk(purchases, suppliers, metrics)
    krj_sids = [s for s in log_spend_map if s in risk_map]
    if krj_sids:
        quad_map, _sm, _rm = assign_kraljic_quadrants(
            {s: log_spend_map[s] for s in krj_sids},
            {s: risk_map[s] for s in krj_sids},
        )
    else:
        quad_map = {}

    sup_meta = (
        suppliers.rename(columns={"externalId": "supplierExternalId"})
        .drop_duplicates("supplierExternalId")
        .set_index("supplierExternalId")
    )
    m = (
        metrics.drop_duplicates("supplierExternalId").set_index("supplierExternalId")
        if len(metrics)
        else pd.DataFrame()
    )

    def name_of(s):
        return str(sup_meta.loc[s, "supplierName"]) if s in sup_meta.index else s

    def country_of(s):
        return (
            str(sup_meta.loc[s, "country"])
            if s in sup_meta.index and "country" in sup_meta.columns
            else ""
        )

    def perf_of(s):
        # Stage 2: LIVE composite for this filter's POs; stored is the fallback.
        if _LIVE_COMPOSITE_MAP is not None:
            v = _LIVE_COMPOSITE_MAP.get(s)
            return float(v) if v is not None else None
        if len(m) and s in m.index and pd.notna(m.loc[s, "compositeScore"]):
            return float(m.loc[s, "compositeScore"])
        return None

    def spend_norm(s):
        return (log_spend_map[s] / max_log * 100.0) if max_log > 0 else 0.0

    def usd(v):
        return f"${v:,.0f}"

    # Suppliers with spend + performance + a quadrant (zone universe).
    sids = [s for s in krj_sids if perf_of(s) is not None]
    spend_med = float(np.median([log_spend_map[s] for s in sids])) if sids else 0.0
    perf_med = float(np.median([perf_of(s) for s in sids])) if sids else 0.0

    def zone_of(s):
        hi_spend = log_spend_map[s] > spend_med
        hi_perf = perf_of(s) > perf_med
        if hi_spend and hi_perf:
            return "Stars"
        if hi_spend and not hi_perf:
            return "Critical Issues"
        if not hi_spend and hi_perf:
            return "Hidden Gems"
        return "Long Tail"

    recs = []

    # CATEGORY 1: critical-issues engagement (top 5 by spend).
    crit = sorted(
        [s for s in sids if zone_of(s) == "Critical Issues"],
        key=lambda s: total_spend_map[s],
        reverse=True,
    )[:5]
    for s in crit:
        gap = max(0.0, perf_med - perf_of(s))
        recs.append({
            "type": "critical_issues_engagement",
            "action": "engage",
            "supplier_id": s,
            "supplier_name": name_of(s),
            "reasoning": (
                f"High-spend supplier with concerning performance. Spend exposure "
                f"{usd(total_spend_map[s])}, performance score {perf_of(s):.1f} "
                f"(below {perf_med:.1f} median). Kraljic quadrant: {quad_map.get(s)}. "
                f"Initiate supplier development engagement or identify alternatives."
            ),
            "impact_score": num(min(100.0, 0.7 * spend_norm(s) + 0.3 * min(100.0, gap * 2))),
            "total_spend_usd": num(total_spend_map[s]),
            "performance_score": num(perf_of(s)),
            "kraljic_quadrant": quad_map.get(s),
        })

    # CATEGORY 2: hidden-gems promotion (top 5 by performance).
    gems = sorted(
        [s for s in sids if zone_of(s) == "Hidden Gems"],
        key=lambda s: perf_of(s),
        reverse=True,
    )[:5]
    denom = (100.0 - perf_med) or 1.0
    for s in gems:
        surplus = max(0.0, perf_of(s) - perf_med)
        recs.append({
            "type": "hidden_gems_promotion",
            "action": "promote",
            "supplier_id": s,
            "supplier_name": name_of(s),
            "reasoning": (
                f"High-performance supplier (score {perf_of(s):.1f}) with currently "
                f"small spend exposure ({usd(total_spend_map[s])}). Strong candidate "
                f"for expanded scope — evaluate for an expanded share of wallet."
            ),
            "impact_score": num(min(100.0, surplus / denom * 100.0)),
            "total_spend_usd": num(total_spend_map[s]),
            "performance_score": num(perf_of(s)),
        })

    # CATEGORY 3: bottleneck risk mitigation (top 5 by supply risk).
    bottleneck = sorted(
        [s for s in sids if quad_map.get(s) == "Bottleneck"],
        key=lambda s: risk_map.get(s, 0.0),
        reverse=True,
    )[:5]
    for s in bottleneck:
        ctry = country_of(s)
        recs.append({
            "type": "bottleneck_risk",
            "action": "mitigate",
            "supplier_id": s,
            "supplier_name": name_of(s),
            "reasoning": (
                f"Low-spend supplier ({usd(total_spend_map[s])}) with high supply risk "
                f"(score {risk_map[s]:.1f}). "
                f"Country: {ctry or 'n/a'}, Category alternatives: {comp_map.get(s, 0)}. "
                f"Develop alternative suppliers, build inventory buffers, or explore "
                f"standardization."
            ),
            "impact_score": num(min(100.0, risk_map[s])),
            "supply_risk_score": num(risk_map[s]),
            "country": ctry,
            "total_spend_usd": num(total_spend_map[s]),
        })

    # CATEGORY 4: process improvement (non-supplier-specific; up to 3).
    pq = purchases.copy()
    pq["quadrant"] = pq["supplierExternalId"].map(quad_map)
    fails = []
    for q in ["Strategic", "Leverage", "Bottleneck", "Routine"]:
        sub = pq[pq["quadrant"] == q]
        n = len(sub)
        if n:
            fails.append((q, float((~sub["threeWayMatchPass"].astype(bool)).sum() / n * 100), n))
    proc = []
    if fails:
        wq = max(fails, key=lambda x: x[1])
        proc.append({
            "type": "process_improvement",
            "action": "improve",
            "scope": f"Quadrant: {wq[0]} compliance",
            "reasoning": (
                f"3-way match failure rate is {wq[1]:.1f}% in the {wq[0]} quadrant "
                f"({wq[2]} POs) — the weakest match compliance among quadrants."
            ),
            "impact_score": num(min(100.0, wq[1])),
        })
    # Improve is now COMPLIANCE-ONLY: the per-stage timing items moved to the
    # dedicated slow_stage category (CATEGORY 4b) so a slow stage isn't listed
    # under two Process-group categories at once.
    recs.extend(proc)

    # CATEGORY 4b: slowest stage — the internal P2P stages above the 8-day flag,
    # ranked by average days desc. PO→Delivery is physical supplier lead time
    # (not an internal stage), so it is excluded — consistent with the Improve
    # flag. Reuses the same per-stage means the flag uses; share-of-cycle = this
    # stage's mean / the sum of all four stage means (matches the "% of cycle"
    # the Process Health page shows).
    internal_stages = [
        ("prToPoDays", "PR to PO"),
        ("deliveryToInvoiceDays", "Delivery to Invoice"),
        ("invoiceToPaymentDays", "Invoice to Payment"),
    ]
    slow = []
    for col, label in internal_stages:
        sv = pd.to_numeric(purchases[col], errors="coerce").dropna()
        if len(sv) and sv.mean() > 8:
            slow.append((label, float(sv.mean())))
    slow.sort(key=lambda x: x[1], reverse=True)
    for i, (label, avg) in enumerate(slow):
        lead = (
            "the longest internal stage, well above the 8-day flag — the main "
            "drag on cycle time"
            if i == 0
            else "above the 8-day flag — a secondary drag on cycle time"
        )
        recs.append({
            "type": "slow_stage",
            "action": "streamline",
            "scope": f"Stage: {label}",
            "reasoning": f"{label} averages {avg:.1f} days — {lead}.",
            "impact_score": num(min(100.0, avg / 18.0 * 100.0)),
            "avg_days": num(avg),
        })

    # CATEGORY 5: concentration (resilience exposure — distinct from performance).
    # CATEGORY-LEVEL ONLY now (share > 30%); supplier-level criticality moved to
    # Critical Spend. Framing is a light "worth a look" nudge; the raw % lives on
    # the card chip + the Classification page, so the reasoning does NOT restate it.
    conc_items = []
    if total_spend > 0:
        cat_spend = purchases.groupby("category")["totalValueUsd"].sum()
        for cat, csp in cat_spend.items():
            share = float(csp) / total_spend
            if share > CATEGORY_CONC_THRESHOLD:
                conc_items.append({
                    "type": "concentration", "action": "diversify",
                    "concentration_kind": "category", "category": str(cat),
                    "share_pct": num(share * 100.0), "total_spend_usd": num(float(csp)),
                    "reasoning": (
                        f"Spend is heavily concentrated in {cat}. A disruption here would "
                        f"hit hard with limited fallback — worth a category-diversification "
                        f"or second-source review."
                    ),
                    "impact_score": num(min(100.0, share * 100.0)),
                    "_share": share,
                })
        conc_items.sort(key=lambda r: r["_share"], reverse=True)
        for r in conc_items:
            del r["_share"]
        recs.extend(conc_items)

    # CATEGORY 6: critical spend — the A-tier "vital few" (reuse ABC). Supplier
    # criticality (moved from Concentration's old supplier-level branch); ranked
    # by spend desc. Light stewardship nudge, NOT a number restatement.
    a_items = sorted(
        [c for c in abc["classifications"] if c["abc_class"] == "A"],
        key=lambda c: c["total"],
        reverse=True,
    )
    for c in a_items:
        share_pct = float(c["pct"]) * 100.0
        recs.append({
            "type": "critical_spend",
            "action": "steward",
            "supplier_id": c["supplier_id"],
            "supplier_name": c["supplier_name"],
            "abc_class": "A",
            "reasoning": (
                "One of your largest spend relationships — make sure a formal "
                "contract, SLA, and regular business review are in place so a "
                "supplier this central is actively managed, not merely paid."
            ),
            "impact_score": num(min(100.0, share_pct)),
            "total_spend_usd": num(float(c["total"])),
            "share_pct": num(share_pct),
        })

    # CATEGORY 7: tail spend — ONE portfolio-summary card (not per-supplier).
    # Suppliers each under 1% of total spend: their count, combined spend share,
    # and share of the supplier roster — long-tail consolidation candidates.
    tail = []
    if total_spend > 0:
        tail = [
            (s, float(v)) for s, v in spend_raw.items()
            if (float(v) / total_spend) < TAIL_SPEND_SHARE
        ]
    if tail:
        n_total = int(len(spend_raw))
        tail_count = len(tail)
        tail_sum = sum(v for _, v in tail)
        tail_share = tail_sum / total_spend * 100.0
        tail_sup_pct = tail_count / n_total * 100.0
        recs.append({
            "type": "tail_spend",
            "action": "consolidate",
            "scope": "Tail spend",
            "reasoning": (
                f"{tail_count} suppliers each under 1% of spend account for "
                f"{tail_share:.0f}% of spend but {tail_sup_pct:.0f}% of your supplier "
                f"count — a long tail worth reviewing for consolidation."
            ),
            "impact_score": num(min(100.0, tail_sup_pct)),
            "total_spend_usd": num(tail_sum),
            "tail_supplier_count": tail_count,
            "tail_spend_share_pct": num(tail_share),
            "tail_supplier_pct": num(tail_sup_pct),
        })

    recs.sort(key=lambda r: r["impact_score"] if r["impact_score"] is not None else 0.0, reverse=True)

    by_category = {
        "critical_issues_engagement": 0,
        "hidden_gems_promotion": 0,
        "bottleneck_risk": 0,
        "process_improvement": 0,
        "concentration": 0,
        "critical_spend": 0,
        "tail_spend": 0,
        "slow_stage": 0,
    }
    for r in recs:
        by_category[r["type"]] = by_category.get(r["type"], 0) + 1

    # SYNTHESIS narrative — one computed finding per source analysis (Spend /
    # Suppliers / Process) for the page's "what each analysis found" strip.
    n_suppliers = int(purchases["supplierExternalId"].nunique())
    top10 = set(spend_raw.sort_values(ascending=False).head(10).index)
    # Supplier "attention" = the supplier-level problem categories (engage +
    # mitigate). Critical Spend is deliberately excluded — it's spend-side and
    # would trivially pull in every top-10 spender.
    attention = {
        r.get("supplier_id")
        for r in recs
        if r.get("supplier_id")
        and r["type"] in ("critical_issues_engagement", "bottleneck_risk")
    }
    top10_in_attention = len(top10 & attention)
    if total_spend > 0 and len(purchases):
        cat_spend2 = purchases.groupby("category")["totalValueUsd"].sum()
        top_cat = str(cat_spend2.idxmax())
        top_cat_share = float(cat_spend2.max()) / total_spend * 100.0
    else:
        top_cat, top_cat_share = "", 0.0
    # Spend finding also cites the A-item count; Process finding cites the
    # slowest internal stage (None when nothing clears the 8-day flag).
    a_items_count = int(sum(1 for c in abc["classifications"] if c["abc_class"] == "A"))
    slowest_stage_name = slow[0][0] if slow else ""
    slowest_stage_avg = num(slow[0][1]) if slow else None

    return {
        "recommendations": recs,
        "summary_stats": {
            "total_recommendations": len(recs),
            "by_category": by_category,
            "highest_impact": recs[0] if recs else None,
            "narrative": {
                "n_suppliers": n_suppliers,
                "total_spend": num(total_spend),
                "top10_in_attention": top10_in_attention,
                "top_category_name": top_cat,
                "top_category_share_pct": num(top_cat_share),
                "a_items_count": a_items_count,
                "slowest_stage_name": slowest_stage_name,
                "slowest_stage_avg_days": slowest_stage_avg,
            },
        },
    }


# --------------------------------------------------------------------------- #
# Persistence (Mode A)
# --------------------------------------------------------------------------- #
def upsert(conn, period_id, analysis_type, result):
    payload = json.dumps(result, default=json_default, allow_nan=False)
    new_id = "c" + uuid.uuid4().hex
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "AnalysisResult" ("id", "periodId", "analysisType", "resultJson", "computedAt")
            VALUES (%s, %s, %s, %s::jsonb, NOW())
            ON CONFLICT ("periodId", "analysisType")
            DO UPDATE SET "resultJson" = EXCLUDED."resultJson", "computedAt" = NOW()
            """,
            (new_id, period_id, analysis_type, payload),
        )
    conn.commit()


def get_period_dates(conn, period_id):
    with conn.cursor() as cur:
        cur.execute(
            'SELECT "startDate", "endDate", "name" FROM "ReportingPeriod" WHERE id = %s',
            (period_id,),
        )
        row = cur.fetchone()
    if not row:
        raise RuntimeError(f"ReportingPeriod {period_id} not found")
    return row[0], row[1], row[2]


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    parser = argparse.ArgumentParser(description="Compute procurement analyses.")
    parser.add_argument("--period-id", help="Mode A: compute + upsert for a period")
    parser.add_argument("--start-date", help="Mode B: range start (YYYY-MM-DD)")
    parser.add_argument("--end-date", help="Mode B: range end (YYYY-MM-DD)")
    args = parser.parse_args()

    if args.period_id:
        mode = "A"
    elif args.start_date and args.end_date:
        mode = "B"
    else:
        log("ERROR: pass --period-id OR both --start-date and --end-date")
        sys.exit(2)

    load_env()
    dsn = get_dsn()
    conn = None
    try:
        conn = psycopg2.connect(dsn)

        if mode == "A":
            start_ts, end_ts, period_name = get_period_dates(conn, args.period_id)
            log(f"Mode A: period '{period_name}' ({start_ts} .. {end_ts})")
        else:
            start_ts = f"{args.start_date} 00:00:00"
            end_ts = f"{args.end_date} 23:59:59"
            log(f"Mode B: range {start_ts} .. {end_ts}")

        # A1: load the full-roster category sizes ONCE (all known suppliers,
        # active or not) so supply_concentration counts available alternatives
        # against the whole roster, not just this window's active suppliers.
        global _ROSTER_CAT_COUNTS
        _ROSTER_CAT_COUNTS = load_roster_category_counts(conn)
        log(
            f"Loaded roster category sizes: {len(_ROSTER_CAT_COUNTS)} categories, "
            f"{sum(_ROSTER_CAT_COUNTS.values())} suppliers (full roster)"
        )

        # Window-INDEPENDENT year-over-year mix decomposition (see _ALL_METHOD_CYCLES).
        # Feeds BOTH cycle_time's mix-adjusted trend and sourcing_coverage's
        # category mix decomposition — one whole-table read, two consumers.
        global _ALL_METHOD_CYCLES
        _ALL_METHOD_CYCLES = load_all_method_cycles(conn)
        log(
            f"Loaded all-period method cycles: {len(_ALL_METHOD_CYCLES)} POs across "
            f"{_ALL_METHOD_CYCLES['period'].nunique()} periods (window-independent)"
        )

        # Sourcing bid graph + call-off framework windows. Keyed by poId and
        # intersected against the window frame inside the emitter, which inherits
        # the view's void exclusion instead of re-spelling it (no 5th void site).
        global _SOURCING_EVENTS, _CALLOFF_FRAMEWORKS
        _SOURCING_EVENTS = load_sourcing_events(conn)
        _CALLOFF_FRAMEWORKS = load_calloff_frameworks(conn)
        log(
            f"Loaded sourcing graph: {_SOURCING_EVENTS['eventId'].nunique()} events "
            f"across {len(_SOURCING_EVENTS)} sourced POs, "
            f"{len(_CALLOFF_FRAMEWORKS)} call-offs with framework windows"
        )

        suppliers, purchases, metrics = load_frames(conn, start_ts, end_ts)
        log(
            f"Loaded {len(suppliers)} suppliers, {len(purchases)} purchases, "
            f"{len(metrics)} metrics"
        )
        if len(purchases) == 0:
            log("ERROR: no purchases in range; nothing to compute.")
            sys.exit(1)

        # Stage 2: compute the composite LIVE from THIS window's filtered POs
        # (re-aggregate delivery/process + score via scores.build_window_metrics)
        # instead of reading the stored per-period SupplierMetric.compositeScore.
        # The three perf_of functions read this map — single-year reproduces the
        # stored composite exactly; range/multi-year becomes a true span-aggregate.
        global _LIVE_COMPOSITE_MAP
        _LIVE_COMPOSITE_MAP = build_live_composite_map(purchases, suppliers, metrics)
        log(f"Live composite map: {len(_LIVE_COMPOSITE_MAP)} suppliers (from filtered POs)")

        # Window PoLine frame for the line-grain cost_premium term (lock C).
        global _PO_LINES
        _PO_LINES = load_po_lines(conn, start_ts, end_ts)
        log(f"Loaded {len(_PO_LINES)} PO lines (for cost-premium benchmarking)")

        results = {}
        for name, fn in ANALYSES:
            try:
                log(f"Computing {name}...")
                results[name] = fn(purchases, suppliers, metrics)
            except Exception as exc:  # noqa: BLE001
                log(f"FAILED {name}: {exc}")
                traceback.print_exc(file=sys.stderr)
                results[name] = None

        # Kraljic returns supplier-level maps alongside its payload; only the
        # payload is persisted now (the SupplierMetric denormalization was dropped —
        # those columns were written every recompute and read by nothing).
        try:
            log("Computing kraljic...")
            kr_result, _risk_map, _comp_map, _quad_map = kraljic_analysis(
                purchases, suppliers, metrics
            )
            results["kraljic"] = kr_result
        except Exception as exc:  # noqa: BLE001
            log(f"FAILED kraljic: {exc}")
            traceback.print_exc(file=sys.stderr)
            results["kraljic"] = None

        # Recommendations synthesize all analyses; computed separately because
        # they need a human-readable period label (not available in the ANALYSES
        # 3-arg loop signature).
        period_label = period_name if mode == "A" else f"{args.start_date} – {args.end_date}"
        try:
            log("Computing recommendations...")
            results["recommendations"] = recommendations_analysis(
                purchases, suppliers, metrics, period_label
            )
        except Exception as exc:  # noqa: BLE001
            log(f"FAILED recommendations: {exc}")
            traceback.print_exc(file=sys.stderr)
            results["recommendations"] = None

        # Cycle time: monitoring + a default midpoint-split period comparison.
        # Computed separately because it needs the period bounds.
        try:
            log("Computing cycle_time...")
            results["cycle_time"] = cycle_time_analysis(
                purchases, suppliers, metrics, start_ts, end_ts
            )
        except Exception as exc:  # noqa: BLE001
            log(f"FAILED cycle_time: {exc}")
            traceback.print_exc(file=sys.stderr)
            results["cycle_time"] = None

        all_types = [n for n, _ in ANALYSES] + [
            "kraljic",
            "recommendations",
            "cycle_time",
        ]

        if mode == "A":
            succeeded = 0
            for name in all_types:
                if results.get(name) is not None:
                    upsert(conn, args.period_id, name, results[name])
                    succeeded += 1
            log(
                f"Done. {succeeded}/{len(all_types)} analyses upserted for period {args.period_id}."
            )
            sys.exit(0 if succeeded == len(all_types) else 1)
        else:
            # Mode B: pure JSON to stdout.
            print(json.dumps(results, default=json_default, allow_nan=False))
            sys.exit(0)

    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        log(f"FATAL: {exc}")
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    main()

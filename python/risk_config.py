"""Loader for config/risk-model.json — the single source of truth for the two
risk composites' component weights, enabled flags, and polarity.

Phase-1 binding consumer of the config. compute_analyses.compute_supply_risk reads
the `supplyRisk` composite; scores.compute_scores reads `performanceRisk`. Both go
through resolve_effective_weights (the ONE renormalization function) and combine_score
(the ONE polarity/clip fold), so neither can drift from the config or from each other.

Pure + deterministic apart from the one-time JSON read. The path resolves relative to
THIS file so it is correct regardless of the caller's CWD (compute_analyses,
seed_compute, scripts/transform_dataset, and the tests all import scores, which imports
this)."""

import functools
import json
import os

import numpy as np

import formula_eval

_HERE = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.path.normpath(os.path.join(_HERE, "..", "config", "risk-model.json"))

# Float tolerance for the "weights sum to 1.0" checks. Generous enough to absorb the
# representation error of non-dyadic weights (0.6 + 0.4), tight enough to reject a
# genuinely malformed config (e.g. 0.5/0.3/0.25 = 1.05).
WEIGHT_SUM_TOL = 1e-9

# The aggregation vocabulary for `aggregate` catalogue variables (Stage E) — the ONLY
# allowed `agg` values, so the set of per-supplier aggregations stays under our control
# rather than the user's (a catalogue-design constraint). scores.build_aggregate_map is
# the dispatcher; this is the validator's copy so a hand-edited config fails at load.
AGG_FUNCS = ("mean", "rate_pct", "share_ge1_pct", "defect_ratio_pct", "spend_share_pct")


@functools.lru_cache(maxsize=1)
def load_risk_model(path=None):
    """Parse and validate config/risk-model.json (cached). Every composite's declared
    weights are validated to sum to 1.0 at load time, so a malformed config fails fast
    the first time any risk score is computed."""
    with open(path or _CONFIG_PATH, encoding="utf-8") as f:
        model = json.load(f)
    for composite in model["composites"]:
        validate_composite(composite)
    for table_id, table in model.get("lookupTables", {}).items():
        validate_lookup_table(table_id, table)
    validate_variables(model)
    return model


def get_composite(composite_id):
    """Return the composite dict for 'supplyRisk' | 'performanceRisk'."""
    for composite in load_risk_model()["composites"]:
        if composite["id"] == composite_id:
            return composite
    raise KeyError(f"risk-model.json: no composite '{composite_id}'")


# --------------------------------------------------------------------------- #
# Lookup tables (Stage A) — the geographic + concentration lookups that were
# hardcoded in scores.py / compute_analyses.py now live in config.lookupTables.
# THIS is the ONE loader both files read (scores.country_distance_score /
# concentration_0_100 and compute_analyses._import_friction_points all delegate
# here), so there is no second load path. `concentration_curve` is SHARED by
# supplyRisk.supply_concentration AND performanceRisk.roster_concentration.
# --------------------------------------------------------------------------- #
def get_lookup_table(table_id):
    """Return the lookup table dict for a table id from config.lookupTables."""
    tables = load_risk_model().get("lookupTables", {})
    if table_id not in tables:
        raise KeyError(f"risk-model.json: no lookup table '{table_id}'")
    return tables[table_id]


def lookup_numeric(table_id, key):
    """Value for an INTEGER-keyed step table (e.g. concentration_curve). Any key not
    listed -> the table's explicit `default`. Reproduces the old
    `_CONC_POINTS.get(int(key), 0.0) * 2.0` exactly: the stored values ARE the already
    doubled 0-100 axis (50->100, 35->70, ...), read straight back."""
    table = get_lookup_table(table_id)
    ikey = int(key)
    for row in table["rows"]:
        if int(row["key"]) == ikey:
            return float(row["value"])
    return float(table["default"])


def lookup_country(table_id, code):
    """Value for a COUNTRY-code table (country_distance / import_friction). Mirrors the
    historical `str(code).strip().upper()` match against each row's `members`
    (case-normalized on both sides); no match -> the explicit `default`. Members are
    disjoint across rows in the shipped config, so row order is irrelevant."""
    table = get_lookup_table(table_id)
    c = str(code).strip().upper()
    for row in table["rows"]:
        if c in (str(m).strip().upper() for m in row.get("members", ())):
            return float(row["value"])
    return float(table["default"])


# --------------------------------------------------------------------------- #
# Variable catalogue + the formula evaluator's env/composite layer (Stage D).
# A `variables` entry is a per-supplier scalar RESOLVED OUTSIDE the evaluator (a table
# lookup, or — Stage G — a partition group) and injected into env[id]. A component's
# `formula` composes those ids; evaluate_composite folds a composite over one supplier's env.
# --------------------------------------------------------------------------- #
def get_variables():
    return load_risk_model().get("variables", {})


def get_variable(var_id):
    variables = get_variables()
    if var_id not in variables:
        raise KeyError(f"risk-model.json: no variable '{var_id}'")
    return variables[var_id]


def validate_variables(model):
    """Fail-fast catalogue checks (Stage D):
      - a variable id may not shadow a whitelisted function name (min/max/abs/sqrt);
      - a `lookup` variable's table must exist and it must declare a `key`;
      - a `computed` variable must declare a numeric `default` (its own missing-value handling,
        since it has no table);
      - supply_concentration + roster_concentration must reference the SAME (table, key) — one
        signal under two ids (the documented r=-0.852 correlation follows from it), so a silent
        split is disallowed;
      - every component `formula` references only known variables. (The per-component
        `lookupTable` field was DROPPED in Prerequisite P; table references are now derived from
        formula -> variables -> table, so there is no lookupTable/formula cross-check here.)"""
    variables = model.get("variables", {})
    tables = model.get("lookupTables", {})
    for vid, var in variables.items():
        if formula_eval.is_reserved_name(vid):
            raise ValueError(f"risk-model variable '{vid}': id shadows reserved function name")
        kind = var.get("kind")
        if kind == "lookup":
            if var.get("table") not in tables:
                raise ValueError(f"risk-model variable '{vid}': lookup table {var.get('table')!r} not found")
            if not var.get("key"):
                raise ValueError(f"risk-model variable '{vid}': a lookup variable needs a 'key'")
        elif kind == "computed":
            if not isinstance(var.get("default"), (int, float)) or isinstance(var.get("default"), bool):
                raise ValueError(f"risk-model variable '{vid}': a computed variable needs a numeric 'default'")
        elif kind == "aggregate":
            if not isinstance(var.get("source"), str) or not var.get("source"):
                raise ValueError(f"risk-model variable '{vid}': an aggregate variable needs a 'source' column")
            if var.get("agg") not in AGG_FUNCS:
                raise ValueError(
                    f"risk-model variable '{vid}': aggregate 'agg' must be one of {AGG_FUNCS}, got {var.get('agg')!r}"
                )
            if not isinstance(var.get("default"), (int, float)) or isinstance(var.get("default"), bool):
                raise ValueError(f"risk-model variable '{vid}': an aggregate variable needs a numeric 'default'")
        elif kind == "locked":
            if not isinstance(var.get("locked"), str) or not var.get("locked"):
                raise ValueError(f"risk-model variable '{vid}': a locked variable needs a 'locked' reason")
        else:
            raise ValueError(f"risk-model variable '{vid}': unknown kind {kind!r}")

    a, b = variables.get("supply_concentration"), variables.get("roster_concentration")
    if a and b and (a.get("table"), a.get("key")) != (b.get("table"), b.get("key")):
        raise ValueError(
            "risk-model: supply_concentration and roster_concentration must reference the SAME "
            "(table, key) — one signal under two ids; splitting them is disallowed"
        )

    for composite in model["composites"]:
        for comp in composite["components"]:
            formula = comp.get("formula")
            if not formula:
                continue
            refs = formula_eval.referenced_names(formula)
            for ref in refs:
                if ref not in variables:
                    raise ValueError(
                        f"risk-model composite '{composite['id']}' component '{comp['id']}': "
                        f"formula references unknown variable {ref!r}"
                    )
                if variables[ref].get("locked"):
                    raise ValueError(
                        f"risk-model composite '{composite['id']}' component '{comp['id']}': "
                        f"formula references LOCKED variable {ref!r}: {variables[ref]['locked']}"
                    )

    validate_builtin_input_block(model)


def validate_builtin_input_block(model):
    """Stage E structural double-count guard, DERIVED from the dependency graph (never
    hardcoded). A variable declares `feedsBuiltin` = the builtin sub-score it is an input
    to (defect/complaint -> quality_score, on-time/lead -> delivery_score, 3-way-match ->
    process_score). A composite that PRODUCES a builtin sub-score (via a component's
    `configuredIn`, e.g. performanceRisk -> risk_score) must NOT reference a variable that
    feeds a SIBLING builtin of what it produces: that field would enter the parent composite
    (performanceComposite) twice at different weights, multiplying rather than adding — the
    Stage-1 hazard one level deeper. A variable feeding the composite's OWN produced builtin
    is fine (that is the definition, not a duplicate). supplyRisk produces no builtin, so it
    is never blocked (its note is a UI concern, not an arithmetic error). Rejected at LOAD so
    a hand-edited config cannot smuggle a double-count past the settings-UI block."""
    variables = model.get("variables", {})
    builtins_of_parent, produced_by, parent_of_builtin = {}, {}, {}
    for composite in model["composites"]:
        for comp in composite["components"]:
            if comp.get("builtin"):
                builtins_of_parent.setdefault(composite["id"], set()).add(comp["id"])
                parent_of_builtin[comp["id"]] = composite["id"]
            if comp.get("configuredIn"):
                produced_by[comp["configuredIn"]] = comp["id"]
    for composite in model["composites"]:
        produced = produced_by.get(composite["id"])  # e.g. performanceRisk -> "risk_score"
        if not produced:
            continue
        siblings = builtins_of_parent.get(parent_of_builtin.get(produced), set())
        for comp in composite["components"]:
            if not comp.get("enabled", True) or not comp.get("formula"):
                continue
            for ref in formula_eval.referenced_names(comp["formula"]):
                fb = variables.get(ref, {}).get("feedsBuiltin")
                if fb and fb != produced and fb in siblings:
                    raise ValueError(
                        f"risk-model: variable {ref!r} feeds builtin {fb!r} and is BLOCKED in "
                        f"composite {composite['id']!r} (which produces sibling builtin "
                        f"{produced!r}) — it would enter the composite twice"
                    )


def resolve_env(var_ids, key_values, computed_maps):
    """Build the per-supplier env {var_id -> float} for `var_ids`. A lookup variable applies its
    table to the supplier's declared key field (key_values[var['key']]); a computed variable
    reads its precomputed map by supplier id, falling back to the catalogue `default`. THE
    resolver layer — the evaluator never does this."""
    env = {}
    for vid in var_ids:
        var = get_variable(vid)
        if var["kind"] == "lookup":
            table = get_lookup_table(var["table"])
            key_val = key_values[var["key"]]
            if table.get("input") == "count":
                env[vid] = lookup_numeric(var["table"], int(key_val))
            else:
                env[vid] = lookup_country(var["table"], key_val)
        else:  # computed
            m = computed_maps.get(vid, {})
            env[vid] = float(m.get(key_values["supplier_id"], var.get("default", 0.0)))
    return env


def evaluate_composite(composite, env):
    """Fold a composite over ONE supplier's env via each ENABLED component's FORMULA + bounds,
    iterating in DECLARED CONFIG ORDER — float addition is not associative, so the order is part
    of the byte-identity; do NOT reorder to a dict/set (test_evaluate_composite_order guards it).
    Returns (score, contributions): score = combine_score(sum of weight*normalized, invert),
    contributions = {component_id -> weight*normalized}."""
    weights = resolve_effective_weights(composite)
    invert = invert_polarity(composite)
    total = 0.0
    contributions = {}
    for comp in composite["components"]:  # DECLARED ORDER — load-bearing for byte-identity
        if not comp.get("enabled", True):
            continue
        cid = comp["id"]
        bounds = comp.get("bounds", {"lo": 0.0, "hi": 100.0})
        value = formula_eval.normalize_to_bounds(
            formula_eval.evaluate_formula(comp["formula"], env),
            bounds["lo"],
            bounds["hi"],
        )
        contribution = weights[cid] * value
        contributions[cid] = contribution
        total += contribution
    return float(combine_score(total, invert)), contributions


def validate_composite(composite, tol=WEIGHT_SUM_TOL):
    """Reject a config whose (declared) component weights don't sum to 1.0 within
    tolerance. The error names the composite. This checks the AUTHORED config is
    coherent; the ENABLED subset is renormalized to 1.0 separately at resolve time."""
    total = sum(float(c["weight"]) for c in composite["components"])
    if abs(total - 1.0) > tol:
        raise ValueError(
            f"risk-model composite '{composite['id']}': component weights sum to "
            f"{total!r}, expected 1.0 (within {tol})"
        )


def validate_lookup_table(table_id, table):
    """Reject a malformed lookup table (fail-fast, mirroring validate_composite):
      - a REQUIRED explicit `default`, every value (rows + default) a number in [0,100]
        (the <0 / >100 / NaN / inf cases all caught by `not 0 <= v <= 100`);
      - row keys present + unique;
      - a `count` table's integer keys CONTIGUOUS from 0 (a gap would silently fall
        through to `default` -- e.g. "no risk" for a supplier with alternatives);
      - a `country` table's `members` DISJOINT across rows (else the code->row match is
        order-dependent, making the score non-deterministic w.r.t. config order).
    Mirrors lib/risk-model.lookupTableError. Runs at LOAD, so a hand-edited config is
    caught before it can reach a score; the grid editor blocks save on the same rules."""
    if "default" not in table:
        raise ValueError(
            f"risk-model lookup table '{table_id}': missing required 'default'"
        )
    rows = table.get("rows", [])
    pairs = [("default", table["default"])]
    for row in rows:
        if "value" not in row:
            raise ValueError(
                f"risk-model lookup table '{table_id}': a row is missing 'value'"
            )
        pairs.append((row.get("key"), row["value"]))
    for key, value in pairs:
        if not (0.0 <= float(value) <= 100.0):
            raise ValueError(
                f"risk-model lookup table '{table_id}' key {key!r}: value {value!r} "
                f"outside [0,100]"
            )
    keys = [str(row.get("key")) for row in rows]
    if len(set(keys)) != len(keys):
        raise ValueError(f"risk-model lookup table '{table_id}': duplicate row key")
    input_mode = table.get("input")
    if input_mode == "count":
        try:
            ints = sorted(int(row["key"]) for row in rows)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(
                f"risk-model lookup table '{table_id}': count keys must be integers >= 0"
            ) from exc
        if ints != list(range(len(ints))):
            raise ValueError(
                f"risk-model lookup table '{table_id}': count keys must be contiguous "
                f"from 0 (a gap would silently fall through to default)"
            )
    elif input_mode == "country":
        seen = {}
        for row in rows:
            for member in row.get("members", []):
                code = str(member).strip().upper()
                if not code:
                    continue
                prior = seen.get(code)
                if prior is not None and prior != str(row.get("key")):
                    raise ValueError(
                        f"risk-model lookup table '{table_id}': member {code!r} in both "
                        f"rows {prior!r} and {str(row.get('key'))!r} -- members must be disjoint"
                    )
                seen[code] = str(row.get("key"))


def resolve_effective_weights(composite):
    """THE renormalization function — used by BOTH composites.

    Returns {component_id -> effective weight} over the ENABLED components, dividing
    each enabled weight by the enabled total so the result always sums to 1.0. This
    proportionally redistributes any DISABLED component's weight across the survivors.
    When every component is enabled and the declared weights already sum to 1.0 (the
    Phase-1 default), the divisor is exactly 1.0, so the effective weights are the
    declared weights unchanged — a bit-for-bit no-op.

    Guard: raises a clear error if every component is disabled (never returns an empty
    map, never emits zeros/NaN)."""
    enabled = [c for c in composite["components"] if c.get("enabled", True)]
    if not enabled:
        raise ValueError(
            f"risk-model composite '{composite['id']}': all components disabled — "
            f"cannot compute a score"
        )
    total = sum(float(c["weight"]) for c in enabled)
    if total <= 0.0:
        raise ValueError(
            f"risk-model composite '{composite['id']}': enabled weights sum to "
            f"{total!r} (must be > 0)"
        )
    return {c["id"]: float(c["weight"]) / total for c in enabled}


def invert_polarity(composite):
    return bool(composite.get("invertPolarity", False))


def combine_score(contribution_sum, invert):
    """Fold the summed weighted contributions into a final 0-100 score. invert=True
    applies the 100-minus inversion (performance risk: higher = safer); invert=False
    leaves the sum as-is (supply risk: higher = riskier). Then clip to [0,100].

    Works elementwise on floats and numpy arrays, so compute_supply_risk can pass a
    vectorized array while compute_scores passes a scalar."""
    raw = (100.0 - contribution_sum) if invert else contribution_sum
    return np.clip(raw, 0.0, 100.0)

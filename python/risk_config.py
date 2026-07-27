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

_HERE = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.path.normpath(os.path.join(_HERE, "..", "config", "risk-model.json"))

# Float tolerance for the "weights sum to 1.0" checks. Generous enough to absorb the
# representation error of non-dyadic weights (0.6 + 0.4), tight enough to reject a
# genuinely malformed config (e.g. 0.5/0.3/0.25 = 1.05).
WEIGHT_SUM_TOL = 1e-9


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

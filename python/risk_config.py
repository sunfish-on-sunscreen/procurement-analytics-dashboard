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
    return model


def get_composite(composite_id):
    """Return the composite dict for 'supplyRisk' | 'performanceRisk'."""
    for composite in load_risk_model()["composites"]:
        if composite["id"] == composite_id:
            return composite
    raise KeyError(f"risk-model.json: no composite '{composite_id}'")


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

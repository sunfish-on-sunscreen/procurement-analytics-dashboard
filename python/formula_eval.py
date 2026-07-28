"""The ONE formula evaluator (Stage D). Pure, whitelisted-AST arithmetic over a flat
per-supplier variable namespace `env: {id -> float}`.

CONTRACT (see the namespace model): the evaluator NEVER performs a lookup or a partition
grouping. Every non-trivial value — table-lookup results AND partition-group results — is
resolved OUTSIDE the evaluator and injected into `env` as a named scalar. A formula composes
those names with whitelisted arithmetic; a name not in `env` is a hard error (no free name
lookups). This is the only evaluator; the TS UI preview calls it through the API, because two
implementations would disagree on rounding and the preview would misrepresent the report.

WHITELIST: literals, names, ( ), unary +/-, binary + - * /, and the functions min, max, abs,
sqrt. Everything else (attribute access, subscripts, comparisons, boolean ops, other calls,
lambdas, comprehensions, ...) is rejected by construction — _eval only handles the allowed node
types and raises FormulaError on anything else.

GUARDS: empty formula, syntax error, unknown variable, division by zero, sqrt of a negative,
and a non-finite (inf/nan) result all raise FormulaError. Component output is then bounded to
0-100 by normalize_to_bounds, so a component is 0-100 BY CONSTRUCTION, not by the author
remembering to clamp.
"""
import ast
import math

# The whitelisted function names. Also RESERVED as variable ids (a catalogue id of "max"
# would collide with the function), enforced by is_reserved_name + the config validator.
ALLOWED_FUNCS = ("min", "max", "abs", "sqrt")
RESERVED_NAMES = frozenset(ALLOWED_FUNCS)

_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div)
_UNARYOPS = (ast.UAdd, ast.USub)


class FormulaError(ValueError):
    """Any malformed / disallowed / non-finite formula. Callers surface it as a 400/inline."""


def is_reserved_name(name):
    """A variable id may not shadow a whitelisted function name."""
    return name in RESERVED_NAMES


def _eval(node, env):
    if isinstance(node, ast.Constant):
        # bool is a subclass of int — reject True/False explicitly; only real numbers allowed.
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise FormulaError(f"only numeric literals are allowed, got {node.value!r}")
        return float(node.value)

    if isinstance(node, ast.Name):
        if node.id not in env:
            raise FormulaError(f"unknown variable '{node.id}'")
        return float(env[node.id])

    if isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, _UNARYOPS):
            raise FormulaError(f"disallowed unary operator {type(node.op).__name__}")
        operand = _eval(node.operand, env)
        return +operand if isinstance(node.op, ast.UAdd) else -operand

    if isinstance(node, ast.BinOp):
        if not isinstance(node.op, _BINOPS):
            raise FormulaError(f"disallowed operator {type(node.op).__name__}")
        left, right = _eval(node.left, env), _eval(node.right, env)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        # Div
        if right == 0:
            raise FormulaError("division by zero")
        return left / right

    if isinstance(node, ast.Call):
        if (
            not isinstance(node.func, ast.Name)
            or node.func.id not in ALLOWED_FUNCS
            or node.keywords
        ):
            raise FormulaError("only min/max/abs/sqrt calls (positional args) are allowed")
        args = [_eval(a, env) for a in node.args]
        fn = node.func.id
        if fn == "min":
            if not args:
                raise FormulaError("min() needs at least one argument")
            return min(args)
        if fn == "max":
            if not args:
                raise FormulaError("max() needs at least one argument")
            return max(args)
        if fn == "abs":
            if len(args) != 1:
                raise FormulaError("abs() takes exactly one argument")
            return abs(args[0])
        # sqrt
        if len(args) != 1:
            raise FormulaError("sqrt() takes exactly one argument")
        if args[0] < 0:
            raise FormulaError("sqrt of a negative number")
        return math.sqrt(args[0])

    raise FormulaError(f"disallowed syntax: {type(node).__name__}")


def evaluate_formula(formula, env):
    """Evaluate `formula` against `env: {id -> number}`; returns a finite float or raises
    FormulaError. Does NOT bound the result — call normalize_to_bounds for that."""
    if formula is None or not str(formula).strip():
        raise FormulaError("empty formula")
    try:
        tree = ast.parse(str(formula), mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"syntax error: {exc.msg}") from exc
    result = _eval(tree.body, env)
    if not math.isfinite(result):
        raise FormulaError("non-finite result")
    return float(result)


def referenced_names(formula):
    """The variable names a formula references (ast.Name ids that are NOT a call target), so
    the caller can build env with exactly the variables the formula needs. Raises FormulaError
    on a malformed formula (same parse guard as evaluate_formula)."""
    if formula is None or not str(formula).strip():
        raise FormulaError("empty formula")
    try:
        tree = ast.parse(str(formula), mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"syntax error: {exc.msg}") from exc
    call_funcs = {
        n.func.id
        for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
    }
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} - call_funcs


def normalize_to_bounds(value, lo, hi):
    """Map a formula result on [lo, hi] to [0, 100], clamped — so component output is 0-100
    BY CONSTRUCTION. Written as (value - lo) * (100 / (hi - lo)) so the DEFAULT (0, 100)
    bounds give scale 100/100 = 1.0 exactly and the map is a bit-exact identity (v * 1.0 == v),
    not v/100*100 which rounds. Raises on a degenerate (hi <= lo) window."""
    span = float(hi) - float(lo)
    if span <= 0:
        raise FormulaError(f"invalid bounds: hi ({hi}) must be greater than lo ({lo})")
    scaled = (float(value) - float(lo)) * (100.0 / span)
    return max(0.0, min(100.0, scaled))

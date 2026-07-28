"""Manual runner for the weight-sensitivity analysis (human-readable tables).

⚠️ The LOGIC moved to python/sensitivity.py (Stage C) so the save path can invoke it as a
callable module; this thin shim only preserves the documented manual command
`python scripts/risk_weight_sensitivity.py`. For the structured JSON the API uses, run
`python python/sensitivity.py --json`.
"""
import os
import sys

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "python")))

from sensitivity import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())

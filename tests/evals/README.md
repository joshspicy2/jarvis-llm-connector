# Router evals

Evaluation set for the Router agent (`docs/design/router-and-estimator.md`, section 1).

- `router_cases.json`: inbound items (source, from, subject, text) with expected severity,
  allowed owners and optional expected `needs_human`. Tags name the rubric rule or edge case.
- `run_router_evals.py`: Python 3 stdlib only. Sends each case to the Anthropic Messages API
  (`claude-sonnet-5-5`) with the system prompt extracted from section 1.6 of the design doc.

```
python3 tests/evals/run_router_evals.py --dry-run     # validate cases, no network, no key
python3 tests/evals/run_router_evals.py --self-test   # check parser/validator on fake responses
ANTHROPIC_API_KEY=... python3 tests/evals/run_router_evals.py [--pass-rate 0.85] [--only fire-]
```

A case passes when the output matches the exact five-key schema, severity equals expected, owner is in
the allowed list and `needs_human` matches when specified. Prints a confusion table; exits 1 below the
pass rate (default 0.85), 2 if the key is missing. The key is read from the environment only.

Notes: allowed owners are lists because the design leaves some owners open (e.g. lead questions:
Estimator or Support). Open questions in section 4 of the design doc (e.g. lead severity) may change
expectations. The pure-injection case `inj-prompt-02` is a judgment call; adjust once decided.

#!/usr/bin/env python3
"""Eval runner for the Jarvis Router agent (stdlib only).

  --dry-run     validate router_cases.json, no network, no key needed
  --self-test   unit-check the response parser/validator with fake responses
  (default)     call the Anthropic Messages API once per case; needs ANTHROPIC_API_KEY in the environment
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.error
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DESIGN = os.path.join(ROOT, "docs", "design", "router-and-estimator.md")
SEVS = ["FIRE", "IMPORTANT", "ROUTINE", "AWARENESS"]
OWNERS = ["Conductor", "Estimator", "Support", "Marketer", "Shield/Ops", "Researcher"]
SOURCES = ["form", "email", "stripe", "call", "system"]
KEYS = {"severity", "owner", "reason", "needs_human", "summary"}
MIN_PER_SEV = {"FIRE": 8, "IMPORTANT": 8, "ROUTINE": 8, "AWARENESS": 6}
MODEL = "claude-sonnet-5-5"


def validate_cases(path):
    errs = []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return None, ["cannot load %s: %s" % (path, e)]
    cases = data.get("cases") if isinstance(data, dict) else None
    if not isinstance(cases, list) or not cases:
        return None, ["top level must be {'cases': [...]} and non-empty"]
    seen = set()
    for i, c in enumerate(cases):
        w = "case[%d]%s" % (i, "" if not isinstance(c, dict) else " " + str(c.get("id")))
        if not isinstance(c, dict):
            errs.append(w + ": not an object"); continue
        for k in ("id", "source", "from", "subject", "text"):
            if not isinstance(c.get(k), str):
                errs.append("%s: '%s' must be a string" % (w, k))
        if isinstance(c.get("id"), str):
            if not c["id"].strip(): errs.append(w + ": empty id")
            if c["id"] in seen: errs.append(w + ": duplicate id")
            seen.add(c["id"])
        if c.get("source") not in SOURCES: errs.append("%s: bad source %r" % (w, c.get("source")))
        if c.get("expected_severity") not in SEVS: errs.append("%s: bad expected_severity" % w)
        ao = c.get("allowed_owners")
        if not isinstance(ao, list) or not ao or any(o not in OWNERS for o in ao):
            errs.append(w + ": allowed_owners must be a non-empty list of valid owners")
        if "expected_needs_human" in c and not isinstance(c["expected_needs_human"], bool):
            errs.append(w + ": expected_needs_human must be boolean")
        if c.get("expected_severity") == "FIRE" and c.get("expected_needs_human") is False:
            errs.append(w + ": FIRE implies needs_human true")
    counts = Counter(c.get("expected_severity") for c in cases if isinstance(c, dict))
    for s, n in MIN_PER_SEV.items():
        if counts.get(s, 0) < n: errs.append("severity %s has %d cases, need >= %d" % (s, counts.get(s, 0), n))
    if len(cases) < 40: errs.append("need >= 40 cases, have %d" % len(cases))
    return (cases, errs), errs


def load_system_prompt():
    with open(DESIGN, encoding="utf-8") as f:
        txt = f.read()
    m = re.search(r"### 1\.6.*?```text\n(.*?)```", txt, re.S)
    if not m: raise SystemExit("cannot extract system prompt from " + DESIGN)
    return m.group(1).strip()


def extract_json(text):
    """Defensively pull one JSON object out of model text (fences, prose). Returns (obj|None, err)."""
    if not isinstance(text, str) or not text.strip(): return None, "empty response"
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try:
        return json.loads(t), None
    except ValueError:
        pass
    dec = json.JSONDecoder()
    for m in re.finditer(r"\{", t):
        try:
            obj, _ = dec.raw_decode(t[m.start():])
            if isinstance(obj, dict): return obj, None
        except ValueError:
            continue
    return None, "no JSON object found"


def check_schema(o):
    if not isinstance(o, dict): return ["not an object"]
    p = []
    if set(o) != KEYS: p.append("keys mismatch: extra=%s missing=%s" % (sorted(set(o) - KEYS), sorted(KEYS - set(o))))
    if o.get("severity") not in SEVS: p.append("bad severity")
    if o.get("owner") not in OWNERS: p.append("bad owner")
    if not isinstance(o.get("needs_human"), bool): p.append("needs_human not boolean")
    for k, mx in (("reason", 200), ("summary", 400)):
        v = o.get(k)
        if not isinstance(v, str) or not v.strip() or len(v) > mx: p.append("%s invalid" % k)
    if o.get("severity") == "FIRE" and o.get("needs_human") is not True: p.append("FIRE without needs_human true")
    return p


def grade(case, text):
    """Returns dict(ok, got_sev, schema_problems, sev_ok, owner_ok, nh_ok, note)."""
    obj, err = extract_json(text)
    r = dict(ok=False, got_sev="INVALID", schema=[], sev_ok=False, owner_ok=False, nh_ok=True, note=err or "")
    if obj is None: return r
    r["schema"] = check_schema(obj)
    if isinstance(obj, dict):
        r["got_sev"] = obj.get("severity") if obj.get("severity") in SEVS else "INVALID"
        r["sev_ok"] = obj.get("severity") == case["expected_severity"]
        r["owner_ok"] = obj.get("owner") in case["allowed_owners"]
        if "expected_needs_human" in case: r["nh_ok"] = obj.get("needs_human") == case["expected_needs_human"]
    r["ok"] = not r["schema"] and r["sev_ok"] and r["owner_ok"] and r["nh_ok"]
    return r


def event_text(c):
    return "source: %s\nfrom: %s\nsubject: %s\n\n%s" % (c["source"], c["from"], c["subject"], c["text"])


def call_api(key, system, user, timeout=60):
    body = json.dumps({"model": MODEL, "max_tokens": 600, "system": system,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                d = json.loads(resp.read().decode())
            return "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
        except urllib.error.HTTPError as e:
            last = "HTTP %s" % e.code  # never echo headers/body (could reflect request details)
            if e.code not in (429, 500, 502, 503, 529): break
        except Exception as e:
            last = type(e).__name__
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(last)


def self_test():
    case = {"expected_severity": "FIRE", "allowed_owners": ["Support"], "expected_needs_human": True}
    good = {"severity": "FIRE", "owner": "Support", "reason": "Damage.", "needs_human": True, "summary": "A vase broke."}
    G = json.dumps(good)
    tests = [
        ("plain json", G, True),
        ("fenced", "```json\n" + G + "\n```", True),
        ("prose around", "Here you go: " + G + " done", True),
        ("wrong severity", G.replace("FIRE", "ROUTINE"), False),
        ("wrong owner", G.replace("Support", "Marketer"), False),
        ("extra key", json.dumps(dict(good, extra=1)), False),
        ("needs_human string", G.replace("true", '"true"'), False),
        ("FIRE needs_human false", G.replace("true", "false"), False),
        ("not json", "I cannot do that", False),
        ("empty", "", False),
    ]
    bad = 0
    for name, resp, want in tests:
        got = grade(case, resp)["ok"]
        print("  %-24s %s" % (name, "ok" if got == want else "WRONG"))
        bad += got != want
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cases", default=os.path.join(HERE, "router_cases.json"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--pass-rate", type=float, default=0.85)
    ap.add_argument("--only", help="run only case ids containing this substring")
    a = ap.parse_args()
    if a.self_test: return self_test()
    res, errs = validate_cases(a.cases)
    if errs:
        print("case file problems:"); [print(" -", e) for e in errs]; return 1
    cases = res[0]
    if a.dry_run:
        print("OK: %d cases; %s" % (len(cases), dict(Counter(c["expected_severity"] for c in cases))))
        return 0
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print("ANTHROPIC_API_KEY not set in the environment; refusing to run (use --dry-run)."); return 2
    system = load_system_prompt()
    if a.only: cases = [c for c in cases if a.only in c["id"]]
    conf = defaultdict(Counter); passed = 0; fails = []
    for c in cases:
        try:
            text = call_api(key, system, event_text(c))
        except RuntimeError as e:
            text = ""; print("API error on %s: %s" % (c["id"], e))
        g = grade(c, text)
        conf[c["expected_severity"]][g["got_sev"]] += 1
        passed += g["ok"]
        if not g["ok"]:
            fails.append("%s: sev=%s owner_ok=%s nh_ok=%s schema=%s %s" % (c["id"], g["got_sev"], g["owner_ok"], g["nh_ok"], g["schema"], g["note"]))
    cols = SEVS + ["INVALID"]
    print("\nconfusion (rows expected, cols got)")
    print("%-10s" % "" + "".join("%11s" % x for x in cols))
    for s in SEVS: print("%-10s" % s + "".join("%11d" % conf[s][x] for x in cols))
    for f in fails: print("FAIL", f)
    rate = passed / len(cases) if cases else 0
    print("\npassed %d/%d = %.2f (threshold %.2f)" % (passed, len(cases), rate, a.pass_rate))
    return 0 if rate >= a.pass_rate else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Validate n8n workflow JSON files.

Usage:
    validate_workflows.py [PATH ...]

With no paths, every dashboard/n8n/*.json file in the repository is checked.
Exit code is 0 when every file passes, 1 when any file fails.
Warnings never cause a failure.

Checks (stdlib only):
  * file is valid JSON and has 'nodes' (list) and 'connections' (object)
  * every node has a unique non-empty name and a type
  * every connection source and target names an existing node
  * every non-webhook node is reachable from some Webhook or Schedule/other trigger node
  * (method, path) pairs of webhooks are unique
  * no node has a non-empty credentials id, and credential names must be placeholders
    ('Select your ... credential', 'REPLACE_WITH_*' or empty)
  * webhook options (allowedOrigins etc.) are never '*'; allowedOrigins must be a REPLACE_WITH_* placeholder
  * URLs use REPLACE_WITH_* hosts, except the allowlisted ops/api hosts
  * each workflow has a sibling .md in dashboard/n8n (error) and is mentioned in
    dashboard/n8n/README.md (warning, since only the dashboard workflow is listed today)
  * no string anywhere matches a secret pattern
  * no 'password' / 'api_key' key has a non-empty value
"""

import glob
import json
import os
import re
import sys
from collections import deque

WEBHOOK_TYPE = "n8n-nodes-base.webhook"
# Other entry points (not reachable from a webhook by design).
TRIGGER_TYPES = {"n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.cron", "n8n-nodes-base.manualTrigger", "n8n-nodes-base.errorTrigger"}

SECRET_PATTERNS = [
    ("OpenAI-style key", re.compile(r"sk-[A-Za-z0-9]{10,}")),
    ("secret_ token", re.compile(r"secret_[A-Za-z0-9]{10,}")),
    ("Notion token", re.compile(r"ntn_[A-Za-z0-9]{10,}")),
    ("Bearer token", re.compile(r"Bearer [A-Za-z0-9._-]{15,}")),
]

# Workflow file -> sibling doc (inside dashboard/n8n). Files not listed fall back to
# '<stem minus -workflow>.upper() + .md'.
WORKFLOW_DOCS = {
    "approvals-api-workflow.json": "APPROVALS-API.md",
    "conductor-workflow.json": "CONDUCTOR.md",
    "estimator-workflow.json": "ESTIMATOR.md",
    "intake-workflow.json": "INTAKE.md",
    "jarvis-dashboard-api.json": "CHAT.md",
    "marketer-workflow.json": "MARKETER.md",
    "qa-workflow.json": "QA.md",
    "router-workflow.json": "ROUTER.md",
    "shield-ops-workflow.json": "SHIELD-OPS.md",
    "support-workflow.json": "SUPPORT.md",
}

PLACEHOLDER_RE = re.compile(r"REPLACE_WITH_[A-Z0-9_]+")
CREDENTIAL_NAME_OK = re.compile(r"^(select your .*|replace_with_.*)$", re.IGNORECASE)
URL_RE = re.compile(r"(?i)\b(?:https?|wss?)://([^\s/\"'`)\\<>]+)")
ALLOWED_HOSTS = {"ops.hightidewash.net", "api.anthropic.com", "api.notion.com"}

SECRET_KEY_MARKERS = ("password", "apikey")


def _redact(text):
    return text[:8] + "..." if len(text) > 8 else "..."


def _normalise_key(key):
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _is_non_empty_value(value):
    if value is None or value is False:
        return False
    if isinstance(value, str):
        # n8n expressions such as "={{ $env.X }}" reference a secret, they do not contain one.
        return bool(value.strip()) and not value.startswith("=")
    if isinstance(value, (list, dict)):
        return len(value) > 0
    if isinstance(value, (int, float)) and value is not True:
        return value != 0
    return True  # True or any other truthy scalar


def _scan_secrets(obj, path, errors):
    """Walk the document; report secret-looking strings and secret-named keys."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if isinstance(key, str):
                for label, pattern in SECRET_PATTERNS:
                    match = pattern.search(key)
                    if match:
                        errors.append(
                            f"{path}: key looks like a {label} ({_redact(match.group(0))})"
                        )
                norm = _normalise_key(key)
                if any(marker in norm for marker in SECRET_KEY_MARKERS) and _is_non_empty_value(value):
                    errors.append(f"{path}.{key}: '{key}' has a non-empty value")
            _scan_secrets(value, f"{path}.{key}", errors)
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            _scan_secrets(value, f"{path}[{index}]", errors)
    elif isinstance(obj, str):
        for label, pattern in SECRET_PATTERNS:
            match = pattern.search(obj)
            if match:
                errors.append(f"{path}: string looks like a {label} ({_redact(match.group(0))})")


def _scan_hosts(obj, path, errors):
    """Every URL host must be a REPLACE_WITH_* placeholder or an allowlisted host."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            _scan_hosts(value, f"{path}.{key}", errors)
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            _scan_hosts(value, f"{path}[{index}]", errors)
    elif isinstance(obj, str):
        for match in URL_RE.finditer(obj):
            host = match.group(1)
            bare = host.split("@")[-1].split(":")[0].lower()
            if PLACEHOLDER_RE.search(host) or bare in ALLOWED_HOSTS:
                continue
            errors.append(f"{path}: URL host '{host}' must be a REPLACE_WITH_* placeholder")


def _scan_wildcard_origins(obj, path, errors):
    """Any allowedOrigins key anywhere (not just on webhook nodes) must not be '*'."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "allowedOrigins" and isinstance(value, str) and "*" in [p.strip() for p in value.split(",")]:
                if not path.endswith(".options") or "parameters" not in path:
                    errors.append(f"{path}.allowedOrigins is '*'")
            _scan_wildcard_origins(value, f"{path}.{key}", errors)
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            _scan_wildcard_origins(value, f"{path}[{index}]", errors)


def _webhook_methods(params):
    method = params.get("httpMethod", "GET")
    if isinstance(method, list):
        methods = [str(m) for m in method] or ["GET"]
    else:
        methods = [str(method)]
    return [m.strip().upper() for m in methods]


def validate_workflow(data):
    """Validate a parsed workflow. Returns (errors, warnings) as lists of strings."""
    errors = []
    warnings = []

    if not isinstance(data, dict):
        return ["top level is not a JSON object"], warnings
    if "nodes" not in data:
        errors.append("missing 'nodes'")
    if "connections" not in data:
        errors.append("missing 'connections'")
    if errors:
        return errors, warnings

    nodes = data["nodes"]
    connections = data["connections"]
    if not isinstance(nodes, list):
        return errors + ["'nodes' is not a list"], warnings
    if not isinstance(connections, dict):
        return errors + ["'connections' is not an object"], warnings

    # Node shape and unique names.
    names = []
    valid_nodes = []
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            errors.append(f"node #{index} is not an object")
            continue
        name = node.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"node #{index} has no name")
            continue
        if not isinstance(node.get("type"), str) or not node.get("type"):
            errors.append(f"node '{name}' has no type")
        names.append(name)
        valid_nodes.append(node)

    seen = set()
    for name in names:
        if name in seen:
            errors.append(f"duplicate node name '{name}'")
        seen.add(name)
    node_names = set(names)

    # Connections: every source and target must be an existing node.
    edges = {}
    for source, outputs in connections.items():
        if source not in node_names:
            errors.append(f"connection source '{source}' is not a node")
        if not isinstance(outputs, dict):
            errors.append(f"connections for '{source}' are malformed")
            continue
        for output_type, branches in outputs.items():
            if not isinstance(branches, list):
                errors.append(f"connections for '{source}' ({output_type}) are malformed")
                continue
            for branch in branches:
                if branch is None:
                    continue
                if not isinstance(branch, list):
                    errors.append(f"connections for '{source}' ({output_type}) are malformed")
                    continue
                for link in branch:
                    target = link.get("node") if isinstance(link, dict) else None
                    if target not in node_names:
                        errors.append(f"connection '{source}' -> '{target}' targets a node that does not exist")
                    elif source in node_names:
                        edges.setdefault(source, set()).add(target)

    # Webhooks: reachability and (method, path) uniqueness.
    webhook_nodes = [n for n in valid_nodes if n.get("type") == WEBHOOK_TYPE]
    webhook_names = {n["name"] for n in webhook_nodes}
    root_names = webhook_names | {n["name"] for n in valid_nodes if n.get("type") in TRIGGER_TYPES}

    queue = deque(root_names)
    reached = set(root_names)
    while queue:
        current = queue.popleft()
        for nxt in edges.get(current, ()):
            if nxt not in reached:
                reached.add(nxt)
                queue.append(nxt)
    for node in valid_nodes:
        if node.get("type") != WEBHOOK_TYPE and node["name"] not in reached:
            errors.append(f"node '{node['name']}' is not reachable from any Webhook or trigger node")

    route_owner = {}
    for node in webhook_nodes:
        params = node.get("parameters") if isinstance(node.get("parameters"), dict) else {}
        path = str(params.get("path") or node.get("webhookId") or "").strip().strip("/")
        if not path:
            warnings.append(f"webhook '{node['name']}' has no path")
        for method in _webhook_methods(params):
            key = (method, path)
            if key in route_owner:
                errors.append(
                    f"duplicate webhook route {method} /{path} ('{route_owner[key]}' and '{node['name']}')"
                )
            else:
                route_owner[key] = node["name"]

        options = params.get("options") if isinstance(params.get("options"), dict) else {}
        for opt_key, opt_value in options.items():
            if isinstance(opt_value, str) and "*" in [p.strip() for p in opt_value.split(",")]:
                errors.append(f"webhook '{node['name']}' (/{path}) option '{opt_key}' is '*'")
        origins = options.get("allowedOrigins")
        if origins is not None and not (
            isinstance(origins, str) and all(PLACEHOLDER_RE.search(o) for o in origins.split(",") if o.strip())
            and origins.strip()
        ) and origins != "*":
            errors.append(
                f"webhook '{node['name']}' (/{path}) allowedOrigins must use a REPLACE_WITH_* placeholder"
            )

    # Credentials: no node may reference a credential id.
    for node in valid_nodes:
        credentials = node.get("credentials")
        if not isinstance(credentials, dict):
            continue
        for cred_type, cred in credentials.items():
            cred_id = cred.get("id") if isinstance(cred, dict) else None
            if cred_id is not None and str(cred_id).strip():
                errors.append(f"node '{node['name']}' has a credential id for '{cred_type}'")
            cred_name = cred.get("name") if isinstance(cred, dict) else None
            if cred_name is not None and str(cred_name).strip() and not CREDENTIAL_NAME_OK.match(str(cred_name).strip()):
                errors.append(
                    f"node '{node['name']}' has a credential name for '{cred_type}' that looks real"
                )
            if not isinstance(cred, dict):
                errors.append(f"node '{node['name']}' credential '{cred_type}' is not an object")

    # Secrets anywhere in the document.
    _scan_secrets(data, "$", errors)
    _scan_hosts(data, "$", errors)
    _scan_wildcard_origins(data, "$", errors)

    return errors, warnings


def expected_doc(filename):
    """Sibling .md name for a workflow JSON file name."""
    if filename in WORKFLOW_DOCS:
        return WORKFLOW_DOCS[filename]
    stem = filename[:-5] if filename.endswith(".json") else filename
    if stem.endswith("-workflow"):
        stem = stem[: -len("-workflow")]
    return stem.upper() + ".md"


def check_docs(path):
    """Docs checks for a file living in a directory named 'n8n'. Returns (errors, warnings)."""
    errors, warnings = [], []
    directory = os.path.dirname(os.path.abspath(path))
    filename = os.path.basename(path)
    doc = expected_doc(filename)
    if not os.path.isfile(os.path.join(directory, doc)):
        errors.append(f"missing sibling doc {doc} for {filename}")
    readme = os.path.join(directory, "README.md")
    try:
        with open(readme, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        warnings.append("README.md not found next to workflow")
        return errors, warnings
    if filename not in text and doc not in text:
        warnings.append(f"{filename} is not mentioned in README.md")
    return errors, warnings


def validate_file(path):
    """Validate a workflow file. Returns (errors, warnings)."""
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        return [f"cannot read file: {exc.strerror or exc}"], []
    except json.JSONDecodeError as exc:
        return [f"invalid JSON: {exc}"], []
    errors, warnings = validate_workflow(data)
    if os.path.basename(os.path.dirname(os.path.abspath(path))) == "n8n":
        doc_errors, doc_warnings = check_docs(path)
        errors += doc_errors
        warnings += doc_warnings
    return errors, warnings


def default_paths():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return sorted(glob.glob(os.path.join(repo_root, "dashboard", "n8n", "*.json")))


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    paths = args or default_paths()
    if not paths:
        print("No workflow files to check.")
        return 1

    failed = 0
    for path in paths:
        errors, warnings = validate_file(path)
        status = "FAIL" if errors else "PASS"
        if errors:
            failed += 1
        print(f"{status} {path}")
        for reason in errors:
            print(f"  error: {reason}")
        for reason in warnings:
            print(f"  warn: {reason}")

    total = len(paths)
    print(f"\n{total - failed}/{total} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Check the agent definitions in .claude/agents/.

Per file: valid frontmatter (name matches filename, description present), the
shared rules block, a mention of the Agent Activity Log and the Approvals rule.
The shared rules block (from the "## Rules every Jarvis agent follows" heading
to the next "## " heading or end of file) must be byte-identical across files.

Usage: python3 scripts/check_agents.py [agents_dir]
Exits 1 with a message per problem on failure.
"""
import re
import sys
from pathlib import Path

EXPECTED_COUNT = 11
RULES_HEADING = "## Rules every Jarvis agent follows"
LOG_PHRASE = "Agent Activity Log"
APPROVAL_PHRASE = "Awaiting Approval"


def parse_frontmatter(text):
    """Return dict of top-level `key: value` lines, or None if no frontmatter."""
    m = re.match(r"---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    if not m:
        return None
    fm = {}
    for line in m.group(1).splitlines():
        km = re.match(r"([A-Za-z_][\w-]*):\s*(.*)$", line)
        if km:
            fm[km.group(1)] = km.group(2).strip()
    return fm


def extract_rules_block(text):
    """Return the shared rules block as a string, or None if absent."""
    start = text.find(RULES_HEADING)
    if start < 0:
        return None
    nxt = re.search(r"^## ", text[start + len(RULES_HEADING):], re.M)
    end = start + len(RULES_HEADING) + nxt.start() if nxt else len(text)
    return text[start:end]


def check_agents(agents_dir, expected_count=EXPECTED_COUNT):
    """Return a list of error strings (empty when everything passes)."""
    errors = []
    agents_dir = Path(agents_dir)
    files = sorted(agents_dir.glob("*.md"))
    if len(files) != expected_count:
        errors.append(f"expected {expected_count} agent files in {agents_dir}, found {len(files)}")
    blocks = {}
    for f in files:
        raw = f.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            errors.append(f"{f.name}: not valid UTF-8")
            continue
        fm = parse_frontmatter(text)
        if fm is None:
            errors.append(f"{f.name}: missing or malformed frontmatter")
        else:
            if fm.get("name") != f.stem:
                errors.append(f"{f.name}: frontmatter name {fm.get('name')!r} does not match filename {f.stem!r}")
            if not fm.get("description"):
                errors.append(f"{f.name}: frontmatter description missing or empty")
        if LOG_PHRASE not in text:
            errors.append(f"{f.name}: does not mention the {LOG_PHRASE}")
        if APPROVAL_PHRASE not in text:
            errors.append(f"{f.name}: does not mention the Approvals rule ({APPROVAL_PHRASE!r})")
        block = extract_rules_block(text)
        if block is None:
            errors.append(f"{f.name}: missing shared rules block ({RULES_HEADING!r})")
        else:
            blocks[f.name] = block
    if blocks:
        counts = {}
        for b in blocks.values():
            counts[b] = counts.get(b, 0) + 1
        reference = max(counts, key=lambda b: (counts[b], -len(b)))
        ref_lines = reference.splitlines()
        for name, b in sorted(blocks.items()):
            if b != reference:
                diff = next(
                    (f"line {i + 1}: {x!r} vs reference {y!r}"
                     for i, (x, y) in enumerate(zip(b.splitlines(), ref_lines)) if x != y),
                    "different length/trailing content",
                )
                errors.append(f"{name}: shared rules block differs from the majority ({diff})")
    return errors


def main(argv):
    default = Path(__file__).resolve().parent.parent / ".claude" / "agents"
    agents_dir = Path(argv[1]) if len(argv) > 1 else default
    errors = check_agents(agents_dir)
    if errors:
        print(f"check_agents: {len(errors)} problem(s)", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(f"check_agents: OK ({agents_dir})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

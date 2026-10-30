import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_agents  # noqa: E402

RULES = (
    "## Rules every Jarvis agent follows\n"
    "- Nothing client-facing is sent. Drafts go to *Awaiting Approval*.\n"
    "- Log each run to the Agent Activity Log.\n"
)


def agent(name, desc="Does a thing.", rules=RULES):
    return f"---\nname: {name}\ndescription: {desc}\n---\n\nYou are {name}.\n\n{rules}"


class CheckAgentsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        for n in ("a", "b", "c"):
            self.write(n, agent(n))

    def write(self, name, text):
        (self.dir / f"{name}.md").write_text(text, encoding="utf-8")

    def run_check(self):
        return check_agents.check_agents(self.dir, expected_count=3)

    def test_valid(self):
        self.assertEqual(self.run_check(), [])

    def test_count(self):
        self.assertTrue(any("expected 11" in e for e in check_agents.check_agents(self.dir)))

    def test_name_mismatch(self):
        self.write("a", agent("zzz"))
        self.assertTrue(any("a.md" in e and "does not match" in e for e in self.run_check()))

    def test_missing_description(self):
        self.write("a", agent("a", desc=""))
        self.assertTrue(any("a.md" in e and "description" in e for e in self.run_check()))

    def test_no_frontmatter(self):
        self.write("a", "hello\n" + RULES)
        self.assertTrue(any("a.md" in e and "frontmatter" in e for e in self.run_check()))

    def test_block_differs(self):
        self.write("a", agent("a", rules=RULES + "- extra rule\n"))
        errs = self.run_check()
        self.assertTrue(any("a.md" in e and "differs" in e for e in errs))
        self.assertFalse(any("b.md" in e for e in errs))

    def test_missing_block(self):
        self.write("a", agent("a", rules="Agent Activity Log, Awaiting Approval\n"))
        self.assertTrue(any("a.md" in e and "missing shared rules block" in e for e in self.run_check()))

    def test_missing_log_and_approval(self):
        bare = "## Rules every Jarvis agent follows\n- Be nice.\n"
        for n in ("a", "b", "c"):
            self.write(n, agent(n, rules=bare))
        errs = self.run_check()
        self.assertTrue(any("Activity Log" in e for e in errs))
        self.assertTrue(any("Approvals" in e for e in errs))

    def test_main_exit_codes(self):
        # main() uses the default count of 11, so 3 fixtures fail with exit 1
        self.assertEqual(check_agents.main(["x", str(self.dir)]), 1)


if __name__ == "__main__":
    unittest.main()

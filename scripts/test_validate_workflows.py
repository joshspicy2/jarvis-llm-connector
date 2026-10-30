#!/usr/bin/env python3
"""Unit tests for validate_workflows.py. Run: python3 scripts/test_validate_workflows.py"""

import copy
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import validate_workflows as vw  # noqa: E402

WEBHOOK = "n8n-nodes-base.webhook"
CODE = "n8n-nodes-base.code"


def webhook(name, method="GET", path="jarvis/x", origins=None):
    options = {} if origins is None else {"allowedOrigins": origins}
    return {
        "name": name,
        "type": WEBHOOK,
        "parameters": {"httpMethod": method, "path": path, "options": options},
    }


def code(name, **extra):
    node = {"name": name, "type": CODE, "parameters": {"jsCode": "return [];"}}
    node.update(extra)
    return node


def link(target):
    return {"main": [[{"node": target, "type": "main", "index": 0}]]}


def good_workflow():
    return {
        "name": "fixture",
        "nodes": [
            webhook("Hook GET", "GET", "jarvis/a", origins="*"),
            code("Shape A"),
            webhook("Hook POST", "POST", "jarvis/b", origins="https://example.com"),
            code("Shape B"),
        ],
        "connections": {
            "Hook GET": link("Shape A"),
            "Hook POST": link("Shape B"),
        },
    }


class ValidWorkflowTests(unittest.TestCase):
    def test_good_workflow_passes_without_errors_or_warnings(self):
        errors, warnings = vw.validate_workflow(good_workflow())
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_empty_workflow_passes(self):
        errors, _ = vw.validate_workflow({"nodes": [], "connections": {}})
        self.assertEqual(errors, [])

    def test_missing_nodes_fails(self):
        errors, _ = vw.validate_workflow({"connections": {}})
        self.assertTrue(any("'nodes'" in e for e in errors))

    def test_missing_connections_fails(self):
        errors, _ = vw.validate_workflow({"nodes": []})
        self.assertTrue(any("'connections'" in e for e in errors))

    def test_nodes_not_a_list_fails(self):
        errors, _ = vw.validate_workflow({"nodes": {}, "connections": {}})
        self.assertTrue(any("not a list" in e for e in errors))

    def test_top_level_not_object_fails(self):
        errors, _ = vw.validate_workflow([1, 2])
        self.assertTrue(errors)


class ConnectionTests(unittest.TestCase):
    def test_unknown_connection_source_fails(self):
        wf = good_workflow()
        wf["connections"]["Ghost"] = link("Shape A")
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("source 'Ghost'" in e for e in errors))

    def test_unknown_connection_target_fails(self):
        wf = good_workflow()
        wf["connections"]["Hook GET"] = link("Missing Node")
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("'Missing Node'" in e for e in errors))

    def test_malformed_connection_branch_fails(self):
        wf = good_workflow()
        wf["connections"]["Hook GET"] = {"main": "nope"}
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("malformed" in e for e in errors))


class ReachabilityTests(unittest.TestCase):
    def test_orphan_node_fails(self):
        wf = good_workflow()
        wf["nodes"].append(code("Orphan"))
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("'Orphan' is not reachable" in e for e in errors))

    def test_node_reachable_through_chain_passes(self):
        wf = good_workflow()
        wf["nodes"].append(code("Second hop"))
        wf["connections"]["Shape A"] = link("Second hop")
        errors, _ = vw.validate_workflow(wf)
        self.assertEqual(errors, [])

    def test_node_fed_only_by_non_webhook_fails(self):
        wf = {
            "nodes": [code("Lonely A"), code("Lonely B")],
            "connections": {"Lonely A": link("Lonely B")},
        }
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("'Lonely A' is not reachable" in e for e in errors))
        self.assertTrue(any("'Lonely B' is not reachable" in e for e in errors))

    def test_webhook_without_outgoing_connections_is_fine(self):
        wf = {"nodes": [webhook("Solo")], "connections": {}}
        errors, _ = vw.validate_workflow(wf)
        self.assertEqual(errors, [])

    def test_duplicate_node_names_fail(self):
        wf = good_workflow()
        wf["nodes"].append(code("Shape A"))
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("duplicate node name 'Shape A'" in e for e in errors))


class WebhookRouteTests(unittest.TestCase):
    def test_same_path_different_method_is_allowed(self):
        wf = {
            "nodes": [
                webhook("Get", "GET", "jarvis/same", origins="https://x.test"),
                webhook("Post", "POST", "jarvis/same", origins="https://x.test"),
            ],
            "connections": {},
        }
        errors, _ = vw.validate_workflow(wf)
        self.assertEqual(errors, [])

    def test_duplicate_method_and_path_fails(self):
        wf = {
            "nodes": [
                webhook("First", "GET", "jarvis/dup", origins="https://x.test"),
                webhook("Second", "GET", "/jarvis/dup/", origins="https://x.test"),
            ],
            "connections": {},
        }
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("duplicate webhook route GET /jarvis/dup" in e for e in errors))

    def test_method_is_case_insensitive_for_duplicates(self):
        wf = {
            "nodes": [
                webhook("A", "post", "p", origins="https://x.test"),
                webhook("B", "POST", "p", origins="https://x.test"),
            ],
            "connections": {},
        }
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(errors)


class CredentialTests(unittest.TestCase):
    def test_empty_credential_id_passes(self):
        wf = good_workflow()
        wf["nodes"][1]["credentials"] = {"notionApi": {"id": "", "name": "Select"}}
        errors, _ = vw.validate_workflow(wf)
        self.assertEqual(errors, [])

    def test_non_empty_credential_id_fails(self):
        wf = good_workflow()
        wf["nodes"][1]["credentials"] = {"notionApi": {"id": "abc123", "name": "Prod"}}
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("'Shape A' has a credential id for 'notionApi'" in e for e in errors))


class SecretTests(unittest.TestCase):
    def assert_secret_flagged(self, value):
        wf = good_workflow()
        wf["nodes"][1]["parameters"]["note"] = value
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(errors, f"expected a finding for {value!r}")
        # The full secret must not be echoed back in the report.
        self.assertFalse(any(value in e for e in errors))

    def test_openai_style_key_flagged(self):
        self.assert_secret_flagged("sk-abcdefghij1234")

    def test_secret_underscore_token_flagged(self):
        self.assert_secret_flagged("secret_abcdefghij1234")

    def test_notion_token_flagged(self):
        self.assert_secret_flagged("ntn_abcdefghij1234")

    def test_bearer_token_flagged(self):
        self.assert_secret_flagged("Authorization: Bearer abc.def-ghi_jkl123")

    def test_short_values_not_flagged(self):
        wf = good_workflow()
        wf["nodes"][1]["parameters"]["note"] = "sk-short Bearer abc"
        errors, _ = vw.validate_workflow(wf)
        self.assertEqual(errors, [])

    def test_secret_in_key_name_flagged(self):
        wf = good_workflow()
        wf["nodes"][1]["parameters"]["ntn_abcdefghij1234"] = "x"
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(errors)

    def test_password_with_value_flagged(self):
        wf = good_workflow()
        wf["nodes"][1]["parameters"]["password"] = "hunter2"
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("'password' has a non-empty value" in e for e in errors))

    def test_api_key_with_value_flagged(self):
        wf = good_workflow()
        wf["nodes"][1]["parameters"]["api_key"] = "value-here"
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(any("'api_key' has a non-empty value" in e for e in errors))

    def test_camel_case_api_key_flagged(self):
        wf = good_workflow()
        wf["nodes"][1]["parameters"]["apiKey"] = "value-here"
        errors, _ = vw.validate_workflow(wf)
        self.assertTrue(errors)

    def test_empty_password_field_passes(self):
        wf = good_workflow()
        wf["nodes"][1]["parameters"]["password"] = ""
        wf["nodes"][1]["parameters"]["api_key"] = None
        errors, _ = vw.validate_workflow(wf)
        self.assertEqual(errors, [])

    def test_n8n_expression_for_password_passes(self):
        wf = good_workflow()
        wf["nodes"][1]["parameters"]["password"] = "={{ $env.DB_PASSWORD }}"
        errors, _ = vw.validate_workflow(wf)
        self.assertEqual(errors, [])


class WarningTests(unittest.TestCase):
    def test_post_webhook_with_wildcard_origin_warns(self):
        wf = good_workflow()
        wf["nodes"][2]["parameters"]["options"]["allowedOrigins"] = "*"
        errors, warnings = vw.validate_workflow(wf)
        self.assertEqual(errors, [])
        self.assertTrue(any("'Hook POST'" in w and "'*'" in w for w in warnings))

    def test_get_webhook_with_wildcard_origin_does_not_warn(self):
        errors, warnings = vw.validate_workflow(good_workflow())
        self.assertEqual(errors, [])
        self.assertFalse(any("Hook GET" in w for w in warnings))

    def test_warnings_do_not_make_errors(self):
        wf = good_workflow()
        wf["nodes"][2]["parameters"]["options"]["allowedOrigins"] = "*"
        errors, warnings = vw.validate_workflow(wf)
        self.assertTrue(warnings)
        self.assertEqual(errors, [])


class FileAndCliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, name, content):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content if isinstance(content, str) else json.dumps(content))
        return path

    def test_invalid_json_fails(self):
        path = self.write("bad.json", "{not json")
        errors, _ = vw.validate_file(path)
        self.assertTrue(any("invalid JSON" in e for e in errors))

    def test_missing_file_fails(self):
        errors, _ = vw.validate_file(os.path.join(self.dir, "absent.json"))
        self.assertTrue(errors)

    def test_cli_exit_zero_when_all_pass(self):
        good = self.write("good.json", good_workflow())
        self.assertEqual(vw.main([good]), 0)

    def test_cli_exit_one_when_any_fail(self):
        good = self.write("good.json", good_workflow())
        bad_wf = good_workflow()
        bad_wf["nodes"].append(code("Orphan"))
        bad = self.write("bad.json", bad_wf)
        self.assertEqual(vw.main([good, bad]), 1)

    def test_cli_warnings_only_exit_zero(self):
        wf = good_workflow()
        wf["nodes"][2]["parameters"]["options"]["allowedOrigins"] = "*"
        self.assertEqual(vw.main([self.write("warn.json", wf)]), 0)

    def test_cli_prints_pass_and_fail_lines(self):
        import io
        from contextlib import redirect_stdout

        bad = self.write("bad.json", "{")
        buf = io.StringIO()
        with redirect_stdout(buf):
            vw.main([bad])
        output = buf.getvalue()
        self.assertIn(f"FAIL {bad}", output)
        self.assertIn("invalid JSON", output)

    def test_default_paths_point_at_dashboard_n8n(self):
        paths = vw.default_paths()
        self.assertTrue(paths)
        for path in paths:
            self.assertTrue(path.endswith(".json"))
            self.assertEqual(os.path.basename(os.path.dirname(path)), "n8n")


if __name__ == "__main__":
    unittest.main()

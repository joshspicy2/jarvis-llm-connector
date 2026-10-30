import unittest

from estimator.estimate import calculate_estimate


def rule(service, category="Interior", base_rate=10, unit="Per Sqft",
         minimum_charge=None, active=True, notes=""):
    return {
        "service": service,
        "category": category,
        "base_rate": base_rate,
        "unit": unit,
        "minimum_charge": minimum_charge,
        "active": active,
        "notes": notes,
    }


class UnitTypeTests(unittest.TestCase):
    def test_per_sqft(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate="2.50", unit="Per Sqft")],
            [{"service": "Wall Paint", "quantity": 100}],
        )
        self.assertEqual(result["lines"], [{
            "service": "Wall Paint", "unit": "Per Sqft", "quantity": "100",
            "rate": "2.50", "amount": "250.00",
        }])
        self.assertEqual(result["subtotal"], "250.00")
        self.assertEqual(result["total"], "250.00")
        self.assertEqual(result["missing"], [])

    def test_per_room(self):
        result = calculate_estimate(
            [rule("Ceiling", base_rate=40, unit="Per Room")],
            [{"service": "Ceiling", "quantity": 3}],
        )
        self.assertEqual(result["lines"][0]["unit"], "Per Room")
        self.assertEqual(result["lines"][0]["amount"], "120.00")
        self.assertEqual(result["total"], "120.00")

    def test_per_hour_allows_fractional_quantity(self):
        result = calculate_estimate(
            [rule("Touch-up", base_rate=60, unit="Per Hour")],
            [{"service": "Touch-up", "quantity": "2.5"}],
        )
        self.assertEqual(result["lines"][0]["quantity"], "2.5")
        self.assertEqual(result["lines"][0]["amount"], "150.00")
        self.assertEqual(result["total"], "150.00")

    def test_flat_rate_ignores_quantity(self):
        result = calculate_estimate(
            [rule("Permit", base_rate=300, unit="Flat Rate")],
            [{"service": "Permit", "quantity": 5}],
        )
        line = result["lines"][0]
        self.assertEqual(line["quantity"], "1")
        self.assertEqual(line["amount"], "300.00")
        self.assertEqual(result["total"], "300.00")
        self.assertEqual(len(result["warnings"]), 1)

    def test_flat_rate_without_quantity_is_fine(self):
        result = calculate_estimate(
            [rule("Permit", base_rate=300, unit="Flat Rate")],
            [{"service": "Permit", "quantity": None}],
        )
        self.assertEqual(result["total"], "300.00")
        self.assertEqual(result["missing"], [])
        self.assertEqual(result["warnings"], [])


class MinimumChargeTests(unittest.TestCase):
    def test_minimum_applied_when_primary_below_minimum(self):
        result = calculate_estimate(
            [rule("Touch-up", base_rate=50, unit="Flat Rate", minimum_charge=100)],
            [{"service": "Touch-up"}],
        )
        self.assertTrue(result["minimum_applied"])
        self.assertEqual(result["minimum_charge"], "100.00")
        self.assertEqual(result["subtotal"], "50.00")
        self.assertEqual(result["total"], "100.00")

    def test_minimum_not_applied_when_primary_above_minimum(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=10, unit="Per Sqft", minimum_charge=100)],
            [{"service": "Wall Paint", "quantity": 15}],
        )
        self.assertFalse(result["minimum_applied"])
        self.assertEqual(result["minimum_charge"], "100.00")
        self.assertEqual(result["subtotal"], "150.00")
        self.assertEqual(result["total"], "150.00")

    def test_minimum_not_applied_when_equal(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=10, unit="Per Sqft", minimum_charge=100)],
            [{"service": "Wall Paint", "quantity": 10}],
        )
        self.assertFalse(result["minimum_applied"])
        self.assertEqual(result["total"], "100.00")

    def test_highest_minimum_among_primary_lines_is_used(self):
        result = calculate_estimate(
            [
                rule("Walls", base_rate=1, unit="Per Sqft", minimum_charge=80),
                rule("Trim", category="Exterior", base_rate=1, unit="Per Sqft",
                     minimum_charge=120),
            ],
            [{"service": "Walls", "quantity": 20},
             {"service": "Trim", "quantity": 30}],
        )
        self.assertEqual(result["minimum_charge"], "120.00")
        self.assertEqual(result["subtotal"], "50.00")
        self.assertTrue(result["minimum_applied"])
        self.assertEqual(result["total"], "120.00")

    def test_add_ons_do_not_trigger_minimum(self):
        result = calculate_estimate(
            [
                rule("Wall Paint", base_rate=1, unit="Per Sqft", minimum_charge=100),
                rule("Caulking", category="Add-On", base_rate=30, unit="Flat Rate"),
            ],
            [{"service": "Wall Paint", "quantity": 50},
             {"service": "Caulking"}],
        )
        self.assertTrue(result["minimum_applied"])
        self.assertEqual(result["subtotal"], "80.00")
        self.assertEqual(result["total"], "130.00")

    def test_add_on_minimum_is_ignored(self):
        result = calculate_estimate(
            [rule("Caulking", category="Add-On", base_rate=30, unit="Flat Rate",
                  minimum_charge=500)],
            [{"service": "Caulking"}],
        )
        self.assertFalse(result["minimum_applied"])
        self.assertIsNone(result["minimum_charge"])
        self.assertEqual(result["total"], "30.00")

    def test_add_ons_only_have_no_minimum(self):
        result = calculate_estimate(
            [rule("Caulking", category="Add-On", base_rate=5, unit="Per Hour")],
            [{"service": "Caulking", "quantity": 2}],
        )
        self.assertFalse(result["minimum_applied"])
        self.assertIsNone(result["minimum_charge"])
        self.assertEqual(result["total"], "10.00")


class RuleSelectionTests(unittest.TestCase):
    def test_matching_is_case_insensitive(self):
        result = calculate_estimate(
            [rule("Interior Paint", base_rate=2, unit="Per Sqft")],
            [{"service": "  INTERIOR paint ", "quantity": 10}],
        )
        self.assertEqual(result["total"], "20.00")
        self.assertEqual(result["missing"], [])

    def test_inactive_rule_is_not_used(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=2, unit="Per Sqft", active=False)],
            [{"service": "Wall Paint", "quantity": 10}],
        )
        self.assertIsNone(result["total"])
        self.assertEqual(result["lines"], [])
        self.assertEqual(len(result["missing"]), 1)
        self.assertIn("inactive", result["missing"][0])
        self.assertIn("Wall Paint", result["missing"][0])

    def test_inactive_rule_ignored_when_active_rule_exists(self):
        result = calculate_estimate(
            [
                rule("Wall Paint", base_rate=99, unit="Per Sqft", active=False),
                rule("Wall Paint", base_rate=2, unit="Per Sqft", active=True),
            ],
            [{"service": "Wall Paint", "quantity": 10}],
        )
        self.assertEqual(result["lines"][0]["rate"], "2.00")
        self.assertEqual(result["total"], "20.00")

    def test_unknown_service_is_missing(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=2, unit="Per Sqft")],
            [{"service": "Roof Repair", "quantity": 10}],
        )
        self.assertIsNone(result["total"])
        self.assertEqual(result["lines"], [])
        self.assertEqual(len(result["missing"]), 1)
        self.assertIn("Roof Repair", result["missing"][0])
        self.assertIn("No active rule", result["missing"][0])

    def test_duplicate_active_rules_are_missing(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=2), rule("wall paint", base_rate=3)],
            [{"service": "Wall Paint", "quantity": 10}],
        )
        self.assertIsNone(result["total"])
        self.assertEqual(result["lines"], [])
        self.assertIn("Multiple active rules", result["missing"][0])

    def test_unknown_unit_is_missing(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=2, unit="Per Gallon")],
            [{"service": "Wall Paint", "quantity": 1}],
        )
        self.assertIsNone(result["total"])
        self.assertIn("unknown unit", result["missing"][0])


class MissingDataTests(unittest.TestCase):
    def test_missing_quantity_for_non_flat_unit(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=2, unit="Per Sqft")],
            [{"service": "Wall Paint", "quantity": None}],
        )
        self.assertIsNone(result["total"])
        self.assertEqual(result["lines"], [])
        self.assertEqual(len(result["missing"]), 1)
        self.assertIn("Quantity missing", result["missing"][0])

    def test_none_base_rate_is_missing(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=None, unit="Per Sqft")],
            [{"service": "Wall Paint", "quantity": 10}],
        )
        self.assertIsNone(result["total"])
        self.assertEqual(result["lines"], [])
        self.assertIn("no base_rate", result["missing"][0])

    def test_none_base_rate_does_not_invent_a_default(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=None, unit="Flat Rate")],
            [{"service": "Wall Paint"}],
        )
        self.assertIsNone(result["total"])
        self.assertEqual(result["lines"], [])

    def test_missing_line_does_not_block_other_lines_but_nulls_total(self):
        result = calculate_estimate(
            [
                rule("Wall Paint", base_rate=2, unit="Per Sqft"),
                rule("Ceiling", base_rate=40, unit="Per Room"),
            ],
            [{"service": "Wall Paint", "quantity": 10},
             {"service": "Ceiling", "quantity": None}],
        )
        self.assertEqual(len(result["lines"]), 1)
        self.assertEqual(result["subtotal"], "20.00")
        self.assertIsNone(result["total"])
        self.assertEqual(len(result["missing"]), 1)

    def test_negative_quantity_is_missing(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=2, unit="Per Sqft")],
            [{"service": "Wall Paint", "quantity": -4}],
        )
        self.assertIsNone(result["total"])
        self.assertIn("Invalid quantity", result["missing"][0])

    def test_invalid_minimum_charge_is_missing(self):
        result = calculate_estimate(
            [rule("Wall Paint", base_rate=2, unit="Per Sqft",
                  minimum_charge="lots")],
            [{"service": "Wall Paint", "quantity": 10}],
        )
        self.assertIsNone(result["total"])
        self.assertIn("Invalid minimum_charge", result["missing"][0])

    def test_empty_items_total_zero(self):
        result = calculate_estimate([rule("Wall Paint")], [])
        self.assertEqual(result["lines"], [])
        self.assertEqual(result["subtotal"], "0.00")
        self.assertEqual(result["total"], "0.00")
        self.assertFalse(result["minimum_applied"])
        self.assertIsNone(result["minimum_charge"])
        self.assertEqual(result["missing"], [])


class RoundingTests(unittest.TestCase):
    def test_half_up_on_line_amount(self):
        result = calculate_estimate(
            [rule("Stain", base_rate="0.125", unit="Flat Rate")],
            [{"service": "Stain"}],
        )
        self.assertEqual(result["lines"][0]["amount"], "0.13")
        self.assertEqual(result["total"], "0.13")

    def test_half_up_not_bankers_rounding(self):
        result = calculate_estimate(
            [rule("Stain", base_rate="2.345", unit="Per Sqft")],
            [{"service": "Stain", "quantity": 1}],
        )
        self.assertEqual(result["lines"][0]["amount"], "2.35")

    def test_float_inputs_do_not_drift(self):
        result = calculate_estimate(
            [rule("Stain", base_rate=0.1, unit="Per Sqft")],
            [{"service": "Stain", "quantity": 3}],
        )
        self.assertEqual(result["lines"][0]["amount"], "0.30")
        self.assertEqual(result["total"], "0.30")

    def test_each_line_rounded_before_summing(self):
        result = calculate_estimate(
            [rule("Stain", base_rate="0.005", unit="Flat Rate")],
            [{"service": "Stain"}, {"service": "Stain"}, {"service": "Stain"}],
        )
        self.assertEqual([l["amount"] for l in result["lines"]],
                         ["0.01", "0.01", "0.01"])
        self.assertEqual(result["subtotal"], "0.03")
        self.assertEqual(result["total"], "0.03")

    def test_money_strings_have_two_decimals(self):
        result = calculate_estimate(
            [rule("Stain", base_rate=5, unit="Per Room")],
            [{"service": "Stain", "quantity": 2}],
        )
        self.assertIsInstance(result["subtotal"], str)
        self.assertIsInstance(result["total"], str)
        self.assertEqual(result["subtotal"], "10.00")
        self.assertEqual(result["lines"][0]["rate"], "5.00")


if __name__ == "__main__":
    unittest.main()

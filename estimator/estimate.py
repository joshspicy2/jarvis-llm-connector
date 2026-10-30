"""Estimate calculator driven by rows from a Notion Estimate Rules database.

Pure standard library. All money is handled with Decimal and rounded to
2 decimal places (ROUND_HALF_UP). Outputs are strings such as '123.45'.

Nothing is guessed: a service without an active rule, a rule without a
base_rate, or a non-flat line without a quantity is reported in ``missing``,
its line is excluded, and ``total`` is None.
"""

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

CENT = Decimal("0.01")

PRIMARY_CATEGORIES = {"Interior", "Exterior"}
CATEGORIES = {"interior": "Interior", "exterior": "Exterior", "add-on": "Add-On"}
UNITS = {
    "per sqft": "Per Sqft",
    "per room": "Per Room",
    "flat rate": "Flat Rate",
    "per hour": "Per Hour",
}


def _money(value):
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _fmt_money(value):
    return format(_money(value), "f")


def _fmt_number(value):
    return format(value.normalize(), "f")


def _to_decimal(value):
    """Return a finite, non-negative Decimal, or None if the value is unusable."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        number = value
    elif isinstance(value, (int, float, str)):
        try:
            number = Decimal(str(value).strip())
        except (InvalidOperation, ValueError):
            return None
    else:
        return None
    if not number.is_finite() or number < 0:
        return None
    return number


def _key(name):
    """Normalise a service name for case-insensitive matching."""
    return " ".join(str(name or "").split()).casefold()


def calculate_estimate(rules, items):
    """Price a list of items against a list of estimate rules.

    rules: list of dicts with keys service, category, base_rate, unit,
        minimum_charge, active (and optional notes, which are ignored).
    items: list of dicts with keys service and quantity. Quantity is ignored
        for Flat Rate services.

    Returns a dict with keys: lines, subtotal, minimum_applied,
    minimum_charge, total, missing, warnings. ``total`` is None whenever
    ``missing`` is non-empty.
    """
    missing = []
    warnings = []

    active_rules = {}
    inactive_keys = set()
    for rule in rules:
        key = _key(rule.get("service"))
        if rule.get("active") is True:
            active_rules.setdefault(key, []).append(rule)
        else:
            inactive_keys.add(key)

    lines = []
    primary_sum = Decimal("0")
    addon_sum = Decimal("0")
    has_primary = False
    minimum = None

    for position, item in enumerate(items, start=1):
        service = item.get("service")
        label = f"'{service}' (item {position})"
        key = _key(service)

        if not key:
            missing.append(f"Item {position} has no service name; line excluded.")
            continue

        matches = active_rules.get(key, [])
        if not matches:
            if key in inactive_keys:
                missing.append(
                    f"Service {label} has only inactive rules; line excluded."
                )
            else:
                missing.append(f"No active rule for service {label}; line excluded.")
            continue
        if len(matches) > 1:
            missing.append(
                f"Multiple active rules match service {label}; cannot choose; "
                "line excluded."
            )
            continue

        rule = matches[0]

        unit = UNITS.get(str(rule.get("unit") or "").strip().casefold())
        if unit is None:
            missing.append(
                f"Rule for {label} has unknown unit {rule.get('unit')!r}; "
                "line excluded."
            )
            continue

        category = CATEGORIES.get(str(rule.get("category") or "").strip().casefold())
        if category is None:
            missing.append(
                f"Rule for {label} has unknown category {rule.get('category')!r}; "
                "line excluded."
            )
            continue

        if rule.get("base_rate") is None:
            missing.append(f"Rule for {label} has no base_rate; line excluded.")
            continue
        rate = _to_decimal(rule.get("base_rate"))
        if rate is None:
            missing.append(
                f"Rule for {label} has invalid base_rate {rule.get('base_rate')!r}; "
                "line excluded."
            )
            continue

        if unit == "Flat Rate":
            if item.get("quantity") is not None:
                warnings.append(
                    f"Quantity for flat-rate service {label} ignored; treated as 1."
                )
            quantity = Decimal("1")
        else:
            raw_quantity = item.get("quantity")
            if raw_quantity is None:
                missing.append(
                    f"Quantity missing for {label} ({unit}); line excluded."
                )
                continue
            quantity = _to_decimal(raw_quantity)
            if quantity is None:
                missing.append(
                    f"Invalid quantity {raw_quantity!r} for {label}; line excluded."
                )
                continue

        if category in PRIMARY_CATEGORIES and rule.get("minimum_charge") is not None:
            rule_minimum = _to_decimal(rule.get("minimum_charge"))
            if rule_minimum is None:
                missing.append(
                    f"Invalid minimum_charge {rule.get('minimum_charge')!r} for "
                    f"{label}; line excluded."
                )
                continue
        else:
            rule_minimum = None

        amount = _money(rate * quantity)
        lines.append(
            {
                "service": rule.get("service"),
                "unit": unit,
                "quantity": _fmt_number(quantity),
                "rate": _fmt_money(rate),
                "amount": _fmt_money(amount),
            }
        )

        if category in PRIMARY_CATEGORIES:
            has_primary = True
            primary_sum += amount
            if rule_minimum is not None and (minimum is None or rule_minimum > minimum):
                minimum = rule_minimum
        else:
            addon_sum += amount

    minimum_applied = (
        has_primary and minimum is not None and primary_sum < minimum
    )
    primary_total = minimum if minimum_applied else primary_sum

    subtotal = _money(primary_sum + addon_sum)
    total = None if missing else _money(primary_total + addon_sum)

    return {
        "lines": lines,
        "subtotal": _fmt_money(subtotal),
        "minimum_applied": bool(minimum_applied),
        "minimum_charge": _fmt_money(minimum) if has_primary and minimum is not None else None,
        "total": _fmt_money(total) if total is not None else None,
        "missing": missing,
        "warnings": warnings,
    }

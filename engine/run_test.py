#!/usr/bin/env python3
"""Run solver with seed_apparel.json and validate output."""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from solver import solve

DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

with open(os.path.join(os.path.dirname(__file__), "seed_apparel.json")) as f:
    data = json.load(f)

print("=" * 60)
print("  Camp Nou Planner - Apparel seed test")
print("=" * 60)

result = solve(data)

print(f"\nStatus:    {result['status']}")
print(f"Objective: {result['objective']}")
print(f"Warnings:  {result['warnings']}")

# ── Schedule table ──
print("\n" + "─" * 80)
print(f"{'Employee':<22}", end="")
for d in DAYS:
    print(f" {d:>9}", end="")
print("  Days  Hours")
print("─" * 80)

dpw = data["params"]["days_per_week"]
errors = []

for emp in data["employees"]:
    eid = emp["id"]
    name = emp["name"]
    sched = result["schedule"].get(eid, {})
    print(f"{name:<22}", end="")
    days_worked = 0
    total_h = 0.0
    for d in DAYS:
        entry = sched.get(d, {"code": "off"})
        code = entry.get("code", "normal")
        if code == "vacation":
            print(f"     {'VAC':>4}", end="")
        elif code == "off":
            print(f"     {'OFF':>4}", end="")
        else:
            s = entry["start"]
            e = entry["end"]
            print(f" {s}-{e}", end="")
            days_worked += 1
            total_h += entry["hours"]
    expected_days = dpw - len(emp.get("vacations", []))
    off_days = 7 - days_worked - len(emp.get("vacations", []))
    print(f"   {days_worked:>2}   {total_h:>4.0f}h")

    # Validate contract
    hpd = emp["weekly_hours"] / dpw
    if days_worked != expected_days:
        errors.append(f"{name}: worked {days_worked}d, expected {expected_days}d")
    if abs(total_h - hpd * expected_days) > 0.01:
        errors.append(f"{name}: {total_h}h worked, expected {hpd * expected_days}h")

# Validate Casas fixed schedule
casas = result["schedule"].get("E07", {})
for d in ["MON", "TUE", "WED", "THU", "FRI"]:
    entry = casas.get(d, {})
    if entry.get("start") != "10:00":
        errors.append(f"Casas: {d} start is {entry.get('start')}, expected 10:00")
for d in ["SAT", "SUN"]:
    if casas.get(d, {}).get("code") != "off":
        errors.append(f"Casas: {d} should be off, got {casas.get(d)}")

# Validate Khayari vacations
khayari = result["schedule"].get("E04", {})
for d in ["THU", "FRI"]:
    if khayari.get(d, {}).get("code") != "vacation":
        errors.append(f"Khayari: {d} should be vacation, got {khayari.get(d)}")

# Validate Thursday inventory coverage (21:00-01:00)
print("\n── THU inventory coverage (21:00-01:00) ──")
thu_cov = result["coverage"].get("THU", [])
for slot in thu_cov:
    t = slot["time"]
    h = int(t.split(":")[0])
    # slots from 21:00 onward or before 02:00 (past midnight)
    if h >= 21 or h < 1:
        print(f"  {t}: {slot['assigned']} assigned")
        if slot["assigned"] < 2:
            errors.append(f"THU inventory {t}: only {slot['assigned']} assigned, need >= 2")

# Validate Saturday late coverage (postclose until 23:30)
print("\n── SAT late coverage (22:00-23:30) ──")
sat_cov = result["coverage"].get("SAT", [])
for slot in sat_cov:
    t = slot["time"]
    h = int(t.split(":")[0])
    m = int(t.split(":")[1])
    if h >= 22:
        print(f"  {t}: {slot['assigned']} assigned (target {slot['target']})")

# Summary
print("\n" + "=" * 60)
if result["status"] == "OPTIMAL" and len(result["warnings"]) == 0 and len(errors) == 0:
    print("  ALL CHECKS PASSED")
else:
    if result["status"] != "OPTIMAL":
        print(f"  STATUS: {result['status']} (expected OPTIMAL)")
    for w in result["warnings"]:
        print(f"  WARNING: {w}")
    for e in errors:
        print(f"  ERROR: {e}")
print("=" * 60)

sys.exit(0 if (result["status"] == "OPTIMAL" and not errors and not result["warnings"]) else 1)

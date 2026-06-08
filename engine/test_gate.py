#!/usr/bin/env python3
"""GATE tests — ALL must pass before deploy."""
import json, sys
from solver import solve

DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
PASS = 0; FAIL = 0

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ✅ {name}")
    else:
        FAIL += 1; print(f"  ❌ {name}  {detail}")

BASE = {
    "days_per_week": 5,
    "preopen": {"minutes": 30, "min": 2, "max": 3},
    "postclose": {"minutes": 30, "min": 2, "max": 3},
    "min_rest_hours": 0, "max_consecutive_days": 7,  # disabled for legacy tests
    "store_hours": {
        "MON": {"open":"08:00","close":"21:00"},
        "TUE": {"open":"08:00","close":"21:00"},
        "WED": {"open":"08:00","close":"21:00"},
        "THU": {"open":"08:00","close":"21:00","special":"inventory",
                "extra":{"from":"21:00","to":"01:00","min":2,"max":3}},
        "FRI": {"open":"08:00","close":"21:00"},
        "SAT": {"open":"08:00","close":"23:00","special":"match"},
        "SUN": {"open":"09:00","close":"21:00"},
    },
    "billing": {
        "daily": {"MON":9000,"TUE":9500,"WED":10000,"THU":10000,
                  "FRI":13000,"SAT":16000,"SUN":10000},
        "productivity_eur_per_person_hour": 420,
        "profiles": {
            "normal": {"8":3,"9":5,"10":11,"11":13,"12":12,"13":9,
                       "14":7,"15":7,"16":9,"17":11,"18":11,"19":9,"20":5,"21":3},
            "match":  {"8":2,"9":3,"10":6,"11":7,"12":7,"13":6,"14":6,
                       "15":7,"16":8,"17":9,"18":9,"19":10,"20":11,"21":14,"22":14,"23":9},
        },
    },
}

# ── (a) Accesorios 6 personas ──────────────────────────────────────
print("\n(a) Accesorios — 6 personas + inventario + partido")
r = solve({
    "department": {"id":"acc","name":"Accesorios"},
    "params": BASE,
    "employees": [
        {"id":"A1","name":"Borja, Melissa","weekly_hours":25,"availability":"M"},
        {"id":"A2","name":"Ji Chen, Elena","weekly_hours":25,"availability":"T"},
        {"id":"A3","name":"Jimenez, Paula","weekly_hours":25,"availability":"M"},
        {"id":"A4","name":"Pérez, Laia",   "weekly_hours":25,"availability":"T"},
        {"id":"A5","name":"Roca, Pau",     "weekly_hours":25,"availability":"F"},
        {"id":"A6","name":"Garcia, Anna",  "weekly_hours":25,"availability":"F"},
    ],
})
check("status OPTIMAL or FEASIBLE", r["status"] in ("OPTIMAL","FEASIBLE"), r["status"])
check("NOT INFEASIBLE", r["status"] != "INFEASIBLE")
check("schedule has 6 employees", len(r["schedule"]) == 6)
for eid in ["A1","A2","A3","A4","A5","A6"]:
    days_on = sum(1 for v in r["schedule"].get(eid,{}).values() if v.get("code")=="normal")
    check(f"  {eid} works 5 days", days_on == 5, f"got {days_on}")
check("coverage all 7 days", all(d in r["coverage"] for d in DAYS))
check("has debug field", "debug" in r)

# ── (b) Apertura 10:00 + montaje 60 min ───────────────────────────
print("\n(b) Apertura 10:00 + montaje 60 min")
p2 = json.loads(json.dumps(BASE))
for d in p2["store_hours"]:
    p2["store_hours"][d] = {"open":"10:00","close":"21:00"}
p2["preopen"]["minutes"] = 60
r2 = solve({
    "department": {"id":"t","name":"Test"},
    "params": p2,
    "employees": [
        {"id":"E1","name":"Test, A","weekly_hours":25,"availability":"M"},
        {"id":"E2","name":"Test, B","weekly_hours":25,"availability":"F"},
    ],
})
check("status OK", r2["status"] in ("OPTIMAL","FEASIBLE"), r2["status"])
bad = []
for eid, days in r2["schedule"].items():
    for d, entry in days.items():
        if entry.get("start") and entry["start"] < "09:00":
            bad.append(f"{eid}/{d}={entry['start']}")
check("nobody before 09:00", len(bad)==0, str(bad))
first = r2["coverage"]["MON"][0]["time"] if r2["coverage"].get("MON") else "?"
check("first slot 09:00", first=="09:00", f"got {first}")

# ── (c) 25h + 2 absences → 3 days 15h ─────────────────────────────
print("\n(c) 25h + 2 ausencias → 3 días (15h)")
r3 = solve({
    "department": {"id":"t","name":"Test"},
    "params": BASE,
    "employees": [
        {"id":"K1","name":"Khayari, Hajar","weekly_hours":25,"availability":"T",
         "absences":[{"type":"VCN","days":["THU","FRI"]}]},
        {"id":"F1","name":"Filler, One","weekly_hours":25,"availability":"F"},
        {"id":"F2","name":"Filler, Two","weekly_hours":25,"availability":"M"},
    ],
})
check("status OK", r3["status"] in ("OPTIMAL","FEASIBLE"), r3["status"])
k1 = r3["schedule"].get("K1", {})
k1_on = sum(1 for v in k1.values() if v.get("code")=="normal")
k1_abs = sum(1 for v in k1.values() if v.get("code") not in ("normal","off"))
check("K1 works 3 days", k1_on==3, f"got {k1_on}")
check("K1 has 2 absence days", k1_abs==2, f"got {k1_abs}")
k1_hrs = sum(v.get("hours",0) for v in k1.values() if v.get("code")=="normal")
check("K1 total 15h", abs(k1_hrs-15)<0.01, f"got {k1_hrs}")
for dd in ("THU","FRI"):
    check(f"K1 {dd} code=VCN", k1.get(dd,{}).get("code")=="VCN",
          f"got {k1.get(dd,{}).get('code')}")

# ── (d) Apparel 9 (seed) ──────────────────────────────────────────
print("\n(d) Apparel — 9 personas (seed)")
with open("seed_apparel.json") as f:
    seed = json.load(f)
r4 = solve(seed)
check("status OPTIMAL", r4["status"]=="OPTIMAL", r4["status"])
check("0 warnings", len(r4["warnings"])==0, f"{len(r4['warnings'])} warnings")
if r4["warnings"]:
    for w in r4["warnings"][:5]: print(f"    ⚠ {w}")

# ── (e) 3 CLOSED days (only 4 open) ───────────────────────────────
print("\n(e) 3 días cerrados (solo 4 abiertos)")
p5 = json.loads(json.dumps(BASE))
# Close THU, SAT, SUN
for d in ["THU", "SAT", "SUN"]:
    p5["store_hours"][d] = {"open": "00:00", "close": "00:00"}  # closed
r5 = solve({
    "department": {"id":"t","name":"Test"},
    "params": p5,
    "employees": [
        {"id":"C1","name":"López, Ana",    "weekly_hours":25,"availability":"M"},
        {"id":"C2","name":"Martín, Carlos","weekly_hours":25,"availability":"T"},
        {"id":"C3","name":"Roca, Marta",   "weekly_hours":25,"availability":"F"},
    ],
})
check("status OK (NOT INFEASIBLE)", r5["status"] in ("OPTIMAL","FEASIBLE"), r5["status"])
check("NOT INFEASIBLE", r5["status"]!="INFEASIBLE")
# each employee works at most 4 days
for eid in ["C1","C2","C3"]:
    on = sum(1 for v in r5["schedule"].get(eid,{}).values() if v.get("code")=="normal")
    check(f"  {eid} works <= 4 days", on <= 4, f"got {on}")
# warnings should mention can't reach hours
found_warn = any("no alcanza" in w or "solo" in w.lower() for w in r5["warnings"])
check("warning about insufficient days", found_warn,
      f"warnings: {r5['warnings'][:3]}")

# ── (f) REAL Accesorios from Firestore (fixture) ──────────────────
print("\n(f) Accesorios REAL (fixtures/accesorios_real.json)")
import os
fixture_path = os.path.join(os.path.dirname(__file__), "fixtures", "accesorios_real.json")
if os.path.exists(fixture_path):
    with open(fixture_path) as f:
        real = json.load(f)
    r6 = solve(real)
    check("status OPTIMAL or FEASIBLE", r6["status"] in ("OPTIMAL","FEASIBLE"), r6["status"])
    check("NOT INFEASIBLE", r6["status"] != "INFEASIBLE")
    check("has schedule", len(r6["schedule"]) > 0)
    check("has coverage", any(len(v) > 0 for v in r6["coverage"].values()))
    n_emps = len(real["employees"])
    n_sched = len(r6["schedule"])
    check(f"schedule has all {n_emps} employees", n_sched == n_emps, f"got {n_sched}")
    # billing is 150M but should NOT cause infeasible
    bill_mon = real["params"]["billing"]["daily"].get("MON", 0)
    check(f"handles extreme billing ({bill_mon}€)", r6["status"] != "INFEASIBLE")
else:
    check("fixture file exists", False, "fixtures/accesorios_real.json not found")

# ── (g) Coverage mode (demand_curve) ───────────────────────────────
print("\n(g) Modo Cobertura (demand_curve explícita)")
p7 = json.loads(json.dumps(BASE))
# Remove billing (not needed for coverage mode)
p7["billing"]["daily"] = {d: 0 for d in DAYS}
# Add explicit demand_curve — Almacén style: 2 bands per day
p7["demand_curve"] = {}
for d in DAYS:
    p7["demand_curve"][d] = [
        {"from": "08:00", "to": "14:00", "min": 2, "max": 3},
        {"from": "14:00", "to": "21:00", "min": 1, "max": 2},
    ]
r7 = solve({
    "department": {"id":"alm", "name":"Almacén"},
    "params": p7,
    "employees": [
        {"id":"W1","name":"Solé, Pere",  "weekly_hours":25,"availability":"M"},
        {"id":"W2","name":"Riba, Toni",  "weekly_hours":25,"availability":"F"},
        {"id":"W3","name":"Tomàs, Quim", "weekly_hours":25,"availability":"M"},
        {"id":"W4","name":"Vila, Aleix", "weekly_hours":25,"availability":"T"},
    ],
})
check("status OPTIMAL/FEASIBLE", r7["status"] in ("OPTIMAL","FEASIBLE"), r7["status"])
check("NOT INFEASIBLE", r7["status"] != "INFEASIBLE")
check("has schedule", len(r7["schedule"]) == 4)
# Coverage targets should reflect the bands (min 1-2), not billing
cov_mon = r7["coverage"].get("MON", [])
open_cov = [c for c in cov_mon if c["target"] > 0]
check("coverage has targets from bands", len(open_cov) > 0, f"open slots with target: {len(open_cov)}")
# Check targets are 1 or 2 (from the bands), not billing-derived huge numbers
max_tgt = max((c["target"] for c in open_cov), default=0)
check(f"max target is reasonable ({max_tgt})", max_tgt <= 3, f"got {max_tgt}")

# ── (h) Cajas with non-flat profile via demand_curve ──────────────
print("\n(h) Modo Cajas (demand_curve con perfil no plano)")
p8 = json.loads(json.dumps(BASE))
# Simulate Cajas: front computes demand_curve from billing × profile / ticket
# Store billing 9000€, ticket 25€, clients/cash/hour 15, profile varies
store_bill = 9000
ticket = 25
clients_per_cash_h = 15
profile = {"8":0,"9":3,"10":11,"11":14,"12":12,"13":9,"14":7,"15":7,"16":9,"17":11,"18":11,"19":9,"20":5,"21":0}
# Compute demand_curve: for each hour, cajas = ceil(store_bill * pct/100 / ticket * 2 / clients_per_cash_h)
import math
curve_day = []
for hr_s, pct in sorted(profile.items(), key=lambda x: int(x[0])):
    hr = int(hr_s)
    if pct == 0:
        continue
    clients_per_hour = store_bill * pct / 100 / ticket
    cajas = max(1, math.ceil(clients_per_hour / clients_per_cash_h))
    curve_day.append({"from": f"{hr:02d}:00", "to": f"{hr+1:02d}:00", "min": cajas, "max": cajas + 1})

p8["demand_curve"] = {d: curve_day for d in DAYS}
p8["billing"]["daily"] = {d: 0 for d in DAYS}  # not used when demand_curve present

r8 = solve({
    "department": {"id": "cajas", "name": "Cajas"},
    "params": p8,
    "employees": [
        {"id":"J1","name":"Serra, Mar",  "weekly_hours":25,"availability":"M"},
        {"id":"J2","name":"Vidal, Joan", "weekly_hours":25,"availability":"T"},
        {"id":"J3","name":"Costa, Aina", "weekly_hours":25,"availability":"F"},
    ],
})
check("status OPTIMAL/FEASIBLE", r8["status"] in ("OPTIMAL","FEASIBLE"), r8["status"])
check("NOT INFEASIBLE", r8["status"] != "INFEASIBLE")
# Coverage targets should VARY by hour (not flat)
cov_mon = r8["coverage"].get("MON", [])
open_targets = [c["target"] for c in cov_mon if c["target"] > 0]
check("has varying targets", len(set(open_targets)) > 1,
      f"unique targets: {sorted(set(open_targets))}")
# Peak target should be higher than valley
if open_targets:
    check(f"peak target ({max(open_targets)}) > valley ({min(open_targets)})",
          max(open_targets) > min(open_targets),
          f"all same: {open_targets[:5]}")

# ── (i) 12h rest: late close prevents early start next day ────────
print("\n(i) Descanso 12h entre turnos")
p9 = json.loads(json.dumps(BASE))
# THU closes at 01:00 (inventory), FRI opens 08:00 with 1h montaje → 07:00
p9["store_hours"]["THU"] = {"open":"08:00","close":"21:00","special":"inventory",
                            "extra":{"from":"21:00","to":"01:00","min":1,"max":2}}
p9["min_rest_hours"] = 12
r9 = solve({
    "department": {"id":"t","name":"Test"},
    "params": p9,
    "employees": [
        {"id":"R1","name":"Test, Rest","weekly_hours":25,"availability":"T"},
        {"id":"R2","name":"Filler, A","weekly_hours":25,"availability":"M"},
        {"id":"R3","name":"Filler, B","weekly_hours":25,"availability":"F"},
    ],
})
check("status OK", r9["status"] in ("OPTIMAL","FEASIBLE"), r9["status"])
# R1 is T availability: if works THU late (e.g. ends 01:00), FRI can't start before 13:00
r1_thu = r9["schedule"].get("R1",{}).get("THU",{})
r1_fri = r9["schedule"].get("R1",{}).get("FRI",{})
if r1_thu.get("end") and r1_fri.get("start"):
    from solver import _tm as TM
    end_thu = TM(r1_thu["end"])
    if end_thu < 420: end_thu += 1440  # past midnight
    start_fri = TM(r1_fri["start"])
    gap = start_fri - end_thu
    if gap < 0: gap += 1440
    check(f"R1 rest gap {gap}min >= 720min (12h)", gap >= 720, f"gap={gap}")
else:
    check("R1 rest (one day off, constraint trivially met)", True)

# ── (j) Max 5 consecutive: prev week trailing ────────────────────
print("\n(j) Máx 5 días seguidos (con semana anterior)")
p10 = json.loads(json.dumps(BASE))
p10["max_consecutive_days"] = 5
# Employee worked WED-SUN of previous week (5 consecutive)
r10 = solve({
    "department": {"id":"t","name":"Test"},
    "params": p10,
    "prev_week_schedule": {
        "C1": {"MON": False, "TUE": False, "WED": True, "THU": True,
               "FRI": True, "SAT": True, "SUN": True},
    },
    "employees": [
        {"id":"C1","name":"Test, Consec","weekly_hours":25,"availability":"F"},
        {"id":"C2","name":"Filler, X","weekly_hours":25,"availability":"M"},
        {"id":"C3","name":"Filler, Y","weekly_hours":25,"availability":"T"},
    ],
})
check("status OK", r10["status"] in ("OPTIMAL","FEASIBLE"), r10["status"])
# C1 had 5 trailing days (WED-SUN), so MON must be off
c1_mon = r10["schedule"].get("C1",{}).get("MON",{})
check("C1 MON is off (5 trailing from prev week)", c1_mon.get("code") == "off",
      f"got {c1_mon.get('code')}")

# ── summary ────────────────────────────────────────────────────────
print(f"\n{'='*50}")
print(f"  {PASS} passed, {FAIL} failed")
print(f"{'='*50}")
sys.exit(1 if FAIL else 0)

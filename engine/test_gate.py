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

# ── summary ────────────────────────────────────────────────────────
print(f"\n{'='*50}")
print(f"  {PASS} passed, {FAIL} failed")
print(f"{'='*50}")
sys.exit(1 if FAIL else 0)

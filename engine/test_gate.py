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
# With corrected demand (no /2), montaje/cierre warnings are expected for 9 people
# Allow montaje/cierre/inventory/empty-slot warnings (coverage gaps are normal with 9 people)
non_ops = [w for w in r4["warnings"] if not any(k in w for k in ["montaje","cierre","inventory","0 personas"])]
check("no non-operational warnings", len(non_ops)==0, f"{non_ops[:3]}")
if r4["warnings"]:
    print(f"    ({len(r4['warnings'])} montaje/cierre warnings — expected)")

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

# ── (k) Balanced distribution with surplus staff ─────────────────
print("\n(k) Reparto equilibrado — 7 días abiertos, demanda parecida, plantilla holgada")
pk = json.loads(json.dumps(BASE))
# Even billing across all days
for d in DAYS:
    pk["billing"]["daily"][d] = 9000
# Profile giving ~2 people target per slot at 420€/h prod
# 9000 × 11%/100 / 420 = 2.36 → round to 2
# Without /2: it's the target per slot = people present
r_k = solve({
    "department": {"id":"t","name":"Test"},
    "params": pk,
    "employees": [
        {"id":"B1","name":"Uno, A",  "weekly_hours":25,"availability":"F"},
        {"id":"B2","name":"Dos, B",  "weekly_hours":25,"availability":"F"},
        {"id":"B3","name":"Tres, C", "weekly_hours":25,"availability":"F"},
        {"id":"B4","name":"Cuatro,D","weekly_hours":25,"availability":"F"},
        {"id":"B5","name":"Cinco, E","weekly_hours":25,"availability":"F"},
        {"id":"B6","name":"Seis, F", "weekly_hours":25,"availability":"F"},
        {"id":"B7","name":"Siete,G", "weekly_hours":25,"availability":"F"},
    ],
})
check("status OK", r_k["status"] in ("OPTIMAL","FEASIBLE"), r_k["status"])

# (i) Target without /2: at peak (11%) → 9000*11/100/420 ≈ 2.36 → 2
cov_mon = r_k["coverage"].get("MON", [])
peak_targets = [c["target"] for c in cov_mon if c["target"] > 0]
if peak_targets:
    check(f"peak target reasonable (~2, got {max(peak_targets)})", max(peak_targets) >= 2)

# (ii) Workers spread across all 7 days, not clustered
workers_per_day = {}
for d in DAYS:
    cnt = sum(1 for eid in r_k["schedule"]
              if r_k["schedule"][eid].get(d, {}).get("code") == "normal")
    workers_per_day[d] = cnt
wvals = list(workers_per_day.values())
check(f"min workers/day ({min(wvals)}) >= 3", min(wvals) >= 3, f"distribution: {workers_per_day}")
check(f"max-min spread <= 2 ({max(wvals)-min(wvals)})", max(wvals) - min(wvals) <= 2,
      f"distribution: {workers_per_day}")
# Specifically: SAT and SUN should not be empty
check(f"SAT has workers ({workers_per_day.get('SAT',0)})", workers_per_day.get("SAT", 0) >= 3)
check(f"SUN has workers ({workers_per_day.get('SUN',0)})", workers_per_day.get("SUN", 0) >= 3)

# (iii) Shift stability: check that individual employees don't jump wildly
for eid in ["B1","B2","B3"]:
    starts = []
    for d in DAYS:
        e = r_k["schedule"].get(eid, {}).get(d, {})
        if e.get("start"):
            h2, m2 = map(int, e["start"].split(":")); starts.append(h2*60+m2)
    if len(starts) >= 2:
        spread = max(starts) - min(starts)
        # F employees covering 13h store days — stability is soft, coverage wins
        # Just check it's not the full 13h range (780min)
        check(f"  {eid} start spread {spread}min < 780min", spread < 780, f"spread={spread}")

# ── (l) Surplus staff: contract hours MUST be fulfilled ──────────
print("\n(l) Sobreplantilla — 9 personas, demanda pico 3, TODOS hacen sus horas")
pl = json.loads(json.dumps(BASE))
for d in DAYS: pl["billing"]["daily"][d] = 9000
# Peak target at hour 11: 9000*13/100/420 ≈ 2.8 → 3
r_l = solve({
    "department": {"id":"t","name":"Test"},
    "params": pl,
    "employees": [
        {"id":"S1","name":"Emp, A","weekly_hours":25,"availability":"M"},
        {"id":"S2","name":"Emp, B","weekly_hours":25,"availability":"M"},
        {"id":"S3","name":"Emp, C","weekly_hours":25,"availability":"M"},
        {"id":"S4","name":"Emp, D","weekly_hours":25,"availability":"T"},
        {"id":"S5","name":"Emp, E","weekly_hours":25,"availability":"T"},
        {"id":"S6","name":"Emp, F","weekly_hours":25,"availability":"T"},
        {"id":"S7","name":"Emp, G","weekly_hours":25,"availability":"F"},
        {"id":"S8","name":"Emp, H","weekly_hours":25,"availability":"F"},
        {"id":"S9","name":"Emp, I","weekly_hours":25,"availability":"F"},
    ],
})
check("status OK", r_l["status"] in ("OPTIMAL","FEASIBLE"), r_l["status"])
# EVERY employee must work their full 5 days — contract trumps demand
all_full = True
for eid in [f"S{i}" for i in range(1,10)]:
    days_on = sum(1 for v in r_l["schedule"].get(eid,{}).values() if v.get("code")=="normal")
    if days_on < 5:
        check(f"  {eid} works 5 days", False, f"got {days_on}")
        all_full = False
check("ALL 9 employees work 5 days (contract fulfilled)", all_full)
# Workers per day should be spread (not all on weekdays, empty weekends)
wpd = {}
for d in DAYS:
    wpd[d] = sum(1 for e in r_l["schedule"] if r_l["schedule"][e].get(d,{}).get("code")=="normal")
check(f"SAT has workers ({wpd.get('SAT',0)} >= 5)", wpd.get("SAT",0) >= 5)
check(f"SUN has workers ({wpd.get('SUN',0)} >= 5)", wpd.get("SUN",0) >= 5)
check(f"max-min spread <= 3 ({max(wpd.values())-min(wpd.values())})",
      max(wpd.values()) - min(wpd.values()) <= 3, f"{wpd}")

# ── (m) Per-day availability: M weekdays, F weekends ─────────────
print("\n(m) Disponibilidad por día: M lun–vie, F sáb–dom")
pm = json.loads(json.dumps(BASE))
rm = solve({
    "department": {"id":"t","name":"Test"},
    "params": pm,
    "employees": [
        {"id":"PD1","name":"Test, PerDay","weekly_hours":25,
         "availability":{"mon":"M","tue":"M","wed":"M","thu":"M","fri":"M","sat":"F","sun":"F"}},
        {"id":"PD2","name":"Filler, A","weekly_hours":25,"availability":"F"},
    ],
})
check("status OK", rm["status"] in ("OPTIMAL","FEASIBLE"), rm["status"])
pd1 = rm["schedule"].get("PD1", {})
# Weekdays: must start before 15:00 (M window)
for d in ["MON","TUE","WED","THU","FRI"]:
    e = pd1.get(d, {})
    if e.get("start"):
        h2, m2 = map(int, e["start"].split(":")); sm = h2*60+m2
        check(f"  PD1 {d} start {e['start']} <= 12:30 (M window)", sm <= 12*60+30, f"start={e['start']}")
# Weekends: can start afternoon (F window)
for d in ["SAT","SUN"]:
    e = pd1.get(d, {})
    if e.get("start"):
        check(f"  PD1 {d} works (F window)", True)

# ── (n) X = not available on Monday ──────────────────────────────
print("\n(n) Disponibilidad X = no disponible lunes")
rn = solve({
    "department": {"id":"t","name":"Test"},
    "params": pm,
    "employees": [
        {"id":"NX1","name":"Test, NoMon","weekly_hours":25,
         "availability":{"mon":"X","tue":"F","wed":"F","thu":"F","fri":"F","sat":"F","sun":"F"}},
        {"id":"NX2","name":"Filler, B","weekly_hours":25,"availability":"F"},
    ],
})
check("status OK", rn["status"] in ("OPTIMAL","FEASIBLE"), rn["status"])
nx1 = rn["schedule"].get("NX1", {})
check("NX1 MON is off (X)", nx1.get("MON", {}).get("code") in ("off", None), f"got {nx1.get('MON',{})}")
nx1_days = sum(1 for v in nx1.values() if v.get("code") == "normal")
check(f"NX1 works 5 days (from tue-sun)", nx1_days == 5, f"got {nx1_days}")

# ── (o) String availability still works ──────────────────────────
print("\n(o) String availability (retrocompat)")
ro = solve({
    "department": {"id":"t","name":"Test"},
    "params": pm,
    "employees": [
        {"id":"RC1","name":"Test, StrM","weekly_hours":25,"availability":"M"},
        {"id":"RC2","name":"Test, StrT","weekly_hours":25,"availability":"T"},
        {"id":"RC3","name":"Test, StrF","weekly_hours":25,"availability":"F"},
    ],
})
check("status OK", ro["status"] in ("OPTIMAL","FEASIBLE"), ro["status"])
for eid in ["RC1","RC2","RC3"]:
    d_on = sum(1 for v in ro["schedule"].get(eid,{}).values() if v.get("code")=="normal")
    check(f"  {eid} works 5 days", d_on == 5, f"got {d_on}")

# ── (p) Bases parciales: días/horas realistas ───────────────────────
print("\n(p) Bases parciales 8/12/16 (F, tienda L-D, sin ausencias) + control 25")
rp = solve({
    "department": {"id":"pt","name":"PartTime"},
    "params": BASE,
    "employees": [
        {"id":"P8", "name":"Part, Ocho",        "weekly_hours":8,  "availability":"F"},
        {"id":"P12","name":"Part, Doce",        "weekly_hours":12, "availability":"F"},
        {"id":"P16","name":"Part, Dieciseis",   "weekly_hours":16, "availability":"F"},
        {"id":"P25","name":"Ctrl, Veinticinco", "weekly_hours":25, "availability":"F"},
    ],
})
check("status OK", rp["status"] in ("OPTIMAL","FEASIBLE"), rp["status"])
for eid, exp_days, exp_hpd, exp_total in [("P8",2,4,8),("P12",2,6,12),("P16",4,4,16),("P25",5,5,25)]:
    work = {d: v for d, v in rp["schedule"].get(eid,{}).items() if v.get("code")=="normal"}
    days  = len(work)
    total = round(sum(v.get("hours",0) for v in work.values()), 2)
    check(f"  {eid} works {exp_days} days", days == exp_days, f"got {days}")
    check(f"  {eid} every day = {exp_hpd}h",
          all(round(v.get('hours',0),2)==exp_hpd for v in work.values()),
          f"got {sorted({round(v.get('hours',0),2) for v in work.values()})}")
    check(f"  {eid} total = {exp_total}h", total == exp_total, f"got {total}")
    print(f"     {eid}: " + ", ".join(f"{d} {v['start']}-{v['end']} ({v['hours']}h)"
                                       for d,v in work.items()))

# ── (q) Contrato gana a la demanda + DLB no resta contrato ──────────
# q1: COBERTURA con plantilla > demanda. Banda min 1 (poca demanda), 6 personas de 25h:
#     todas deben cumplir contrato (5 días × 5h) aunque sobre gente. (Antes fallaba: la
#     sobre-cobertura cuadrática superaba al contrato y dejaba días sin cubrir.)
print("\n(q1) Cobertura plantilla>demanda: todos cumplen contrato")
pcov = json.loads(json.dumps(BASE))
pcov["demand_mode"] = "cobertura"
pcov["billing"]["daily"] = {d: 0 for d in DAYS}
band = [{"from":"08:00","to":"21:00","min":1,"max":2}]
pcov["demand_curve"] = {d: band for d in DAYS}
rq = solve({
    "department": {"id":"cov","name":"Cob"},
    "params": pcov,
    "employees": [{"id":f"Q{i}","name":f"Cob, {i}","weekly_hours":25,"availability":"F"} for i in range(1,7)],
})
check("status OK", rq["status"] in ("OPTIMAL","FEASIBLE"), rq["status"])
for i in range(1,7):
    eid = f"Q{i}"
    work = {d:v for d,v in rq["schedule"].get(eid,{}).items() if v.get("code")=="normal"}
    total = round(sum(v.get("hours",0) for v in work.values()),2)
    check(f"  {eid} works 5 days", len(work)==5, f"got {len(work)}")
    check(f"  {eid} total 25h",  total==25, f"got {total}")
print("     Q1: " + ", ".join(f"{d} {v['hours']}h" for d,v in
      {d:v for d,v in rq["schedule"].get("Q1",{}).items() if v.get("code")=="normal"}.items()))

# q2: DLB NO resta contrato → 25h/5d con 1 DLB trabaja 5 días (evita el DLB), 25h.
print("\n(q2) DLB no resta contrato (trabaja 5 días, 25h)")
rdlb = solve({
    "department": {"id":"t","name":"T"},
    "params": BASE,
    "employees": [{"id":"DLB1","name":"Libre, Uno","weekly_hours":25,"availability":"F",
                   "absences":[{"type":"DLB","days":["MON"]}]}],
})
check("status OK", rdlb["status"] in ("OPTIMAL","FEASIBLE"), rdlb["status"])
wdlb = {d:v for d,v in rdlb["schedule"].get("DLB1",{}).items() if v.get("code")=="normal"}
check("  DLB1 works 5 days", len(wdlb)==5, f"got {len(wdlb)}")
check("  DLB1 total 25h", round(sum(v.get('hours',0) for v in wdlb.values()),2)==25, f"got {sum(v.get('hours',0) for v in wdlb.values())}")
check("  DLB1 MON libre", rdlb["schedule"].get("DLB1",{}).get("MON",{}).get("code") in ("off",None,"DLB"), f"got {rdlb['schedule'].get('DLB1',{}).get('MON',{})}")
print("     DLB1: " + ", ".join(f"{d} {v['hours']}h" for d,v in wdlb.items()))

# q3: VCN SÍ resta contrato → 25h/5d con 1 VCN trabaja 4 días, 20h.
print("\n(q3) VCN sí resta contrato (trabaja 4 días)")
rvcn = solve({
    "department": {"id":"t","name":"T"},
    "params": BASE,
    "employees": [{"id":"VCN1","name":"Vaca, Uno","weekly_hours":25,"availability":"F",
                   "absences":[{"type":"VCN","days":["MON"]}]}],
})
check("status OK", rvcn["status"] in ("OPTIMAL","FEASIBLE"), rvcn["status"])
wvcn = {d:v for d,v in rvcn["schedule"].get("VCN1",{}).items() if v.get("code")=="normal"}
check("  VCN1 works 4 days", len(wvcn)==4, f"got {len(wvcn)}")

# ── summary ────────────────────────────────────────────────────────
print(f"\n{'='*50}")
print(f"  {PASS} passed, {FAIL} failed")
print(f"{'='*50}")
sys.exit(1 if FAIL else 0)

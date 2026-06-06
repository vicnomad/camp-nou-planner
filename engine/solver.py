"""Camp Nou Planner - CP-SAT schedule solver.

One call = one department, one week.
Grid of 30-minute slots starting at grid_default_start (default 07:00).
"""

from ortools.sat.python import cp_model

DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]


def _tm(t: str) -> int:
    """HH:MM -> minutes since midnight."""
    h, m = map(int, t.split(":"))
    return h * 60 + m


def _fmt(m: int) -> str:
    """Minutes since midnight -> HH:MM (wraps at 24 h)."""
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


def solve(data: dict) -> dict:
    params = data["params"]
    employees = data["employees"]
    grid0 = _tm(params.get("grid_default_start", "07:00"))
    dpw = params.get("days_per_week", 5)

    pre_cfg = params.get("preopen", {})
    post_cfg = params.get("postclose", {})
    pre_slots = pre_cfg.get("minutes", 0) // 30
    post_slots = post_cfg.get("minutes", 0) // 30
    pre_min = pre_cfg.get("min", 0)
    pre_max = pre_cfg.get("max", 99)
    post_min = post_cfg.get("min", 0)
    post_max = post_cfg.get("max", 99)

    billing = params.get("billing", {})
    productivity = billing.get("productivity_eur_per_person_hour", 420)
    daily_bill = billing.get("daily", {})
    profiles = billing.get("profiles", {})

    # -- helpers ---------------------------------------------------------
    def to_slot(time_str: str) -> int:
        """HH:MM -> slot index relative to grid0 (past-midnight wraps)."""
        m = _tm(time_str)
        if m < grid0:
            m += 24 * 60
        return (m - grid0) // 30

    # -- day info --------------------------------------------------------
    day_cfg = {}
    for d in DAYS:
        sh = params["store_hours"][d]
        o = to_slot(sh["open"])
        c = to_slot(sh["close"])
        pre_s = o - pre_slots
        post_s = c + post_slots
        last = post_s

        extra = None
        if "extra" in sh:
            e = sh["extra"]
            ef = to_slot(e["from"])
            et = to_slot(e["to"])
            extra = {"from": ef, "to": et, "min": e["min"], "max": e["max"]}
            last = max(last, et)

        day_cfg[d] = {
            "open": o,
            "close": c,
            "pre": pre_s,
            "post": post_s,
            "last": last,
            "special": sh.get("special"),
            "extra": extra,
        }

    # -- billing targets -------------------------------------------------
    targets: dict[str, dict[int, int]] = {}
    for d in DAYS:
        di = day_cfg[d]
        prof_name = di["special"] if di["special"] in profiles else "normal"
        prof = profiles.get(prof_name, {})
        bill = daily_bill.get(d, 0)
        targets[d] = {}
        for s in range(di["open"], di["close"]):
            hour = ((grid0 + s * 30) // 60) % 24
            pct = prof.get(str(hour), 0)
            if pct > 0 and bill > 0:
                t = bill * pct / 100.0 / productivity / 2.0
                t = max(1, round(t))
            else:
                t = 1
            targets[d][s] = t

    # -- employee info ---------------------------------------------------
    emp_info = []
    for emp in employees:
        hpd = emp["weekly_hours"] / dpw
        shift_slots = int(hpd * 2)
        vac = set(emp.get("vacations", []))
        fixed = emp.get("fixed", {})
        avail = emp.get("availability", "F")
        working_days = dpw - len(vac)
        emp_info.append({
            "id": emp["id"],
            "name": emp["name"],
            "shift_slots": shift_slots,
            "hours_per_day": hpd,
            "vacations": vac,
            "fixed": fixed,
            "availability": avail,
            "working_days": working_days,
        })

    n = len(emp_info)

    # -- CP-SAT model ----------------------------------------------------
    model = cp_model.CpModel()

    # x[ei][d] = {start_slot: BoolVar}  (possible start positions)
    # work[ei][d] = BoolVar | None      (None = forced off)
    x: list[dict[str, dict[int, object]]] = [{} for _ in range(n)]
    work: list[dict[str, object]] = [{} for _ in range(n)]

    for ei, ed in enumerate(emp_info):
        for d in DAYS:
            di = day_cfg[d]

            # forced off?
            if d in ed["vacations"] or ed["fixed"].get(d) == "off":
                work[ei][d] = None
                x[ei][d] = {}
                continue

            # availability window
            if ed["availability"] == "M":
                a_lo, a_hi = 0, to_slot("15:00")
            elif ed["availability"] == "T":
                a_lo, a_hi = to_slot("14:00"), di["last"]
            else:
                a_lo, a_hi = 0, di["last"]

            earliest = max(a_lo, di["pre"])
            latest = min(a_hi, di["last"]) - ed["shift_slots"]

            # fixed start?
            if d in ed["fixed"]:
                fs = to_slot(ed["fixed"][d])
                earliest = max(earliest, fs)
                latest = min(latest, fs)

            if earliest > latest:
                work[ei][d] = None
                x[ei][d] = {}
                continue

            w = model.new_bool_var(f"w_{ei}_{d}")
            work[ei][d] = w
            starts: dict[int, object] = {}
            for s in range(earliest, latest + 1):
                starts[s] = model.new_bool_var(f"x_{ei}_{d}_{s}")
            x[ei][d] = starts

            model.add(sum(starts.values()) == 1).only_enforce_if(w)
            model.add(sum(starts.values()) == 0).only_enforce_if(w.Not())

        # working-days constraint
        week_w = [work[ei][d] for d in DAYS if work[ei][d] is not None]
        model.add(sum(week_w) == ed["working_days"])

    # -- coverage IntVars ------------------------------------------------
    cov: dict[str, dict[int, object]] = {}
    for d in DAYS:
        di = day_cfg[d]
        cov[d] = {}
        for s in range(di["pre"], di["last"]):
            parts = []
            for ei in range(n):
                for ss, bv in x[ei][d].items():
                    if ss <= s < ss + emp_info[ei]["shift_slots"]:
                        parts.append(bv)
            cv = model.new_int_var(0, n, f"cov_{d}_{s}")
            if parts:
                model.add(cv == sum(parts))
            else:
                model.add(cv == 0)
            cov[d][s] = cv

    # -- hard constraints ------------------------------------------------
    for d in DAYS:
        di = day_cfg[d]
        # preopen
        for s in range(di["pre"], di["open"]):
            if s in cov[d]:
                model.add(cov[d][s] >= pre_min)
                model.add(cov[d][s] <= pre_max)
        # postclose
        for s in range(di["close"], di["post"]):
            if s in cov[d]:
                model.add(cov[d][s] >= post_min)
                model.add(cov[d][s] <= post_max)
        # extra
        if di["extra"]:
            ex = di["extra"]
            for s in range(ex["from"], ex["to"]):
                if s in cov[d]:
                    model.add(cov[d][s] >= ex["min"])
                    model.add(cov[d][s] <= ex["max"])
        # >= 1 during open hours
        for s in range(di["open"], di["close"]):
            if s in cov[d]:
                model.add(cov[d][s] >= 1)

    # -- soft objective --------------------------------------------------
    obj = []
    for d in DAYS:
        for s, tgt in targets[d].items():
            if s in cov[d]:
                u = model.new_int_var(0, 50, f"u_{d}_{s}")
                o = model.new_int_var(0, 50, f"o_{d}_{s}")
                model.add(u >= tgt - cov[d][s])
                model.add(o >= cov[d][s] - tgt)
                obj.append(4 * u + o)
    model.minimize(sum(obj))

    # -- solve -----------------------------------------------------------
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30
    rc = solver.solve(model)

    status_map = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
        cp_model.UNKNOWN: "UNKNOWN",
    }
    status = status_map.get(rc, "UNKNOWN")

    if rc not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "status": status,
            "objective": None,
            "schedule": {},
            "coverage": {},
            "warnings": ["No feasible solution found."],
        }

    # -- extract solution ------------------------------------------------
    warnings: list[str] = []
    schedule: dict[str, dict] = {}
    for ei, ed in enumerate(emp_info):
        eid = ed["id"]
        schedule[eid] = {}
        days_worked = 0
        total_hours = 0.0
        for d in DAYS:
            if d in ed["vacations"]:
                schedule[eid][d] = {"code": "vacation"}
                continue
            w = work[ei][d]
            if w is None or solver.value(w) == 0:
                schedule[eid][d] = {"code": "off"}
                continue
            days_worked += 1
            for ss, bv in x[ei][d].items():
                if solver.value(bv) == 1:
                    sm = grid0 + ss * 30
                    em = sm + ed["shift_slots"] * 30
                    total_hours += ed["hours_per_day"]
                    schedule[eid][d] = {
                        "start": _fmt(sm),
                        "end": _fmt(em),
                        "hours": ed["hours_per_day"],
                        "code": "normal",
                    }
                    break

        if days_worked != ed["working_days"]:
            warnings.append(
                f"{ed['name']}: worked {days_worked}d, expected {ed['working_days']}d"
            )

    coverage_out: dict[str, list] = {}
    for d in DAYS:
        di = day_cfg[d]
        coverage_out[d] = []
        for s in range(di["pre"], di["last"]):
            if s in cov[d]:
                tgt = targets[d].get(s, 0)
                assigned = solver.value(cov[d][s])
                coverage_out[d].append({
                    "time": _fmt(grid0 + s * 30),
                    "target": tgt,
                    "assigned": assigned,
                })

    return {
        "status": status,
        "objective": int(solver.objective_value),
        "schedule": schedule,
        "coverage": coverage_out,
        "warnings": warnings,
    }

"""Camp Nou Planner - CP-SAT schedule solver.

One call = one department, one week.
Grid of 30-minute slots starting at grid_default_start (default 07:00).

HARD constraints (employee-level only):
  - 1 shift per day, exactly N working days per contract
  - Shift fits within availability window (M/T/F)
  - Fixed schedule respected
  - Absences = forced days off

SOFT constraints (penalties, so solver ALWAYS produces a schedule):
  - Pre-open min/max, post-close min/max, extra window min/max
  - At least 1 person during open hours
  - Billing-based demand targets
"""

from ortools.sat.python import cp_model

DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
DAY_LABELS = {
    "MON": "Lunes", "TUE": "Martes", "WED": "Miércoles", "THU": "Jueves",
    "FRI": "Viernes", "SAT": "Sábado", "SUN": "Domingo",
}

# Penalty weights (higher = more important to satisfy)
W_EMPTY_OPEN = 20    # no one during open hours
W_PREPOST_UNDER = 15 # below min for pre-open / post-close / extra
W_PREPOST_OVER = 3   # above max for pre-open / post-close / extra
W_DEMAND_UNDER = 4   # below billing target
W_DEMAND_OVER = 1    # above billing target


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
            "open": o, "close": c, "pre": pre_s, "post": post_s,
            "last": last, "special": sh.get("special"), "extra": extra,
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

    # -- employee info + data validation ---------------------------------
    data_warnings: list[str] = []
    emp_info = []
    for emp in employees:
        hpd = emp["weekly_hours"] / dpw
        shift_slots = int(hpd * 2)
        vac = set(emp.get("vacations", []))
        fixed = emp.get("fixed", {})
        avail = emp.get("availability", "F")
        working_days = dpw - len(vac)

        # Validate: enough available days?
        available_days = 0
        for d in DAYS:
            if d in vac or fixed.get(d) == "off":
                continue
            di = day_cfg[d]
            if avail == "M":
                a_lo, a_hi = 0, to_slot("15:00")
            elif avail == "T":
                a_lo, a_hi = to_slot("14:00"), di["last"]
            else:
                a_lo, a_hi = 0, di["last"]
            earliest = max(a_lo, di["pre"])
            latest = min(a_hi, di["last"]) - shift_slots
            if d in fixed and fixed[d] != "off":
                fs = to_slot(fixed[d])
                earliest = max(earliest, fs)
                latest = min(latest, fs)
            if earliest <= latest:
                available_days += 1

        if available_days < working_days:
            data_warnings.append(
                f"{emp['name']}: solo puede trabajar {available_days} días "
                f"pero su contrato exige {working_days} "
                f"(revisa disponibilidad/jornada/fijos)"
            )
            working_days = available_days  # relax to avoid infeasible

        emp_info.append({
            "id": emp["id"], "name": emp["name"],
            "shift_slots": shift_slots, "hours_per_day": hpd,
            "vacations": vac, "fixed": fixed,
            "availability": avail, "working_days": working_days,
        })

    n = len(emp_info)
    if n == 0:
        return {
            "status": "OPTIMAL", "objective": 0,
            "schedule": {}, "coverage": {},
            "warnings": data_warnings or ["No hay empleados en este departamento."],
        }

    # -- CP-SAT model ----------------------------------------------------
    model = cp_model.CpModel()

    x: list[dict[str, dict[int, object]]] = [{} for _ in range(n)]
    work: list[dict[str, object]] = [{} for _ in range(n)]

    for ei, ed in enumerate(emp_info):
        for d in DAYS:
            di = day_cfg[d]

            if d in ed["vacations"] or ed["fixed"].get(d) == "off":
                work[ei][d] = None
                x[ei][d] = {}
                continue

            if ed["availability"] == "M":
                a_lo, a_hi = 0, to_slot("15:00")
            elif ed["availability"] == "T":
                a_lo, a_hi = to_slot("14:00"), di["last"]
            else:
                a_lo, a_hi = 0, di["last"]

            earliest = max(a_lo, di["pre"])
            latest = min(a_hi, di["last"]) - ed["shift_slots"]

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

        # HARD: working-days constraint (employee contract)
        week_w = [work[ei][d] for d in DAYS if work[ei][d] is not None]
        if week_w:
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

    # -- ALL coverage constraints are SOFT (penalties) -------------------
    obj = []

    for d in DAYS:
        di = day_cfg[d]

        # Pre-open: penalize being below min or above max
        for s in range(di["pre"], di["open"]):
            if s not in cov[d]:
                continue
            u = model.new_int_var(0, n, f"pre_u_{d}_{s}")
            o = model.new_int_var(0, n, f"pre_o_{d}_{s}")
            model.add(u >= pre_min - cov[d][s])
            model.add(o >= cov[d][s] - pre_max)
            obj.append(W_PREPOST_UNDER * u + W_PREPOST_OVER * o)

        # Post-close: penalize being below min or above max
        for s in range(di["close"], di["post"]):
            if s not in cov[d]:
                continue
            u = model.new_int_var(0, n, f"post_u_{d}_{s}")
            o = model.new_int_var(0, n, f"post_o_{d}_{s}")
            model.add(u >= post_min - cov[d][s])
            model.add(o >= cov[d][s] - post_max)
            obj.append(W_PREPOST_UNDER * u + W_PREPOST_OVER * o)

        # Extra window (inventory etc.): penalize being below min or above max
        if di["extra"]:
            ex = di["extra"]
            for s in range(ex["from"], ex["to"]):
                if s not in cov[d]:
                    continue
                u = model.new_int_var(0, n, f"ex_u_{d}_{s}")
                o = model.new_int_var(0, n, f"ex_o_{d}_{s}")
                model.add(u >= ex["min"] - cov[d][s])
                model.add(o >= cov[d][s] - ex["max"])
                obj.append(W_PREPOST_UNDER * u + W_PREPOST_OVER * o)

        # Open hours: penalize having zero people (very heavy)
        for s in range(di["open"], di["close"]):
            if s not in cov[d]:
                continue
            empty = model.new_bool_var(f"empty_{d}_{s}")
            model.add(cov[d][s] == 0).only_enforce_if(empty)
            model.add(cov[d][s] >= 1).only_enforce_if(empty.Not())
            obj.append(W_EMPTY_OPEN * empty)

        # Billing demand targets (soft)
        for s, tgt in targets[d].items():
            if s not in cov[d]:
                continue
            u = model.new_int_var(0, 50, f"u_{d}_{s}")
            o = model.new_int_var(0, 50, f"o_{d}_{s}")
            model.add(u >= tgt - cov[d][s])
            model.add(o >= cov[d][s] - tgt)
            obj.append(W_DEMAND_UNDER * u + W_DEMAND_OVER * o)

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
            "status": status, "objective": None,
            "schedule": {}, "coverage": {},
            "warnings": data_warnings + [
                "No se encontró solución. Revisa los datos de los empleados "
                "(disponibilidad, jornada, días fijos)."
            ],
        }

    # -- extract solution ------------------------------------------------
    warnings: list[str] = list(data_warnings)
    schedule: dict[str, dict] = {}
    for ei, ed in enumerate(emp_info):
        eid = ed["id"]
        schedule[eid] = {}
        days_worked = 0
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
                    schedule[eid][d] = {
                        "start": _fmt(sm),
                        "end": _fmt(em),
                        "hours": ed["hours_per_day"],
                        "code": "normal",
                    }
                    break

    # -- generate coverage warnings --------------------------------------
    coverage_out: dict[str, list] = {}
    for d in DAYS:
        di = day_cfg[d]
        coverage_out[d] = []
        label = DAY_LABELS.get(d, d)

        # Track shortfalls for warnings
        pre_short = []
        post_short = []
        extra_short = []
        open_empty = []

        for s in range(di["pre"], di["last"]):
            if s not in cov[d]:
                continue
            tgt = targets[d].get(s, 0)
            assigned = solver.value(cov[d][s])
            time_str = _fmt(grid0 + s * 30)
            coverage_out[d].append({
                "time": time_str, "target": tgt, "assigned": assigned,
            })

            # Check shortfalls
            if di["pre"] <= s < di["open"]:
                if assigned < pre_min:
                    pre_short.append((time_str, pre_min - assigned))
            elif di["close"] <= s < di["post"]:
                if assigned < post_min:
                    post_short.append((time_str, post_min - assigned))
            elif di["open"] <= s < di["close"]:
                if assigned == 0:
                    open_empty.append(time_str)

            if di["extra"]:
                ex = di["extra"]
                if ex["from"] <= s < ex["to"] and assigned < ex["min"]:
                    extra_short.append((time_str, ex["min"] - assigned))

        # Emit warnings
        if pre_short:
            deficit = max(v for _, v in pre_short)
            warnings.append(
                f"{label} montaje {pre_short[0][0]}–{_fmt(grid0 + di['open'] * 30)}: "
                f"faltan {deficit} persona(s) (mín. {pre_min})"
            )
        if post_short:
            deficit = max(v for _, v in post_short)
            warnings.append(
                f"{label} cierre {_fmt(grid0 + di['close'] * 30)}–{_fmt(grid0 + di['post'] * 30)}: "
                f"faltan {deficit} persona(s) (mín. {post_min})"
            )
        if extra_short:
            ex = di["extra"]
            deficit = max(v for _, v in extra_short)
            sp = di["special"] or "extra"
            warnings.append(
                f"{label} {sp} {_fmt(grid0 + ex['from'] * 30)}–{_fmt(grid0 + ex['to'] * 30)}: "
                f"faltan {deficit} persona(s) (mín. {ex['min']})"
            )
        if open_empty:
            if len(open_empty) <= 3:
                times = ", ".join(open_empty)
            else:
                times = f"{open_empty[0]}–{open_empty[-1]} ({len(open_empty)} franjas)"
            warnings.append(
                f"{label} horario comercial: 0 personas en {times}"
            )

    return {
        "status": status,
        "objective": int(solver.objective_value),
        "schedule": schedule,
        "coverage": coverage_out,
        "warnings": warnings,
    }

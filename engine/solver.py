"""Camp Nou Planner - CP-SAT schedule solver.

One call = one department, one week.
Grid of 30-minute slots. Each day starts at (open - preopen) and ends at
max(close + postclose, extra_end). No fixed 07:00 floor.

HARD constraints (employee-level only):
  - 1 shift per day, exactly N working days per contract
  - Shift fits within availability window (M/T/F)
  - Fixed schedule respected
  - Absences = forced days off

SOFT constraints (penalties → solver ALWAYS produces a schedule):
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

W_EMPTY_OPEN = 20
W_PREPOST_UNDER = 15
W_PREPOST_OVER = 3
W_DEMAND_UNDER = 4
W_DEMAND_OVER = 1

# Internal slot reference point (midnight). All minutes are absolute from 00:00.
# Past-midnight times (e.g. 01:00 close) are handled by adding 1440 when < open.
REF = 0


def _tm(t: str) -> int:
    h, m = map(int, t.split(":"))
    return h * 60 + m


def _fmt(m: int) -> str:
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


def solve(data: dict) -> dict:
    params = data["params"]
    employees = data["employees"]
    dpw = params.get("days_per_week", 5)

    pre_cfg = params.get("preopen", {})
    post_cfg = params.get("postclose", {})
    pre_minutes = pre_cfg.get("minutes", 30)
    post_minutes = post_cfg.get("minutes", 30)
    pre_min_ppl = pre_cfg.get("min", 0)
    pre_max_ppl = pre_cfg.get("max", 99)
    post_min_ppl = post_cfg.get("min", 0)
    post_max_ppl = post_cfg.get("max", 99)

    billing = params.get("billing", {})
    productivity = billing.get("productivity_eur_per_person_hour", 420)
    daily_bill = billing.get("daily", {})
    profiles = billing.get("profiles", {})

    # -- day info --------------------------------------------------------
    # Each day has its own slot space: slot 0 = day_base (open - preopen)
    day_cfg = {}
    for d in DAYS:
        sh = params["store_hours"][d]
        open_m = _tm(sh["open"])
        close_m = _tm(sh["close"])
        if close_m <= open_m:
            close_m += 1440  # past midnight

        day_base = open_m - pre_minutes           # grid starts here
        post_end = close_m + post_minutes
        day_end = post_end

        pre_slots = pre_minutes // 30
        post_slots = post_minutes // 30
        open_slot = pre_slots                      # = (open_m - day_base) / 30
        close_slot = (close_m - day_base) // 30
        post_slot = close_slot + post_slots

        extra = None
        if "extra" in sh:
            e = sh["extra"]
            ef_m = _tm(e["from"])
            et_m = _tm(e["to"])
            if ef_m < open_m: ef_m += 1440
            if et_m <= ef_m:  et_m += 1440
            extra = {
                "from": (ef_m - day_base) // 30,
                "to":   (et_m - day_base) // 30,
                "min": e["min"], "max": e["max"],
            }
            day_end = max(day_end, et_m)

        total_slots = (day_end - day_base + 29) // 30  # ceiling

        day_cfg[d] = {
            "base": day_base,          # absolute minutes of slot 0
            "open": open_slot,
            "close": close_slot,
            "pre": 0,                  # first slot = pre-open start
            "post": post_slot,
            "last": total_slots,
            "special": sh.get("special"),
            "extra": extra,
            "open_m": open_m,
            "close_m": close_m,
        }

    # -- per-day slot helper ---------------------------------------------
    def abs_to_slot(d: str, abs_min: int) -> int:
        """Absolute minutes → slot index for day d."""
        return (abs_min - day_cfg[d]["base"]) // 30

    # -- billing targets -------------------------------------------------
    targets: dict[str, dict[int, int]] = {}
    for d in DAYS:
        di = day_cfg[d]
        prof_name = di["special"] if di["special"] in profiles else "normal"
        prof = profiles.get(prof_name, {})
        bill = daily_bill.get(d, 0)
        targets[d] = {}
        for s in range(di["open"], di["close"]):
            abs_min = di["base"] + s * 30
            hour = (abs_min // 60) % 24
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

        available_days = 0
        for d in DAYS:
            if d in vac or fixed.get(d) == "off":
                continue
            di = day_cfg[d]
            # Availability in absolute minutes
            if avail == "M":
                av_lo, av_hi = 7 * 60, 15 * 60
            elif avail == "T":
                av_lo, av_hi = 14 * 60, di["base"] + di["last"] * 30
            else:
                av_lo, av_hi = di["base"], di["base"] + di["last"] * 30

            # Convert to slots
            s_lo = max(0, (av_lo - di["base"]) // 30)
            s_hi = (av_hi - di["base"]) // 30

            earliest = max(s_lo, di["pre"])
            latest = min(s_hi, di["last"]) - shift_slots

            if d in fixed and fixed[d] != "off":
                fs = abs_to_slot(d, _tm(fixed[d]))
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
            working_days = available_days

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

            # Availability in absolute minutes
            if ed["availability"] == "M":
                av_lo, av_hi = 7 * 60, 15 * 60
            elif ed["availability"] == "T":
                av_lo, av_hi = 14 * 60, di["base"] + di["last"] * 30
            else:
                av_lo, av_hi = di["base"], di["base"] + di["last"] * 30

            s_lo = max(0, (av_lo - di["base"]) // 30)
            s_hi = (av_hi - di["base"]) // 30

            earliest = max(s_lo, di["pre"])
            latest = min(s_hi, di["last"]) - ed["shift_slots"]

            if d in ed["fixed"] and ed["fixed"][d] != "off":
                fs = abs_to_slot(d, _tm(ed["fixed"][d]))
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

        week_w = [work[ei][d] for d in DAYS if work[ei][d] is not None]
        if week_w:
            model.add(sum(week_w) == ed["working_days"])

    # -- coverage --------------------------------------------------------
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
            model.add(cv == sum(parts) if parts else cv == 0)
            cov[d][s] = cv

    # -- soft objective --------------------------------------------------
    obj = []
    for d in DAYS:
        di = day_cfg[d]

        for s in range(di["pre"], di["open"]):
            if s not in cov[d]: continue
            u = model.new_int_var(0, n, f"pre_u_{d}_{s}")
            o = model.new_int_var(0, n, f"pre_o_{d}_{s}")
            model.add(u >= pre_min_ppl - cov[d][s])
            model.add(o >= cov[d][s] - pre_max_ppl)
            obj.append(W_PREPOST_UNDER * u + W_PREPOST_OVER * o)

        for s in range(di["close"], di["post"]):
            if s not in cov[d]: continue
            u = model.new_int_var(0, n, f"post_u_{d}_{s}")
            o = model.new_int_var(0, n, f"post_o_{d}_{s}")
            model.add(u >= post_min_ppl - cov[d][s])
            model.add(o >= cov[d][s] - post_max_ppl)
            obj.append(W_PREPOST_UNDER * u + W_PREPOST_OVER * o)

        if di["extra"]:
            ex = di["extra"]
            for s in range(ex["from"], ex["to"]):
                if s not in cov[d]: continue
                u = model.new_int_var(0, n, f"ex_u_{d}_{s}")
                o = model.new_int_var(0, n, f"ex_o_{d}_{s}")
                model.add(u >= ex["min"] - cov[d][s])
                model.add(o >= cov[d][s] - ex["max"])
                obj.append(W_PREPOST_UNDER * u + W_PREPOST_OVER * o)

        for s in range(di["open"], di["close"]):
            if s not in cov[d]: continue
            empty = model.new_bool_var(f"empty_{d}_{s}")
            model.add(cov[d][s] == 0).only_enforce_if(empty)
            model.add(cov[d][s] >= 1).only_enforce_if(empty.Not())
            obj.append(W_EMPTY_OPEN * empty)

        for s, tgt in targets[d].items():
            if s not in cov[d]: continue
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
                "No se encontró solución. Revisa los datos de los empleados."
            ],
        }

    # -- extract solution ------------------------------------------------
    warnings: list[str] = list(data_warnings)
    schedule: dict[str, dict] = {}
    for ei, ed in enumerate(emp_info):
        eid = ed["id"]
        schedule[eid] = {}
        for d in DAYS:
            if d in ed["vacations"]:
                schedule[eid][d] = {"code": "vacation"}
                continue
            w = work[ei][d]
            if w is None or solver.value(w) == 0:
                schedule[eid][d] = {"code": "off"}
                continue
            di = day_cfg[d]
            for ss, bv in x[ei][d].items():
                if solver.value(bv) == 1:
                    sm = di["base"] + ss * 30
                    em = sm + ed["shift_slots"] * 30
                    schedule[eid][d] = {
                        "start": _fmt(sm),
                        "end": _fmt(em),
                        "hours": ed["hours_per_day"],
                        "code": "normal",
                    }
                    break

    # -- coverage output + warnings --------------------------------------
    coverage_out: dict[str, list] = {}
    for d in DAYS:
        di = day_cfg[d]
        coverage_out[d] = []
        label = DAY_LABELS.get(d, d)
        pre_short, post_short, extra_short, open_empty = [], [], [], []

        for s in range(di["pre"], di["last"]):
            if s not in cov[d]: continue
            tgt = targets[d].get(s, 0)
            assigned = solver.value(cov[d][s])
            abs_min = di["base"] + s * 30
            time_str = _fmt(abs_min)
            coverage_out[d].append({
                "time": time_str, "target": tgt, "assigned": assigned,
            })
            if di["pre"] <= s < di["open"] and assigned < pre_min_ppl:
                pre_short.append((time_str, pre_min_ppl - assigned))
            elif di["close"] <= s < di["post"] and assigned < post_min_ppl:
                post_short.append((time_str, post_min_ppl - assigned))
            elif di["open"] <= s < di["close"] and assigned == 0:
                open_empty.append(time_str)
            if di["extra"]:
                ex = di["extra"]
                if ex["from"] <= s < ex["to"] and assigned < ex["min"]:
                    extra_short.append((time_str, ex["min"] - assigned))

        if pre_short:
            deficit = max(v for _, v in pre_short)
            warnings.append(f"{label} montaje: faltan {deficit} persona(s) (mín. {pre_min_ppl})")
        if post_short:
            deficit = max(v for _, v in post_short)
            warnings.append(f"{label} cierre: faltan {deficit} persona(s) (mín. {post_min_ppl})")
        if extra_short:
            ex = di["extra"]
            deficit = max(v for _, v in extra_short)
            sp = di["special"] or "extra"
            warnings.append(f"{label} {sp}: faltan {deficit} persona(s) (mín. {ex['min']})")
        if open_empty:
            times = ", ".join(open_empty) if len(open_empty) <= 3 else f"{open_empty[0]}–{open_empty[-1]} ({len(open_empty)} franjas)"
            warnings.append(f"{label} horario comercial: 0 personas en {times}")

    return {
        "status": status,
        "objective": int(solver.objective_value),
        "schedule": schedule,
        "coverage": coverage_out,
        "warnings": warnings,
    }

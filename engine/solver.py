"""Camp Nou Planner - CP-SAT schedule solver.

One call = one department, one week.

HARD constraints (ONLY employee-level):
  - 1 shift per day, exactly N working days per contract
  - Shift fits within availability window (M/T/F)
  - Fixed schedule respected
  - Absences = forced days off

ALL coverage is SOFT (penalties via slack variables):
  cov + u >= lo   (u = under-coverage, penalized)
  cov - o <= hi   (o = over-coverage, penalized lightly)
  → ALWAYS FEASIBLE unless employee data is contradictory.
"""

from ortools.sat.python import cp_model

DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
DAY_LABELS = {
    "MON": "Lunes", "TUE": "Martes", "WED": "Miércoles", "THU": "Jueves",
    "FRI": "Viernes", "SAT": "Sábado", "SUN": "Domingo",
}

W_OPEN_UNDER = 8     # below demand / min-1 during open hours
W_OPEN_OVER = 1      # above demand during open hours
W_BAND_UNDER = 6     # below min for montaje / cierre / extra
W_BAND_OVER = 2      # above max for montaje / cierre / extra


def _tm(t: str) -> int:
    h, m = map(int, t.split(":"))
    return h * 60 + m


def _fmt(m: int) -> str:
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


def _soft(model, obj, cov_var, lo: int, hi: int, w_under: int, w_over: int,
          tag: str, n: int):
    """Add soft [lo, hi] on cov_var. Pure linear, always feasible."""
    u = model.new_int_var(0, 60, f"u_{tag}")
    o = model.new_int_var(0, 60, f"o_{tag}")
    model.add(cov_var + u >= lo)
    model.add(cov_var - o <= hi)
    obj.append(w_under * u + w_over * o)


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
    day_cfg = {}
    for d in DAYS:
        sh = params["store_hours"][d]
        open_m = _tm(sh["open"])
        close_m = _tm(sh["close"])
        if close_m <= open_m:
            close_m += 1440

        day_base = open_m - pre_minutes
        post_end = close_m + post_minutes
        day_end = post_end

        pre_slots = pre_minutes // 30
        post_slots = post_minutes // 30
        open_slot = pre_slots
        close_slot = (close_m - day_base) // 30
        post_slot = close_slot + post_slots

        extra = None
        if "extra" in sh:
            e = sh["extra"]
            ef_m = _tm(e["from"])
            et_m = _tm(e["to"])
            if ef_m < open_m:
                ef_m += 1440
            if et_m <= ef_m:
                et_m += 1440
            extra = {
                "from": (ef_m - day_base) // 30,
                "to":   (et_m - day_base) // 30,
                "min": e["min"], "max": e["max"],
            }
            day_end = max(day_end, et_m)

        total_slots = (day_end - day_base + 29) // 30

        day_cfg[d] = {
            "base": day_base, "open": open_slot, "close": close_slot,
            "pre": 0, "post": post_slot, "last": total_slots,
            "special": sh.get("special"), "extra": extra,
            "open_m": open_m, "close_m": close_m,
        }

    def abs_to_slot(d: str, abs_min: int) -> int:
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
        cant_work_reasons = []
        for d in DAYS:
            if d in vac or fixed.get(d) == "off":
                continue
            di = day_cfg[d]
            if avail == "M":
                av_lo, av_hi = 7 * 60, 15 * 60
            elif avail == "T":
                av_lo, av_hi = 14 * 60, di["base"] + di["last"] * 30
            else:
                av_lo, av_hi = di["base"], di["base"] + di["last"] * 30
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
            else:
                window_h = max(0, (min(av_hi, di["base"] + di["last"] * 30) - max(av_lo, di["base"]))) / 60
                cant_work_reasons.append(
                    f"{DAY_LABELS.get(d, d)}: ventana {avail} = {window_h:.1f}h "
                    f"< jornada {hpd}h"
                )

        if available_days < working_days:
            reason = "; ".join(cant_work_reasons[:3])
            data_warnings.append(
                f"{emp['name']}: solo puede trabajar {available_days} días "
                f"de {working_days} ({reason})"
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

    # -- SOFT objective: ZERO hard coverage constraints -------------------
    # Every coverage requirement uses: cov + u >= lo, cov - o <= hi
    obj: list = []

    for d in DAYS:
        di = day_cfg[d]

        # Montaje (pre-open): soft [pre_min_ppl, pre_max_ppl]
        for s in range(di["pre"], di["open"]):
            if s in cov[d]:
                _soft(model, obj, cov[d][s],
                      pre_min_ppl, pre_max_ppl,
                      W_BAND_UNDER, W_BAND_OVER, f"pre_{d}_{s}", n)

        # Open hours: soft demand target [target, target] + soft minimum [1, 99]
        for s in range(di["open"], di["close"]):
            if s not in cov[d]:
                continue
            tgt = targets[d].get(s, 1)
            _soft(model, obj, cov[d][s],
                  tgt, tgt + 10,
                  W_OPEN_UNDER, W_OPEN_OVER, f"dem_{d}_{s}", n)

        # Cierre (post-close): soft [post_min_ppl, post_max_ppl]
        for s in range(di["close"], di["post"]):
            if s in cov[d]:
                _soft(model, obj, cov[d][s],
                      post_min_ppl, post_max_ppl,
                      W_BAND_UNDER, W_BAND_OVER, f"post_{d}_{s}", n)

        # Extra (inventory etc.): soft [extra_min, extra_max]
        if di["extra"]:
            ex = di["extra"]
            for s in range(ex["from"], ex["to"]):
                if s in cov[d]:
                    _soft(model, obj, cov[d][s],
                          ex["min"], ex["max"],
                          W_BAND_UNDER, W_BAND_OVER, f"ex_{d}_{s}", n)

    if obj:
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
        # Should only happen with contradictory employee data
        msgs = list(data_warnings)
        if not msgs:
            msgs.append(
                "INFEASIBLE sin avisos de datos: posible bug. "
                "Contacta al administrador."
            )
        return {
            "status": status, "objective": None,
            "schedule": {}, "coverage": {},
            "warnings": msgs,
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
                        "start": _fmt(sm), "end": _fmt(em),
                        "hours": ed["hours_per_day"], "code": "normal",
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
            if s not in cov[d]:
                continue
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
            warnings.append(
                f"{label} montaje: faltan {deficit} persona(s) (mín. {pre_min_ppl})")
        if post_short:
            deficit = max(v for _, v in post_short)
            warnings.append(
                f"{label} cierre: faltan {deficit} persona(s) (mín. {post_min_ppl})")
        if extra_short:
            ex = di["extra"]
            deficit = max(v for _, v in extra_short)
            sp = di["special"] or "extra"
            warnings.append(
                f"{label} {sp}: faltan {deficit} persona(s) (mín. {ex['min']})")
        if open_empty:
            times = (", ".join(open_empty) if len(open_empty) <= 3
                     else f"{open_empty[0]}–{open_empty[-1]} ({len(open_empty)} franjas)")
            warnings.append(
                f"{label} horario comercial: 0 personas en {times}")

    return {
        "status": status,
        "objective": int(solver.objective_value),
        "schedule": schedule,
        "coverage": coverage_out,
        "warnings": warnings,
    }

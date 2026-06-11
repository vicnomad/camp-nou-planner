"""Camp Nou Planner – CP-SAT solver (2026-06-09 v4).

NEVER returns INFEASIBLE in normal use. Relaxes and warns.

HARD (only employee-level upper bounds):
  * 1 continuous shift per working day
  * days_worked <= target_days (upper bound)
  * shift fits inside (availability ∩ day window)
  * fixed schedule, absences → forced off

SOFT (everything else):
  * days_worked < target_days → penalty (fill contract when possible)
  * ALL coverage: cov+u>=lo, cov-o<=hi (pure slack)
"""

import json
from ortools.sat.python import cp_model

DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
DAY_ES = {"MON": "Lunes", "TUE": "Martes", "WED": "Miércoles",
          "THU": "Jueves", "FRI": "Viernes", "SAT": "Sábado", "SUN": "Domingo"}

# Contract hours = TOP PRIORITY. Demand only shapes placement, never cuts hours.
W_CONTRACT = 100  # missing a contract day (very high)
WU_DEM     = 3    # under demand target (shapes where to place people)
WO_DEM_SQ  = 1    # over demand (quadratic, just distributes excess evenly)
WU_BAND    = 5    # under montaje/cierre min
WO_BAND_SQ = 1    # over montaje/cierre max (quadratic)
W_STAB     = 2    # shift-time stability

# Bases parciales con días/horas realistas (no repartidas entre dpw días).
PARTTIME_BASES = {8: (2, 4), 12: (2, 6), 16: (4, 4)}  # weekly_hours: (días, horas_por_día)


def _tm(t):
    h, m = map(int, t.split(":"))
    return h * 60 + m

def _hm(m):
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"

# Map day key to lowercase for per-day availability maps
_DAY_LO = {"MON":"mon","TUE":"tue","WED":"wed","THU":"thu","FRI":"fri","SAT":"sat","SUN":"sun"}

def _av_for_day(av, d):
    """Return availability code for a specific day.
    av: string "M"|"T"|"F" (all days) OR dict {mon,tue,...} with per-day values.
    Returns "M","T","F", or "X" (not available).
    """
    if isinstance(av, str):
        return av
    if isinstance(av, dict):
        return av.get(_DAY_LO.get(d, d.lower()), "F")
    return "F"

def _av_window(av_code, dc):
    """Return (lo_minutes, hi_minutes) for an availability code on a given day config."""
    if av_code == "M":
        return 7*60, 15*60
    elif av_code == "T":
        return 14*60, dc["base"] + dc["N"]*30
    elif av_code == "X":
        return 0, 0  # not available
    else:  # F or anything else
        return dc["base"], dc["base"] + dc["N"]*30


def solve(data):
    # ── keep raw request for debug ──────────────────────────────────
    debug_input = json.loads(json.dumps(data))  # deep copy

    P   = data["params"]
    EMP = data["employees"]
    dpw = P.get("days_per_week", 5)

    pre_min  = P.get("preopen",  {}).get("minutes", 30)
    post_min = P.get("postclose",{}).get("minutes", 30)
    pre_lo   = P.get("preopen",  {}).get("min", 0)
    pre_hi   = P.get("preopen",  {}).get("max", 99)
    post_lo  = P.get("postclose",{}).get("min", 0)
    post_hi  = P.get("postclose",{}).get("max", 99)

    billing      = P.get("billing", {})
    productivity = billing.get("productivity_eur_per_person_hour", 420)
    daily_bill   = billing.get("daily", {})
    profiles     = billing.get("profiles", {})

    # ── day config ──────────────────────────────────────────────────
    DC = {}
    for d in DAYS:
        sh = P.get("store_hours", {}).get(d)
        if not sh or "open" not in sh or "close" not in sh:
            # Day is CLOSED
            DC[d] = None
            continue
        o_m = _tm(sh["open"]); c_m = _tm(sh["close"])
        if o_m == c_m:
            DC[d] = None; continue          # 0-length = closed
        if c_m <= o_m:
            c_m += 1440

        base  = o_m - pre_min
        end_m = c_m + post_min
        o_s   = (o_m  - base) // 30
        c_s   = (c_m  - base) // 30
        po_s  = c_s + post_min // 30

        extra = None
        if "extra" in sh:
            e = sh["extra"]
            ef = _tm(e["from"]); et = _tm(e["to"])
            if ef < o_m: ef += 1440
            if et <= ef: et += 1440
            extra = {"fs": (ef-base)//30, "ts": (et-base)//30,
                     "lo": e["min"], "hi": e["max"]}
            end_m = max(end_m, et)

        DC[d] = {"base": base, "o": o_s, "c": c_s, "po": po_s,
                 "N": (end_m - base + 29) // 30,
                 "sp": sh.get("special"), "extra": extra}

    open_days = [d for d in DAYS if DC[d] is not None]

    def s4(d, m):
        return (m - DC[d]["base"]) // 30

    # ── demand targets ──────────────────────────────────────────────
    # Two modes:
    #  1) billing-based (default): billing.daily × profiles / productivity
    #  2) explicit demand_curve: [{from,to,min,max}] per day → [lo,hi] per slot
    demand_curve = P.get("demand_curve")  # optional: {DAY: [{from,to,min,max},...]}

    TGT = {}      # slot → single target (billing mode)
    TGT_BAND = {} # slot → (lo, hi) (coverage mode)

    for d in open_days:
        dc = DC[d]
        TGT[d] = {}; TGT_BAND[d] = {}

        if demand_curve and d in demand_curve:
            # Coverage mode: explicit min/max bands
            for band in demand_curve[d]:
                f_m = _tm(band["from"]); t_m = _tm(band["to"])
                if t_m <= f_m: t_m += 1440
                f_s = max(0, (f_m - dc["base"]) // 30)
                t_s = min(dc["N"], (t_m - dc["base"]) // 30)
                for s in range(f_s, t_s):
                    TGT_BAND[d][s] = (band.get("min", 1), band.get("max", 99))
        else:
            # Billing mode: compute from revenue × profile / productivity
            pn = dc["sp"] if dc["sp"] in profiles else "normal"
            pr = profiles.get(pn, {})
            bl = daily_bill.get(d, 0)
            for s in range(dc["o"], dc["c"]):
                hr = ((dc["base"] + s*30) // 60) % 24
                pct = pr.get(str(hr), 0)
                t = max(1, round(bl * pct / 100 / productivity)) if pct and bl else 1
                TGT[d][s] = t

    # ── employees ───────────────────────────────────────────────────
    warns = []
    EI = []
    for e in EMP:
        wh_ = e["weekly_hours"]
        if wh_ in PARTTIME_BASES:
            base_days, hpd = PARTTIME_BASES[wh_]
        else:
            base_days, hpd = dpw, wh_ / dpw
        L     = round(hpd * 2)
        fixed = e.get("fixed") or {}
        av    = e.get("availability", "F")

        # build absence map (day → code)
        abs_days = {}
        for ab in e.get("absences", []):
            for dd in (ab.get("days") or []):
                abs_days[dd] = ab.get("type", "VCN")
        for dd in e.get("vacations", []):
            if dd not in abs_days:
                abs_days[dd] = "vacation"

        # target = contract days minus absences, capped by feasible days
        contract_td = max(0, base_days - len(abs_days))

        feasible_days = 0
        infeasible_reasons = []
        for d in DAYS:
            if DC[d] is None:
                continue
            if d in abs_days or fixed.get(d) == "off":
                continue
            dc = DC[d]
            av_d = _av_for_day(av, d)
            if av_d == "X":
                infeasible_reasons.append(f"{DAY_ES.get(d,d)}: no disponible (X)")
                continue
            lo, hi = _av_window(av_d, dc)
            sl = max(0, s4(d, lo)); sh2 = s4(d, hi)
            ea = max(sl, 0); la = min(sh2, dc["N"]) - L
            if d in fixed and fixed[d] != "off":
                fs = s4(d, _tm(fixed[d]))
                ea = max(ea, fs); la = min(la, fs)
            if ea <= la:
                feasible_days += 1
            else:
                wh = max(0, min(hi, dc["base"]+dc["N"]*30) - max(lo, dc["base"])) / 60
                infeasible_reasons.append(
                    f"{DAY_ES.get(d,d)}: ventana {av_d}={wh:.1f}h < jornada {hpd}h")

        td = min(contract_td, feasible_days)
        if td < contract_td:
            why = "; ".join(infeasible_reasons[:3]) if infeasible_reasons else \
                  f"solo {len(open_days)} días abiertos"
            warns.append(
                f"{e['name']}: solo {td} días disponibles de {contract_td} "
                f"({why}) — no alcanza sus {e['weekly_hours']}h")

        EI.append({"id": e["id"], "nm": e["name"], "L": L, "hpd": hpd,
                   "abs": abs_days, "fix": fixed, "av": av, "td": td})

    n = len(EI)
    if n == 0:
        return {"status": "OPTIMAL", "objective": 0,
                "schedule": {}, "coverage": {},
                "warnings": warns or ["Sin empleados."],
                "debug": debug_input}

    # ── CP-SAT model ────────────────────────────────────────────────
    mdl = cp_model.CpModel()
    X = [{} for _ in range(n)]
    W = [{} for _ in range(n)]

    for i, ei in enumerate(EI):
        for d in DAYS:
            if DC[d] is None or d in ei["abs"] or ei["fix"].get(d) == "off":
                W[i][d] = None; X[i][d] = {}; continue
            dc = DC[d]
            av_d = _av_for_day(ei["av"], d)
            if av_d == "X":
                W[i][d] = None; X[i][d] = {}; continue
            lo, hi = _av_window(av_d, dc)
            sl = max(0, s4(d, lo)); sh2 = s4(d, hi)
            ea = max(sl, 0); la = min(sh2, dc["N"]) - ei["L"]
            if d in ei["fix"] and ei["fix"][d] != "off":
                fs = s4(d, _tm(ei["fix"][d]))
                ea = max(ea, fs); la = min(la, fs)
            if ea > la:
                W[i][d] = None; X[i][d] = {}; continue

            w = mdl.new_bool_var(f"w{i}_{d}")
            W[i][d] = w
            st = {}
            for s in range(ea, la+1):
                st[s] = mdl.new_bool_var(f"x{i}_{d}_{s}")
            X[i][d] = st
            mdl.add(sum(st.values()) == 1).only_enforce_if(w)
            mdl.add(sum(st.values()) == 0).only_enforce_if(w.Not())

        ww = [W[i][d] for d in DAYS if W[i][d] is not None]
        if ww:
            # HARD upper bound only: don't exceed contract
            mdl.add(sum(ww) <= ei["td"])
            # SOFT penalty for working fewer is added in the objective section

    # ── convention rules (HARD) ────────────────────────────────────
    min_rest = P.get("min_rest_hours", 0) * 60   # 0 = disabled by default
    max_consec = P.get("max_consecutive_days", 7)  # 7 = disabled by default
    prev_sched = data.get("prev_week_schedule", {})  # {empId: {DAY: worked_bool}}

    for i, ei in enumerate(EI):
        # (a) Minimum rest between consecutive days
        if min_rest > 0:
            for di in range(len(DAYS) - 1):
                d1, d2 = DAYS[di], DAYS[di + 1]
                if DC[d1] is None or DC[d2] is None:
                    continue
                for s1, bv1 in X[i][d1].items():
                    end1_m = DC[d1]["base"] + s1 * 30 + ei["L"] * 30
                    for s2, bv2 in X[i][d2].items():
                        start2_m = DC[d2]["base"] + s2 * 30
                        if start2_m - end1_m < min_rest:
                            mdl.add_bool_or([bv1.Not(), bv2.Not()])

        # (b) Max consecutive days (within week)
        if max_consec < 7:
            window_len = max_consec + 1
            for start_idx in range(len(DAYS) - window_len + 1):
                window = DAYS[start_idx:start_idx + window_len]
                ww_win = [W[i][d] for d in window if W[i][d] is not None]
                if len(ww_win) > max_consec:
                    mdl.add(sum(ww_win) <= max_consec)

            # Cross-week: use prev_week_schedule
            emp_prev = prev_sched.get(ei["id"], {})
            # Count trailing consecutive worked days at end of prev week
            trailing = 0
            for d in reversed(DAYS):
                if emp_prev.get(d):
                    trailing += 1
                else:
                    break
            if trailing > 0:
                # First (max_consec + 1 - trailing) days of this week: sum <= max_consec - trailing
                cap = max_consec - trailing
                first_n = max_consec + 1 - trailing
                first_days = DAYS[:first_n]
                ww_first = [W[i][d] for d in first_days if W[i][d] is not None]
                if cap >= 0 and ww_first:
                    mdl.add(sum(ww_first) <= max(cap, 0))

    # ── coverage IntVars ────────────────────────────────────────────
    COV = {}
    for d in open_days:
        dc = DC[d]; COV[d] = {}
        for s in range(dc["N"]):
            parts = []
            for i in range(n):
                for ss, bv in X[i][d].items():
                    if ss <= s < ss + EI[i]["L"]:
                        parts.append(bv)
            cv = mdl.new_int_var(0, n, f"c{d}_{s}")
            if parts:
                mdl.add(cv == sum(parts))
            else:
                mdl.add(cv == 0)
            COV[d][s] = cv

    # ── objective ───────────────────────────────────────────────────
    # PRINCIPLE: contract hours = top priority. Demand shapes placement only.
    obj = []

    # (1) CONTRACT HOURS — highest priority: penalize missing any contract day
    for i, ei in enumerate(EI):
        ww = [W[i][d] for d in DAYS if W[i][d] is not None]
        if ww and ei["td"] > 0:
            short = mdl.new_int_var(0, 7, f"ds{i}")
            mdl.add(short + sum(ww) >= ei["td"])
            obj.append(W_CONTRACT * short)

    # (2) Coverage: under = shapes placement, over = distributes (convex, very low)
    def soft_cov(cv, lo, wu_under, wo_sq, tag):
        """Under-coverage: linear penalty. Over-coverage: quadratic, very low."""
        u_max = max(lo, n, 1)
        u = mdl.new_int_var(0, u_max, f"u_{tag}")
        mdl.add(cv + u >= lo)
        obj.append(wu_under * u)
        # Convex over: o = max(0, cov - lo), penalty = wo * o²
        # This distributes surplus evenly without preventing anyone from working
        o = mdl.new_int_var(0, max(n, 1), f"o_{tag}")
        mdl.add(cv - o <= lo)
        if wo_sq > 0:
            o_sq = mdl.new_int_var(0, n * n, f"osq_{tag}")
            mdl.add_multiplication_equality(o_sq, [o, o])
            obj.append(wo_sq * o_sq)

    for d in open_days:
        dc = DC[d]
        # Pre-open (montaje)
        for s in range(0, dc["o"]):
            if s in COV[d]:
                soft_cov(COV[d][s], pre_lo, WU_BAND, WO_BAND_SQ, f"pre{d}{s}")
        # Open hours (demand)
        for s in range(dc["o"], dc["c"]):
            if s not in COV[d]: continue
            if s in TGT_BAND[d]:
                lo2, _ = TGT_BAND[d][s]
                soft_cov(COV[d][s], lo2, WU_BAND, WO_BAND_SQ, f"dem{d}{s}")
            elif s in TGT[d]:
                tgt = TGT[d][s]
                soft_cov(COV[d][s], tgt, WU_DEM, WO_DEM_SQ, f"dem{d}{s}")
            else:
                soft_cov(COV[d][s], 1, WU_DEM, WO_DEM_SQ, f"dem{d}{s}")
        # Post-close (cierre)
        for s in range(dc["c"], dc["po"]):
            if s in COV[d]:
                soft_cov(COV[d][s], post_lo, WU_BAND, WO_BAND_SQ, f"pst{d}{s}")
        # Extra (inventory)
        if dc["extra"]:
            ex = dc["extra"]
            for s in range(ex["fs"], ex["ts"]):
                if s in COV[d]:
                    soft_cov(COV[d][s], ex["lo"], WU_BAND, WO_BAND_SQ, f"ex{d}{s}")

    # (3) Day balance: prefer high-demand days (shapes where offs go)
    daily_demand = {}
    for d in open_days:
        dd = sum(TGT[d].values()) + sum(lo for lo, _ in TGT_BAND[d].values())
        daily_demand[d] = max(dd, 1)
    max_dd = max(daily_demand.values()) if daily_demand else 1
    for i, ei in enumerate(EI):
        for d in open_days:
            if W[i][d] is not None:
                bonus = int(3 * daily_demand.get(d, 1) / max_dd)
                if bonus > 0:
                    obj.append(-bonus * W[i][d])

    # (4) Shift stability: prefer start times near availability center
    for i, ei in enumerate(EI):
        for d in open_days:
            if not X[i][d]: continue
            slots = sorted(X[i][d].keys())
            if not slots: continue
            center = (slots[0] + slots[-1]) // 2
            for s, bv in X[i][d].items():
                dist = abs(s - center)
                if dist > 2:
                    obj.append(W_STAB * (dist - 2) * bv)

    if obj:
        mdl.minimize(sum(obj))

    # ── solve ───────────────────────────────────────────────────────
    slv = cp_model.CpSolver()
    slv.parameters.max_time_in_seconds = 30
    rc = slv.solve(mdl)
    SM = {cp_model.OPTIMAL: "OPTIMAL", cp_model.FEASIBLE: "FEASIBLE",
          cp_model.INFEASIBLE: "INFEASIBLE", cp_model.MODEL_INVALID: "MODEL_INVALID",
          cp_model.UNKNOWN: "UNKNOWN"}
    status = SM.get(rc, "UNKNOWN")

    # ── INFEASIBLE diagnostic ───────────────────────────────────────
    if rc not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        diag = _diagnose(EI, DC, open_days, warns, debug_input)
        return {"status": status, "objective": None,
                "schedule": {}, "coverage": {},
                "warnings": warns + diag, "debug": debug_input}

    # ── extract ─────────────────────────────────────────────────────
    sched = {}
    for i, ei in enumerate(EI):
        sid = ei["id"]; sched[sid] = {}
        for d in DAYS:
            if d in ei["abs"]:
                sched[sid][d] = {"code": ei["abs"][d]}; continue
            if DC[d] is None:
                sched[sid][d] = {"code": "off"}; continue
            w = W[i][d]
            if w is None or slv.value(w) == 0:
                sched[sid][d] = {"code": "off"}; continue
            dc = DC[d]
            for ss, bv in X[i][d].items():
                if slv.value(bv):
                    sm = dc["base"] + ss*30
                    sched[sid][d] = {"start": _hm(sm), "end": _hm(sm+ei["L"]*30),
                                     "hours": ei["hpd"], "code": "normal"}
                    break

        # warn if worked < target
        worked = sum(1 for d in DAYS if sched[sid].get(d,{}).get("code")=="normal")
        if worked < ei["td"]:
            warns.append(f"{ei['nm']}: trabaja {worked}d de {ei['td']} objetivo")

    covout = {}
    for d in open_days:
        dc = DC[d]; covout[d] = []; lab = DAY_ES.get(d, d)
        pre_gap=[]; post_gap=[]; ex_gap=[]; empty=[]
        for s in range(dc["N"]):
            if s not in COV[d]: continue
            asgn = slv.value(COV[d][s])
            # target for output: use band min if coverage mode, else billing target
            if s in TGT_BAND[d]:
                tgt = TGT_BAND[d][s][0]  # use min as the target for display
            else:
                tgt = TGT[d].get(s, 0)
            covout[d].append({"time": _hm(dc["base"]+s*30), "target": tgt, "assigned": asgn})
            if 0 <= s < dc["o"] and asgn < pre_lo:  pre_gap.append(pre_lo - asgn)
            if dc["c"] <= s < dc["po"] and asgn < post_lo: post_gap.append(post_lo - asgn)
            if dc["o"] <= s < dc["c"] and asgn == 0: empty.append(_hm(dc["base"]+s*30))
            if dc["extra"]:
                ex = dc["extra"]
                if ex["fs"] <= s < ex["ts"] and asgn < ex["lo"]:
                    ex_gap.append(ex["lo"] - asgn)
        if pre_gap:  warns.append(f"{lab} montaje: faltan {max(pre_gap)} persona(s) (mín. {pre_lo})")
        if post_gap: warns.append(f"{lab} cierre: faltan {max(post_gap)} persona(s) (mín. {post_lo})")
        if ex_gap and dc["extra"]:
            warns.append(f"{lab} {dc['sp'] or 'extra'}: faltan {max(ex_gap)} persona(s) (mín. {dc['extra']['lo']})")
        if empty:
            t = ", ".join(empty) if len(empty)<=3 else f"{empty[0]}–{empty[-1]} ({len(empty)} franjas)"
            warns.append(f"{lab}: 0 personas en {t}")

    # also output coverage for closed days (empty list)
    for d in DAYS:
        if d not in covout:
            covout[d] = []

    return {"status": status, "objective": int(slv.objective_value),
            "schedule": sched, "coverage": covout,
            "warnings": warns, "debug": debug_input}


def _diagnose(EI, DC, open_days, warns, raw):
    """Attempt to identify the cause of INFEASIBLE."""
    diag = []
    diag.append(f"Días abiertos: {', '.join(open_days)} ({len(open_days)}/7)")
    for i, ei in enumerate(EI):
        feasible = []
        for d in DAYS:
            if DC[d] is None: continue
            if d in ei["abs"] or ei["fix"].get(d) == "off": continue
            feasible.append(d)
        diag.append(
            f"  {ei['nm']}: L={ei['L']} slots, target={ei['td']}d, "
            f"disponible={ei['av']}, días factibles=[{','.join(feasible)}] ({len(feasible)}d)")
    return diag

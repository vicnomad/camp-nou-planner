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

WU_BAND = 6; WO_BAND = 2; WU_DEM = 4; WO_DEM = 1; W_DAY_SHORT = 10


def _tm(t):
    h, m = map(int, t.split(":"))
    return h * 60 + m

def _hm(m):
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


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

    # ── billing targets ─────────────────────────────────────────────
    TGT = {}
    for d in open_days:
        dc = DC[d]
        pn = dc["sp"] if dc["sp"] in profiles else "normal"
        pr = profiles.get(pn, {})
        bl = daily_bill.get(d, 0)
        TGT[d] = {}
        for s in range(dc["o"], dc["c"]):
            hr = ((dc["base"] + s*30) // 60) % 24
            pct = pr.get(str(hr), 0)
            t = max(1, round(bl * pct / 100 / productivity / 2)) if pct and bl else 1
            TGT[d][s] = t

    # ── employees ───────────────────────────────────────────────────
    warns = []
    EI = []
    for e in EMP:
        hpd   = e["weekly_hours"] / dpw
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
        contract_td = max(0, dpw - len(abs_days))

        feasible_days = 0
        infeasible_reasons = []
        for d in DAYS:
            if DC[d] is None:
                continue                       # closed day
            if d in abs_days or fixed.get(d) == "off":
                continue
            dc = DC[d]
            if av == "M":
                lo, hi = 7*60, 15*60
            elif av == "T":
                lo, hi = 14*60, dc["base"] + dc["N"]*30
            else:
                lo, hi = dc["base"], dc["base"] + dc["N"]*30
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
                    f"{DAY_ES.get(d,d)}: ventana {av}={wh:.1f}h < jornada {hpd}h")

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
            if ei["av"] == "M":
                lo, hi = 7*60, 15*60
            elif ei["av"] == "T":
                lo, hi = 14*60, dc["base"] + dc["N"]*30
            else:
                lo, hi = dc["base"], dc["base"] + dc["N"]*30
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
    obj = []

    # day-shortfall penalties
    for i, ei in enumerate(EI):
        ww = [W[i][d] for d in DAYS if W[i][d] is not None]
        if ww and ei["td"] > 0:
            short = mdl.new_int_var(0, 7, f"ds{i}")
            mdl.add(short + sum(ww) >= ei["td"])
            obj.append(W_DAY_SHORT * short)

    def soft(cv, lo, hi, wu, wo, tag):
        u = mdl.new_int_var(0, 60, f"u_{tag}")
        o = mdl.new_int_var(0, 60, f"o_{tag}")
        mdl.add(cv + u >= lo)
        mdl.add(cv - o <= hi)
        obj.append(wu * u + wo * o)

    for d in open_days:
        dc = DC[d]
        for s in range(0, dc["o"]):
            if s in COV[d]:
                soft(COV[d][s], pre_lo, pre_hi, WU_BAND, WO_BAND, f"pre{d}{s}")
        for s in range(dc["o"], dc["c"]):
            if s in COV[d]:
                tgt = TGT[d].get(s, 1)
                soft(COV[d][s], tgt, tgt+10, WU_DEM, WO_DEM, f"dem{d}{s}")
        for s in range(dc["c"], dc["po"]):
            if s in COV[d]:
                soft(COV[d][s], post_lo, post_hi, WU_BAND, WO_BAND, f"pst{d}{s}")
        if dc["extra"]:
            ex = dc["extra"]
            for s in range(ex["fs"], ex["ts"]):
                if s in COV[d]:
                    soft(COV[d][s], ex["lo"], ex["hi"], WU_BAND, WO_BAND, f"ex{d}{s}")

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
            tgt = TGT[d].get(s, 0); asgn = slv.value(COV[d][s])
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

"use client";

import { useState, useCallback, useMemo } from "react";
import { db } from "@/lib/firebase";
import { doc, setDoc } from "firebase/firestore";
import type {
  Department,
  Employee,
  SolveResult,
  ScheduleEntry,
  CoverageSlot,
  DayKey,
} from "@/lib/types";
import { DAYS_KEYS, DAY_LABELS, DAY_SHORT } from "@/lib/types";

const SOLVER_URL =
  process.env.NEXT_PUBLIC_SOLVER_URL || "https://camp-nou-engine.vercel.app";

interface Props {
  department: Department;
  employees: Employee[];
  schedule: SolveResult | null;
  onSchedule: (r: SolveResult) => void;
  showToast: (msg: string) => void;
}

function hh(m: number) {
  const x = ((m % 1440) + 1440) % 1440;
  return (
    String(Math.floor(x / 60)).padStart(2, "0") +
    ":" +
    String(x % 60).padStart(2, "0")
  );
}

function tm(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function initials(name: string) {
  return name.split(",")[0].slice(0, 2).toUpperCase();
}

export default function GridView({
  department,
  employees,
  schedule,
  onSchedule,
  showToast,
}: Props) {
  const [mode, setMode] = useState<"dia" | "semana">("dia");
  const [dayIdx, setDayIdx] = useState(0);
  const [loading, setLoading] = useState(false);

  const params = department.params;
  const color = department.color;

  const daySpecials = useMemo(() => {
    const m: Record<string, string | undefined> = {};
    for (const d of DAYS_KEYS) {
      m[d] = params?.store_hours?.[d]?.special;
    }
    return m;
  }, [params]);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    try {
      // Build solver input
      const solverEmps = employees.map((emp) => {
        const vacDays = (emp.absences ?? [])
          .filter((a) => a.type === "vacation")
          .flatMap((a) => (Array.isArray(a.days) ? a.days : []));
        return {
          id: emp.id,
          name: emp.name,
          weekly_hours: emp.weekly_hours,
          availability: emp.availability,
          ...(emp.fixed ? { fixed: emp.fixed } : {}),
          ...(vacDays.length > 0 ? { vacations: vacDays } : {}),
        };
      });

      const payload = {
        department: { id: department.id, name: department.name },
        params,
        employees: solverEmps,
      };

      const res = await fetch(`${SOLVER_URL}/api/solve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: SolveResult = await res.json();
      onSchedule(result);

      // Save to Firestore
      const weekId = `${department.id}_${new Date().toISOString().slice(0, 10)}`;
      await setDoc(doc(db, "schedules", weekId), {
        weekStart: new Date().toISOString().slice(0, 10),
        department: department.id,
        ...result,
      });

      showToast(
        `<b>${result.status}</b> · Objetivo ${result.objective}${result.warnings.length > 0 ? ` · ${result.warnings.length} avisos` : ""}`
      );
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : "desconocido"}`);
    } finally {
      setLoading(false);
    }
  }, [department, employees, params, onSchedule, showToast]);

  return (
    <>
      <div className="gridbar">
        <div className="gridtoggle">
          <button
            className={`gt ${mode === "dia" ? "active" : ""}`}
            onClick={() => setMode("dia")}
          >
            Por día
          </button>
          <button
            className={`gt ${mode === "semana" ? "active" : ""}`}
            onClick={() => setMode("semana")}
          >
            Semana completa
          </button>
        </div>
        <div className="legend">
          <div className="lg">
            <span className="lgsw" style={{ background: color }} /> Normales
          </div>
          <div className="lg">
            <span className="lgsw lg-vac" /> Vacaciones
          </div>
          <div className="lg">
            <span className="lgsw lg-band" /> Montaje/Cierre
          </div>
        </div>
        <div className="spacer" />
        <button
          className="btn btn-go"
          data-generate
          onClick={handleGenerate}
          disabled={loading}
        >
          {loading ? (
            <span className="spinner" />
          ) : (
            <svg className="ico" viewBox="0 0 24 24">
              <path d="M5 12l3 3 5-7M13 5l2 2M19 4l-1.5 3.5L14 9l3.5 1.5L19 14l1.5-3.5L24 9" />
            </svg>
          )}{" "}
          Generar
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setMode("semana");
            setTimeout(() => window.print(), 300);
          }}
        >
          <svg className="ico" viewBox="0 0 24 24">
            <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2M6 14h12v7H6Z" />
          </svg>{" "}
          Imprimir A3
        </button>
      </div>

      {mode === "dia" && (
        <>
          <div className="days">
            {DAYS_KEYS.map((d, i) => (
              <div
                key={d}
                className={`day ${i === dayIdx ? "active" : ""}`}
                onClick={() => setDayIdx(i)}
              >
                {DAY_SHORT[d]}
                {daySpecials[d] === "match" && (
                  <span className="matchbadge">Partido</span>
                )}
                {daySpecials[d] === "inventory" && (
                  <span
                    className="matchbadge"
                    style={{ background: "#e7e0fb", color: "#5b32b0" }}
                  >
                    Invent.
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="card">
            <div className="chead">
              <h3>
                Cuadrante por franjas de media hora ·{" "}
                {DAY_LABELS[DAYS_KEYS[dayIdx]]}
              </h3>
              <span className="sub">desde 07:00 · se adapta a cada día</span>
            </div>
            {schedule ? (
              <div className="gwrap">
                <DayGrid
                  day={DAYS_KEYS[dayIdx]}
                  params={params}
                  employees={employees}
                  schedule={schedule}
                  color={color}
                />
              </div>
            ) : (
              <div
                className="cardpad"
                style={{ textAlign: "center", color: "var(--ink-3)", padding: 40 }}
              >
                Pulsa <b>Generar</b> para calcular el cuadrante
              </div>
            )}
          </div>
        </>
      )}

      {mode === "semana" && (
        <div>
          {schedule ? (
            DAYS_KEYS.map((d) => {
              const sp = daySpecials[d];
              return (
                <div key={d} className="dayblock">
                  <h5>
                    {DAY_LABELS[d]}{" "}
                    {sp === "match" && (
                      <span className="dbtag match">Partido</span>
                    )}
                    {sp === "inventory" && (
                      <span className="dbtag inv">Inventario</span>
                    )}
                  </h5>
                  <div className="gscroll">
                    <DayGrid
                      day={d}
                      params={params}
                      employees={employees}
                      schedule={schedule}
                      color={color}
                    />
                  </div>
                </div>
              );
            })
          ) : (
            <div
              className="card cardpad"
              style={{ textAlign: "center", color: "var(--ink-3)", padding: 40 }}
            >
              Pulsa <b>Generar</b> para calcular el cuadrante semanal
            </div>
          )}
        </div>
      )}

      {/* Warnings */}
      {schedule && schedule.warnings.length > 0 && (
        <div
          style={{
            marginTop: 14,
            background: "#fdf0d6",
            border: "1px solid var(--gold-deep)",
            borderRadius: 12,
            padding: "12px 16px",
          }}
        >
          <b style={{ color: "var(--gold-deep)" }}>Avisos</b>
          {schedule.warnings.map((w, i) => (
            <p key={i} style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>
              {w}
            </p>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------- Day Grid Renderer ---------- */

function DayGrid({
  day,
  params,
  employees,
  schedule,
  color,
}: {
  day: DayKey;
  params: Department["params"];
  employees: Employee[];
  schedule: SolveResult;
  color: string;
}) {
  const sh = params.store_hours?.[day];
  if (!sh) return null;

  const grid0 = 420; // 07:00
  const openM = tm(sh.open);
  const closeRaw = tm(sh.close);
  const closeM = closeRaw <= openM ? closeRaw + 1440 : closeRaw;
  const preM = openM - (params.preopen?.minutes ?? 30);
  const postM = closeM + (params.postclose?.minutes ?? 30);

  let endM = postM;
  if (sh.extra) {
    const extraTo = tm(sh.extra.to);
    const extraEnd = extraTo <= grid0 ? extraTo + 1440 : extraTo;
    endM = Math.max(endM, extraEnd);
  }

  const t0 = Math.min(grid0, preM);
  const slotCount = Math.ceil((endM - t0) / 30);

  function isOpenSlot(slotMin: number) {
    return slotMin >= openM && slotMin < closeM;
  }
  function isBandSlot(slotMin: number) {
    return slotMin < openM || slotMin >= closeM;
  }

  // Build coverage map from schedule.coverage
  const covMap: Record<string, CoverageSlot> = {};
  (schedule.coverage?.[day] ?? []).forEach((c) => {
    covMap[c.time] = c;
  });

  return (
    <>
      {/* HEADER ROW */}
      <div className="ghead">
        <div className="grow">
          <div className="gmeta">
            <div className="c-obs" />
            <div className="c-name" style={{ fontWeight: 700 }}>
              Empleado
            </div>
            <div className="c-base">Base</div>
            <div className="c-ent">Entrada</div>
            <div className="c-tot">Total</div>
          </div>
          <div className="cells">
            {Array.from({ length: slotCount }, (_, k) => {
              const slotMin = t0 + k * 30;
              if (slotMin % 60 !== 0) return null;
              const band = isBandSlot(slotMin);
              return (
                <div
                  key={k}
                  className={`hourcell ${band ? "bandhead" : ""}`}
                >
                  {hh(slotMin)}
                  {slotMin === preM && (
                    <span className="bandtag">Montaje</span>
                  )}
                  {slotMin === closeM && (
                    <span className="bandtag">Cierre</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* EMPLOYEE ROWS */}
      {employees.map((emp) => {
        const entry: ScheduleEntry | undefined =
          schedule.schedule?.[emp.id]?.[day];
        const isOff = !entry || entry.code === "off";
        const isVac = entry?.code === "vacation";
        const isWorking = !isOff && !isVac;

        const shiftStart = isWorking && entry?.start ? tm(entry.start) : -1;
        const shiftSlots = isWorking && entry?.hours ? entry.hours * 2 : 0;
        const shiftStartSlot =
          shiftStart >= 0 ? Math.round((shiftStart - t0) / 30) : -1;

        const dpw = params.days_per_week ?? 5;
        const hpd = emp.weekly_hours / dpw;

        // Total hours for the week
        let weekHours = 0;
        for (const d of DAYS_KEYS) {
          const e = schedule.schedule?.[emp.id]?.[d];
          if (e && e.code === "normal" && e.hours) weekHours += e.hours;
        }

        return (
          <div key={emp.id} className="grow">
            <div className="gmeta">
              <div className="c-obs" />
              <div className="c-name">
                <div className="avmini" style={{ background: color }}>
                  {initials(emp.name)}
                </div>
                <div className="nm">
                  <b>{emp.name}</b>
                  <span>
                    <span className={`pill p-${emp.availability}`}>
                      {emp.availability}
                    </span>
                    {emp.fixed && (
                      <svg className="lock" viewBox="0 0 24 24">
                        <rect x="5" y="11" width="14" height="9" rx="2" />
                        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                      </svg>
                    )}
                  </span>
                </div>
              </div>
              <div className="c-base">
                <b>{emp.weekly_hours}</b>
                <small>{hpd}h/d</small>
              </div>
              <div className="c-ent">
                {isWorking ? entry?.start : isVac ? "VAC" : "—"}
              </div>
              <div className="c-tot">
                <b>{isWorking ? entry?.hours : isVac ? "VAC" : 0}</b>
                <small>{weekHours}h sem</small>
              </div>
            </div>
            <div className="cells">
              {Array.from({ length: slotCount }, (_, k) => {
                const slotMin = t0 + k * 30;
                const band = isBandSlot(slotMin);
                const hourend = (slotMin + 30) % 60 === 0;

                if (isVac) {
                  const isStart = k === 0;
                  const isEnd = k === slotCount - 1;
                  return (
                    <div
                      key={k}
                      className={`cell w vac ${isStart ? "s" : ""} ${isEnd ? "e" : ""} ${hourend ? "hourend" : ""}`}
                      style={{ "--dc": color } as React.CSSProperties}
                    >
                      <div className="fill" />
                      {k === Math.floor(slotCount / 2) && (
                        <span className="entlabel dark">Vacaciones</span>
                      )}
                    </div>
                  );
                }

                const inShift =
                  isWorking &&
                  k >= shiftStartSlot &&
                  k < shiftStartSlot + shiftSlots;

                if (inShift) {
                  const isStart = k === shiftStartSlot;
                  const isEnd = k === shiftStartSlot + shiftSlots - 1;
                  return (
                    <div
                      key={k}
                      className={`cell w ${isStart ? "s" : ""} ${isEnd ? "e" : ""} ${hourend ? "hourend" : ""} ${band ? "band" : ""}`}
                      style={{ "--dc": color } as React.CSSProperties}
                    >
                      <div className="fill" />
                      {isStart && (
                        <span className="entlabel">{entry?.start}</span>
                      )}
                    </div>
                  );
                }

                return (
                  <div
                    key={k}
                    className={`cell ${hourend ? "hourend" : ""} ${band ? "band" : ""}`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {/* COVERAGE ROW */}
      <div className="crow">
        <div className="gmeta">
          <div className="c-obs" />
          <div className="c-name">CANT. PERSONAS</div>
          <div className="c-base" />
          <div className="c-ent" style={{ fontSize: 9, color: "var(--ink-3)" }}>
            obj→
          </div>
          <div className="c-tot" />
        </div>
        <div className="cells">
          {Array.from({ length: slotCount }, (_, k) => {
            const slotMin = t0 + k * 30;
            const timeStr = hh(slotMin);
            const cov = covMap[timeStr];
            const open = isOpenSlot(slotMin);
            const hourend = (slotMin + 30) % 60 === 0;

            const assigned = cov?.assigned ?? 0;
            const target = cov?.target ?? 0;

            let bg = "transparent";
            let col = "var(--ink-3)";
            if (open) {
              const ratio = assigned / Math.max(target, 1);
              bg =
                assigned === 0
                  ? "#fdecec"
                  : ratio < 0.8
                    ? "#fdf0d6"
                    : "#e7f4ee";
              col =
                assigned === 0
                  ? "var(--bad)"
                  : ratio < 0.8
                    ? "var(--gold-deep)"
                    : "var(--ok)";
            }

            return (
              <div
                key={k}
                className={`ccell ${hourend ? "hourend" : ""}`}
                style={{ background: bg, color: col }}
              >
                {(open || assigned > 0) ? assigned : ""}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

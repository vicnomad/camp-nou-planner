"use client";

import { useState, useCallback, useMemo, useEffect, useRef, type MutableRefObject } from "react";
import { db } from "@/lib/firebase";
import { doc, setDoc, getDoc } from "firebase/firestore";
import type {
  Department, Employee, SolveResult, ScheduleEntry,
  CoverageSlot, DayKey, StoreHours,
} from "@/lib/types";
import { DAYS_KEYS, DAY_LABELS, DAY_SHORT } from "@/lib/types";

const SOLVER_URL = process.env.NEXT_PUBLIC_SOLVER_URL || "https://camp-nou-engine.vercel.app";

interface WeekEvent {
  type: "match" | "inventory";
  close?: string;
  extra?: { from: string; to: string; min: number; max: number };
}

interface Props {
  department: Department;
  employees: Employee[];
  schedule: SolveResult | null;
  onSchedule: (r: SolveResult) => void;
  showToast: (msg: string) => void;
  generateRef: MutableRefObject<(() => void) | null>;
}

function hh(m: number) {
  const x = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0");
}
function tm(t: string) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function initials(name: string) { return name.split(",")[0].slice(0, 2).toUpperCase(); }

function getMonday(d: Date) {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff);
}
function fmtDate(d: Date) { return d.toISOString().slice(0, 10); }

export default function GridView({ department, employees, schedule, onSchedule, showToast, generateRef }: Props) {
  const [mode, setMode] = useState<"dia" | "semana">("dia");
  const [dayIdx, setDayIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [weekMonday, setWeekMonday] = useState(() => fmtDate(getMonday(new Date())));
  const [events, setEvents] = useState<Record<string, WeekEvent>>({});
  const [eventModal, setEventModal] = useState<{ day: DayKey; event: WeekEvent } | null>(null);
  const [editedSchedule, setEditedSchedule] = useState<SolveResult | null>(null);

  const params = department.params;
  const color = department.color;
  const displaySchedule = editedSchedule ?? schedule;

  // Load week events from Firestore
  const weekDocId = `${department.id}_${weekMonday}`;
  useEffect(() => {
    getDoc(doc(db, "weeks", weekDocId)).then((snap) => {
      if (snap.exists()) setEvents(snap.data().events ?? {});
      else setEvents({});
    });
  }, [weekDocId]);

  // Reset edited schedule when base schedule changes
  useEffect(() => { setEditedSchedule(null); }, [schedule]);

  // Merge base store_hours with week events
  const mergedStoreHours = useMemo(() => {
    const merged: Record<string, StoreHours> = {};
    for (const d of DAYS_KEYS) {
      merged[d] = { ...params.store_hours[d] };
      const ev = events[d];
      if (ev?.type === "match") {
        merged[d].special = "match";
        if (ev.close) merged[d].close = ev.close;
      } else if (ev?.type === "inventory") {
        merged[d].special = "inventory";
        if (ev.extra) merged[d].extra = ev.extra;
      } else {
        delete merged[d].special;
        delete merged[d].extra;
      }
    }
    return merged;
  }, [params.store_hours, events]);

  async function saveEvents(newEvents: Record<string, WeekEvent>) {
    setEvents(newEvents);
    await setDoc(doc(db, "weeks", weekDocId), { events: newEvents }, { merge: true });
  }

  function addEvent(day: DayKey, ev: WeekEvent) {
    saveEvents({ ...events, [day]: ev });
    setEventModal(null);
    showToast(`Evento ${ev.type} añadido al ${DAY_LABELS[day]}`);
  }
  function removeEvent(day: DayKey) {
    const next = { ...events };
    delete next[day];
    saveEvents(next);
    setEventModal(null);
  }

  const handleGenerate = useCallback(async () => {
    if (editedSchedule && !confirm("Se descartarán los ajustes manuales. ¿Continuar?")) return;
    setLoading(true);
    try {
      const solverEmps = employees.map((emp) => {
        const vacDays = (emp.absences ?? []).flatMap((a) => Array.isArray(a.days) ? a.days : []);
        return {
          id: emp.id, name: emp.name, weekly_hours: emp.weekly_hours,
          availability: emp.availability,
          ...(emp.fixed ? { fixed: emp.fixed } : {}),
          ...(vacDays.length > 0 ? { vacations: vacDays } : {}),
        };
      });
      const payload = {
        department: { id: department.id, name: department.name },
        params: { ...params, store_hours: mergedStoreHours },
        employees: solverEmps,
      };
      const res = await fetch(`${SOLVER_URL}/api/solve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: SolveResult = await res.json();
      onSchedule(result);
      setEditedSchedule(null);
      await setDoc(doc(db, "schedules", weekDocId), {
        weekStart: weekMonday, department: department.id, ...result,
      });
      showToast(`<b>${result.status}</b> · Objetivo ${result.objective}${result.warnings.length > 0 ? ` · ${result.warnings.length} avisos` : ""}`);
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : "desconocido"}`);
    } finally { setLoading(false); }
  }, [department, employees, params, mergedStoreHours, weekDocId, weekMonday, onSchedule, showToast, editedSchedule]);

  useEffect(() => {
    generateRef.current = handleGenerate;
    return () => { generateRef.current = null; };
  }, [handleGenerate, generateRef]);

  // Manual edit handler
  function handleManualEdit(empId: string, day: DayKey, newStart: string, newHours: number) {
    const base = displaySchedule;
    if (!base) return;
    const newSched = JSON.parse(JSON.stringify(base)) as SolveResult;
    newSched.schedule[empId][day] = { start: newStart, end: hh(tm(newStart) + newHours * 60), hours: newHours, code: "normal" };
    // Recalculate coverage for this day
    newSched.coverage[day] = recalcCoverage(day, newSched, employees, params, mergedStoreHours);
    setEditedSchedule(newSched);
  }

  return (
    <>
      {/* Week selector */}
      <div className="gridbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>Semana:</label>
          <input type="date" value={weekMonday} onChange={(e) => setWeekMonday(fmtDate(getMonday(new Date(e.target.value))))}
            style={{ fontFamily: "'Spline Sans Mono'", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, padding: "6px 10px", background: "var(--paper)" }} />
        </div>
        <div className="gridtoggle">
          <button className={`gt ${mode === "dia" ? "active" : ""}`} onClick={() => setMode("dia")}>Por día</button>
          <button className={`gt ${mode === "semana" ? "active" : ""}`} onClick={() => setMode("semana")}>Semana completa</button>
        </div>
        <div className="legend">
          <div className="lg"><span className="lgsw" style={{ background: color }} /> Normales</div>
          <div className="lg"><span className="lgsw lg-vac" /> Ausencias</div>
          <div className="lg"><span className="lgsw lg-band" /> Montaje/Cierre</div>
        </div>
        <div className="spacer" />
        {loading && <span className="spinner" style={{ borderColor: "var(--garnet)", borderTopColor: "#fff" }} />}
        <button className="btn btn-ghost" onClick={() => { setMode("semana"); setTimeout(() => window.print(), 300); }}>
          <svg className="ico" viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2M6 14h12v7H6Z"/></svg> Imprimir A3
        </button>
      </div>

      {mode === "dia" && (
        <>
          <div className="days">
            {DAYS_KEYS.map((d, i) => (
              <div key={d} className={`day ${i === dayIdx ? "active" : ""}`} onClick={() => setDayIdx(i)}>
                {DAY_SHORT[d]}
                {events[d]?.type === "match" && <span className="matchbadge">Partido</span>}
                {events[d]?.type === "inventory" && <span className="matchbadge" style={{ background: "#e7e0fb", color: "#5b32b0" }}>Invent.</span>}
                <button onClick={(e) => { e.stopPropagation(); setEventModal({ day: d, event: events[d] ?? { type: "match" } }); }}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "var(--ink-3)", marginLeft: 2, padding: 0 }}>⚙</button>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="chead">
              <h3>Cuadrante · {DAY_LABELS[DAYS_KEYS[dayIdx]]}{events[DAYS_KEYS[dayIdx]]?.type === "match" ? " · Partido" : events[DAYS_KEYS[dayIdx]]?.type === "inventory" ? " · Inventario" : ""}</h3>
              <span className="sub">desde apertura − montaje</span>
            </div>
            {displaySchedule ? (
              <div className="gwrap">
                <DayGrid day={DAYS_KEYS[dayIdx]} params={params} storeHours={mergedStoreHours} employees={employees} schedule={displaySchedule} color={color} onManualEdit={handleManualEdit} />
              </div>
            ) : (
              <div className="cardpad" style={{ textAlign: "center", color: "var(--ink-3)", padding: 40 }}>Pulsa <b>Generar</b> para calcular el cuadrante</div>
            )}
          </div>
        </>
      )}

      {mode === "semana" && (
        <div>
          {displaySchedule ? DAYS_KEYS.map((d) => (
            <div key={d} className="dayblock">
              <h5>{DAY_LABELS[d]} {events[d]?.type === "match" && <span className="dbtag match">Partido</span>}{events[d]?.type === "inventory" && <span className="dbtag inv">Inventario</span>}</h5>
              <div className="gscroll"><DayGrid day={d} params={params} storeHours={mergedStoreHours} employees={employees} schedule={displaySchedule} color={color} onManualEdit={handleManualEdit} /></div>
            </div>
          )) : (
            <div className="card cardpad" style={{ textAlign: "center", color: "var(--ink-3)", padding: 40 }}>Pulsa <b>Generar</b></div>
          )}
        </div>
      )}

      {displaySchedule && displaySchedule.warnings.length > 0 && (
        <div style={{ marginTop: 14, background: "#fdf0d6", border: "1px solid var(--gold-deep)", borderRadius: 12, padding: "12px 16px" }}>
          <b style={{ color: "var(--gold-deep)" }}>Avisos ({displaySchedule.warnings.length})</b>
          {displaySchedule.warnings.map((w, i) => <p key={i} style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>{w}</p>)}
        </div>
      )}

      {/* Event modal */}
      {eventModal && (
        <EventModal event={eventModal.event} day={eventModal.day}
          onSave={(ev) => addEvent(eventModal.day, ev)}
          onRemove={() => removeEvent(eventModal.day)}
          onClose={() => setEventModal(null)}
          hasEvent={!!events[eventModal.day]}
        />
      )}
    </>
  );
}

/* ---------- Event Modal ---------- */
function EventModal({ event, day, onSave, onRemove, onClose, hasEvent }: {
  event: WeekEvent; day: DayKey; onSave: (e: WeekEvent) => void; onRemove: () => void; onClose: () => void; hasEvent: boolean;
}) {
  const [ev, setEv] = useState<WeekEvent>(event);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 400 }}>
        <div className="modal-head"><h3>Evento — {DAY_LABELS[day]}</h3><button className="editbtn" onClick={onClose} style={{background:"transparent"}}>✕</button></div>
        <div className="modal-body">
          <div className="form-field"><label>Tipo</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button className={`prof ${ev.type === "match" ? "active" : ""}`} onClick={() => setEv({...ev, type: "match"})}>Partido ⚽</button>
              <button className={`prof ${ev.type === "inventory" ? "active" : ""}`} onClick={() => setEv({...ev, type: "inventory"})}>Inventario 📦</button>
            </div>
          </div>
          {ev.type === "match" && (
            <div className="form-field"><label>Cierre ampliado</label>
              <input className="timeinput" value={ev.close ?? "23:00"} onChange={e => setEv({...ev, close: e.target.value})} />
            </div>
          )}
          {ev.type === "inventory" && (
            <>
              <div style={{ display: "flex", gap: 10 }}>
                <div className="form-field" style={{flex:1}}><label>Desde</label><input className="timeinput" value={ev.extra?.from ?? "21:00"} onChange={e => setEv({...ev, extra: {...(ev.extra ?? {from:"21:00",to:"01:00",min:2,max:3}), from: e.target.value}})}/></div>
                <div className="form-field" style={{flex:1}}><label>Hasta</label><input className="timeinput" value={ev.extra?.to ?? "01:00"} onChange={e => setEv({...ev, extra: {...(ev.extra ?? {from:"21:00",to:"01:00",min:2,max:3}), to: e.target.value}})}/></div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div className="form-field" style={{flex:1}}><label>Mín personas</label><input className="num" type="number" value={ev.extra?.min ?? 2} onChange={e => setEv({...ev, extra: {...(ev.extra ?? {from:"21:00",to:"01:00",min:2,max:3}), min: +e.target.value}})}/></div>
                <div className="form-field" style={{flex:1}}><label>Máx personas</label><input className="num" type="number" value={ev.extra?.max ?? 3} onChange={e => setEv({...ev, extra: {...(ev.extra ?? {from:"21:00",to:"01:00",min:2,max:3}), max: +e.target.value}})}/></div>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          {hasEvent && <button className="btn-danger" onClick={onRemove}>Quitar evento</button>}
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-go" onClick={() => onSave(ev)}>Guardar</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Recalculate coverage locally ---------- */
function recalcCoverage(
  day: DayKey, sched: SolveResult, employees: Employee[],
  params: Department["params"], storeHours: Record<string, StoreHours>,
): CoverageSlot[] {
  const sh = storeHours[day];
  if (!sh) return [];
  const openM = tm(sh.open);
  const closeRaw = tm(sh.close);
  const closeM = closeRaw <= openM ? closeRaw + 1440 : closeRaw;
  const preM = openM - (params.preopen?.minutes ?? 30);
  const postM = closeM + (params.postclose?.minutes ?? 30);
  let endM = postM;
  if (sh.extra) { const et = tm(sh.extra.to); endM = Math.max(endM, et <= openM ? et + 1440 : et); }
  const t0 = preM;
  const slotCount = Math.ceil((endM - t0) / 30);
  const coverage: number[] = new Array(slotCount).fill(0);

  for (const emp of employees) {
    const entry = sched.schedule?.[emp.id]?.[day];
    if (!entry || entry.code !== "normal" || !entry.start) continue;
    const startM = tm(entry.start);
    const slots = (entry.hours ?? 0) * 2;
    for (let i = 0; i < slots; i++) {
      const slotM = startM + i * 30;
      const idx = Math.round((slotM - t0) / 30);
      if (idx >= 0 && idx < slotCount) coverage[idx]++;
    }
  }

  // TODO: billing targets could be recomputed here too
  return coverage.map((assigned, k) => {
    const slotM = t0 + k * 30;
    const open = slotM >= openM && slotM < closeM;
    return { time: hh(slotM), target: open ? 1 : 0, assigned };
  });
}

/* ---------- Day Grid (with drag editing) ---------- */
function DayGrid({ day, params, storeHours, employees, schedule, color, onManualEdit }: {
  day: DayKey; params: Department["params"]; storeHours: Record<string, StoreHours>;
  employees: Employee[]; schedule: SolveResult; color: string;
  onManualEdit: (empId: string, day: DayKey, start: string, hours: number) => void;
}) {
  const sh = storeHours[day];
  if (!sh) return null;

  const openM = tm(sh.open);
  const closeRaw = tm(sh.close);
  const closeM = closeRaw <= openM ? closeRaw + 1440 : closeRaw;
  const preM = openM - (params.preopen?.minutes ?? 30);
  const postM = closeM + (params.postclose?.minutes ?? 30);
  let endM = postM;
  if (sh.extra) { const et = tm(sh.extra.to); const extraEnd = et <= tm(sh.open) ? et + 1440 : et; endM = Math.max(endM, extraEnd); }

  const t0 = preM;
  const slotCount = Math.ceil((endM - t0) / 30);

  const isOpen = (m: number) => m >= openM && m < closeM;
  const isBand = (m: number) => m < openM || m >= closeM;

  const covMap: Record<string, CoverageSlot> = {};
  (schedule.coverage?.[day] ?? []).forEach((c) => { covMap[c.time] = c; });

  // Drag state
  const dragRef = useRef<{ empId: string; mode: "move" | "start" | "end"; origStart: number; origSlots: number; startX: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ empId: string; startSlot: number; slots: number } | null>(null);

  function handlePointerDown(e: React.PointerEvent, empId: string, startSlot: number, shiftSlots: number, clickSlot: number) {
    e.preventDefault();
    const isStartEdge = clickSlot === startSlot;
    const isEndEdge = clickSlot === startSlot + shiftSlots - 1;
    dragRef.current = {
      empId, origStart: startSlot, origSlots: shiftSlots,
      mode: isStartEdge ? "start" : isEndEdge ? "end" : "move",
      startX: e.clientX,
    };
    setDragPreview({ empId, startSlot, slots: shiftSlots });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dr = dragRef.current;
    const cellW = 24; // --cell
    const dx = Math.round((e.clientX - dr.startX) / cellW);
    if (dr.mode === "move") {
      const ns = Math.max(0, Math.min(slotCount - dr.origSlots, dr.origStart + dx));
      setDragPreview({ empId: dr.empId, startSlot: ns, slots: dr.origSlots });
    } else if (dr.mode === "end") {
      const newSlots = Math.max(1, dr.origSlots + dx);
      setDragPreview({ empId: dr.empId, startSlot: dr.origStart, slots: newSlots });
    } else if (dr.mode === "start") {
      const ns = Math.max(0, dr.origStart + dx);
      const newSlots = Math.max(1, dr.origSlots - dx);
      setDragPreview({ empId: dr.empId, startSlot: ns, slots: newSlots });
    }
  }

  function handlePointerUp() {
    if (!dragRef.current || !dragPreview) { dragRef.current = null; setDragPreview(null); return; }
    const newStartM = t0 + dragPreview.startSlot * 30;
    const newHours = dragPreview.slots / 2;
    onManualEdit(dragRef.current.empId, day, hh(newStartM), newHours);
    dragRef.current = null;
    setDragPreview(null);
  }

  return (
    <div onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}>
      {/* HEADER */}
      <div className="ghead"><div className="grow">
        <div className="gmeta"><div className="c-obs"/><div className="c-name" style={{fontWeight:700}}>Empleado</div><div className="c-base">Base</div><div className="c-ent">Entrada</div><div className="c-tot">Total</div></div>
        <div className="cells">
          {Array.from({length: slotCount}, (_, k) => {
            const m = t0 + k * 30;
            if (m % 60 !== 0) return null;
            const band = isBand(m);
            return <div key={k} className={`hourcell ${band ? "bandhead" : ""}`}>
              {hh(m)}
              {m === preM && m % 60 === 0 && <span className="bandtag">Montaje</span>}
              {m === closeM && m % 60 === 0 && <span className="bandtag">Cierre</span>}
            </div>;
          })}
        </div>
      </div></div>

      {/* EMPLOYEES */}
      {employees.map((emp) => {
        const entry: ScheduleEntry | undefined = schedule.schedule?.[emp.id]?.[day];
        const isOff = !entry || entry.code === "off";
        const isVac = entry?.code === "vacation" || (entry?.code && entry.code !== "normal" && entry.code !== "off");
        const isWorking = !isOff && !isVac;
        const dpw = params.days_per_week ?? 5;
        const hpd = emp.weekly_hours / dpw;

        let shiftStartSlot = -1, shiftSlots = 0;
        if (isWorking && entry?.start) {
          const startM = tm(entry.start);
          shiftStartSlot = Math.round((startM - t0) / 30);
          shiftSlots = (entry.hours ?? hpd) * 2;
        }

        // Apply drag preview
        const dp = dragPreview?.empId === emp.id ? dragPreview : null;
        const dispStart = dp ? dp.startSlot : shiftStartSlot;
        const dispSlots = dp ? dp.slots : shiftSlots;

        let weekHours = 0;
        for (const d of DAYS_KEYS) {
          const e2 = schedule.schedule?.[emp.id]?.[d];
          if (e2?.code === "normal" && e2.hours) weekHours += e2.hours;
        }

        return (
          <div key={emp.id} className="grow">
            <div className="gmeta">
              <div className="c-obs"/>
              <div className="c-name">
                <div className="avmini" style={{background: color}}>{initials(emp.name)}</div>
                <div className="nm">
                  <b>{emp.name}</b>
                  <span><span className={`pill p-${emp.availability}`}>{emp.availability}</span>
                  {emp.fixed && <svg className="lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>}</span>
                </div>
              </div>
              <div className="c-base"><b>{emp.weekly_hours}</b><small>{hpd}h/d</small></div>
              <div className="c-ent">{isWorking ? entry?.start : isVac ? (entry?.code ?? "AUS").toUpperCase().slice(0,3) : "—"}</div>
              <div className="c-tot"><b>{isWorking ? entry?.hours : isVac ? "AUS" : 0}</b><small>{weekHours}h sem</small></div>
            </div>
            <div className="cells">
              {Array.from({length: slotCount}, (_, k) => {
                const m = t0 + k * 30;
                const band = isBand(m);
                const hourend = (m + 30) % 60 === 0;

                if (isVac) {
                  return <div key={k} className={`cell w vac ${k===0?"s":""} ${k===slotCount-1?"e":""} ${hourend?"hourend":""}`} style={{"--dc": color} as React.CSSProperties}>
                    <div className="fill"/>
                    {k === Math.floor(slotCount/2) && <span className="entlabel dark">{(entry?.code ?? "vacation").toUpperCase().slice(0,3)}</span>}
                  </div>;
                }

                const inShift = isWorking && k >= dispStart && k < dispStart + dispSlots;
                if (inShift) {
                  const isS = k === dispStart, isE = k === dispStart + dispSlots - 1;
                  return <div key={k}
                    className={`cell w ${isS?"s":""} ${isE?"e":""} ${hourend?"hourend":""} ${band?"band":""}`}
                    style={{"--dc": color, cursor: "grab"} as React.CSSProperties}
                    onPointerDown={(e) => handlePointerDown(e, emp.id, dispStart, dispSlots, k)}
                  >
                    <div className="fill"/>
                    {isS && <span className="entlabel">{hh(t0 + dispStart * 30)}</span>}
                  </div>;
                }
                return <div key={k} className={`cell ${hourend?"hourend":""} ${band?"band":""}`}/>;
              })}
            </div>
          </div>
        );
      })}

      {/* COVERAGE */}
      <div className="crow">
        <div className="gmeta"><div className="c-obs"/><div className="c-name">CANT. PERSONAS</div><div className="c-base"/><div className="c-ent" style={{fontSize:9,color:"var(--ink-3)"}}>obj→</div><div className="c-tot"/></div>
        <div className="cells">
          {Array.from({length: slotCount}, (_, k) => {
            const m = t0 + k * 30;
            const timeStr = hh(m);
            const cov = covMap[timeStr];
            const open = isOpen(m);
            const hourend = (m + 30) % 60 === 0;
            const assigned = cov?.assigned ?? 0;
            const target = cov?.target ?? 0;
            let bg = "transparent", col = "var(--ink-3)";
            if (open || assigned > 0) {
              const ratio = assigned / Math.max(target, 1);
              bg = assigned === 0 ? "#fdecec" : ratio < 0.8 ? "#fdf0d6" : "#e7f4ee";
              col = assigned === 0 ? "var(--bad)" : ratio < 0.8 ? "var(--gold-deep)" : "var(--ok)";
            }
            return <div key={k} className={`ccell ${hourend?"hourend":""}`} style={{background: bg, color: col}}>
              {(open || assigned > 0) ? assigned : ""}
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}

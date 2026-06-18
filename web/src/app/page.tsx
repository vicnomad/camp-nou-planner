"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { db, auth } from "@/lib/firebase";
import { onAuthStateChanged, signInWithEmailAndPassword, type User } from "firebase/auth";
import {
  collection, onSnapshot, query, where, doc, updateDoc, getDoc, setDoc, deleteDoc,
} from "firebase/firestore";
import type { Department, Employee, SolveResult, Absence } from "@/lib/types";
import { DAYS_KEYS } from "@/lib/types";
import { getMonday, fmtDate, weekIsoId, fiscalWeekNumber, weekLabel, shiftWeek } from "@/lib/week";
import { exportCegidXlsx } from "@/lib/exportCegid";
import { mergeSchedule, applyAbsences, type ScheduleEdits } from "@/lib/schedule";
import Sidebar from "@/components/Sidebar";
import TeamView from "@/components/TeamView";
import ParamsView from "@/components/ParamsView";
import GridView from "@/components/GridView";
import BillingView from "@/components/BillingView";

export type ViewId = "grid" | "team" | "params" | "billing";

const ACCESS_EMAIL = "acceso@camp-nou-planner.app";

export interface WeekOverride {
  weekly_hours?: number;
  availability?: "M" | "T" | "F";
  fixed?: Record<string, string> | null;
  active?: boolean;
  absences?: Absence[];
}

// Old CSV export removed — now uses exportCegidXlsx from lib/exportCegid

export default function Home() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [currentDeptId, setCurrentDeptId] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [view, setView] = useState<ViewId>("grid");
  const [schedule, setSchedule] = useState<SolveResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [weekMonday, setWeekMonday] = useState(() => fmtDate(getMonday(new Date())));
  const [weekOverrides, setWeekOverrides] = useState<Record<string, WeekOverride>>({});
  const [scheduleEdits, setScheduleEdits] = useState<ScheduleEdits>({});
  const [storeBilling, setStoreBilling] = useState<Record<string, number>>({});
  const generateRef = useRef<(() => void) | null>(null);

  // Puerta de acceso (Firebase Auth, sesión persistida).
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  useEffect(() => onAuthStateChanged(auth, (u) => { setAuthUser(u); setAuthReady(true); }), []);

  const currentDept = departments.find((d) => d.id === currentDeptId) ?? null;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3400);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("sidebar_collapsed");
    if (saved === "true") setCollapsed(true);
  }, []);
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => { localStorage.setItem("sidebar_collapsed", String(!c)); return !c; });
  }, []);

  // Load departments
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(collection(db, "departments"), (snap) => {
      const depts = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Department[];
      depts.sort((a, b) => a.name.localeCompare(b.name));
      setDepartments(depts);
      if (!currentDeptId && depts.length > 0) setCurrentDeptId(depts[0].id);
    });
    return unsub;
  }, [currentDeptId, authUser]);

  // Load employees
  useEffect(() => {
    if (!authUser) return;
    if (!currentDeptId) return;
    const q = query(collection(db, "employees"), where("department", "==", currentDeptId));
    const unsub = onSnapshot(q, (snap) => {
      const emps = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Employee[];
      emps.sort((a, b) => a.name.localeCompare(b.name));
      setEmployees(emps);
    });
    return unsub;
  }, [currentDeptId, authUser]);

  // Load saved schedule + overrides when dept or week changes
  const weekDocId = currentDeptId ? `${currentDeptId}_${weekIsoId(weekMonday)}` : null;
  useEffect(() => {
    if (!authUser) return;
    setSchedule(null); // blank until loaded
    setWeekOverrides({});
    setScheduleEdits({});
    setStoreBilling({});
    if (!weekDocId) return;
    // Load saved schedule
    getDoc(doc(db, "schedules", weekDocId)).then((snap) => {
      if (snap.exists()) {
        const d = snap.data();
        setSchedule({ status: d.status, objective: d.objective, schedule: d.schedule, coverage: d.coverage, warnings: d.warnings ?? [] });
      }
    });
    // Load week overrides
    getDoc(doc(db, "weekOverrides", weekDocId)).then((snap) => {
      if (snap.exists()) setWeekOverrides(snap.data() as Record<string, WeekOverride>);
    });
    // Load manual schedule edits (persisted)
    getDoc(doc(db, "scheduleEdits", weekDocId)).then((snap) => {
      if (snap.exists()) setScheduleEdits(snap.data() as ScheduleEdits);
    });
    // Facturación diaria store-level POR SEMANA (colección storeBilling, id = weekIsoId).
    getDoc(doc(db, "storeBilling", weekIsoId(weekMonday))).then((snap) => {
      if (snap.exists()) setStoreBilling((snap.data().daily as Record<string, number>) ?? {});
    });
  }, [weekDocId, authUser]);

  // Compute effective employees (base + week overrides).
  // Las ausencias son SIEMPRE por semana: se toman del override (o [] si no hay);
  // las ausencias globales del empleado se ignoran.
  const effectiveEmployees = employees.map((emp) => {
    const ov = weekOverrides[emp.id];
    return {
      ...emp,
      ...(ov?.weekly_hours !== undefined ? { weekly_hours: ov.weekly_hours } : {}),
      ...(ov?.availability !== undefined ? { availability: ov.availability } : {}),
      ...(ov?.fixed !== undefined ? { fixed: ov.fixed } : {}),
      absences: ov?.absences ?? [],
    };
  });
  const activeEmployees = effectiveEmployees.filter((emp) => {
    const ov = weekOverrides[emp.id];
    return ov?.active !== false;
  });

  // Horario EFECTIVO = generado + ediciones manuales + ausencias de la semana.
  // Única fuente para export/ficha/grid. Tras effectiveEmployees (usa sus ausencias).
  const effectiveSchedule = applyAbsences(mergeSchedule(schedule, scheduleEdits), effectiveEmployees);

  const updateParams = useCallback(async (params: Department["params"]) => {
    if (!currentDeptId) return;
    await updateDoc(doc(db, "departments", currentDeptId), { params });
    showToast("Parámetros guardados");
  }, [currentDeptId, showToast]);

  // Guarda la facturación diaria de la semana en curso (store-level, no por departamento).
  const saveStoreBilling = useCallback(async (daily: Record<string, number>) => {
    setStoreBilling(daily);
    if (!authUser) return;
    await setDoc(doc(db, "storeBilling", weekIsoId(weekMonday)), { daily });
  }, [weekMonday, authUser]);

  const totalHours = activeEmployees.reduce((s, e) => s + e.weekly_hours, 0);
  const dpw = currentDept?.params?.days_per_week ?? 5;

  // Puerta: tras TODOS los hooks. Cargando / acceso / app.
  if (!authReady) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-3)" }}>
        Cargando…
      </div>
    );
  }
  if (!authUser) return <AccessGate />;

  return (
    <>
      <Sidebar
        departments={departments} employees={employees}
        currentDeptId={currentDeptId} onSelectDept={(id) => setCurrentDeptId(id)}
        view={view} onViewChange={setView}
        collapsed={collapsed} onToggle={toggleSidebar} showToast={showToast}
      />
      <div className="main">
        <div className="top">
          {collapsed && (
            <button className="btn btn-ghost" onClick={toggleSidebar} style={{ padding: "8px 10px" }}>
              <svg className="ico" viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
            </button>
          )}
          <div className="dhead">
            <div className="dchip" style={{ background: currentDept?.color ?? "#999" }}>{currentDept?.name?.[0] ?? "?"}</div>
            <div>
              <h2>{currentDept?.name ?? "..."}</h2>
              <p>{activeEmployees.length} personas &middot; {totalHours} h / semana</p>
            </div>
          </div>
          {/* Selector de semana — SIEMPRE visible (todas las vistas) */}
          <div style={{display:"flex",alignItems:"center",gap:4,background:"var(--paper)",border:"1px solid var(--line)",borderRadius:11,padding:"3px 4px",boxShadow:"var(--shadow)"}}>
            <button onClick={()=>setWeekMonday(shiftWeek(weekMonday,-1))} style={{border:"none",background:"transparent",cursor:"pointer",padding:"5px 8px",borderRadius:8,fontSize:14,color:"var(--ink-2)",fontWeight:700}}>‹</button>
            <span style={{fontFamily:"'Spline Sans Mono'",fontSize:12,fontWeight:600,padding:"0 6px",whiteSpace:"nowrap"}}>{weekLabel(weekMonday)}</span>
            <button onClick={()=>setWeekMonday(shiftWeek(weekMonday,1))} style={{border:"none",background:"transparent",cursor:"pointer",padding:"5px 8px",borderRadius:8,fontSize:14,color:"var(--ink-2)",fontWeight:700}}>›</button>
          </div>
          <div className="spacer" />
          {view === "grid" && effectiveSchedule && currentDept && (
            <button className="btn btn-ghost" onClick={() => exportCegidXlsx(currentDept.name, activeEmployees, effectiveSchedule, weekMonday, dpw, scheduleEdits)}>
              <svg className="ico" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" /></svg> Exportar Cegid
            </button>
          )}
          {view === "grid" && schedule && weekDocId && (
            <button className="btn btn-ghost" style={{ color: "var(--bad)" }} onClick={async () => {
              if (!confirm(`¿Reiniciar el cuadrante de ${currentDept?.name} · Semana ${fiscalWeekNumber(weekMonday)}?\nSe borrará lo generado y los ajustes manuales.`)) return;
              await deleteDoc(doc(db, "schedules", weekDocId));
              await deleteDoc(doc(db, "scheduleEdits", weekDocId));
              setSchedule(null);
              setScheduleEdits({});
              showToast("Cuadrante reiniciado");
            }}>Reiniciar</button>
          )}
          {view === "grid" && (
            <button className="btn btn-go" onClick={() => generateRef.current?.()}>
              <svg className="ico" viewBox="0 0 24 24"><path d="M5 12l3 3 5-7M13 5l2 2M19 4l-1.5 3.5L14 9l3.5 1.5L19 14l1.5-3.5L24 9" /></svg> Generar
            </button>
          )}
        </div>

        <div className="viewtabs">
          {(["grid", "team", "params", "billing"] as const).map((v) => (
            <div key={v} className={`vtab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
              {v === "grid" && <svg className="ico" viewBox="0 0 24 24" style={{width:15,height:15}}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/></svg>}
              {v === "team" && <svg className="ico" viewBox="0 0 24 24" style={{width:15,height:15}}><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8"/></svg>}
              {v === "params" && <svg className="ico" viewBox="0 0 24 24" style={{width:15,height:15}}><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 2v3M12 19v3M5 12H2M22 12h-3"/></svg>}
              {v === "billing" && <svg className="ico" viewBox="0 0 24 24" style={{width:15,height:15}}><path d="M12 2v20M17 6a4 4 0 0 0-4-2H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-3a4 4 0 0 1-4-2"/></svg>}
              {" "}{v === "grid" ? "Cuadrícula" : v === "team" ? "Equipo" : v === "params" ? "Parámetros" : "Facturación"}
            </div>
          ))}
        </div>

        <div className="scroll">
          {view === "grid" && currentDept && (
            <GridView
              department={currentDept} employees={activeEmployees}
              allEmployees={effectiveEmployees} weekOverrides={weekOverrides}
              schedule={schedule} onSchedule={setSchedule}
              scheduleEdits={scheduleEdits} onScheduleEditsChange={setScheduleEdits}
              showToast={showToast} generateRef={generateRef}
              weekMonday={weekMonday} storeBilling={storeBilling}
            />
          )}
          {view === "team" && currentDept && (
            <TeamView
              department={currentDept} employees={employees}
              departments={departments} showToast={showToast}
              weekMonday={weekMonday} weekOverrides={weekOverrides}
              onOverridesChange={setWeekOverrides}
            />
          )}
          {view === "params" && currentDept && (
            <ParamsView department={currentDept} onUpdateParams={updateParams} />
          )}
          {view === "billing" && (
            <BillingView departments={departments} weekMonday={weekMonday} showToast={showToast}
              storeBilling={storeBilling} onSaveStoreBilling={saveStoreBilling} />
          )}
        </div>
      </div>

      <div className={`toast ${toast ? "show" : ""}`}>
        <span className="dotok" />
        <span dangerouslySetInnerHTML={{ __html: toast ?? "" }} />
      </div>
    </>
  );
}

// Pantalla de acceso: una sola contraseña; el email es fijo (todos los managers comparten cuenta).
function AccessGate() {
  const [pwd, setPwd] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, ACCESS_EMAIL, pwd);
    } catch {
      setError("Contraseña incorrecta");
    } finally {
      setBusy(false);
    }
  }, [pwd, busy]);

  return (
    <div className="ag-screen">
      <style>{`
        .ag-screen{position:fixed;inset:0;z-index:50;overflow:auto;display:flex;align-items:center;justify-content:center;padding:24px;
          background:linear-gradient(150deg,#5e0030 0%,#a50044 40%,#1c1740 80%,#001a44 100%)}
        .ag-screen::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.06;
          background:repeating-linear-gradient(115deg,#fff 0 2px,transparent 2px 26px)}
        .ag-card{position:relative;background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.28);
          padding:36px 32px;width:min(92vw,380px)}
        .ag-wordmark{display:flex;align-items:center;gap:11px}
        .ag-bars{display:flex;gap:3px}
        .ag-bars span{width:5px;height:22px;border-radius:2px}
        .ag-title{font-family:'Archivo',sans-serif;font-weight:800;font-size:22px;color:var(--garnet);letter-spacing:-.01em;margin:0}
        .ag-sub{font-family:'Hanken Grotesk',sans-serif;font-size:12.5px;color:#8a8a93;margin:6px 0 26px}
        .ag-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#9a9aa2;margin-bottom:7px}
        .ag-input{width:100%;height:46px;border:1.5px solid var(--line);border-radius:11px;padding:0 14px;font-size:16px;
          letter-spacing:.18em;background:#fbfbfc;outline:none;box-sizing:border-box;transition:border-color .15s,box-shadow .15s,background .15s}
        .ag-input:focus{border-color:var(--garnet);box-shadow:0 0 0 3px rgba(165,0,68,.12);background:#fff}
        .ag-error{color:var(--bad);font-size:12.5px;margin:8px 0 0}
        .ag-btn{width:100%;height:46px;margin-top:18px;border:none;border-radius:11px;background:var(--garnet);color:#fff;
          font-family:'Archivo',sans-serif;font-weight:700;font-size:15px;cursor:pointer;transition:background .15s}
        .ag-btn:hover{background:#8a0039}
        .ag-btn:active{transform:translateY(1px)}
        .ag-btn:disabled{opacity:.7;cursor:default}
        .ag-foot{position:relative;text-align:center;color:rgba(255,255,255,.7);font-size:11px;margin-top:22px}
      `}</style>
      <div>
        <div className="ag-card">
          <div className="ag-wordmark">
            <div className="ag-bars">
              <span style={{ background: "#a50044" }} />
              <span style={{ background: "#004d98" }} />
            </div>
            <h1 className="ag-title">Camp Nou Planner</h1>
          </div>
          <p className="ag-sub">Planificador de cuadrantes</p>
          <label className="ag-label" htmlFor="ag-pwd">Contraseña</label>
          <input
            id="ag-pwd"
            className="ag-input"
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            autoFocus
          />
          {error && <p className="ag-error">{error}</p>}
          <button className="ag-btn" onClick={submit} disabled={busy}>
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </div>
        <p className="ag-foot">Acceso restringido · FC Barcelona Store</p>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { db } from "@/lib/firebase";
import {
  collection, onSnapshot, query, where, doc, updateDoc, getDoc,
} from "firebase/firestore";
import type { Department, Employee, SolveResult } from "@/lib/types";
import { DAYS_KEYS, DAY_LABELS } from "@/lib/types";
import { getMonday, fmtDate, weekIsoId } from "@/lib/week";
import Sidebar from "@/components/Sidebar";
import TeamView from "@/components/TeamView";
import ParamsView from "@/components/ParamsView";
import GridView from "@/components/GridView";
import BillingView from "@/components/BillingView";

export type ViewId = "grid" | "team" | "params" | "billing";

export interface WeekOverride {
  weekly_hours?: number;
  availability?: "M" | "T" | "F";
  fixed?: Record<string, string> | null;
  active?: boolean;
}

function exportCegidCSV(schedule: SolveResult, employees: Employee[], dpw: number) {
  const rows = ["Nombre;DNI;Día;Entrada;Salida;Horas;HorasCompl;Código"];
  for (const emp of employees) {
    const hpd = emp.weekly_hours / dpw;
    const empSched = schedule.schedule?.[emp.id];
    if (!empSched) continue;
    for (const d of DAYS_KEYS) {
      const entry = empSched[d];
      if (!entry) continue;
      const code = entry.code === "normal" ? "NOR" : entry.code === "off" ? "OFF" : entry.code.toUpperCase();
      const compl = entry.code === "normal" && entry.hours ? Math.max(0, entry.hours - hpd) : 0;
      rows.push(
        `${emp.name};${emp.dni};${DAY_LABELS[d]};${entry.start ?? ""};${entry.end ?? ""};${entry.hours ?? 0};${compl};${code}`
      );
    }
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cegid_export_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

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
  const generateRef = useRef<(() => void) | null>(null);

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
    const unsub = onSnapshot(collection(db, "departments"), (snap) => {
      const depts = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Department[];
      depts.sort((a, b) => a.name.localeCompare(b.name));
      setDepartments(depts);
      if (!currentDeptId && depts.length > 0) setCurrentDeptId(depts[0].id);
    });
    return unsub;
  }, [currentDeptId]);

  // Load employees
  useEffect(() => {
    if (!currentDeptId) return;
    const q = query(collection(db, "employees"), where("department", "==", currentDeptId));
    const unsub = onSnapshot(q, (snap) => {
      const emps = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Employee[];
      emps.sort((a, b) => a.name.localeCompare(b.name));
      setEmployees(emps);
    });
    return unsub;
  }, [currentDeptId]);

  // Load saved schedule + overrides when dept or week changes
  const weekDocId = currentDeptId ? `${currentDeptId}_${weekIsoId(weekMonday)}` : null;
  useEffect(() => {
    setSchedule(null); // blank until loaded
    setWeekOverrides({});
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
  }, [weekDocId]);

  // Compute effective employees (base + week overrides)
  const effectiveEmployees = employees.map((emp) => {
    const ov = weekOverrides[emp.id];
    if (!ov) return emp;
    return {
      ...emp,
      ...(ov.weekly_hours !== undefined ? { weekly_hours: ov.weekly_hours } : {}),
      ...(ov.availability !== undefined ? { availability: ov.availability } : {}),
      ...(ov.fixed !== undefined ? { fixed: ov.fixed } : {}),
    };
  });
  const activeEmployees = effectiveEmployees.filter((emp) => {
    const ov = weekOverrides[emp.id];
    return ov?.active !== false;
  });

  const updateParams = useCallback(async (params: Department["params"]) => {
    if (!currentDeptId) return;
    await updateDoc(doc(db, "departments", currentDeptId), { params });
    showToast("Parámetros guardados");
  }, [currentDeptId, showToast]);

  const totalHours = activeEmployees.reduce((s, e) => s + e.weekly_hours, 0);
  const dpw = currentDept?.params?.days_per_week ?? 5;

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
          <div className="spacer" />
          {view === "grid" && schedule && (
            <button className="btn btn-ghost" onClick={() => exportCegidCSV(schedule, activeEmployees, dpw)}>
              <svg className="ico" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" /></svg> Exportar Cegid
            </button>
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
              showToast={showToast} generateRef={generateRef}
              weekMonday={weekMonday} onWeekChange={setWeekMonday}
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
            <BillingView departments={departments} weekMonday={weekMonday} showToast={showToast} />
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

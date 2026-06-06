"use client";

import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/firebase";
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  updateDoc,
} from "firebase/firestore";
import type { Department, Employee, SolveResult } from "@/lib/types";
import Sidebar from "@/components/Sidebar";
import TeamView from "@/components/TeamView";
import ParamsView from "@/components/ParamsView";
import GridView from "@/components/GridView";

export type ViewId = "grid" | "team" | "params";

export default function Home() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [currentDeptId, setCurrentDeptId] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [view, setView] = useState<ViewId>("grid");
  const [schedule, setSchedule] = useState<SolveResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const currentDept = departments.find((d) => d.id === currentDeptId) ?? null;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3400);
  }, []);

  // Load departments
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "departments"), (snap) => {
      const depts = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Department[];
      depts.sort((a, b) => a.name.localeCompare(b.name));
      setDepartments(depts);
      if (!currentDeptId && depts.length > 0) {
        setCurrentDeptId(depts[0].id);
      }
    });
    return unsub;
  }, [currentDeptId]);

  // Load employees for current department
  useEffect(() => {
    if (!currentDeptId) return;
    const q = query(
      collection(db, "employees"),
      where("department", "==", currentDeptId)
    );
    const unsub = onSnapshot(q, (snap) => {
      const emps = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Employee[];
      emps.sort((a, b) => a.name.localeCompare(b.name));
      setEmployees(emps);
    });
    return unsub;
  }, [currentDeptId]);

  // Clear schedule when department changes
  useEffect(() => {
    setSchedule(null);
  }, [currentDeptId]);

  const updateParams = useCallback(
    async (params: Department["params"]) => {
      if (!currentDeptId) return;
      await updateDoc(doc(db, "departments", currentDeptId), { params });
      showToast("Parámetros guardados");
    },
    [currentDeptId, showToast]
  );

  const totalHours = employees.reduce((s, e) => s + e.weekly_hours, 0);

  return (
    <>
      <Sidebar
        departments={departments}
        employees={employees}
        currentDeptId={currentDeptId}
        onSelectDept={(id) => setCurrentDeptId(id)}
        view={view}
        onViewChange={setView}
      />
      <div className="main">
        {/* TOP BAR */}
        <div className="top">
          <div className="dhead">
            <div
              className="dchip"
              style={{ background: currentDept?.color ?? "#999" }}
            >
              {currentDept?.name?.[0] ?? "?"}
            </div>
            <div>
              <h2>{currentDept?.name ?? "..."}</h2>
              <p>
                {employees.length} personas &middot; {totalHours} h / semana
              </p>
            </div>
          </div>
          <div className="spacer" />
          {view === "grid" && (
            <button
              className="btn btn-go"
              onClick={() =>
                (
                  document.querySelector("[data-generate]") as HTMLButtonElement
                )?.click()
              }
            >
              <svg className="ico" viewBox="0 0 24 24">
                <path d="M5 12l3 3 5-7M13 5l2 2M19 4l-1.5 3.5L14 9l3.5 1.5L19 14l1.5-3.5L24 9" />
              </svg>{" "}
              Generar
            </button>
          )}
        </div>

        {/* VIEW TABS */}
        <div className="viewtabs">
          <div
            className={`vtab ${view === "grid" ? "active" : ""}`}
            onClick={() => setView("grid")}
          >
            <svg
              className="ico"
              viewBox="0 0 24 24"
              style={{ width: 15, height: 15 }}
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18M8 4v16" />
            </svg>{" "}
            Cuadrícula
          </div>
          <div
            className={`vtab ${view === "team" ? "active" : ""}`}
            onClick={() => setView("team")}
          >
            <svg
              className="ico"
              viewBox="0 0 24 24"
              style={{ width: 15, height: 15 }}
            >
              <circle cx="9" cy="8" r="3.2" />
              <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8" />
            </svg>{" "}
            Equipo
          </div>
          <div
            className={`vtab ${view === "params" ? "active" : ""}`}
            onClick={() => setView("params")}
          >
            <svg
              className="ico"
              viewBox="0 0 24 24"
              style={{ width: 15, height: 15 }}
            >
              <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 2v3M12 19v3M5 12H2M22 12h-3" />
            </svg>{" "}
            Parámetros
          </div>
        </div>

        {/* SCROLL CONTENT */}
        <div className="scroll">
          {view === "grid" && currentDept && (
            <GridView
              department={currentDept}
              employees={employees}
              schedule={schedule}
              onSchedule={setSchedule}
              showToast={showToast}
            />
          )}
          {view === "team" && currentDept && (
            <TeamView
              department={currentDept}
              employees={employees}
              departments={departments}
              showToast={showToast}
            />
          )}
          {view === "params" && currentDept && (
            <ParamsView
              department={currentDept}
              onUpdateParams={updateParams}
            />
          )}
        </div>
      </div>

      {/* TOAST */}
      <div className={`toast ${toast ? "show" : ""}`}>
        <span className="dotok" />
        <span dangerouslySetInnerHTML={{ __html: toast ?? "" }} />
      </div>
    </>
  );
}

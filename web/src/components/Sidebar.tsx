"use client";

import { useState, useRef, useEffect } from "react";
import { db, auth } from "@/lib/firebase";
import { signOut } from "firebase/auth";
import { doc, setDoc, deleteDoc, collection, query, where, getDocs, updateDoc } from "firebase/firestore";
import type { Department, Employee } from "@/lib/types";
import type { ViewId } from "@/app/page";

interface Props {
  departments: Department[];
  employees: Employee[];
  currentDeptId: string | null;
  onSelectDept: (id: string) => void;
  view: ViewId;
  onViewChange: (v: ViewId) => void;
  collapsed: boolean;
  onToggle: () => void;
  showToast: (msg: string) => void;
}

const DEPT_COLORS = [
  "#a50044", "#004d98", "#e0a100", "#1d9e75", "#7a4dd0", "#5f6470",
  "#d44c2e", "#2e86ab", "#a23b72", "#3c896d", "#e8871e", "#5c5470",
];

const DEFAULT_PARAMS = {
  grid_default_start: "07:00",
  days_per_week: 5,
  preopen: { minutes: 30, min: 2, max: 3 },
  postclose: { minutes: 30, min: 2, max: 3 },
  store_hours: {
    MON: { open: "08:00", close: "21:00" }, TUE: { open: "08:00", close: "21:00" },
    WED: { open: "08:00", close: "21:00" }, THU: { open: "08:00", close: "21:00" },
    FRI: { open: "08:00", close: "21:00" }, SAT: { open: "08:00", close: "21:00" },
    SUN: { open: "09:00", close: "21:00" },
  },
  billing: {
    daily: { MON: 9000, TUE: 9500, WED: 10000, THU: 10000, FRI: 13000, SAT: 16000, SUN: 10000 },
    productivity_eur_per_person_hour: 420,
    profiles: {
      normal: {"8":3,"9":5,"10":11,"11":13,"12":12,"13":9,"14":7,"15":7,"16":9,"17":11,"18":11,"19":9,"20":5,"21":3},
      match: {"8":2,"9":3,"10":6,"11":7,"12":7,"13":6,"14":6,"15":7,"16":8,"17":9,"18":9,"19":10,"20":11,"21":14,"22":14,"23":9},
    },
  },
};

interface DeptModal { open: boolean; mode: "add" | "edit"; deptId: string; name: string; color: string; }

export default function Sidebar({
  departments, employees, currentDeptId, onSelectDept,
  view, onViewChange, collapsed, onToggle, showToast,
}: Props) {
  const [modal, setModal] = useState<DeptModal>({ open: false, mode: "add", deptId: "", name: "", color: DEPT_COLORS[0] });
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(null);
    }
    if (menuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  function openAdd() {
    const usedColors = departments.map(d => d.color);
    const nextColor = DEPT_COLORS.find(c => !usedColors.includes(c)) ?? DEPT_COLORS[0];
    setModal({ open: true, mode: "add", deptId: "", name: "", color: nextColor });
  }

  function openEdit(dept: Department) {
    setMenuOpen(null);
    setModal({ open: true, mode: "edit", deptId: dept.id, name: dept.name, color: dept.color });
  }

  async function saveDept() {
    if (!modal.name.trim()) return;
    if (modal.mode === "add") {
      const id = modal.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      await setDoc(doc(db, "departments", id), { name: modal.name.trim(), color: modal.color, params: DEFAULT_PARAMS });
      onSelectDept(id);
      showToast(`Departamento <b>${modal.name}</b> creado`);
    } else {
      await updateDoc(doc(db, "departments", modal.deptId), { name: modal.name.trim(), color: modal.color });
      showToast("Departamento actualizado");
    }
    setModal(m => ({ ...m, open: false }));
  }

  async function handleDelete(dept: Department) {
    setMenuOpen(null);
    // Check employees
    const empQ = query(collection(db, "employees"), where("department", "==", dept.id));
    const empSnap = await getDocs(empQ);
    if (empSnap.size > 0) {
      alert(`No se puede eliminar "${dept.name}": tiene ${empSnap.size} empleado(s) asignados.\nReasígnalos a otro departamento antes de eliminar.`);
      return;
    }
    if (!confirm(`¿Eliminar "${dept.name}"?\n\nSe borrará su configuración y sus cuadrantes guardados.\nNo se puede deshacer.`)) return;
    // Delete associated data
    try {
      // Delete schedules/{dept}_*
      const schedQ = query(collection(db, "schedules"), where("department", "==", dept.id));
      const schedSnap = await getDocs(schedQ);
      for (const d of schedSnap.docs) await deleteDoc(d.ref);
    } catch { /* schedules may not have the field indexed */ }
    // Delete department
    await deleteDoc(doc(db, "departments", dept.id));
    if (currentDeptId === dept.id) {
      const other = departments.find(d => d.id !== dept.id);
      if (other) onSelectDept(other.id);
    }
    showToast(`Departamento "${dept.name}" eliminado`);
  }

  if (collapsed) return null;

  return (
    <aside className="side">
      <div className="brand">
        <div className="crest"><span>FC</span></div>
        <div><h1>Camp Nou Planner</h1><p>Botiga oficial</p></div>
        <button onClick={onToggle} style={{
          marginLeft: "auto", background: "transparent", border: "none", cursor: "pointer",
          color: "#8fa0c4", padding: 4, borderRadius: 6, position: "relative", zIndex: 1,
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      <div className="slabel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Departamentos
        <button onClick={openAdd} style={{
          background: "rgba(255,255,255,.08)", border: "none", color: "#8fa0c4",
          borderRadius: 6, width: 20, height: 20, display: "grid", placeItems: "center",
          cursor: "pointer", fontSize: 14, fontWeight: 700,
        }}>+</button>
      </div>
      <div className="depts" ref={menuRef}>
        {departments.map((d) => (
          <div key={d.id} className={`dept ${d.id === currentDeptId ? "active" : ""}`}
            onClick={() => { onSelectDept(d.id); setMenuOpen(null); }}
            style={{ position: "relative" }}>
            <span className="dot" style={{ background: d.color }} />
            {d.name}
            <span className="ct">{d.id === currentDeptId ? employees.length : ""}</span>
            {/* Kebab menu */}
            <button className="dept-kebab" onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === d.id ? null : d.id); }}
              style={{
                position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", color: "#7f90b6",
                fontSize: 14, padding: "2px 4px", borderRadius: 4, letterSpacing: 1,
                opacity: menuOpen === d.id ? 1 : undefined,
              }}>⋯</button>
            {/* Dropdown */}
            {menuOpen === d.id && (
              <div style={{
                position: "absolute", right: 4, top: "100%", zIndex: 30,
                background: "#1a2a4e", border: "1px solid rgba(255,255,255,.12)",
                borderRadius: 8, padding: 4, minWidth: 140, boxShadow: "0 8px 24px rgba(0,0,0,.4)",
              }}>
                <button style={menuItemStyle} onClick={(e) => { e.stopPropagation(); openEdit(d); }}>Renombrar / color</button>
                <button style={{ ...menuItemStyle, color: "#f06070" }} onClick={(e) => { e.stopPropagation(); handleDelete(d); }}>Eliminar</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <nav className="nav">
        {([
          ["grid", "Cuadrícula", <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/></>],
          ["team", "Equipo", <><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M20.5 19a4.8 4.8 0 0 0-3.4-4.6"/></>],
          ["params", "Parámetros", <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2-1.2l-.4-2.5h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"/></>],
          ["billing", "Facturación", <><path d="M12 2v20M17 6a4 4 0 0 0-4-2H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-3a4 4 0 0 1-4-2"/></>],
        ] as [ViewId, string, React.ReactNode][]).map(([id, label, paths]) => (
          <a key={id} className={view === id ? "on" : ""} onClick={() => onViewChange(id)}>
            <svg className="ico" viewBox="0 0 24 24">{paths}</svg> {label}
          </a>
        ))}
      </nav>

      {/* Cerrar sesión (Firebase Auth). El gate de page.tsx vuelve a mostrar el login al instante. */}
      <button onClick={() => signOut(auth)} style={{
        marginTop: "auto", display: "flex", alignItems: "center", gap: 9,
        background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)",
        color: "#cfd8ec", borderRadius: 9, padding: "9px 12px", cursor: "pointer",
        fontFamily: "inherit", fontSize: 12.5, fontWeight: 600,
        position: "relative", zIndex: 1,
      }}>
        <svg className="ico" viewBox="0 0 24 24" style={{ width: 15, height: 15 }}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
        </svg>
        Cerrar sesión
      </button>

      {/* DEPARTMENT MODAL (create/edit) */}
      {modal.open && (
        <div className="modal-overlay" onClick={() => setModal(m => ({...m, open: false}))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{modal.mode === "add" ? "Nuevo departamento" : "Editar departamento"}</h3>
              <button className="editbtn" onClick={() => setModal(m => ({...m, open: false}))} style={{background:"transparent"}}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label>Nombre</label>
                <input className="form-input" value={modal.name} onChange={e => setModal(m => ({...m, name: e.target.value}))} placeholder="Nombre del departamento" />
              </div>
              <div className="form-field">
                <label>Color</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {DEPT_COLORS.map(c => (
                    <div key={c} onClick={() => setModal(m => ({...m, color: c}))} style={{
                      width: 28, height: 28, borderRadius: 8, background: c, cursor: "pointer",
                      border: modal.color === c ? "3px solid #fff" : "3px solid transparent",
                      boxShadow: modal.color === c ? "0 0 0 2px var(--garnet)" : "none",
                    }} />
                  ))}
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <div className="spacer" />
              <button className="btn btn-ghost" onClick={() => setModal(m => ({...m, open: false}))}>Cancelar</button>
              <button className="btn btn-go" onClick={saveDept}>{modal.mode === "add" ? "Crear" : "Guardar"}</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left", border: "none",
  background: "transparent", color: "#cfd8ec", fontSize: 12, fontWeight: 500,
  padding: "7px 10px", borderRadius: 6, cursor: "pointer",
  fontFamily: "inherit",
};

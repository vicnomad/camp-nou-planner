"use client";

import { useState, useMemo } from "react";
import { db } from "@/lib/firebase";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
import type { Department, Employee, Absence } from "@/lib/types";
import { DAYS_KEYS, DAY_SHORT, DEFAULT_ABSENCE_TYPES } from "@/lib/types";
import { weekIsoId, isoWeekNumber } from "@/lib/week";
import type { WeekOverride } from "@/app/page";

interface Props {
  department: Department;
  employees: Employee[];
  departments: Department[];
  showToast: (msg: string) => void;
  weekMonday: string;
  weekOverrides: Record<string, WeekOverride>;
  onOverridesChange: (o: Record<string, WeekOverride>) => void;
}

const HOURS_OPTIONS = [8, 12, 16, 20, 25, 30, 35, 40];
const AVAIL_OPTIONS: { value: Employee["availability"]; label: string }[] = [
  { value: "M", label: "Mañana" },
  { value: "T", label: "Tarde" },
  { value: "F", label: "Completa" },
];

function initials(name: string) {
  return name.split(",")[0].slice(0, 2).toUpperCase();
}

function vacDaysCount(absences: Absence[]): number {
  return absences
    .filter((a) => a.type === "vacation")
    .reduce((s, a) => s + (Array.isArray(a.days) ? a.days.length : 0), 0);
}

interface ModalState {
  open: boolean;
  employee: Partial<Employee> | null;
  isNew: boolean;
}

export default function TeamView({
  department, employees, departments, showToast,
  weekMonday, weekOverrides, onOverridesChange,
}: Props) {
  const weekDocId = `${department.id}_${weekIsoId(weekMonday)}`;
  const weekNum = isoWeekNumber(weekMonday);

  async function saveOverride(empId: string, ov: WeekOverride | null) {
    const next = { ...weekOverrides };
    if (ov && Object.keys(ov).length > 0) next[empId] = ov;
    else delete next[empId];
    onOverridesChange(next);
    await setDoc(doc(db, "weekOverrides", weekDocId), next);
  }
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<ModalState>({
    open: false,
    employee: null,
    isNew: false,
  });

  const filtered = useMemo(() => {
    if (!search) return employees;
    const q = search.toLowerCase();
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.dni.toLowerCase().includes(q)
    );
  }, [employees, search]);

  function openNew() {
    setModal({
      open: true,
      isNew: true,
      employee: {
        name: "",
        dni: "",
        department: department.id,
        weekly_hours: 25,
        availability: "F",
        fixed: null,
        absences: [],
      },
    });
  }

  function openEdit(emp: Employee) {
    setModal({ open: true, isNew: false, employee: { ...emp } });
  }

  async function handleSave() {
    const e = modal.employee;
    if (!e || !e.name || !e.dni) return;
    const docId = e.dni!;
    let hoursToWrite = e.weekly_hours ?? 25;
    // Proteger el contrato base GLOBAL: si en un empleado existente cambia weekly_hours,
    // pedir confirmación (afecta a TODAS las semanas). El cambio puntual va por "Solo esta semana".
    if (!modal.isNew) {
      const orig = employees.find((x) => x.dni === e.dni);
      if (orig && hoursToWrite !== orig.weekly_hours) {
        const ok = confirm(
          `Vas a cambiar el contrato base de ${e.name} a ${hoursToWrite}h. ` +
          `Afecta a TODAS las semanas, incluidas las ya hechas.\n\n` +
          `Para un cambio de una sola semana usa "Solo esta semana (S${weekNum})".\n\n¿Continuar?`
        );
        if (!ok) hoursToWrite = orig.weekly_hours; // no se toca la base; el resto sí se guarda
      }
    }
    await setDoc(doc(db, "employees", docId), {
      name: e.name,
      dni: e.dni,
      department: e.department ?? department.id,
      weekly_hours: hoursToWrite,
      availability: e.availability ?? "F",
      fixed: e.fixed ?? null,
      absences: [], // las ausencias son por semana (weekOverrides), no en el doc global
    });
    setModal({ open: false, employee: null, isNew: false });
    showToast(modal.isNew ? "Persona añadida" : "Persona actualizada");
  }

  async function handleDelete() {
    const e = modal.employee;
    if (!e?.dni) return;
    if (!confirm(`¿Eliminar a ${e.name}?`)) return;
    await deleteDoc(doc(db, "employees", e.dni));
    setModal({ open: false, employee: null, isNew: false });
    showToast("Persona eliminada");
  }

  return (
    <>
      <div className="teamtools">
        <div className="search">
          <svg
            className="ico"
            viewBox="0 0 24 24"
            style={{ width: 16, height: 16, stroke: "var(--ink-3)" }}
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            placeholder="Buscar persona..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="spacer" />
        <button className="btn btn-go" onClick={openNew}>
          <svg className="ico" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>{" "}
          Añadir persona
        </button>
      </div>

      <div className="card">
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Persona</th>
                <th>Departamento</th>
                <th>Contrato</th>
                <th>Disponibilidad</th>
                <th>Horario fijo</th>
                <th>Vacaciones</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((emp) => {
                const hpd = emp.weekly_hours / (department.params?.days_per_week ?? 5);
                const vac = vacDaysCount(weekOverrides[emp.id]?.absences ?? []);
                const ov = weekOverrides[emp.id];
                const hasOv = !!ov;
                const isInactive = ov?.active === false;
                return (
                  <tr key={emp.id} style={isInactive ? { opacity: 0.4 } : {}}>
                    <td>
                      <div className="te-name">
                        <div
                          className="avmini"
                          style={{ background: department.color }}
                        >
                          {initials(emp.name)}
                        </div>
                        <div>
                          <b>{emp.name}</b>
                          <br />
                          <span>{emp.dni}</span>
                        </div>
                      </div>
                    </td>
                    <td>{department.name}</td>
                    <td className="basecell">
                      <b>{emp.weekly_hours} h</b>
                      <small>{hpd}h/día</small>
                    </td>
                    <td>
                      <span className={`pill p-${typeof emp.availability === "string" ? emp.availability : "F"}`}>
                        {typeof emp.availability === "string"
                          ? (AVAIL_OPTIONS.find((a) => a.value === emp.availability)?.label ?? emp.availability)
                          : "Por día"}
                      </span>
                    </td>
                    <td>
                      <div className={`tg ${emp.fixed ? "on" : ""}`} />
                    </td>
                    <td>
                      <span className={`vacbadge ${vac ? "" : "none"}`}>
                        {vac ? `${vac} días` : "—"}
                      </span>
                    </td>
                    <td style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      {hasOv && <span style={{ width: 7, height: 7, borderRadius: 4, background: "#d4940a", flexShrink: 0 }} title={`Override S${weekNum}`} />}
                      {hasOv && <button onClick={() => saveOverride(emp.id, null)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 10, color: "var(--ink-3)" }} title="Volver al base">↺</button>}
                      <button className="editbtn" onClick={() => openEdit(emp)}>
                        <svg className="ico" viewBox="0 0 24 24" style={{ width: 15, height: 15 }}><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /></svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "0 18px 16px" }}>
          <button className="addrow" onClick={openNew}>
            <svg
              className="ico"
              viewBox="0 0 24 24"
              style={{ width: 15, height: 15 }}
            >
              <path d="M12 5v14M5 12h14" />
            </svg>{" "}
            Añadir persona al equipo de {department.name}
          </button>
        </div>
      </div>

      {/* MODAL */}
      {modal.open && modal.employee && (
        <EmployeeModal
          employee={modal.employee}
          isNew={modal.isNew}
          departments={departments}
          deptParams={department.params}
          onChange={(e) => setModal((m) => ({ ...m, employee: e }))}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setModal({ open: false, employee: null, isNew: false })}
          weekNum={weekNum}
          weekOverride={modal.employee?.id ? weekOverrides[modal.employee.id] : undefined}
          onSaveOverride={(ov) => { if (modal.employee?.id) saveOverride(modal.employee.id, ov); }}
        />
      )}
    </>
  );
}

/* ---------- Employee Modal ---------- */

function EmployeeModal({
  employee, isNew, departments, deptParams, onChange, onSave, onDelete, onClose,
  weekNum, weekOverride, onSaveOverride,
}: {
  employee: Partial<Employee>; isNew: boolean; departments: Department[];
  deptParams: Department["params"]; onChange: (e: Partial<Employee>) => void;
  onSave: () => void; onDelete: () => void; onClose: () => void;
  weekNum: number; weekOverride?: WeekOverride; onSaveOverride: (ov: WeekOverride | null) => void;
}) {
  const [ov, setOv] = useState<WeekOverride>(weekOverride ?? {});
  const [absenceType, setAbsenceType] = useState("VCN");
  const hasFixed = !!employee.fixed;
  // Las ausencias son POR SEMANA: viven en el override (estado ov), no en el doc global del empleado.
  const absences = ov.absences ?? [];

  // Build a map: day -> absence code
  const dayAbsenceMap: Record<string, string> = {};
  for (const a of absences) {
    if (Array.isArray(a.days)) {
      for (const d of a.days) dayAbsenceMap[d] = a.type;
    }
  }

  function toggleFixed() {
    if (hasFixed) {
      onChange({ ...employee, fixed: null });
    } else {
      onChange({
        ...employee,
        fixed: {
          MON: "10:00",
          TUE: "10:00",
          WED: "10:00",
          THU: "10:00",
          FRI: "10:00",
          SAT: "off",
          SUN: "off",
        },
      });
    }
  }

  function setFixedDay(day: string, val: string) {
    onChange({
      ...employee,
      fixed: { ...(employee.fixed ?? {}), [day]: val },
    });
  }

  function toggleAbsenceDay(day: string) {
    const current = dayAbsenceMap[day];
    const newMap = { ...dayAbsenceMap };
    if (current) {
      delete newMap[day]; // remove absence for this day
    } else {
      newMap[day] = absenceType; // add with selected type
    }
    // Rebuild absences array grouped by type
    const grouped: Record<string, string[]> = {};
    for (const [d, code] of Object.entries(newMap)) {
      if (!grouped[code]) grouped[code] = [];
      grouped[code].push(d);
    }
    const newAbsences: Absence[] = Object.entries(grouped).map(([type, days]) => ({ type, days }));
    // Actualiza y PERSISTE el override de la semana al instante (no en el doc global).
    const next: WeekOverride = { ...ov };
    if (newAbsences.length > 0) next.absences = newAbsences; else delete next.absences;
    (Object.keys(next) as (keyof WeekOverride)[]).forEach((k) => { if (next[k] === undefined) delete next[k]; });
    setOv(next);
    onSaveOverride(Object.keys(next).length > 0 ? next : null);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{isNew ? "Añadir persona" : "Editar persona"}</h3>
          <button
            className="editbtn"
            onClick={onClose}
            style={{ background: "transparent" }}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="form-field">
            <label>Nombre</label>
            <input
              className="form-input"
              value={employee.name ?? ""}
              onChange={(e) =>
                onChange({ ...employee, name: e.target.value })
              }
              placeholder="Apellido, Nombre"
            />
          </div>
          <div className="form-field">
            <label>DNI / NIE</label>
            <input
              className="form-input"
              value={employee.dni ?? ""}
              onChange={(e) =>
                onChange({ ...employee, dni: e.target.value })
              }
              disabled={!isNew}
            />
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            <div className="form-field" style={{ flex: 1 }}>
              <label>Departamento</label>
              <select
                className="sel"
                style={{ width: "100%" }}
                value={employee.department ?? ""}
                onChange={(e) =>
                  onChange({ ...employee, department: e.target.value })
                }
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label>Contrato base (fijo · afecta a TODAS las semanas)</label>
              <select
                className="sel"
                style={{ width: "100%" }}
                value={employee.weekly_hours ?? 25}
                onChange={(e) =>
                  onChange({
                    ...employee,
                    weekly_hours: Number(e.target.value),
                  })
                }
              >
                {HOURS_OPTIONS.map((h) => (
                  <option key={h} value={h}>
                    {h} h ({h / (deptParams?.days_per_week ?? 5)}h/día)
                  </option>
                ))}
              </select>
            </div>
          </div>
          <AvailabilityEditor availability={employee.availability ?? "F"}
            onChange={(av) => onChange({ ...employee, availability: av })} />
          <div className="form-field">
            <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
              Horario fijo
              <div
                className={`tg ${hasFixed ? "on" : ""}`}
                onClick={toggleFixed}
              />
            </label>
            {hasFixed && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7,1fr)",
                  gap: 6,
                  marginTop: 8,
                }}
              >
                {DAYS_KEYS.map((d) => (
                  <div key={d} style={{ textAlign: "center" }}>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: "var(--ink-3)",
                        marginBottom: 4,
                      }}
                    >
                      {DAY_SHORT[d]}
                    </div>
                    <input
                      className="timeinput"
                      style={{ width: "100%" }}
                      value={employee.fixed?.[d] ?? "off"}
                      onChange={(e) => setFixedDay(d, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="form-field">
            <label>Ausencias (días libres esta semana)</label>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {DEFAULT_ABSENCE_TYPES.map((at) => (
                <button key={at.code} onClick={() => setAbsenceType(at.code)} style={{
                  padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 600,
                  border: absenceType === at.code ? "2px solid var(--garnet)" : "1px solid var(--line)",
                  background: absenceType === at.code ? "var(--garnet)" : "var(--canvas)",
                  color: absenceType === at.code ? "#fff" : "var(--ink-2)",
                  cursor: "pointer",
                }}>{at.code}</button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6 }}>
              Selecciona tipo y pulsa los días:
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {DAYS_KEYS.map((d) => {
                const code = dayAbsenceMap[d];
                return (
                  <button key={d} style={{
                    padding: "6px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                    background: code ? "var(--gold)" : "var(--canvas)",
                    color: code ? "#7a5500" : "var(--ink-2)",
                    border: "1px solid var(--line)", cursor: "pointer",
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                  }} onClick={() => toggleAbsenceDay(d)}>
                    {DAY_SHORT[d]}
                    {code && <span style={{ fontSize: 8, fontWeight: 700 }}>{code}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {/* WEEK OVERRIDE section */}
        {!isNew && (
          <div style={{ padding: "0 22px 14px", borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
              Esta semana · Semana {weekNum}
              {Object.keys(ov).length > 0 && <span style={{ width: 7, height: 7, borderRadius: 4, background: "#d4940a" }} />}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
              <div className="form-field" style={{ flex: 1, minWidth: 160, marginBottom: 8 }}>
                <label>Solo esta semana (S{weekNum})</label>
                <input className="form-input" type="number" placeholder={String(employee.weekly_hours ?? 25)}
                  value={ov.weekly_hours ?? ""} onChange={e => setOv({ ...ov, weekly_hours: e.target.value ? +e.target.value : undefined })} />
                <span style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 2, display: "block" }}>Cambio puntual; no afecta a otras semanas</span>
              </div>
              <div className="form-field" style={{ flex: 1, minWidth: 120, marginBottom: 8 }}>
                <label>Disponibilidad</label>
                <select className="sel" style={{ width: "100%" }} value={ov.availability ?? ""}
                  onChange={e => setOv({ ...ov, availability: (e.target.value || undefined) as WeekOverride["availability"] })}>
                  <option value="">= Base ({typeof employee.availability === "string" ? employee.availability : "por día"})</option>
                  <option value="M">Mañana</option><option value="T">Tarde</option><option value="F">Completa</option>
                </select>
              </div>
              <div className="form-field" style={{ flex: 1, minWidth: 120, marginBottom: 8 }}>
                <label>Activo esta semana</label>
                <div className={`tg ${ov.active !== false ? "on" : ""}`} onClick={() => setOv({ ...ov, active: ov.active === false ? undefined : false })} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { onSaveOverride(Object.keys(ov).length > 0 ? ov : null); }}>
                Guardar override S{weekNum}
              </button>
              {Object.keys(ov).length > 0 && (
                <button style={{ border: "none", background: "none", cursor: "pointer", fontSize: 11, color: "var(--ink-3)" }}
                  onClick={() => { setOv({}); onSaveOverride(null); }}>↺ Volver al base</button>
              )}
            </div>
          </div>
        )}

        <div className="modal-foot">
          {!isNew && (
            <button className="btn-danger" onClick={onDelete}>
              Eliminar
            </button>
          )}
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-go" onClick={onSave}>
            {isNew ? "Añadir" : "Guardar base"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Availability Editor (simple + per-day) ---------- */
const AV_OPTS = [
  { v: "M", l: "Mañana", c: "#fde6c7" },
  { v: "T", l: "Tarde", c: "#dbe7fb" },
  { v: "F", l: "Completa", c: "#d8f1e7" },
  { v: "X", l: "—", c: "#f0f0f0" },
] as const;
const DAY_KEYS_LO = ["mon","tue","wed","thu","fri","sat","sun"] as const;
const DAY_LABELS_SHORT = ["L","M","X","J","V","S","D"];

function AvailabilityEditor({ availability, onChange }: {
  availability: Employee["availability"];
  onChange: (av: Employee["availability"]) => void;
}) {
  const isPerDay = typeof availability === "object";
  const simpleVal = isPerDay ? "F" : (availability as string);
  const [expanded, setExpanded] = useState(isPerDay);

  const perDay: Record<string, string> = isPerDay
    ? (availability as Record<string, string>)
    : Object.fromEntries(DAY_KEYS_LO.map(d => [d, simpleVal]));

  function setSimple(v: string) {
    onChange(v as Employee["availability"]);
    setExpanded(false);
  }

  function setDay(day: string, v: string) {
    const next = { ...perDay, [day]: v };
    // If all the same, collapse to simple
    const vals = new Set(Object.values(next));
    if (vals.size === 1 && !vals.has("X")) {
      onChange([...vals][0] as Employee["availability"]);
    } else {
      onChange(next as unknown as Employee["availability"]);
    }
  }

  return (
    <div className="form-field">
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        Disponibilidad
        {isPerDay && <span style={{ width: 6, height: 6, borderRadius: 3, background: "#d4940a" }} title="Modo por día" />}
      </label>
      {!expanded && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select className="sel" style={{ width: "100%" }} value={simpleVal}
            onChange={e => setSimple(e.target.value)}>
            {AV_OPTS.filter(a => a.v !== "X").map(a => (
              <option key={a.v} value={a.v}>{a.l}</option>
            ))}
          </select>
        </div>
      )}
      <button onClick={() => setExpanded(!expanded)} style={{
        border: "none", background: "none", cursor: "pointer", fontSize: 11,
        color: "var(--blau-bright)", fontWeight: 500, padding: "4px 0", marginTop: 2,
      }}>{expanded ? "▾ Simplificar" : "▸ Disponibilidad por día"}</button>
      {expanded && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginTop: 4 }}>
          {DAY_KEYS_LO.map((dk, i) => {
            const val = perDay[dk] ?? "F";
            const opt = AV_OPTS.find(a => a.v === val);
            return (
              <div key={dk} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", marginBottom: 3 }}>{DAY_LABELS_SHORT[i]}</div>
                <select className="sel" style={{ width: "100%", fontSize: 11, padding: "3px 4px", background: opt?.c ?? "#fff" }}
                  value={val} onChange={e => setDay(dk, e.target.value)}>
                  {AV_OPTS.map(a => <option key={a.v} value={a.v}>{a.v === "X" ? "—" : a.v}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

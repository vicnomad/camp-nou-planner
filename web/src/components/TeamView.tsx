"use client";

import { useState, useMemo } from "react";
import { db } from "@/lib/firebase";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
import type { Department, Employee, Absence } from "@/lib/types";
import { DAYS_KEYS, DAY_SHORT } from "@/lib/types";

interface Props {
  department: Department;
  employees: Employee[];
  departments: Department[];
  showToast: (msg: string) => void;
}

const HOURS_OPTIONS = [20, 25, 35, 40];
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
  department,
  employees,
  departments,
  showToast,
}: Props) {
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
    await setDoc(doc(db, "employees", docId), {
      name: e.name,
      dni: e.dni,
      department: e.department ?? department.id,
      weekly_hours: e.weekly_hours ?? 25,
      availability: e.availability ?? "F",
      fixed: e.fixed ?? null,
      absences: e.absences ?? [],
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
                const vac = vacDaysCount(emp.absences ?? []);
                return (
                  <tr key={emp.id}>
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
                      <span className={`pill p-${emp.availability}`}>
                        {AVAIL_OPTIONS.find((a) => a.value === emp.availability)
                          ?.label ?? emp.availability}
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
                    <td>
                      <button
                        className="editbtn"
                        onClick={() => openEdit(emp)}
                      >
                        <svg
                          className="ico"
                          viewBox="0 0 24 24"
                          style={{ width: 15, height: 15 }}
                        >
                          <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
                        </svg>
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
          onClose={() =>
            setModal({ open: false, employee: null, isNew: false })
          }
        />
      )}
    </>
  );
}

/* ---------- Employee Modal ---------- */

function EmployeeModal({
  employee,
  isNew,
  departments,
  deptParams,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  employee: Partial<Employee>;
  isNew: boolean;
  departments: Department[];
  deptParams: Department["params"];
  onChange: (e: Partial<Employee>) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const hasFixed = !!employee.fixed;
  const vacDays = (employee.absences ?? [])
    .filter((a) => a.type === "vacation")
    .flatMap((a) => (Array.isArray(a.days) ? a.days : []));

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

  function toggleVacDay(day: string) {
    const newDays = vacDays.includes(day)
      ? vacDays.filter((d) => d !== day)
      : [...vacDays, day];
    const absences: Absence[] =
      newDays.length > 0
        ? [{ type: "vacation", days: newDays }]
        : [];
    onChange({ ...employee, absences });
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
              <label>Contrato (h/semana)</label>
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
          <div className="form-field">
            <label>Disponibilidad</label>
            <select
              className="sel"
              style={{ width: "100%" }}
              value={employee.availability ?? "F"}
              onChange={(e) =>
                onChange({
                  ...employee,
                  availability: e.target.value as Employee["availability"],
                })
              }
            >
              {AVAIL_OPTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
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
            <label>Vacaciones (días libres esta semana)</label>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {DAYS_KEYS.map((d) => (
                <button
                  key={d}
                  className="day"
                  style={{
                    background: vacDays.includes(d)
                      ? "var(--gold)"
                      : "var(--canvas)",
                    color: vacDays.includes(d) ? "#7a5500" : "var(--ink-2)",
                    padding: "6px 10px",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                  onClick={() => toggleVacDay(d)}
                >
                  {DAY_SHORT[d]}
                </button>
              ))}
            </div>
          </div>
        </div>
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
            {isNew ? "Añadir" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

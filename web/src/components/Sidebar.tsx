"use client";

import type { Department, Employee } from "@/lib/types";
import type { ViewId } from "@/app/page";

interface Props {
  departments: Department[];
  employees: Employee[];
  currentDeptId: string | null;
  onSelectDept: (id: string) => void;
  view: ViewId;
  onViewChange: (v: ViewId) => void;
}

/* Count employees per department from the full list by querying Firestore is
   already done in the parent; here we just display department list with counts
   that come from the department doc or we count locally from employees. Since
   employees are only loaded for the current dept, we store the count in the
   department doc instead. For now we show "--" for non-current departments. */

export default function Sidebar({
  departments,
  employees,
  currentDeptId,
  onSelectDept,
  view,
  onViewChange,
}: Props) {
  const empCountForCurrent = employees.length;

  return (
    <aside className="side">
      <div className="brand">
        <div className="crest">
          <span>FC</span>
        </div>
        <div>
          <h1>Camp Nou Planner</h1>
          <p>Botiga oficial</p>
        </div>
      </div>

      <div className="slabel">Departamentos</div>
      <div className="depts">
        {departments.map((d) => (
          <div
            key={d.id}
            className={`dept ${d.id === currentDeptId ? "active" : ""}`}
            onClick={() => onSelectDept(d.id)}
          >
            <span className="dot" style={{ background: d.color }} />
            {d.name}
            <span className="ct">
              {d.id === currentDeptId ? empCountForCurrent : ""}
            </span>
          </div>
        ))}
      </div>

      <nav className="nav">
        <a
          className={view === "grid" ? "on" : ""}
          onClick={() => onViewChange("grid")}
        >
          <svg className="ico" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M8 4v16" />
          </svg>{" "}
          Cuadrícula
        </a>
        <a
          className={view === "team" ? "on" : ""}
          onClick={() => onViewChange("team")}
        >
          <svg className="ico" viewBox="0 0 24 24">
            <circle cx="9" cy="8" r="3.2" />
            <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M20.5 19a4.8 4.8 0 0 0-3.4-4.6" />
          </svg>{" "}
          Equipo
        </a>
        <a
          className={view === "params" ? "on" : ""}
          onClick={() => onViewChange("params")}
        >
          <svg className="ico" viewBox="0 0 24 24">
            <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
            <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2-1.2l-.4-2.5h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" />
          </svg>{" "}
          Parámetros
        </a>
      </nav>
    </aside>
  );
}

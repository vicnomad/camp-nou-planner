"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { db } from "@/lib/firebase";
import { doc, updateDoc, getDoc } from "firebase/firestore";
import type { Department, SolveResult } from "@/lib/types";
import { DAYS_KEYS, DAY_LABELS, DAY_SHORT } from "@/lib/types";
import { weekIsoId, weekLabel } from "@/lib/week";

interface Props {
  departments: Department[];
  weekMonday: string;
  showToast: (msg: string) => void;
}

export default function BillingView({ departments, weekMonday, showToast }: Props) {
  const [schedules, setSchedules] = useState<Record<string, SolveResult | null>>({});
  const wiso = weekIsoId(weekMonday);

  // Load schedules for ALL departments for the active week
  useEffect(() => {
    const load = async () => {
      const result: Record<string, SolveResult | null> = {};
      for (const dept of departments) {
        const snap = await getDoc(doc(db, "schedules", `${dept.id}_${wiso}`));
        result[dept.id] = snap.exists()
          ? { status: snap.data().status, objective: snap.data().objective, schedule: snap.data().schedule, coverage: snap.data().coverage, warnings: snap.data().warnings ?? [] }
          : null;
      }
      setSchedules(result);
    };
    load();
  }, [departments, wiso]);

  // Use first department's billing as store billing (shared)
  const refDept = departments[0];
  const storeBilling = refDept?.params?.billing?.daily ?? {};
  const storeProfiles = refDept?.params?.billing?.profiles ?? {};

  async function setStoreBillingDay(day: string, val: number) {
    // Update ALL departments' billing.daily (shared source)
    for (const dept of departments) {
      const newDaily = { ...dept.params.billing.daily, [day]: val };
      await updateDoc(doc(db, "departments", dept.id), {
        "params.billing.daily": newDaily,
      });
    }
    showToast("Facturación guardada");
  }

  // Excel import
  const fileRef = useRef<HTMLInputElement>(null);
  async function handleExcelImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
      const vals = data.map(row => {
        const v = Object.values(row).find(val => typeof val === "number" && val > 0);
        return typeof v === "number" ? v : null;
      }).filter((v): v is number => v !== null);
      if (vals.length >= 7) {
        for (const dept of departments) {
          const nd = { ...dept.params.billing.daily };
          DAYS_KEYS.forEach((d, i) => { if (i < vals.length) nd[d] = vals[i]; });
          await updateDoc(doc(db, "departments", dept.id), { "params.billing.daily": nd });
        }
        showToast("Facturación importada desde Excel");
      }
    } catch { alert("Error al leer el archivo Excel"); }
    if (fileRef.current) fileRef.current.value = "";
  }

  // Compute totals
  const weekBillingTotal = DAYS_KEYS.reduce((s, d) => s + (storeBilling[d] ?? 0), 0);

  // Per-department data
  const deptRows = departments.map(dept => {
    const mode = dept.params.demand_mode ?? "billing";
    const sells = mode === "billing";
    const pct = dept.params.billing_pct ?? 0;
    const prodConfig = dept.params.billing?.productivity_eur_per_person_hour ?? 420;
    const expectedBilling = sells ? Math.round(weekBillingTotal * pct / 100) : 0;

    // Hours worked from schedule
    const sched = schedules[dept.id];
    let hoursWorked = 0;
    if (sched?.schedule) {
      for (const empSched of Object.values(sched.schedule)) {
        for (const d of DAYS_KEYS) {
          const entry = (empSched as Record<string, { code: string; hours?: number }>)[d];
          if (entry?.code === "normal" && entry.hours) hoursWorked += entry.hours;
        }
      }
    }

    const prodReal = hoursWorked > 0 && sells ? Math.round(expectedBilling / hoursWorked) : null;

    return { dept, mode, sells, pct, prodConfig, expectedBilling, hoursWorked, prodReal, hasSched: !!sched };
  });

  const sellingDepts = deptRows.filter(r => r.sells);
  const nonSellingDepts = deptRows.filter(r => !r.sells);
  const totalPct = sellingDepts.reduce((s, r) => s + r.pct, 0);
  const totalHoursAll = deptRows.reduce((s, r) => s + r.hoursWorked, 0);
  const prodRealStore = totalHoursAll > 0 ? Math.round(weekBillingTotal / totalHoursAll) : null;
  const missingDepts = deptRows.filter(r => !r.hasSched).length;

  async function updateDeptField(deptId: string, field: string, val: number) {
    if (field === "billing_pct") {
      await updateDoc(doc(db, "departments", deptId), { "params.billing_pct": val });
    } else if (field === "productivity") {
      await updateDoc(doc(db, "departments", deptId), { "params.billing.productivity_eur_per_person_hour": val });
    }
    showToast("Guardado");
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14, fontWeight: 500 }}>
        {weekLabel(weekMonday)}
      </div>

      {/* ── Section 1: Store billing ── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="cardpad psec">
          <h4>
            <svg className="ico" viewBox="0 0 24 24" style={{ stroke: "var(--garnet)", width: 16, height: 16 }}>
              <path d="M12 2v20M17 6a4 4 0 0 0-4-2H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-3a4 4 0 0 1-4-2" />
            </svg> Facturación de tienda
          </h4>
          <p className="desc">Venta diaria real en € de toda la tienda. Fuente única.</p>

          <div className="import" onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0 4 4m-4-4-4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
            <div><b>Importar mes desde Excel</b><small>arrastra el .xlsx</small></div>
            <span className="impbtn">Subir</span>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={handleExcelImport} />

          <div className="bill-days" style={{ marginTop: 10 }}>
            {DAYS_KEYS.map(d => {
              const val = storeBilling[d] ?? 0;
              const hi = val > 1000000;
              return (
                <div key={d} className="bd" style={hi ? { borderColor: "var(--bad)", background: "#fef0f0" } : {}}>
                  <label>{DAY_SHORT[d]}</label>
                  <div className="eur">
                    <input value={val || ""} onChange={e => setStoreBillingDay(d, +e.target.value || 0)} type="number" placeholder="0" />
                    <span>€</span>
                  </div>
                  {hi && <div style={{ fontSize: 8, color: "var(--bad)", marginTop: 2 }}>¿Seguro?</div>}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginTop: 8, textAlign: "right" }}>
            Total semana: {weekBillingTotal.toLocaleString("es-ES")} €
          </div>
        </div>
      </div>

      {/* ── Section 2: Department breakdown ── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="chead">
          <h3>Reparto por departamento</h3>
          {Math.abs(totalPct - 100) > 1 && totalPct > 0 && (
            <span style={{ fontSize: 11, color: totalPct > 100 ? "var(--bad)" : "var(--gold-deep)", fontWeight: 600 }}>
              Σ {totalPct}% {totalPct > 100 ? "⚠ supera 100%" : ""}
            </span>
          )}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Departamento</th>
                <th>Modo</th>
                <th>%</th>
                <th>Fact. esperada</th>
                <th>Horas sem.</th>
                <th>Prod. config.</th>
                <th>Prod. real</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sellingDepts.map(r => (
                <tr key={r.dept.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 3, background: r.dept.color, flexShrink: 0 }} />
                      <b style={{ fontSize: 13 }}>{r.dept.name}</b>
                    </div>
                  </td>
                  <td><span className="pill p-F" style={{ fontSize: 10 }}>Facturación</span></td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <input className="num" type="number" style={{ width: 44 }} value={r.pct}
                        onChange={e => updateDeptField(r.dept.id, "billing_pct", +e.target.value || 0)} />
                      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>%</span>
                    </div>
                  </td>
                  <td style={{ fontFamily: "'Spline Sans Mono'", fontSize: 12 }}>
                    {r.expectedBilling > 0 ? `${r.expectedBilling.toLocaleString("es-ES")} €` : "—"}
                  </td>
                  <td style={{ fontFamily: "'Spline Sans Mono'", fontSize: 12 }}>
                    {r.hasSched ? `${r.hoursWorked}h` : <span style={{ color: "var(--ink-3)" }}>—</span>}
                  </td>
                  <td>
                    <input className="num" type="number" style={{ width: 52 }} value={r.prodConfig}
                      onChange={e => updateDeptField(r.dept.id, "productivity", +e.target.value || 420)} />
                  </td>
                  <td style={{ fontFamily: "'Spline Sans Mono'", fontSize: 12, fontWeight: 600 }}>
                    {r.prodReal !== null ? `${r.prodReal} €/h` : <span style={{ color: "var(--ink-3)" }}>—</span>}
                  </td>
                  <td>
                    {r.prodReal !== null && r.prodReal !== r.prodConfig && (
                      <button className="editbtn" title="Usar productividad real" style={{ fontSize: 9 }}
                        onClick={() => updateDeptField(r.dept.id, "productivity", r.prodReal!)}>
                        ↻
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {nonSellingDepts.length > 0 && (
                <tr><td colSpan={8} style={{ padding: "10px 14px", fontSize: 11, color: "var(--ink-3)", fontWeight: 600, borderTop: "1px solid var(--line)" }}>
                  No generan ventas · se miden con tienda
                </td></tr>
              )}
              {nonSellingDepts.map(r => (
                <tr key={r.dept.id} style={{ opacity: 0.7 }}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 3, background: r.dept.color, flexShrink: 0 }} />
                      <b style={{ fontSize: 13 }}>{r.dept.name}</b>
                    </div>
                  </td>
                  <td><span className="pill p-M" style={{ fontSize: 10 }}>{r.mode === "cajas" ? "Cajas" : "Cobertura"}</span></td>
                  <td style={{ color: "var(--ink-3)" }}>—</td>
                  <td style={{ color: "var(--ink-3)" }}>—</td>
                  <td style={{ fontFamily: "'Spline Sans Mono'", fontSize: 12 }}>
                    {r.hasSched ? `${r.hoursWorked}h` : <span style={{ color: "var(--ink-3)" }}>—</span>}
                  </td>
                  <td style={{ color: "var(--ink-3)" }}>—</td>
                  <td style={{ color: "var(--ink-3)" }}>—</td>
                  <td></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Section 3: Store totals ── */}
      <div className="card">
        <div className="cardpad">
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".05em" }}>Facturación semana</div>
              <div style={{ fontFamily: "'Archivo'", fontSize: 22, fontWeight: 800, color: "var(--garnet)" }}>{weekBillingTotal.toLocaleString("es-ES")} €</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".05em" }}>Horas totales</div>
              <div style={{ fontFamily: "'Archivo'", fontSize: 22, fontWeight: 800, color: "var(--ink)" }}>
                {totalHoursAll > 0 ? `${totalHoursAll}h` : "—"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".05em" }}>Productividad tienda</div>
              <div style={{ fontFamily: "'Archivo'", fontSize: 22, fontWeight: 800, color: "var(--blau)" }}>
                {prodRealStore !== null ? `${prodRealStore} €/h` : "—"}
              </div>
            </div>
          </div>
          {missingDepts > 0 && (
            <div style={{ fontSize: 11, color: "var(--gold-deep)", marginTop: 8 }}>
              ⚠ Faltan {missingDepts} dpto(s) por generar esta semana
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useRef } from "react";
import { db } from "@/lib/firebase";
import { doc, updateDoc, getDoc } from "firebase/firestore";
import type { Department, SolveResult } from "@/lib/types";
import { DAYS_KEYS, DAY_SHORT } from "@/lib/types";
import { weekIsoId, weekLabel } from "@/lib/week";

interface Props {
  departments: Department[];
  weekMonday: string;
  showToast: (msg: string) => void;
}

export default function BillingView({ departments, weekMonday, showToast }: Props) {
  const [schedules, setSchedules] = useState<Record<string, SolveResult | null>>({});
  const wiso = weekIsoId(weekMonday);

  useEffect(() => {
    (async () => {
      const r: Record<string, SolveResult | null> = {};
      for (const d of departments) {
        const snap = await getDoc(doc(db, "schedules", `${d.id}_${wiso}`));
        r[d.id] = snap.exists() ? snap.data() as SolveResult : null;
      }
      setSchedules(r);
    })();
  }, [departments, wiso]);

  const refDept = departments[0];
  const storeBilling = refDept?.params?.billing?.daily ?? {};

  async function setStoreBillingDay(day: string, val: number) {
    for (const dept of departments) {
      await updateDoc(doc(db, "departments", dept.id), {
        "params.billing.daily": { ...dept.params.billing.daily, [day]: val },
      });
    }
    showToast("Facturación guardada");
  }

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
      const vals = data.map(row => { const v = Object.values(row).find(val => typeof val === "number" && val > 0); return typeof v === "number" ? v : null; }).filter((v): v is number => v !== null);
      if (vals.length >= 7) {
        for (const dept of departments) {
          const nd = { ...dept.params.billing.daily };
          DAYS_KEYS.forEach((d, i) => { if (i < vals.length) nd[d] = vals[i]; });
          await updateDoc(doc(db, "departments", dept.id), { "params.billing.daily": nd });
        }
        showToast("Facturación importada");
      }
    } catch { alert("Error al leer el archivo"); }
    if (fileRef.current) fileRef.current.value = "";
  }

  const weekTotal = DAYS_KEYS.reduce((s, d) => s + (storeBilling[d] ?? 0), 0);

  // Compute per-department
  function hoursFromSched(sched: SolveResult | null): number {
    if (!sched?.schedule) return 0;
    let h = 0;
    for (const es of Object.values(sched.schedule)) {
      for (const d of DAYS_KEYS) {
        const en = (es as Record<string, { code: string; hours?: number }>)[d];
        if (en?.code === "normal" && en.hours) h += en.hours;
      }
    }
    return h;
  }

  const rows = departments.map(dept => {
    const mode = dept.params.demand_mode ?? "billing";
    const pct = dept.params.billing_pct ?? 0;
    const sched = schedules[dept.id];
    const hours = hoursFromSched(sched);
    // hasSched = doc exists AND has at least one working shift
    const hasSched = hours > 0;
    const expected = Math.round(weekTotal * pct / 100);
    const prodReal = hasSched && pct > 0 ? Math.round(expected / hours) : null;

    // Cajas specifics
    const ticketMedio = dept.params.ticket_medio ?? 25;
    const cpcConfig = dept.params.clients_per_cash_hour ?? 15;
    const transWeek = ticketMedio > 0 ? Math.round(weekTotal / ticketMedio) : 0;
    const transPerHourReal = hasSched ? Math.round(transWeek / hours) : null;

    return { dept, mode, pct, hours, hasSched, expected, prodReal, prodConfig: dept.params.billing?.productivity_eur_per_person_hour ?? 420, ticketMedio, cpcConfig, transWeek, transPerHourReal };
  });

  const withSales = rows.filter(r => r.pct > 0);
  const noSales = rows.filter(r => r.pct === 0);
  const totalPct = rows.reduce((s, r) => s + r.pct, 0);
  const generatedRows = rows.filter(r => r.hasSched);
  const totalHours = generatedRows.reduce((s, r) => s + r.hours, 0);
  const prodStore = totalHours > 0 ? Math.round(weekTotal / totalHours) : null;
  const missing = rows.filter(r => !r.hasSched).length;

  async function updateField(deptId: string, path: string, val: number) {
    await updateDoc(doc(db, "departments", deptId), { [path]: val });
    showToast("Guardado");
  }

  const modeLabel = (m: string) => m === "billing" ? "Facturación" : m === "cajas" ? "Cajas" : "Cobertura";
  const modePill = (m: string) => m === "billing" ? "p-F" : m === "cajas" ? "p-T" : "p-M";

  return (
    <div style={{ maxWidth: 960 }}>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14, fontWeight: 500 }}>{weekLabel(weekMonday)}</div>

      {/* ── Section 1: Store billing ── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="cardpad psec">
          <h4><svg className="ico" viewBox="0 0 24 24" style={{ stroke: "var(--garnet)", width: 16, height: 16 }}><path d="M12 2v20M17 6a4 4 0 0 0-4-2H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-3a4 4 0 0 1-4-2" /></svg> Facturación de tienda</h4>
          <p className="desc">Venta diaria real en € de toda la tienda. Fuente única.</p>
          <div className="import" onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0 4 4m-4-4-4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
            <div><b>Importar mes desde Excel</b><small>arrastra el .xlsx</small></div>
            <span className="impbtn">Subir</span>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={handleExcelImport} />
          <div className="bill-days" style={{ marginTop: 10 }}>
            {DAYS_KEYS.map(d => {
              const val = storeBilling[d] ?? 0; const hi = val > 1000000;
              return <div key={d} className="bd" style={hi ? { borderColor: "var(--bad)", background: "#fef0f0" } : {}}>
                <label>{DAY_SHORT[d]}</label>
                <div className="eur"><input value={val || ""} onChange={e => setStoreBillingDay(d, +e.target.value || 0)} type="number" placeholder="0" /><span>€</span></div>
                {hi && <div style={{ fontSize: 8, color: "var(--bad)", marginTop: 2 }}>¿Seguro?</div>}
              </div>;
            })}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginTop: 8, textAlign: "right" }}>
            Total semana: {weekTotal.toLocaleString("es-ES")} €
          </div>
        </div>
      </div>

      {/* ── Section 2: Department breakdown ── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="chead">
          <h3>Reparto por departamento</h3>
          <span style={{ fontSize: 11, color: totalPct > 100 ? "var(--bad)" : totalPct > 0 ? "var(--ok)" : "var(--ink-3)", fontWeight: 600 }}>
            Σ {totalPct}%{totalPct > 100 ? " ⚠ supera 100%" : ""}
          </span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr><th>Departamento</th><th>Modo</th><th>% venta</th><th>Fact. esperada</th><th>Horas sem.</th><th>KPI</th><th></th></tr>
            </thead>
            <tbody>
              {/* Departments with sales attribution (% > 0) */}
              {withSales.map(r => (
                <tr key={r.dept.id}>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: 3, background: r.dept.color, flexShrink: 0 }} /><b style={{ fontSize: 13 }}>{r.dept.name}</b></div></td>
                  <td><span className={`pill ${modePill(r.mode)}`} style={{ fontSize: 10 }}>{modeLabel(r.mode)}</span></td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <input className="num" type="number" style={{ width: 44 }} value={r.pct}
                        onChange={e => updateField(r.dept.id, "params.billing_pct", +e.target.value || 0)} />
                      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>%</span>
                    </div>
                  </td>
                  <td style={{ fontFamily: "'Spline Sans Mono'", fontSize: 12 }}>
                    {r.expected > 0 ? `${r.expected.toLocaleString("es-ES")} €` : "—"}
                  </td>
                  <td style={{ fontFamily: "'Spline Sans Mono'", fontSize: 12 }}>
                    {r.hasSched ? `${r.hours}h` : <span style={{ color: "var(--ink-3)" }}>—</span>}
                  </td>
                  <KpiCell r={r} prodStore={prodStore} updateField={updateField} />
                </tr>
              ))}
              {/* Departments without sales attribution (% = 0) */}
              {noSales.length > 0 && (
                <tr><td colSpan={7} style={{ padding: "10px 14px", fontSize: 11, color: "var(--ink-3)", fontWeight: 600, borderTop: "1px solid var(--line)" }}>
                  Sin atribución de venta (% = 0)
                </td></tr>
              )}
              {noSales.map(r => (
                <tr key={r.dept.id} style={{ opacity: 0.6 }}>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: 3, background: r.dept.color, flexShrink: 0 }} /><b style={{ fontSize: 13 }}>{r.dept.name}</b></div></td>
                  <td><span className={`pill ${modePill(r.mode)}`} style={{ fontSize: 10 }}>{modeLabel(r.mode)}</span></td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <input className="num" type="number" style={{ width: 44 }} value={r.pct}
                        onChange={e => updateField(r.dept.id, "params.billing_pct", +e.target.value || 0)} />
                      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>%</span>
                    </div>
                  </td>
                  <td style={{ color: "var(--ink-3)" }}>—</td>
                  <td style={{ fontFamily: "'Spline Sans Mono'", fontSize: 12 }}>
                    {r.hasSched ? `${r.hours}h` : <span style={{ color: "var(--ink-3)" }}>—</span>}
                  </td>
                  <KpiCell r={r} prodStore={prodStore} updateField={updateField} />
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
              <div style={{ fontFamily: "'Archivo'", fontSize: 22, fontWeight: 800, color: "var(--garnet)" }}>{weekTotal.toLocaleString("es-ES")} €</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".05em" }}>Horas totales</div>
              <div style={{ fontFamily: "'Archivo'", fontSize: 22, fontWeight: 800, color: "var(--ink)" }}>{totalHours > 0 ? `${totalHours}h` : "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".05em" }}>Productividad tienda</div>
              <div style={{ fontFamily: "'Archivo'", fontSize: 22, fontWeight: 800, color: "var(--blau)" }}>{prodStore !== null ? `${prodStore} €/h` : "—"}</div>
            </div>
          </div>
          {missing > 0 && <div style={{ fontSize: 11, color: "var(--gold-deep)", marginTop: 8 }}>⚠ Faltan {missing} dpto(s) por generar</div>}
        </div>
      </div>
    </div>
  );
}

/* Unified KPI cell for all department modes */
function KpiCell({ r, prodStore, updateField }: {
  r: { dept: Department; mode: string; prodConfig: number; prodReal: number | null; cpcConfig: number; transPerHourReal: number | null; hasSched: boolean };
  prodStore: number | null;
  updateField: (deptId: string, path: string, val: number) => void;
}) {
  return <>
    <td style={{ fontSize: 11 }}>
      {/* Productivity €/h — ALL departments */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <input className="num" type="number" style={{ width: 48, fontSize: 9 }} value={r.prodConfig}
            onChange={e => updateField(r.dept.id, "params.billing.productivity_eur_per_person_hour", +e.target.value || 420)} />
          <span style={{ fontSize: 9, color: "var(--ink-3)" }}>€/h</span>
        </div>
        <div style={{ fontFamily: "'Spline Sans Mono'", fontSize: 10, color: "var(--ink-2)", marginTop: 1 }}>
          real: {r.prodReal !== null ? `${r.prodReal} €/h` : "—"}
        </div>
        {r.mode === "cobertura" && <div style={{ fontSize: 8, color: "var(--ink-3)", fontStyle: "italic" }}>informativo (bandas)</div>}
      </div>
      {/* Cajas: additional trans/hour driver */}
      {r.mode === "cajas" && (
        <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--line-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <input className="num" type="number" style={{ width: 48, fontSize: 9 }} value={r.cpcConfig}
              onChange={e => updateField(r.dept.id, "params.clients_per_cash_hour", +e.target.value || 15)} />
            <span style={{ fontSize: 9, color: "var(--ink-3)" }}>trans/h</span>
          </div>
          <div style={{ fontFamily: "'Spline Sans Mono'", fontSize: 10, color: "var(--ink-2)", marginTop: 1 }}>
            real: {r.transPerHourReal !== null ? `${r.transPerHourReal} trans/h` : "—"}
          </div>
        </div>
      )}
    </td>
    <td>
      {/* ↻ usar real — productivity */}
      {r.prodReal !== null && r.prodReal !== r.prodConfig && (
        <button className="editbtn" title="Usar productividad real" style={{ fontSize: 9 }}
          onClick={() => updateField(r.dept.id, "params.billing.productivity_eur_per_person_hour", r.prodReal!)}>↻</button>
      )}
      {/* ↻ usar real — cajas trans/hour */}
      {r.mode === "cajas" && r.transPerHourReal !== null && r.transPerHourReal !== r.cpcConfig && (
        <button className="editbtn" title="Usar trans/hora reales" style={{ fontSize: 9, marginTop: 4 }}
          onClick={() => updateField(r.dept.id, "params.clients_per_cash_hour", r.transPerHourReal!)}>↻</button>
      )}
    </td>
  </>;
}

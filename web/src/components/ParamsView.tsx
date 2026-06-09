"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Department, DepartmentParams, BillingProfile, DemandMode, CoverageBand } from "@/lib/types";
import { DAYS_KEYS, DAY_LABELS } from "@/lib/types";

interface Props {
  department: Department;
  onUpdateParams: (params: DepartmentParams) => void;
}

export default function ParamsView({ department, onUpdateParams }: Props) {
  const [params, setParams] = useState<DepartmentParams>(department.params);
  const [profile, setProfile] = useState<"normal" | "match">("normal");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setParams(department.params);
  }, [department]);

  const autosave = useCallback(
    (p: DepartmentParams) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => onUpdateParams(p), 800);
    },
    [onUpdateParams]
  );

  function update(fn: (p: DepartmentParams) => DepartmentParams) {
    setParams((prev) => {
      const next = fn(prev);
      autosave(next);
      return next;
    });
  }

  function setStoreHour(day: string, field: "open" | "close", val: string) {
    update((p) => ({
      ...p,
      store_hours: {
        ...p.store_hours,
        [day]: { ...p.store_hours[day], [field]: val },
      },
    }));
  }

  function setPrePost(
    key: "preopen" | "postclose",
    field: "min" | "max" | "minutes",
    val: number
  ) {
    update((p) => ({
      ...p,
      [key]: { ...p[key], [field]: val },
    }));
  }

  function setBillingDaily(day: string, val: number) {
    update((p) => ({
      ...p,
      billing: {
        ...p.billing,
        daily: { ...p.billing.daily, [day]: val },
      },
    }));
  }

  function setProfilePct(hour: string, val: number) {
    update((p) => ({
      ...p,
      billing: {
        ...p.billing,
        profiles: {
          ...p.billing.profiles,
          [profile]: { ...p.billing.profiles[profile], [hour]: val },
        },
      },
    }));
  }

  function setProductivity(val: number) {
    update((p) => ({
      ...p,
      billing: { ...p.billing, productivity_eur_per_person_hour: val },
    }));
  }

  const demandMode = params.demand_mode ?? "billing";

  const currentProfile: BillingProfile = params.billing?.profiles?.[profile] ?? {};
  const profileHours = Object.keys(currentProfile)
    .map(Number)
    .sort((a, b) => a - b);
  const pctSum = Object.values(currentProfile).reduce(
    (s: number, v: number) => s + v,
    0
  );

  const maxPct = useMemo(
    () => Math.max(...Object.values(currentProfile), 1),
    [currentProfile]
  );

  const peakHeads = useMemo(() => {
    const prod = params.billing?.productivity_eur_per_person_hour ?? 420;
    const dailyMax = Math.max(...Object.values(params.billing?.daily ?? {}), 1);
    let peak = 0;
    for (const h of profileHours) {
      const pct = currentProfile[String(h)] ?? 0;
      const eurHr = dailyMax * (pct / 100);
      const heads = Math.max(1, Math.round(eurHr / prod / 2));
      peak = Math.max(peak, heads);
    }
    return peak;
  }, [params.billing, currentProfile, profileHours]);

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
      // Expect rows with a numeric column for billing
      const vals = data
        .map((row) => {
          const v = Object.values(row).find(
            (val) => typeof val === "number" && val > 0
          );
          return typeof v === "number" ? v : null;
        })
        .filter((v): v is number => v !== null);

      if (vals.length >= 7) {
        // Take the first 7 values as MON-SUN
        const newDaily = { ...params.billing.daily };
        DAYS_KEYS.forEach((d, i) => {
          if (i < vals.length) newDaily[d] = vals[i];
        });
        update((p) => ({
          ...p,
          billing: { ...p.billing, daily: newDaily },
        }));
      }
    } catch {
      alert("Error al leer el archivo Excel");
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="pgrid">
      {/* LEFT COLUMN */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Store Hours */}
        <div className="card">
          <div className="cardpad psec">
            <h4>
              <svg
                className="ico"
                viewBox="0 0 24 24"
                style={{ stroke: "var(--garnet)", width: 16, height: 16 }}
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>{" "}
              Horario de tienda por día
            </h4>
            <p className="desc">
              Apertura y cierre base de cada día. Los eventos (partido, inventario) se marcan por semana en la pestaña Cuadrícula.
            </p>
            <table className="hours-tbl">
              <thead>
                <tr>
                  <th>Día</th>
                  <th>Apertura</th>
                  <th>Cierre</th>
                </tr>
              </thead>
              <tbody>
                {DAYS_KEYS.map((d) => {
                  const sh = params.store_hours?.[d];
                  if (!sh) return null;
                  return (
                    <tr key={d}>
                      <td className="daytag">{DAY_LABELS[d]}</td>
                      <td>
                        <input className="timeinput" value={sh.open}
                          onChange={(e) => setStoreHour(d, "open", e.target.value)} />
                      </td>
                      <td>
                        <input className="timeinput" value={sh.close}
                          onChange={(e) => setStoreHour(d, "close", e.target.value)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pre/Post Open */}
        <div className="card">
          <div className="cardpad psec">
            <h4>
              <svg
                className="ico"
                viewBox="0 0 24 24"
                style={{ stroke: "var(--blau)", width: 16, height: 16 }}
              >
                <path d="M3 21V8l9-5 9 5v13M9 21v-6h6v6" />
              </svg>{" "}
              Franjas sin facturación
            </h4>
            <p className="desc">
              Personal de montaje antes de abrir y cierre tras cerrar.
            </p>
            <table className="hours-tbl">
              <thead><tr><th>Franja</th><th>Duración</th><th>Mín / Máx personas</th></tr></thead>
              <tbody>
                <tr>
                  <td className="daytag">Montaje (antes de abrir)</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input className="num" type="number" step="0.5" min="0" style={{ width: 56 }}
                        value={(params.preopen?.minutes ?? 30) / 60}
                        onChange={(e) => setPrePost("preopen", "minutes", Math.round((+e.target.value || 0) * 60))} />
                      <span style={{ fontSize: 11, color: "var(--ink-3)" }}>horas</span>
                    </div>
                  </td>
                  <td>
                    <div className="minmax">
                      <input className="num" type="number" value={params.preopen?.min ?? 2}
                        onChange={(e) => setPrePost("preopen", "min", +e.target.value)} />
                      <span style={{ color: "var(--ink-3)" }}>–</span>
                      <input className="num" type="number" value={params.preopen?.max ?? 3}
                        onChange={(e) => setPrePost("preopen", "max", +e.target.value)} />
                    </div>
                  </td>
                </tr>
                <tr>
                  <td className="daytag">Cierre (después de cerrar)</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input className="num" type="number" step="0.5" min="0" style={{ width: 56 }}
                        value={(params.postclose?.minutes ?? 30) / 60}
                        onChange={(e) => setPrePost("postclose", "minutes", Math.round((+e.target.value || 0) * 60))} />
                      <span style={{ fontSize: 11, color: "var(--ink-3)" }}>horas</span>
                    </div>
                  </td>
                  <td>
                    <div className="minmax">
                      <input className="num" type="number" value={params.postclose?.min ?? 2}
                        onChange={(e) => setPrePost("postclose", "min", +e.target.value)} />
                      <span style={{ color: "var(--ink-3)" }}>–</span>
                      <input className="num" type="number" value={params.postclose?.max ?? 3}
                        onChange={(e) => setPrePost("postclose", "max", +e.target.value)} />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Contract reference */}
        <div className="card">
          <div className="cardpad psec">
            <h4>
              <svg
                className="ico"
                viewBox="0 0 24 24"
                style={{ stroke: "var(--teal)", width: 16, height: 16 }}
              >
                <path d="M12 2v20M5 5l7-3 7 3M5 5v6a7 7 0 0 0 14 0V5" />
              </svg>{" "}
              Base horaria → jornada
            </h4>
            <p className="desc">
              Regla fija: las horas por día se derivan del contrato semanal (
              {params.days_per_week ?? 5} días,{" "}
              {7 - (params.days_per_week ?? 5)} libres).
            </p>
            <table className="hours-tbl">
              <thead>
                <tr>
                  <th>Contrato</th>
                  <th>Días/semana</th>
                  <th>Horas/día</th>
                  <th>Libres</th>
                </tr>
              </thead>
              <tbody>
                {[40, 35, 25, 20].map((h) => {
                  const dpw = params.days_per_week ?? 5;
                  return (
                    <tr key={h}>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {h} h
                      </td>
                      <td className="mono">{dpw}</td>
                      <td className="mono">{h / dpw} h</td>
                      <td className="mono">{7 - dpw}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Convention rules */}
        <div className="card">
          <div className="cardpad psec">
            <h4>
              <svg className="ico" viewBox="0 0 24 24" style={{stroke:"var(--violet)",width:16,height:16}}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg> Reglas de convenio
            </h4>
            <p className="desc">Restricciones laborales aplicadas al generar (nivel tienda).</p>
            <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
              <div className="field" style={{flex:1,minWidth:140}}>
                <label>Descanso mínimo entre turnos</label>
                <div style={{display:"flex",alignItems:"center",gap:4}}>
                  <input className="num" type="number" style={{width:50}} value={params.min_rest_hours ?? 12}
                    onChange={e=>update(p=>({...p,min_rest_hours:+e.target.value||12}))}/>
                  <span style={{fontSize:11,color:"var(--ink-3)"}}>horas</span>
                </div>
              </div>
              <div className="field" style={{flex:1,minWidth:140}}>
                <label>Máx. días seguidos</label>
                <div style={{display:"flex",alignItems:"center",gap:4}}>
                  <input className="num" type="number" style={{width:50}} value={params.max_consecutive_days ?? 5}
                    onChange={e=>update(p=>({...p,max_consecutive_days:+e.target.value||5}))}/>
                  <span style={{fontSize:11,color:"var(--ink-3)"}}>días</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT COLUMN — DEMAND MODEL */}
      <div className="card">
        <div className="cardpad psec">
          <h4>
            <svg className="ico" viewBox="0 0 24 24" style={{stroke:"var(--garnet)",width:16,height:16}}>
              <path d="M12 2v20M17 6a4 4 0 0 0-4-2H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-3a4 4 0 0 1-4-2"/>
            </svg> Modelo de demanda
          </h4>
          <p className="desc">Cómo se calcula cuánta gente necesita este departamento por franja.</p>

          {/* Mode selector */}
          <div className="profiles" style={{marginBottom:14}}>
            {([["billing","Facturación"],["cajas","Cajas"],["cobertura","Cobertura"]] as const).map(([m,l])=>(
              <button key={m} className={`prof ${demandMode===m?"active":""}`}
                onClick={()=>update(p=>({...p,demand_mode:m}))}>
                {l}
              </button>
            ))}
          </div>

          {/* ── Curva horaria — visible for billing & cajas ── */}
          {(demandMode === "billing" || demandMode === "cajas") && (
            <div className="field">
              <label>Curva horaria <span className="hint">(% de venta por franja — nivel tienda)</span></label>
              <div className="profiles">
                <button className={`prof ${profile==="normal"?"active":""}`} onClick={()=>setProfile("normal")}>Normal</button>
                <button className={`prof ${profile==="match"?"active":""}`} onClick={()=>setProfile("match")}>Partido ⚽</button>
                <span className="pctsum" style={{color:Math.abs(pctSum-100)<=2?"var(--ok)":"var(--bad)"}}>Σ {pctSum}%</span>
              </div>
              <div className="pctgrid">{profileHours.map(hr=>(<div key={hr} className="pctchip"><span>{hr}h</span><input type="number" value={currentProfile[String(hr)]??0} onChange={e=>setProfilePct(String(hr),+e.target.value||0)}/><i>%</i></div>))}</div>
              <div className="chartbox"><div className="chart">{profileHours.map(hr=>{const pct=currentProfile[String(hr)]??0;return <div key={hr} className="col"><div className="rev" style={{height:`${(pct/maxPct)*100}%`}}/><div className="hl">{hr}h</div></div>;})}</div><div className="chleg"><span><span className="s1"/> Venta</span><span><span className="s2"/> Personas</span></div></div>
              <div style={{fontSize:10,color:"var(--ink-3)",marginTop:6}}>Mantén el total ~100%. La facturación y el % se editan en la pestaña Facturación.</div>
            </div>
          )}

          {/* ── CAJAS-specific ── */}
          {demandMode === "cajas" && (
            <div style={{display:"flex",gap:12,marginBottom:14}}>
              <div className="field" style={{flex:1}}>
                <label>Ticket medio <span className="hint">(€/cliente)</span></label>
                <input className="eurinput" type="number" value={params.ticket_medio??25}
                  onChange={e=>update(p=>({...p,ticket_medio:+e.target.value||25}))}/>
              </div>
              <div className="field" style={{flex:1}}>
                <label>Clientes/caja·hora</label>
                <input className="eurinput" type="number" value={params.clients_per_cash_hour??15}
                  onChange={e=>update(p=>({...p,clients_per_cash_hour:+e.target.value||15}))}/>
              </div>
            </div>
          )}

          {/* ── COBERTURA mode ── */}
          {demandMode === "cobertura" && (<>
            <div className="note" style={{marginTop:0,marginBottom:14}}>
              <svg className="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v.5M12 11v5"/></svg>
              <div>Sin facturación. Define tramos de mín/máx de personas directamente.</div>
            </div>
            <table className="hours-tbl">
              <thead><tr><th>Desde</th><th>Hasta</th><th>Mín</th><th>Máx</th><th></th></tr></thead>
              <tbody>
                {(params.coverage_bands ?? []).map((b, i) => (
                  <tr key={i}>
                    <td><input className="timeinput" value={b.from} onChange={e => {
                      const bands = [...(params.coverage_bands ?? [])];
                      bands[i] = { ...bands[i], from: e.target.value };
                      update(p => ({ ...p, coverage_bands: bands }));
                    }}/></td>
                    <td><input className="timeinput" value={b.to} onChange={e => {
                      const bands = [...(params.coverage_bands ?? [])];
                      bands[i] = { ...bands[i], to: e.target.value };
                      update(p => ({ ...p, coverage_bands: bands }));
                    }}/></td>
                    <td><input className="num" type="number" value={b.min} onChange={e => {
                      const bands = [...(params.coverage_bands ?? [])];
                      bands[i] = { ...bands[i], min: +e.target.value };
                      update(p => ({ ...p, coverage_bands: bands }));
                    }}/></td>
                    <td><input className="num" type="number" value={b.max} onChange={e => {
                      const bands = [...(params.coverage_bands ?? [])];
                      bands[i] = { ...bands[i], max: +e.target.value };
                      update(p => ({ ...p, coverage_bands: bands }));
                    }}/></td>
                    <td><button className="editbtn" onClick={() => {
                      const bands = (params.coverage_bands ?? []).filter((_, j) => j !== i);
                      update(p => ({ ...p, coverage_bands: bands }));
                    }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="addrow" style={{marginTop:8}} onClick={() => {
              const bands = [...(params.coverage_bands ?? []), { from: "08:00", to: "14:00", min: 1, max: 2 }];
              update(p => ({ ...p, coverage_bands: bands }));
            }}>+ Añadir tramo</button>
          </>)}
        </div>
      </div>
    </div>
  );
}

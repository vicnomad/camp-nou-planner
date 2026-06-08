"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Department, DepartmentParams, BillingProfile } from "@/lib/types";
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
      </div>

      {/* RIGHT COLUMN — BILLING */}
      <div className="card">
        <div className="cardpad psec">
          <h4>
            <svg
              className="ico"
              viewBox="0 0 24 24"
              style={{ stroke: "var(--garnet)", width: 16, height: 16 }}
            >
              <path d="M12 2v20M17 6a4 4 0 0 0-4-2H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-3a4 4 0 0 1-4-2" />
            </svg>{" "}
            Facturación → demanda
          </h4>
          <p className="desc">
            De aquí sale cuánta gente necesitas en cada franja.
          </p>

          {/* Daily billing */}
          <div className="field">
            <label>
              1 · Facturación diaria prevista{" "}
              <span className="hint">(€/día)</span>
            </label>
            <div
              className="import"
              onClick={() => fileRef.current?.click()}
            >
              <svg viewBox="0 0 24 24">
                <path d="M12 16V4m0 0 4 4m-4-4-4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              <div>
                <b>Importar mes desde Excel</b>
                <small>
                  arrastra el .xlsx con la facturación diaria del mes
                </small>
              </div>
              <span className="impbtn">Subir</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: "none" }}
              onChange={handleExcelImport}
            />
            <div className="bill-days">
              {DAYS_KEYS.map((d) => {
                const sh = params.store_hours?.[d];
                const isMatch = sh?.special === "match";
                return (
                  <div key={d} className={`bd ${isMatch ? "match" : ""}`}>
                    <label>{d}</label>
                    <div className="eur">
                      <input
                        value={Math.round(
                          (params.billing?.daily?.[d] ?? 0) / 1000
                        )}
                        onChange={(e) =>
                          setBillingDaily(d, (+e.target.value || 0) * 1000)
                        }
                        type="number"
                      />
                      <span>k€</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Profile percentages */}
          <div className="field">
            <label>
              2 · Reparto por franja horaria{" "}
              <span className="hint">(% de la venta del día)</span>
            </label>
            <div className="profiles">
              <button
                className={`prof ${profile === "normal" ? "active" : ""}`}
                onClick={() => setProfile("normal")}
              >
                Día normal
              </button>
              <button
                className={`prof ${profile === "match" ? "active" : ""}`}
                onClick={() => setProfile("match")}
              >
                Día de partido ⚽
              </button>
              <span
                className="pctsum"
                style={{
                  color:
                    Math.abs(pctSum - 100) <= 2 ? "var(--ok)" : "var(--bad)",
                }}
              >
                Σ {pctSum}%
              </span>
            </div>
            <div className="pctgrid">
              {profileHours.map((hr) => (
                <div key={hr} className="pctchip">
                  <span>{hr}h</span>
                  <input
                    type="number"
                    value={currentProfile[String(hr)] ?? 0}
                    onChange={(e) =>
                      setProfilePct(String(hr), +e.target.value || 0)
                    }
                  />
                  <i>%</i>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div className="chartbox">
              <div className="chart">
                {profileHours.map((hr) => {
                  const pct = currentProfile[String(hr)] ?? 0;
                  return (
                    <div key={hr} className="col">
                      <div
                        className="rev"
                        style={{ height: `${(pct / maxPct) * 100}%` }}
                      />
                      <div className="hl">{hr}h</div>
                    </div>
                  );
                })}
              </div>
              <div className="chleg">
                <span>
                  <span className="s1" /> Venta por franja
                </span>
                <span>
                  <span className="s2" /> Personas necesarias
                </span>
              </div>
            </div>
          </div>

          {/* Productivity */}
          <div className="field" style={{ marginBottom: 0 }}>
            <label>
              3 · Productividad{" "}
              <span className="hint">
                (define cuánta venta cubre una persona)
              </span>
            </label>
            <div className="prodbox">
              <div className="lab">
                ≈{" "}
                <input
                  className="eurinput"
                  type="number"
                  value={
                    params.billing?.productivity_eur_per_person_hour ?? 420
                  }
                  onChange={(e) => setProductivity(+e.target.value || 420)}
                />{" "}
                € / persona·hora
                <small>ventas medias que atiende 1 persona</small>
              </div>
              <div className="res">
                <b>{peakHeads}</b>
                <small>pico de personas</small>
              </div>
            </div>
          </div>

          <div className="note">
            <svg className="ico" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v.5M12 11v5" />
            </svg>
            <div>
              <b>
                Venta de la franja ÷ productividad = personas objetivo.
              </b>{" "}
              El día de partido usa su propio reparto, y el motor reparte los
              turnos para cubrir esa curva.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

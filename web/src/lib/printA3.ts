/**
 * A3 portrait print sheet — UNA página.
 * Bloques Gantt por día en 2 columnas (L|M, X|J, V|S, D|Resumen), eje horario completo
 * con línea divisoria por hora y parte complementaria del turno en otro color (ámbar).
 */
import type { Department, Employee, SolveResult, StoreHours, DayKey } from "./types";
import { DAYS_KEYS, DAY_SHORT } from "./types";
import { weekComplSplit } from "./weekCompl";
import { editedDaysOf, type ScheduleEdits } from "./schedule";

const DAY_ES: Record<string, string> = {
  MON:"LUNES",TUE:"MARTES",WED:"MIÉRCOLES",THU:"JUEVES",FRI:"VIERNES",SAT:"SÁBADO",SUN:"DOMINGO"
};
function tm(t:string){const[h,m]=t.split(":").map(Number);return h*60+m}
function hh(m:number){return`${String(Math.floor(((m%1440+1440)%1440)/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`}
function esc(s:string){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}

export function printA3(
  dept: Department, employees: Employee[], sched: SolveResult,
  storeHours: Record<string,StoreHours>, weekLbl: string, edits: ScheduleEdits,
) {
  const p = dept.params;
  const c = dept.color;
  const AMBER = "#d4940a";
  const preM = p.preopen?.minutes ?? 30;
  const postM = p.postclose?.minutes ?? 30;
  const dpw = p.days_per_week ?? 5;

  // Weekly split per empleado (base completa; weekComplSplit ya reduce por ausencias del cuadrante).
  const splitByEmp = new Map(employees.map(e =>
    [e.id, weekComplSplit(sched.schedule?.[e.id], e.weekly_hours, e.weekly_hours / dpw, editedDaysOf(edits, e.id))] as const));

  // ── Un bloque (media celda) por día ──
  function dayCell(d: DayKey): string {
    const label = `<div class="daylabel" style="color:${c}">${DAY_ES[d] ?? d}</div>`;
    const sh = storeHours[d];
    if (!sh?.open || !sh?.close) {
      return `<div class="cell">${label}<div class="empty">Cerrado</div></div>`;
    }
    const openM = tm(sh.open);
    let closeM = tm(sh.close);
    if (closeM <= openM) closeM += 1440;
    let dayStart = openM - preM;
    let dayEnd = closeM + postM;
    if (sh.extra) { let et = tm(sh.extra.to); if (et <= openM) et += 1440; dayEnd = Math.max(dayEnd, et); }
    dayStart = Math.floor(dayStart / 60) * 60;   // a hora en punto para que la regla cuadre
    dayEnd = Math.ceil(dayEnd / 60) * 60;
    const span = dayEnd - dayStart;
    if (span <= 0) return `<div class="cell">${label}<div class="empty">—</div></div>`;
    const pct = (m: number) => ((m - dayStart) / span) * 100;

    // Empleados que trabajan ese día
    const rows: {name:string;start:number;end:number;normH:number;complH:number}[] = [];
    for (const emp of employees) {
      const en = sched.schedule?.[emp.id]?.[d];
      if (en?.code === "normal" && en.start && en.end) {
        let endM2 = tm(en.end); if (endM2 <= tm(en.start)) endM2 += 1440;
        const ds = splitByEmp.get(emp.id)!.days[d];
        rows.push({ name: emp.name, start: tm(en.start), end: endM2, normH: ds.norm, complH: ds.compl });
      }
    }
    rows.sort((a,b) => a.start - b.start || a.name.localeCompare(b.name));
    if (rows.length === 0) return `<div class="cell">${label}<div class="empty">Sin turnos</div></div>`;

    const firstHour = Math.ceil(dayStart / 60) * 60;

    // Overlay reutilizable: sombreado fuera de horario + líneas verticales por hora.
    function overlay(): string {
      let s = "";
      if (openM > dayStart) s += `<i class="band" style="left:0;width:${pct(openM)}%"></i>`;
      if (closeM < dayEnd) s += `<i class="band" style="left:${pct(closeM)}%;width:${(100 - pct(closeM)).toFixed(2)}%"></i>`;
      for (let h = firstHour; h < dayEnd; h += 60) if (h > dayStart) s += `<i class="vline" style="left:${pct(h)}%"></i>`;
      return s;
    }

    // Regla horaria (etiqueta por cada hora en punto)
    let ruler = "";
    for (let h = dayStart; h < dayEnd; h += 60) {
      const band = h < openM || h >= closeM;
      ruler += `<span class="hrlbl${band ? " bandtxt" : ""}" style="left:${pct(h)}%">${hh(h)}</span>`;
    }

    // Filas de empleado
    let empRows = "";
    for (const r of rows) {
      const shiftEnd = r.end;
      const normEnd = r.start + Math.min(r.normH * 60, shiftEnd - r.start);
      const normW = (normEnd - r.start) / span * 100;
      const complW = (shiftEnd - normEnd) / span * 100;
      const left = pct(r.start);
      let bars = "";
      if (normW > 0.01) bars += `<i class="bar" style="left:${left.toFixed(2)}%;width:${normW.toFixed(2)}%;background:${c}"></i>`;
      if (complW > 0.01) bars += `<i class="bar" style="left:${pct(normEnd).toFixed(2)}%;width:${complW.toFixed(2)}%;background:${AMBER}"></i>`;
      // Etiquetas (entrada siempre; salida si el turno es ancho)
      const wide = (shiftEnd - r.start) / span > 0.16;
      const lbl = `<span class="blab" style="left:${left.toFixed(2)}%">${hh(r.start)}</span>` +
        (wide ? `<span class="blab end" style="left:${pct(shiftEnd).toFixed(2)}%">${hh(shiftEnd % 1440)}</span>` : "");
      empRows += `<div class="erow"><div class="ename">${esc(r.name)}</div><div class="trk">${overlay()}${bars}${lbl}</div></div>`;
    }

    // Presencia por hora (turnos que cubren cada hora)
    let maxCnt = 0;
    const buckets: {from:number;to:number;n:number}[] = [];
    for (let h = dayStart; h < dayEnd; h += 60) {
      const from = h, to = Math.min(h + 60, dayEnd);
      const n = rows.filter(r => r.start < to && r.end > from).length;
      if (n > maxCnt) maxCnt = n;
      buckets.push({ from, to, n });
    }
    const presCells = buckets.map(b => {
      const w = (b.to - b.from) / span * 100;
      const hot = maxCnt > 0 && b.n === maxCnt && b.n > 0;
      return `<i class="pcell${hot ? " hot" : ""}" style="left:${pct(b.from).toFixed(2)}%;width:${w.toFixed(2)}%">${b.n || ""}</i>`;
    }).join("");

    return `<div class="cell">
      ${label}
      <div class="rulrow"><div class="ename"></div><div class="trk rul">${overlay()}${ruler}</div></div>
      ${empRows}
      <div class="prow"><div class="ename">presencia</div><div class="trk pres">${overlay()}${presCells}</div></div>
    </div>`;
  }

  // ── Resumen semanal a lo ancho (mismo formato que el "Resumen semanal" de la app) ──
  function summarySection(): string {
    const rs = employees.map(emp => ({ emp, sp: splitByEmp.get(emp.id)! }));
    const dayTotals = DAYS_KEYS.map(d => rs.reduce((s, r) =>
      sched.schedule?.[r.emp.id]?.[d]?.code === "normal" ? s + r.sp.days[d].hours : s, 0));
    const dayPeople = DAYS_KEYS.map(d => rs.reduce((n, r) =>
      sched.schedule?.[r.emp.id]?.[d]?.code === "normal" ? n + 1 : n, 0));
    const grand = rs.reduce((s, r) => s + r.sp.total, 0);

    const head = `<tr><td class="wname">Nombre</td><td>Base</td><td>Check</td>${DAYS_KEYS.map(d => `<td class="wd">${DAY_SHORT[d]}</td>`).join("")}<td>Tot</td></tr>`;
    let body = "";
    for (const { emp, sp } of rs) {
      const ok = sp.missing === 0;
      let dayc = "";
      for (const d of DAYS_KEYS) {
        const code = sched.schedule?.[emp.id]?.[d]?.code;
        if (code === "normal") dayc += `<td class="wc work mono">${sp.days[d].hours}</td>`;
        else if (code && code !== "off") dayc += `<td class="wc abs">${code.toUpperCase().slice(0,3)}</td>`;
        else dayc += `<td class="wc off">–</td>`;
      }
      body += `<tr>
        <td class="wname">${esc(emp.name)}</td>
        <td class="mono">${emp.weekly_hours}</td>
        <td><span class="chk ${ok ? "ok" : "no"}">${ok ? "ok" : "✕"}</span></td>
        ${dayc}
        <td class="mono wtot${sp.compl > 0 ? " amber" : ""}"><b>${sp.total}</b></td>
      </tr>`;
    }
    const totRow = `<tr class="ftot"><td class="wname">Total horas</td><td></td><td></td>${dayTotals.map(t => `<td class="mono"><b>${t}</b></td>`).join("")}<td class="mono"><b>${grand}</b></td></tr>`;
    const perRow = `<tr class="fper"><td class="wname">Personas</td><td></td><td></td>${dayPeople.map(n => `<td class="mono">${n}</td>`).join("")}<td></td></tr>`;
    return `<div class="wsum">
      <div class="daylabel" style="color:${c}">RESUMEN SEMANAL</div>
      <table class="wtbl"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${totRow}${perRow}</tfoot></table>
    </div>`;
  }

  const cells = DAYS_KEYS.map(dayCell).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A3 portrait;margin:6mm}
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:'Helvetica Neue',Arial,sans-serif;color:#16202e;font-size:6pt}
.head{display:flex;align-items:center;justify-content:space-between;background:#0b1f3a;color:#fff;padding:2mm 3.5mm;border-radius:2mm 2mm 0 0}
.head .t{font-weight:800;font-size:11pt;letter-spacing:.3px}
.head .t b{color:#ffcb05}
.head .w{font-size:9pt;opacity:.92}
.accent{height:1.4mm;background:${c}}
.key{display:flex;gap:4mm;align-items:center;font-size:6.5pt;color:#6b7686;padding:1mm 1mm 1.5mm}
.key i{display:inline-block;width:3mm;height:2mm;border-radius:0.4mm;vertical-align:middle;margin-right:1mm}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.6mm}
.cell{break-inside:avoid;page-break-inside:avoid;border:0.18mm solid #dde0e6;border-radius:1mm;overflow:hidden}
.daylabel{font-weight:800;font-size:7.5pt;padding:0.6mm 1.2mm;background:#f3f5f8;border-bottom:0.18mm solid #dde0e6;letter-spacing:.4px}
.empty{font-size:6pt;color:#aab2bd;font-style:italic;padding:2mm}
.erow,.rulrow,.prow{display:flex;align-items:stretch;height:3.2mm;border-top:0.15mm solid #eef0f3}
.rulrow{height:3mm;border-top:0}
.prow{height:3mm;border-top:0.3mm solid #c9ced6}
.ename{flex:0 0 30mm;width:30mm;font-size:5pt;line-height:3.2mm;padding-left:1mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-right:0.2mm solid #d7dbe1}
.prow .ename{color:#aab2bd;font-style:italic;font-size:5.4pt;text-align:right;padding-right:1mm}
.trk{position:relative;flex:1;overflow:hidden}
.trk.rul{border-bottom:0.3mm solid #c9ced6}
.band{position:absolute;top:0;bottom:0;background:#f5f6f9}
.vline{position:absolute;top:0;bottom:0;width:0;border-left:0.15mm solid #d2d7df}
.hrlbl{position:absolute;top:0.4mm;font-size:5.4pt;font-weight:700;color:#6b7686;font-family:'Courier New',monospace;padding-left:0.3mm}
.hrlbl.bandtxt{color:#b8c0cc}
.bar{position:absolute;top:0.5mm;height:2.2mm;border-radius:0.5mm}
.blab{position:absolute;top:0.7mm;font-size:5pt;font-weight:700;color:#fff;font-family:'Courier New',monospace;padding-left:0.4mm;white-space:nowrap;z-index:2}
.blab.end{transform:translateX(-100%);padding-left:0;padding-right:0.4mm}
.pcell{position:absolute;top:0;bottom:0;text-align:center;font-size:5.4pt;font-weight:700;color:#6b7686;line-height:3mm}
.pcell.hot{color:#16202e;font-weight:700}
.wsum{break-inside:avoid;page-break-inside:avoid;border:0.18mm solid #dde0e6;border-radius:1mm;overflow:hidden}
.wtbl{width:100%;border-collapse:collapse;font-size:5.6pt;table-layout:fixed}
.wtbl thead td{font-size:5.2pt;font-weight:700;color:#8a93a0;text-transform:uppercase;letter-spacing:.04em;padding:0.7mm 1mm;border-bottom:0.3mm solid #c9ced6;background:#fafbfc;text-align:center}
.wtbl td{padding:0.6mm 1mm;border-bottom:0.15mm solid #eef0f3;text-align:center}
.wtbl td.mono{font-family:'Courier New',monospace}
.wtbl td.wname{width:34%;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.wtbl td.wd{width:6%}
.wtbl td.wc.work{background:#e7f5ef;color:#0f6e56;font-weight:700}
.wtbl td.wc.abs{background:#f0f0f0;color:#5a657c;font-weight:700}
.wtbl td.wc.off{color:#aab2bd}
.wtbl td.wtot{font-weight:700}
.wtbl td.wtot.amber b{color:${AMBER}}
.wtbl tr.ftot td{border-top:0.3mm solid #c9ced6;font-weight:700;padding-top:0.8mm}
.wtbl tr.fper td{color:#6b7686;font-size:5.6pt;padding-bottom:0.8mm}
.chk{display:inline-block;padding:0.3mm 1.4mm;border-radius:2mm;font-size:5.4pt;font-weight:800}
.chk.ok{background:#d8f1e7;color:#0f6e56}
.chk.no{background:#fbe1e8;color:#a50044}
.foot{font-size:6pt;color:#aab2bd;padding:1.5mm 1mm 0;text-align:right}
.foot b{color:${c}}
</style></head><body>
<div class="head"><div class="t">CUADRANTE · <b>${esc(dept.name)}</b></div><div class="w">${esc(weekLbl)} · Camp Nou Planner</div></div>
<div class="accent"></div>
<div class="key"><span><i style="background:${c}"></i>ordinaria</span><span><i style="background:${AMBER}"></i>complementaria</span></div>
<div class="grid">${cells}${summarySection()}</div>
<div class="foot"><b>Camp Nou Planner</b></div>
</body></html>`;

  const w = window.open("","_blank");
  if(w){w.document.write(html);w.document.close();setTimeout(()=>w.print(),400)}
}

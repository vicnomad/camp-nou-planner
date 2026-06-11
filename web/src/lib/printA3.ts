/**
 * A3 portrait print sheet — one page per week, per-day axis.
 * Each day has its OWN time axis (montaje→cierre), filling full width.
 */
import type { Department, Employee, SolveResult, StoreHours } from "./types";
import { DAYS_KEYS } from "./types";
import { weekComplSplit } from "./weekCompl";

const DAY_ES: Record<string, string> = {
  MON:"LUNES",TUE:"MARTES",WED:"MIÉRCOLES",THU:"JUEVES",FRI:"VIERNES",SAT:"SÁBADO",SUN:"DOMINGO"
};
function tm(t:string){const[h,m]=t.split(":").map(Number);return h*60+m}
function hh(m:number){return`${String(Math.floor(((m%1440+1440)%1440)/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`}
function esc(s:string){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}

export function printA3(
  dept: Department, employees: Employee[], sched: SolveResult,
  storeHours: Record<string,StoreHours>, weekLbl: string,
) {
  const p = dept.params;
  const c = dept.color;
  const preM = p.preopen?.minutes ?? 30;
  const postM = p.postclose?.minutes ?? 30;
  const dpw = p.days_per_week ?? 5;

  const absences: string[] = [];

  // Weekly split per employee: complementarias = last hours of the week (MON→SUN order)
  const splitByEmp = new Map(employees.map(e =>
    [e.id, weekComplSplit(sched.schedule?.[e.id], e.weekly_hours, e.weekly_hours / dpw)] as const));

  // Build each day block
  let blocks = "";
  for (const d of DAYS_KEYS) {
    const sh = storeHours[d];
    if (!sh?.open || !sh?.close) continue;
    const openM = tm(sh.open);
    let closeM = tm(sh.close);
    if (closeM <= openM) closeM += 1440;
    let dayStart = openM - preM;
    let dayEnd = closeM + postM;
    if (sh.extra) { let et = tm(sh.extra.to); if (et <= openM) et += 1440; dayEnd = Math.max(dayEnd, et); }
    dayStart = Math.floor(dayStart / 30) * 30;
    dayEnd = Math.ceil(dayEnd / 30) * 30;
    const slots = (dayEnd - dayStart) / 30;
    if (slots <= 0) continue;

    // Collect working employees
    const rows: {name:string;wh:number;hpd:number;start:number;end:number;hours:number;normH:number;complH:number}[] = [];
    for (const emp of employees) {
      const en = sched.schedule?.[emp.id]?.[d];
      if (!en) continue;
      if (en.code === "normal" && en.start && en.end) {
        const hpd = emp.weekly_hours / dpw;
        let endM2 = tm(en.end); if (endM2 <= tm(en.start)) endM2 += 1440;
        const ds = splitByEmp.get(emp.id)!.days[d];
        rows.push({name:emp.name, wh:emp.weekly_hours, hpd, start:tm(en.start), end:endM2, hours:en.hours??hpd, normH:ds.norm, complH:ds.compl});
      } else if (en.code && en.code !== "off") {
        absences.push(`${emp.name} (${en.code.toUpperCase()})`);
      }
    }
    rows.sort((a,b) => a.start - b.start);
    if (rows.length === 0) continue;

    // Meta column widths (mm): name 42, base 11, entrada 11, norm 9, compl 9 = 82mm
    // Available for slots: 297 - 10 (margins) - 82 = 205mm / slots
    const slotW = Math.max(3, (297 - 10 - 82) / slots);

    // Build colgroup
    const slotCol = `<col style="width:${slotW.toFixed(2)}mm">`;
    const cg = `<colgroup><col style="width:42mm"><col style="width:11mm"><col style="width:11mm"><col style="width:9mm"><col style="width:9mm">${slotCol.repeat(slots)}</colgroup>`;

    // Hour ruler
    let ruler = `<tr class="ruler"><td colspan="5" class="mr"></td>`;
    for (let m = dayStart; m < dayEnd; m += 30) {
      const isHour = m % 60 === 0;
      const isBand = m < openM || m >= closeM;
      if (isHour) {
        ruler += `<td colspan="2" class="hr${isBand?" band":""}">${hh(m)}</td>`;
        m += 30; // skip the :30 slot (already in colspan=2)
        if (m >= dayEnd) break;
        continue;
      }
    }
    // Simpler approach: iterate by hours
    ruler = `<tr class="ruler"><td colspan="5" class="mr"></td>`;
    for (let m = dayStart; m < dayEnd; m += 60) {
      const isBand = m < openM || m >= closeM;
      const colsHere = Math.min(2, (dayEnd - m) / 30);
      ruler += `<td colspan="${colsHere}" class="hr${isBand?" band":""}">${hh(m)}</td>`;
    }
    ruler += `</tr>`;

    // Employee rows
    let empRows = "";
    for (const r of rows) {
      const s0 = Math.round((r.start - dayStart) / 30);
      const sl = Math.round((r.end - r.start) / 30);
      const normSlots = Math.min(sl, Math.round(r.normH * 2));
      const complSlots = Math.max(0, sl - normSlots);
      const normH = r.normH;
      const complH = r.complH;
      const before = s0;
      const after = slots - s0 - sl;

      empRows += `<tr>`;
      empRows += `<td class="name">${esc(r.name)}</td>`;
      empRows += `<td class="meta mono">${r.wh}·${r.hpd}h</td>`;
      empRows += `<td class="meta mono">${hh(r.start)}</td>`;
      empRows += `<td class="meta mono">${normH}h</td>`;
      empRows += `<td class="meta mono${complH > 0 ? " compl" : ""}">${complH > 0 ? complH + "h" : "—"}</td>`;
      if (before > 0) empRows += `<td colspan="${before}"></td>`;
      if (normSlots > 0) empRows += `<td class="bar" colspan="${normSlots}" style="background:${c}"><span>${hh(r.start)}–${hh(r.end % 1440)}</span></td>`;
      if (complSlots > 0) empRows += `<td class="bar amber" colspan="${complSlots}">${normSlots === 0 ? `<span>${hh(r.start)}–${hh(r.end%1440)}</span>` : ""}</td>`;
      if (after > 0) empRows += `<td colspan="${after}"></td>`;
      empRows += `</tr>`;
    }

    // Count row
    const counts = new Array(slots).fill(0);
    for (const r of rows) {
      const s0 = Math.round((r.start - dayStart) / 30);
      const sl = Math.round((r.end - r.start) / 30);
      for (let i = 0; i < sl; i++) { const j = s0+i; if (j >= 0 && j < slots) counts[j]++; }
    }
    const countCells = counts.map(n => `<td class="cnt">${n||""}</td>`).join("");

    blocks += `<div class="dayblock">
      <div class="daylabel" style="color:${c}">${DAY_ES[d] ?? d}</div>
      <table>${cg}
        <thead>${ruler}
          <tr class="metahead"><td>Nombre</td><td>Base</td><td>Ent.</td><td>Norm.</td><td>Compl.</td><td colspan="${slots}"></td></tr>
        </thead>
        <tbody>${empRows}
          <tr class="countrow"><td class="cntlbl" colspan="5">personas</td>${countCells}</tr>
        </tbody>
      </table>
    </div>`;
  }

  const uniqueAbs = [...new Set(absences)];

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A3 portrait;margin:5mm}
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:'Helvetica Neue',Arial,sans-serif;color:#16202e;font-size:6pt}
.head{display:flex;align-items:center;justify-content:space-between;background:#0b1f3a;color:#fff;padding:2mm 3.5mm;border-radius:2mm 2mm 0 0}
.head .t{font-weight:800;font-size:11pt;letter-spacing:.3px}
.head .t b{color:#ffcb05}
.head .w{font-size:9pt;opacity:.92}
.accent{height:1.4mm;background:${c};margin-bottom:1mm}
.dayblock{page-break-inside:avoid;margin-bottom:0.8mm}
.daylabel{font-weight:800;font-size:7.5pt;padding:0.5mm 1mm;background:#f3f5f8;border:0.18mm solid #dde0e6;letter-spacing:.4px}
table{width:100%;border-collapse:collapse;table-layout:fixed}
td{height:3mm;border:0.15mm solid #e6e8ec;padding:0;font-size:5.8pt;overflow:hidden;line-height:1}
tr.ruler td{border:0;height:2.5mm}
td.mr{border-bottom:0.3mm solid #c9ced6}
td.hr{font-size:6.5pt;color:#6b7686;text-align:left;padding-left:0.5mm;font-weight:700;border-bottom:0.3mm solid #c9ced6;font-family:'Courier New',monospace}
td.hr.band{background:#f7f8fa;color:#b0b8c6}
tr.metahead td{font-size:5pt;font-weight:700;color:#8a93a0;text-transform:uppercase;letter-spacing:.04em;padding:0.3mm 0.5mm;border-bottom:0.3mm solid #c9ced6;height:2.2mm}
td.name{padding-left:0.8mm;font-size:5.8pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-right:0.2mm solid #d7dbe1}
td.meta{text-align:center;font-size:5.5pt;color:#5a657c;border-right:0.2mm solid #e6e8ec}
td.meta.mono{font-family:'Courier New',monospace}
td.meta.compl{color:#a50044;font-weight:700}
td.bar{position:relative}
td.bar span{color:#fff;font-size:5pt;font-weight:700;padding-left:0.6mm;font-family:'Courier New',monospace;white-space:nowrap}
td.bar.amber{background:#d4940a}
tr.countrow td{height:2mm;background:#fafbfc;border-top:0.3mm solid #c9ced6}
td.cnt{text-align:center;font-size:5.5pt;color:#8a93a0;font-weight:700}
td.cntlbl{color:#aab2bd;font-style:italic;font-size:5.5pt;text-align:right;padding-right:1mm}
.foot{font-size:6.5pt;color:#6b7686;padding:1mm 1mm 0}
.foot b{color:${c}}
</style></head><body>
<div class="head"><div class="t">CUADRANTE · <b>${esc(dept.name)}</b></div><div class="w">${esc(weekLbl)} · Camp Nou Planner</div></div>
<div class="accent"></div>
${blocks}
<div class="foot">${uniqueAbs.length>0?`Ausencias semana: <b>${uniqueAbs.join("</b> · <b>")}</b> · `:""}Solo se muestran las personas que trabajan cada día.</div>
</body></html>`;

  const w = window.open("","_blank");
  if(w){w.document.write(html);w.document.close();setTimeout(()=>w.print(),400)}
}

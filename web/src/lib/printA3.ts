/**
 * Generate and print an A3 portrait schedule sheet.
 * Opens a new window with the HTML and triggers print dialog.
 */
import type { Department, Employee, SolveResult, DayKey, StoreHours } from "./types";
import { DAYS_KEYS, DAY_LABELS } from "./types";

const DAY_SHORT_ES: Record<string, string> = {
  MON: "LUN", TUE: "MAR", WED: "MIÉ", THU: "JUE", FRI: "VIE", SAT: "SÁB", SUN: "DOM",
};

function tm(t: string) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function hh(m: number) { return `${String(Math.floor(((m % 1440 + 1440) % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }

export function printA3(
  department: Department,
  employees: Employee[],
  schedule: SolveResult,
  storeHours: Record<string, StoreHours>,
  weekLabel: string,
) {
  const params = department.params;
  const color = department.color;
  const preMin = params.preopen?.minutes ?? 30;
  const postMin = params.postclose?.minutes ?? 30;
  const dpw = params.days_per_week ?? 5;

  // Determine global time range (earliest preopen → latest postclose)
  let globalStart = 1440, globalEnd = 0;
  for (const d of DAYS_KEYS) {
    const sh = storeHours[d];
    if (!sh?.open || !sh?.close) continue;
    const o = tm(sh.open);
    let c = tm(sh.close);
    if (c <= o) c += 1440;
    globalStart = Math.min(globalStart, o - preMin);
    globalEnd = Math.max(globalEnd, c + postMin);
    if (sh.extra) {
      let et = tm(sh.extra.to);
      if (et <= o) et += 1440;
      globalEnd = Math.max(globalEnd, et);
    }
  }
  // Round to full hours
  globalStart = Math.floor(globalStart / 60) * 60;
  globalEnd = Math.ceil(globalEnd / 60) * 60;
  const totalSlots = (globalEnd - globalStart) / 30;
  const totalHours = totalSlots / 2;

  // Column widths
  const dayW = "11mm";
  const nameW = "46mm";
  const availW = `${(297 - 5 * 2 - 11 - 46) / totalSlots}mm`; // A3 width - margins - day - name

  // Colgroup
  const colgroup = `<colgroup><col style="width:${dayW}"><col style="width:${nameW}">${Array(totalSlots).fill(`<col style="width:${availW}">`).join("")}</colgroup>`;

  // Hour ruler
  let ruler = `<tr class="ruler"><td class="meta-ruler" colspan="2"></td>`;
  for (let m = globalStart; m < globalEnd; m += 60) {
    ruler += `<td class="hr" colspan="2">${String(Math.floor(m / 60) % 24).padStart(2, "0")}</td>`;
  }
  ruler += `</tr>`;

  // Build day blocks
  const absences: string[] = [];
  let dayRows = "";

  for (const d of DAYS_KEYS) {
    const sh = storeHours[d];
    if (!sh?.open || !sh?.close) continue;

    // Collect working employees for this day, sorted by start time
    const working: { name: string; start: number; end: number; hours: number; baseSlots: number }[] = [];
    for (const emp of employees) {
      const entry = schedule.schedule?.[emp.id]?.[d];
      if (!entry) continue;
      if (entry.code === "normal" && entry.start && entry.end) {
        const hpd = emp.weekly_hours / dpw;
        working.push({
          name: emp.name,
          start: tm(entry.start),
          end: tm(entry.end) <= tm(entry.start) ? tm(entry.end) + 1440 : tm(entry.end),
          hours: entry.hours ?? hpd,
          baseSlots: Math.round(hpd * 2),
        });
      } else if (entry.code && entry.code !== "off") {
        absences.push(`${emp.name} (${entry.code.toUpperCase()})`);
      }
    }
    working.sort((a, b) => a.start - b.start);

    const rowspan = working.length + 1; // employees + count row

    // Employee rows
    working.forEach((w, idx) => {
      const startSlot = Math.max(0, Math.round((w.start - globalStart) / 30));
      const shiftSlots = Math.round((w.end - w.start) / 30);
      const before = startSlot;
      const after = totalSlots - startSlot - shiftSlots;
      const normalSlots = Math.min(shiftSlots, w.baseSlots);
      const complSlots = Math.max(0, shiftSlots - w.baseSlots);

      let row = "<tr>";
      if (idx === 0) {
        row += `<td class="day" rowspan="${rowspan}">${DAY_SHORT_ES[d] ?? d}</td>`;
      }
      row += `<td class="name">${escHtml(w.name)}</td>`;
      if (before > 0) row += `<td colspan="${before}"></td>`;
      if (normalSlots > 0) {
        row += `<td class="bar" colspan="${normalSlots}" style="background:${color}"><span>${hh(w.start)}–${hh(w.end % 1440)}</span></td>`;
      }
      if (complSlots > 0) {
        row += `<td class="bar" colspan="${complSlots}" style="background:#d4940a">${normalSlots === 0 ? `<span>${hh(w.start)}–${hh(w.end % 1440)}</span>` : ""}</td>`;
      }
      if (after > 0) row += `<td colspan="${after}"></td>`;
      row += "</tr>";
      dayRows += row;
    });

    // Count row
    const counts = new Array(totalSlots).fill(0);
    for (const w of working) {
      const s0 = Math.max(0, Math.round((w.start - globalStart) / 30));
      const sl = Math.round((w.end - w.start) / 30);
      for (let i = 0; i < sl; i++) {
        const idx2 = s0 + i;
        if (idx2 >= 0 && idx2 < totalSlots) counts[idx2]++;
      }
    }
    if (working.length === 0) {
      dayRows += `<tr><td class="day">${DAY_SHORT_ES[d]}</td><td class="name" style="color:#aab2bd;font-style:italic">sin personal</td><td colspan="${totalSlots}"></td></tr>`;
      dayRows += `<tr class="countrow"><td class="name cntlbl">personas</td>${counts.map(c => `<td class="cnt">${c || ""}</td>`).join("")}</tr>`;
    } else {
      dayRows += `<tr class="countrow"><td class="name cntlbl">personas</td>${counts.map(c => `<td class="cnt">${c || ""}</td>`).join("")}</tr>`;
    }
  }

  // Deduplicate absences
  const uniqueAbs = [...new Set(absences)];

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A3 portrait; margin: 5mm; }
* { box-sizing: border-box; }
html,body { margin:0; padding:0; font-family:'Helvetica Neue',Arial,sans-serif; color:#16202e; }
.head { display:flex; align-items:center; justify-content:space-between;
        background:#0b1f3a; color:#fff; padding:2mm 3.5mm; border-radius:2mm 2mm 0 0; }
.head .t { font-weight:800; font-size:11pt; letter-spacing:.3px; }
.head .t b { color:#ffcb05; }
.head .w { font-size:9pt; opacity:.92; }
.accent { height:1.4mm; background:${color}; }
table { width:100%; border-collapse:collapse; table-layout:fixed; }
td { height:3.25mm; border:0.18mm solid #e6e8ec; padding:0; font-size:6pt; overflow:hidden; line-height:1; }
tr.ruler td { border:0; }
td.hr { font-size:7pt; color:#6b7686; text-align:left; padding-left:0.6mm; font-weight:700;
        border-bottom:0.4mm solid #c9ced6; font-family:'Courier New',monospace; }
td.meta-ruler { border-bottom:0.4mm solid #c9ced6; }
td.day { background:#f3f5f8; color:${color}; font-weight:800; font-size:8pt; text-align:center;
         border-right:0.5mm solid #c9ced6; letter-spacing:.3px; }
td.name { padding-left:1.2mm; font-size:6pt; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
          border-right:0.3mm solid #d7dbe1; }
td.bar span { color:#fff; font-size:5.4pt; font-weight:700; padding-left:1mm;
              font-family:'Courier New',monospace; white-space:nowrap; }
tr.countrow td { height:2.3mm; background:#fafbfc; border-top:0.4mm solid #c9ced6; }
td.cnt { text-align:center; font-size:6pt; color:#8a93a0; font-weight:700; }
td.cntlbl { color:#aab2bd; font-style:italic; font-size:6pt; }
.foot { font-size:7pt; color:#6b7686; padding:1.5mm 1mm 0; }
.foot b { color:${color}; }
.dayblock { page-break-inside: avoid; }
</style></head><body>
<div class="head">
  <div class="t">CUADRANTE · <b>${escHtml(department.name)}</b></div>
  <div class="w">${escHtml(weekLabel)} · Camp Nou Planner</div>
</div>
<div class="accent"></div>
<table>${colgroup}${ruler}${dayRows}</table>
<div class="foot">${uniqueAbs.length > 0 ? `Ausencias semana: <b>${uniqueAbs.join("</b> · <b>")}</b> · ` : ""}Solo se muestran las personas que trabajan cada día.</div>
</body></html>`;

  const w = window.open("", "_blank");
  if (w) {
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 400);
  }
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

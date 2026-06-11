/**
 * Export schedule to Cegid .xlsx format.
 * One sheet "Cuadrante", no header row, all values as TEXT.
 */
import type { Employee, SolveResult, DayKey } from "./types";
import { DAYS_KEYS } from "./types";
import { isoWeekNumber } from "./week";
import { weekComplSplit } from "./weekCompl";

// Code → color mapping for DIA column
const CODE_COLORS: Record<string, string> = {
  VCN: "FFF5E6C7", VAA: "FFF5E6C7", FRC: "FFD8F1E7", DEC: "FFDBE7FB",
  BJA: "FFFDEAEA", DLB: "FFF0F0F0", IP2: "FFE7E0FB",
};
const DEFAULT_CODE_BG = "FFFFFFFF";

function fmtHM(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

function dateStr(mondayStr: string, dayIdx: number): string {
  const d = new Date(mondayStr + "T00:00:00");
  d.setDate(d.getDate() + dayIdx);
  return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`;
}

export async function exportCegidXlsx(
  deptName: string,
  employees: Employee[],
  schedule: SolveResult,
  weekMonday: string,
  dpw: number,
) {
  const ExcelJS = (await import("exceljs")).default;
  const { saveAs } = await import("file-saver");

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Cuadrante", {
    views: [{ state: "frozen", xSplit: 2, ySplit: 1 }],
  });

  const arialFont = { name: "Arial", size: 9 };
  const arialSmall = { name: "Arial", size: 8 };

  // Column widths: A=26, B=13, then per day 5 cols: 6, 8, 8, 11, 11
  const colWidths = [26, 13];
  for (let i = 0; i < 7; i++) colWidths.push(6, 8, 8, 11, 11);
  colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // Row 1: dates in the DIA column of each day block
  const row1 = ws.getRow(1);
  row1.height = 14;
  for (let di = 0; di < 7; di++) {
    const col = 3 + di * 5; // DIA column for this day
    const cell = row1.getCell(col);
    cell.value = dateStr(weekMonday, di);
    cell.font = { ...arialSmall, bold: true, color: { argb: "FF5A657C" } };
    cell.alignment = { horizontal: "center" };
  }

  // Employee rows (row 2+)
  const sorted = [...employees].sort((a, b) => a.name.localeCompare(b.name));

  sorted.forEach((emp, ri) => {
    const row = ws.getRow(ri + 2);
    row.height = 13;
    const hpd = emp.weekly_hours / dpw;
    // Weekly split: normales = min(Σ_semana, contrato); complementarias = the LAST hours of the week
    const split = weekComplSplit(schedule.schedule?.[emp.id], emp.weekly_hours, hpd);

    // A = name
    const cA = row.getCell(1);
    cA.value = emp.name;
    cA.font = { ...arialFont, bold: true };

    // B = DNI
    const cB = row.getCell(2);
    cB.value = emp.dni ?? "";
    cB.font = arialSmall;

    // Per day
    for (let di = 0; di < 7; di++) {
      const d = DAYS_KEYS[di] as DayKey;
      const entry = schedule.schedule?.[emp.id]?.[d];
      const baseCol = 3 + di * 5;

      const cDia = row.getCell(baseCol);
      const cEnt = row.getCell(baseCol + 1);
      const cEnt2 = row.getCell(baseCol + 2);
      const cOrd = row.getCell(baseCol + 3);
      const cComp = row.getCell(baseCol + 4);

      // Default font
      [cDia, cEnt, cEnt2, cOrd, cComp].forEach(c => { c.font = arialSmall; c.alignment = { horizontal: "center" }; });

      if (!entry || entry.code === "off") {
        // Day off
        cDia.value = "DLB";
        cEnt.value = "0:00"; cEnt2.value = "0:00";
        cOrd.value = "0:00"; cComp.value = "0:00";
        cDia.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CODE_COLORS.DLB } };
      } else if (entry.code === "normal" && entry.start) {
        // Working — weekly split for this day
        const { hours, norm: normH, compl: complH } = split.days[d];
        const hasCompl = complH > 0.01;

        cDia.value = hasCompl ? "IP2" : `${fmtHM(hours)}`;
        cEnt.value = entry.start;
        cEnt2.value = entry.start;
        cOrd.value = fmtHM(normH);
        cComp.value = fmtHM(complH);

        if (hasCompl) {
          cDia.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CODE_COLORS.IP2 } };
          cDia.font = { ...arialSmall, bold: true, color: { argb: "FF5B32B0" } };
        }
        if (complH > 0.01) {
          cComp.font = { ...arialSmall, bold: true, color: { argb: "FFA50044" } };
        }
      } else {
        // Absence (VCN, BJA, etc.)
        const code = entry.code.toUpperCase();
        cDia.value = code;
        cEnt.value = "0:00"; cEnt2.value = "0:00";
        cOrd.value = "0:00"; cComp.value = "0:00";
        cDia.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CODE_COLORS[code] ?? DEFAULT_CODE_BG } };
        cDia.font = { ...arialSmall, bold: true };
      }
    }
  });

  // Thin borders on all used cells
  const thin = { style: "thin" as const, color: { argb: "FFE0E0E0" } };
  const lastRow = sorted.length + 1;
  const lastCol = 2 + 7 * 5;
  for (let r = 1; r <= lastRow; r++) {
    for (let c2 = 1; c2 <= lastCol; c2++) {
      ws.getRow(r).getCell(c2).border = { top: thin, bottom: thin, left: thin, right: thin };
    }
  }

  // Generate and save
  const wn = isoWeekNumber(weekMonday);
  const yr = new Date(weekMonday + "T00:00:00").getFullYear();
  const fileName = `Cegid_${deptName.replace(/[^a-zA-Z0-9]/g, "_")}_Sem${wn}_${yr}.xlsx`;

  const buf = await wb.xlsx.writeBuffer();
  saveAs(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileName);
}

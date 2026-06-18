/** Shared week utilities — used by page.tsx, GridView, TeamView */

export function getMonday(d: Date) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(dt.getFullYear(), dt.getMonth(), diff);
}

export function fmtDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isoWeek(d: Date): number {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function fiscalYearStartMonday(year: number): Date {
  return getMonday(new Date(year, 6, 1)); // 6 = julio
}
function dayIndexUTC(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}
/** Semana FISCAL (1-based): ejercicio empieza el lunes de la semana que contiene el 1-jul.
 *  SOLO display; weekIsoId sigue siendo ISO. */
export function fiscalWeek(d: Date): number {
  const y = d.getFullYear();
  let start = fiscalYearStartMonday(y);
  if (dayIndexUTC(d) < dayIndexUTC(start)) start = fiscalYearStartMonday(y - 1);
  return Math.round((dayIndexUTC(d) - dayIndexUTC(start)) / 7) + 1;
}
export function fiscalWeekNumber(mondayStr: string): number {
  return fiscalWeek(new Date(mondayStr + "T00:00:00"));
}

export function weekIsoId(mondayStr: string): string {
  const d = new Date(mondayStr + "T00:00:00");
  const wn = isoWeek(d);
  return `${d.getFullYear()}-W${String(wn).padStart(2, "0")}`;
}

export function weekLabel(mondayStr: string): string {
  const monday = new Date(mondayStr + "T00:00:00");
  const wn = fiscalWeek(monday);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const m1 = months[monday.getMonth()];
  const m2 = months[sunday.getMonth()];
  const dayRange = monday.getMonth() === sunday.getMonth()
    ? `${monday.getDate()}–${sunday.getDate()} ${m2}`
    : `${monday.getDate()} ${m1}–${sunday.getDate()} ${m2}`;
  return `Semana ${wn} · ${dayRange} ${monday.getFullYear()}`;
}

export function shiftWeek(mondayStr: string, delta: number): string {
  const d = new Date(mondayStr + "T00:00:00");
  d.setDate(d.getDate() + delta * 7);
  return fmtDate(getMonday(d));
}

export function isoWeekNumber(mondayStr: string): number {
  return isoWeek(new Date(mondayStr + "T00:00:00"));
}

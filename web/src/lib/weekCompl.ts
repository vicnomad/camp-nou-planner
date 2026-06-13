/**
 * Cómputo SEMANAL de complementarias con JORNADA ESTÁNDAR DIARIA + GATE SEMANAL.
 *
 * - `dailyStd` = jornada estándar diaria = contrato/días (p.ej. 25/5 = 5h). También
 *   es el valor por defecto de un día trabajado sin horas explícitas.
 * - GATE semanal: las complementarias de la semana = max(0, Σ_horas − contrato).
 *   Si la semana NO supera el contrato no hay complementaria en ningún día, aunque
 *   algún día pase de la jornada estándar (otro día lo compensa por debajo).
 * - Reparto por día: el exceso semanal se atribuye PRIMERO a los días que superan
 *   la jornada estándar (MON→SUN) → el ámbar aparece EN el día que sube de 5h, ese
 *   mismo día. Fallback (un día extra entero a jornada estándar, sin ningún día por
 *   encima): se reparte en las últimas horas trabajadas (MON→SUN al revés).
 *
 * Los totales (total, norm=min(Σ,contrato), compl, missing) se calculan sobre la
 * suma semanal. Por día rem = norm = parte VERDE: la rejilla pinta verde los
 * primeros rem*2 slots y ámbar el resto → verde = normal, ámbar = complementaria.
 */
import type { ScheduleEntry, DayKey } from "./types";
import { DAYS_KEYS } from "./types";

// Ausencias que restan días de contrato (mismo conjunto que el motor: solver.py ABSENCE_REDUCES).
// El DLB (día libre) NO resta. Los códigos reales de la app: VCN/VAA/FRC/DEC/BJA (+ legacy "vacation").
export const ABSENCE_REDUCES = new Set(["VCN", "VAA", "FRC", "DEC", "BJA", "vacation"]);

/**
 * Base EFECTIVA de la semana = contrato − (días de ausencia reductora × jornada estándar).
 * Es la base contra la que se cuentan complementarias y "faltan". Cuadra con el motor (#3),
 * que genera menos días por esas ausencias. El DLB no resta (no aparece falso "faltan").
 */
export function effectiveContract(
  emp: { weekly_hours: number; absences?: { type: string; days?: string[] }[] },
  dailyStd: number,
): number {
  const reducingDays = (emp.absences ?? []).reduce(
    (n, a) => ABSENCE_REDUCES.has(a.type) ? n + (Array.isArray(a.days) ? a.days.length : 0) : n, 0);
  return Math.max(0, emp.weekly_hours - reducingDays * dailyStd);
}

export interface DaySplit {
  hours: number; // horas trabajadas ese día
  norm: number;  // parte normal (verde) de ese día
  compl: number; // parte complementaria (ámbar) de ese día
  rem: number;   // = norm: horas verdes del día (la rejilla pinta verde los primeros rem*2 slots)
}

export interface WeekSplit {
  days: Record<DayKey, DaySplit>;
  total: number;   // Σ horas semana
  norm: number;    // min(Σ, contrato)
  compl: number;   // max(0, Σ − contrato)
  missing: number; // max(0, contrato − Σ)
  worked: boolean; // tiene al menos un día "normal"
}

export function weekComplSplit(
  entries: Record<string, ScheduleEntry> | undefined,
  contract: number,
  dailyStd: number,
  editedDays?: Set<DayKey>,
): WeekSplit {
  void editedDays; // ya no se usa para repartir; se mantiene en la firma (limpieza para otro día)

  // 1) horas por día, total semanal y si trabaja algún día
  const hours = {} as Record<DayKey, number>;
  let total = 0;
  let worked = false;
  for (const d of DAYS_KEYS) {
    const e = entries?.[d];
    const isWork = e?.code === "normal";
    if (isWork) worked = true;
    hours[d] = isWork ? (e.hours ?? dailyStd) : 0;
    total += hours[d];
  }

  // 1.5) base EFECTIVA contada del PROPIO cuadrante (fuente de verdad): el motor escribe
  // el código real de cada ausencia en sched[día] (DEC/VCN/FRC/...). Reducimos el contrato
  // por cada día con ausencia reductora presente en `entries`. Así cuadra siempre con lo que
  // se ve, aunque la ausencia se generara cuando era global y ya no esté en el override.
  const reducingDays = DAYS_KEYS.reduce((n, d) => {
    const c = entries?.[d]?.code;
    return c && ABSENCE_REDUCES.has(c) ? n + 1 : n;
  }, 0);
  const effContract = Math.max(0, contract - reducingDays * dailyStd);

  // 2) GATE semanal: si la semana no supera la base EFECTIVA, no hay ámbar en ningún día
  const weeklyCompl = Math.max(0, total - effContract);

  // 3) reparto de la complementaria por día (Σ compl[d] === weeklyCompl)
  const compl = {} as Record<DayKey, number>;
  for (const d of DAYS_KEYS) compl[d] = 0;
  let restante = weeklyCompl;
  // PASE 1 — días por encima de la jornada estándar (MON→SUN): el día que sube de 5h se lleva el ámbar
  for (const d of DAYS_KEYS) {
    if (restante <= 0) break;
    const over = Math.max(0, hours[d] - dailyStd);
    const take = Math.min(over, restante);
    compl[d] = take;
    restante -= take;
  }
  // PASE 2 — fallback (p.ej. un día extra entero a jornada estándar): últimas horas trabajadas (MON→SUN al revés)
  for (let i = DAYS_KEYS.length - 1; i >= 0 && restante > 0; i--) {
    const d = DAYS_KEYS[i];
    const take = Math.min(hours[d] - compl[d], restante);
    compl[d] += take;
    restante -= take;
  }

  // 4) por día: rem = norm = parte verde
  const days = {} as Record<DayKey, DaySplit>;
  for (const d of DAYS_KEYS) {
    const norm = hours[d] - compl[d];
    days[d] = { hours: hours[d], norm, compl: compl[d], rem: norm };
  }

  // 5)
  return {
    days,
    total,
    norm: Math.min(total, effContract),
    compl: weeklyCompl,
    missing: Math.max(0, effContract - total),
    worked,
  };
}

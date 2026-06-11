/**
 * Cómputo SEMANAL de complementarias, sobre el horario efectivo de la semana
 * (generado + ediciones manuales):
 *   normales        = min(Σ_horas_semana, contrato)
 *   complementarias = max(0, Σ_horas_semana − contrato)
 * El exceso se atribuye a las ÚLTIMAS horas de la semana, en orden MON→SUN
 * (y dentro de un día, al final del turno).
 */
import type { ScheduleEntry, DayKey } from "./types";
import { DAYS_KEYS } from "./types";

export interface DaySplit {
  hours: number; // horas trabajadas ese día
  norm: number;  // parte normal de ese día
  compl: number; // parte complementaria de ese día
  rem: number;   // horas normales aún disponibles al empezar el día (contrato − acumulado previo)
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
  fallbackHpd: number,
): WeekSplit {
  let cum = 0;
  let worked = false;
  const days = {} as Record<DayKey, DaySplit>;
  for (const d of DAYS_KEYS) {
    const e = entries?.[d];
    const isWork = e?.code === "normal";
    if (isWork) worked = true;
    const hours = isWork ? (e.hours ?? fallbackHpd) : 0;
    const rem = Math.max(0, contract - cum);
    const norm = Math.min(hours, rem);
    days[d] = { hours, norm, compl: hours - norm, rem };
    cum += hours;
  }
  return {
    days,
    total: cum,
    norm: Math.min(cum, contract),
    compl: Math.max(0, cum - contract),
    missing: Math.max(0, contract - cum),
    worked,
  };
}

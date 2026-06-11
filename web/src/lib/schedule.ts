/**
 * Horario EFECTIVO = cuadrante generado (schedules/{...}) fusionado con las
 * ediciones manuales de horas (scheduleEdits/{...}).
 *
 * El efectivo es la ÚNICA fuente de verdad para: pintado de la rejilla,
 * weekComplSplit, totales de cabecera, ficha del trabajador, export Cegid y
 * cuadrante A3. Nada debe leer el generado "crudo" ignorando las ediciones.
 */
import type { SolveResult, ScheduleEntry, DayKey } from "./types";

/** empId → (día → entrada editada a mano). */
export type ScheduleEdits = Record<string, Partial<Record<DayKey, ScheduleEntry>>>;

export function hasEdits(edits: ScheduleEdits | undefined | null): boolean {
  return !!edits && Object.values(edits).some((d) => d && Object.keys(d).length > 0);
}

/** Días con al menos una edición manual (para recalcular cobertura solo donde toca). */
export function editedDays(edits: ScheduleEdits | undefined | null): Set<DayKey> {
  const out = new Set<DayKey>();
  if (!edits) return out;
  for (const days of Object.values(edits)) {
    for (const d of Object.keys(days ?? {})) out.add(d as DayKey);
  }
  return out;
}

/** Días editados a mano de UN empleado (para atribuir la complementaria en su día editado). */
export function editedDaysOf(edits: ScheduleEdits | undefined | null, empId: string): Set<DayKey> {
  return new Set(Object.keys(edits?.[empId] ?? {}) as DayKey[]);
}

/**
 * Fusiona el cuadrante generado con las ediciones manuales.
 * Devuelve un SolveResult nuevo (no muta el base). La cobertura se conserva tal
 * cual; quien necesite el recuento por franja recalculado debe hacerlo aparte.
 */
export function mergeSchedule(
  base: SolveResult | null,
  edits: ScheduleEdits | undefined | null,
): SolveResult | null {
  if (!base) return base;
  if (!hasEdits(edits)) return base;
  const schedule: SolveResult["schedule"] = {};
  for (const [empId, days] of Object.entries(base.schedule ?? {})) schedule[empId] = { ...days };
  for (const [empId, days] of Object.entries(edits!)) {
    if (!days) continue;
    schedule[empId] = { ...(schedule[empId] ?? {}) };
    for (const [day, entry] of Object.entries(days)) {
      if (entry) schedule[empId][day] = entry;
    }
  }
  return { ...base, schedule };
}

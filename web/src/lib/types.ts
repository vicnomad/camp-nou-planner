export interface StoreHours {
  open: string;
  close: string;
  special?: string;
  extra?: { from: string; to: string; min: number; max: number };
}

export interface BillingProfile {
  [hour: string]: number;
}

export interface Billing {
  daily: Record<string, number>;
  productivity_eur_per_person_hour: number;
  profiles: Record<string, BillingProfile>;
}

export interface DepartmentParams {
  grid_default_start: string;
  days_per_week: number;
  preopen: { minutes: number; min: number; max: number };
  postclose: { minutes: number; min: number; max: number };
  store_hours: Record<string, StoreHours>;
  billing: Billing;
}

export interface Department {
  id: string;
  name: string;
  color: string;
  params: DepartmentParams;
}

export interface AbsenceType {
  code: string;
  label: string;
  countsAsWorked: boolean;
}

export const DEFAULT_ABSENCE_TYPES: AbsenceType[] = [
  { code: "VCN", label: "Vacaciones", countsAsWorked: false },
  { code: "VAA", label: "Vacaciones año anterior", countsAsWorked: false },
  { code: "FRC", label: "Festivo recuperado", countsAsWorked: false },
  { code: "DEC", label: "Día de convenio", countsAsWorked: false },
  { code: "BJA", label: "Baja", countsAsWorked: false },
  { code: "DLB", label: "Día libre", countsAsWorked: false },
];

export interface Absence {
  type: string; // code from AbsenceType (e.g. "VCN", "BJA")
  days: string[];
}

export interface Employee {
  id: string;
  name: string;
  dni: string;
  department: string;
  weekly_hours: number;
  availability: "M" | "T" | "F";
  fixed: Record<string, string> | null;
  absences: Absence[];
}

export interface ScheduleEntry {
  start?: string;
  end?: string;
  hours?: number;
  code: string;
}

export interface CoverageSlot {
  time: string;
  target: number;
  assigned: number;
}

export interface SolveResult {
  status: string;
  objective: number | null;
  schedule: Record<string, Record<string, ScheduleEntry>>;
  coverage: Record<string, CoverageSlot[]>;
  warnings: string[];
}

export const DAYS_KEYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type DayKey = (typeof DAYS_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  MON: "Lunes", TUE: "Martes", WED: "Miércoles", THU: "Jueves",
  FRI: "Viernes", SAT: "Sábado", SUN: "Domingo",
};

export const DAY_SHORT: Record<DayKey, string> = {
  MON: "Lun", TUE: "Mar", WED: "Mié", THU: "Jue",
  FRI: "Vie", SAT: "Sáb", SUN: "Dom",
};

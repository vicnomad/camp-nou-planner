"use client";

import { useState } from "react";

const SOLVER_URL = process.env.NEXT_PUBLIC_SOLVER_URL || "https://camp-nou-engine.vercel.app";

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

const SEED = {
  department: { id: "apparel", name: "Apparel" },
  params: {
    grid_default_start: "07:00",
    days_per_week: 5,
    preopen: { minutes: 30, min: 2, max: 3 },
    postclose: { minutes: 30, min: 2, max: 3 },
    store_hours: {
      MON: { open: "08:00", close: "21:00" },
      TUE: { open: "08:00", close: "21:00" },
      WED: { open: "08:00", close: "21:00" },
      THU: { open: "08:00", close: "21:00", special: "inventory", extra: { from: "21:00", to: "01:00", min: 2, max: 3 } },
      FRI: { open: "08:00", close: "21:00" },
      SAT: { open: "08:00", close: "23:00", special: "match" },
      SUN: { open: "09:00", close: "21:00" },
    },
    billing: {
      daily: { MON: 9000, TUE: 9500, WED: 10000, THU: 10000, FRI: 13000, SAT: 16000, SUN: 10000 },
      productivity_eur_per_person_hour: 420,
      profiles: {
        normal: { "8":3,"9":5,"10":11,"11":13,"12":12,"13":9,"14":7,"15":7,"16":9,"17":11,"18":11,"19":9,"20":5,"21":3 },
        match:  { "8":2,"9":3,"10":6,"11":7,"12":7,"13":6,"14":6,"15":7,"16":8,"17":9,"18":9,"19":10,"20":11,"21":14,"22":14,"23":9 },
      },
    },
  },
  employees: [
    { id: "E01", name: "López, Ana",        weekly_hours: 25, availability: "M" },
    { id: "E02", name: "Martín, Carlos",     weekly_hours: 25, availability: "M" },
    { id: "E03", name: "Roca, Marta",        weekly_hours: 25, availability: "M" },
    { id: "E04", name: "Khayari, Hajar",     weekly_hours: 25, availability: "T", vacations: ["THU","FRI"] },
    { id: "E05", name: "Fernández, Jorge",   weekly_hours: 25, availability: "T" },
    { id: "E06", name: "Navarro, Lucía",     weekly_hours: 25, availability: "T" },
    { id: "E07", name: "Casas, David",       weekly_hours: 25, availability: "F", fixed: { MON:"10:00",TUE:"10:00",WED:"10:00",THU:"10:00",FRI:"10:00",SAT:"off",SUN:"off" } },
    { id: "E08", name: "Torres, Pablo",      weekly_hours: 35, availability: "F" },
    { id: "E09", name: "Vidal, Elena",       weekly_hours: 25, availability: "F" },
  ],
};

interface ScheduleEntry {
  start?: string;
  end?: string;
  hours?: number;
  code: string;
}

interface SolveResult {
  status: string;
  objective: number | null;
  schedule: Record<string, Record<string, ScheduleEntry>>;
  coverage: Record<string, { time: string; target: number; assigned: number }[]>;
  warnings: string[];
}

export default function Home() {
  const [result, setResult] = useState<SolveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSolve() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${SOLVER_URL}/api/solve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(SEED),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SolveResult = await res.json();
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-2">Camp Nou Planner</h1>
      <p className="text-gray-500 mb-6">Test page — Apparel department solver</p>

      <button
        onClick={handleSolve}
        disabled={loading}
        className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Solving..." : "Solve Apparel week"}
      </button>

      {error && <p className="mt-4 text-red-600">Error: {error}</p>}

      {result && (
        <div className="mt-6 space-y-6">
          {/* Status */}
          <div className="flex gap-6 text-sm">
            <span className={`font-mono px-2 py-1 rounded ${result.status === "OPTIMAL" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}`}>
              {result.status}
            </span>
            <span className="text-gray-600">Objective: {result.objective}</span>
          </div>

          {/* Warnings */}
          {result.warnings.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
              <p className="font-semibold text-yellow-800 mb-1">Warnings</p>
              {result.warnings.map((w, i) => <p key={i} className="text-sm text-yellow-700">{w}</p>)}
            </div>
          )}

          {/* Schedule table */}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-100">
                  <th className="text-left px-3 py-2 border">Employee</th>
                  {DAYS.map(d => <th key={d} className="px-3 py-2 border text-center">{d}</th>)}
                </tr>
              </thead>
              <tbody>
                {SEED.employees.map(emp => (
                  <tr key={emp.id} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 border font-medium whitespace-nowrap">{emp.name}</td>
                    {DAYS.map(d => {
                      const entry = result.schedule[emp.id]?.[d];
                      if (!entry || entry.code === "off") {
                        return <td key={d} className="px-3 py-1.5 border text-center text-gray-400">OFF</td>;
                      }
                      if (entry.code === "vacation") {
                        return <td key={d} className="px-3 py-1.5 border text-center text-orange-500 font-medium">VAC</td>;
                      }
                      return (
                        <td key={d} className="px-3 py-1.5 border text-center font-mono text-xs">
                          {entry.start}-{entry.end}
                          <br />
                          <span className="text-gray-400">{entry.hours}h</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}

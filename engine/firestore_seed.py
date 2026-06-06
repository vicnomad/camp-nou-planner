#!/usr/bin/env python3
"""Seed Firestore with Apparel department data and provide solve helper.

Usage:
  python firestore_seed.py seed     # write department + employees to Firestore
  python firestore_seed.py solve    # read Firestore, call /api/solve, save result
"""

import json
import os
import ssl
import sys
import urllib.request

import certifi

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ID = os.environ.get("FIREBASE_PROJECT", "camp-nou-planner")
SOLVER_URL = os.environ.get("SOLVER_URL", "https://camp-nou-engine.vercel.app")

# Init Firebase (uses Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS)
if not firebase_admin._apps:
    firebase_admin.initialize_app(options={"projectId": PROJECT_ID})

db = firestore.client()

# ---------- seed data (same as seed_apparel.json) ----------

DEPARTMENT = {
    "name": "Apparel",
    "params": {
        "grid_default_start": "07:00",
        "days_per_week": 5,
        "preopen": {"minutes": 30, "min": 2, "max": 3},
        "postclose": {"minutes": 30, "min": 2, "max": 3},
        "store_hours": {
            "MON": {"open": "08:00", "close": "21:00"},
            "TUE": {"open": "08:00", "close": "21:00"},
            "WED": {"open": "08:00", "close": "21:00"},
            "THU": {"open": "08:00", "close": "21:00", "special": "inventory",
                    "extra": {"from": "21:00", "to": "01:00", "min": 2, "max": 3}},
            "FRI": {"open": "08:00", "close": "21:00"},
            "SAT": {"open": "08:00", "close": "23:00", "special": "match"},
            "SUN": {"open": "09:00", "close": "21:00"},
        },
        "billing": {
            "daily": {"MON": 9000, "TUE": 9500, "WED": 10000, "THU": 10000,
                      "FRI": 13000, "SAT": 16000, "SUN": 10000},
            "productivity_eur_per_person_hour": 420,
            "profiles": {
                "normal": {"8":3,"9":5,"10":11,"11":13,"12":12,"13":9,
                           "14":7,"15":7,"16":9,"17":11,"18":11,"19":9,"20":5,"21":3},
                "match":  {"8":2,"9":3,"10":6,"11":7,"12":7,"13":6,"14":6,
                           "15":7,"16":8,"17":9,"18":9,"19":10,"20":11,"21":14,"22":14,"23":9},
            },
        },
    },
}

EMPLOYEES = [
    {"id": "E01", "name": "López, Ana",        "weekly_hours": 25, "availability": "M"},
    {"id": "E02", "name": "Martín, Carlos",     "weekly_hours": 25, "availability": "M"},
    {"id": "E03", "name": "Roca, Marta",        "weekly_hours": 25, "availability": "M"},
    {"id": "E04", "name": "Khayari, Hajar",     "weekly_hours": 25, "availability": "T",
     "vacations": ["THU", "FRI"]},
    {"id": "E05", "name": "Fernández, Jorge",   "weekly_hours": 25, "availability": "T"},
    {"id": "E06", "name": "Navarro, Lucía",     "weekly_hours": 25, "availability": "T"},
    {"id": "E07", "name": "Casas, David",       "weekly_hours": 25, "availability": "F",
     "fixed": {"MON":"10:00","TUE":"10:00","WED":"10:00","THU":"10:00","FRI":"10:00",
               "SAT":"off","SUN":"off"}},
    {"id": "E08", "name": "Torres, Pablo",      "weekly_hours": 35, "availability": "F"},
    {"id": "E09", "name": "Vidal, Elena",       "weekly_hours": 25, "availability": "F"},
]


def seed():
    """Write department and employees to Firestore."""
    print("Seeding department 'apparel'...")
    db.collection("departments").document("apparel").set(DEPARTMENT)

    for emp in EMPLOYEES:
        doc = {k: v for k, v in emp.items() if k != "id"}
        doc["department"] = "apparel"
        db.collection("employees").document(emp["id"]).set(doc)
        print(f"  {emp['id']}: {emp['name']}")

    print("Done.")


def solve_from_firestore(week_start: str = "2026-06-08"):
    """Read Firestore, build solver input, call /api/solve, save result."""
    # Read department
    dept_doc = db.collection("departments").document("apparel").get()
    if not dept_doc.exists:
        print("Department 'apparel' not found. Run 'seed' first.")
        return
    dept = dept_doc.to_dict()

    # Read employees
    emps_query = db.collection("employees").where("department", "==", "apparel").stream()
    employees = []
    for doc in emps_query:
        emp = doc.to_dict()
        emp["id"] = doc.id
        employees.append(emp)

    if not employees:
        print("No employees found for 'apparel'.")
        return

    # Build solver input
    payload = {
        "department": {"id": "apparel", "name": dept["name"]},
        "params": dept["params"],
        "employees": employees,
    }

    print(f"Calling {SOLVER_URL}/api/solve with {len(employees)} employees...")
    req = urllib.request.Request(
        f"{SOLVER_URL}/api/solve",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
        result = json.loads(resp.read())

    print(f"Status: {result['status']}, Objective: {result['objective']}")

    # Save to schedules collection
    doc_id = f"apparel_{week_start}"
    schedule_doc = {
        "weekStart": week_start,
        "department": "apparel",
        **result,
    }
    db.collection("schedules").document(doc_id).set(schedule_doc)
    print(f"Saved to schedules/{doc_id}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "seed"
    if cmd == "seed":
        seed()
    elif cmd == "solve":
        week = sys.argv[2] if len(sys.argv) > 2 else "2026-06-08"
        solve_from_firestore(week)
    else:
        print(f"Unknown command: {cmd}. Use 'seed' or 'solve'.")

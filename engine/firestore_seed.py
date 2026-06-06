#!/usr/bin/env python3
"""Seed Firestore with all 6 departments and their employees.

Usage:
  python firestore_seed.py seed     # write departments + employees to Firestore
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

# ---------- shared params (same for all departments) ----------

SHARED_PARAMS = {
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
}

# ---------- departments ----------

DEPARTMENTS = {
    "apparel": {"name": "Apparel",      "color": "#a50044"},
    "perf":    {"name": "Performance",   "color": "#004d98"},
    "petits":  {"name": "Petits Culers", "color": "#e0a100"},
    "acc":     {"name": "Accesorios",    "color": "#1d9e75"},
    "cajas":   {"name": "Cajas",         "color": "#7a4dd0"},
    "almacen": {"name": "Almacén",       "color": "#5f6470"},
}

# ---------- helper for fixed schedule ----------

FIXED_MON_FRI_10 = {
    "MON": "10:00", "TUE": "10:00", "WED": "10:00",
    "THU": "10:00", "FRI": "10:00", "SAT": "off", "SUN": "off",
}

# ---------- employees per department ----------
# Each tuple: (name, dni, weekly_hours, availability, fixed, absences)

EMPLOYEES = {
    "apparel": [
        ("Garcia Carro, Adria",  "49325784F", 25, "M", None, []),
        ("Sorribas, Clara",      "45154264C", 25, "M", None, []),
        ("Vasquez, Marian",      "47326578F", 25, "M", None, []),
        ("Padulles, Anna",       "77750682X", 25, "F", None, []),
        ("Bastit, Jana",         "48089226K", 25, "T", None, []),
        ("Rabasco, Arnau",       "21772684X", 25, "T", None, []),
        ("Khayari, Hajar",       "13413178S", 25, "T", None,
         [{"type": "vacation", "days": ["THU", "FRI"]}]),
        ("Gimenez, Miguel",      "Y4985730B", 35, "F", None, []),
        ("Casas, David",         "46417617Y", 25, "F", FIXED_MON_FRI_10, []),
    ],
    "perf": [
        ("Ilagan, Joey",         "54177318J", 35, "F", None, []),
        ("Chowdhury, Bashar",    "Y2250363B", 25, "M", None, []),
        ("Pastor, Carlos",       "46490290E", 25, "F", None, []),
        ("Hernandez, Oscar",     "47864939F", 25, "T", None, []),
        ("Perret, Gwenola",      "Y0003039V", 25, "F", None, []),
        ("Rodriguez, Ainhoa",    "39443160T", 25, "T", None,
         [{"type": "vacation", "days": 7}]),
        ("Cumellas, Andrea",     "48095659Z", 20, "M", None, []),
    ],
    "petits": [
        ("Dot i Grau, Martina",  "49325064T", 25, "M", None, []),
        ("Fajardo, Edymar",      "26272831T", 25, "F", None, []),
        ("Suarez, Rocio",        "49300464X", 25, "T", None,
         [{"type": "vacation", "days": 3}]),
        ("Nikabadze, Sofia",     "60492129J", 25, "M", None, []),
    ],
    "acc": [
        ("Borja, Melissa",       "49491064D", 25, "M", None, []),
        ("Ji Chen, Elena",       "54765375Y", 25, "T", None, []),
        ("Jimenez, Paula",       "47672042B", 25, "M", None, []),
        ("Pérez, Laia",          "46012233K", 25, "T", None, []),
        ("Roca, Pau",            "45998112M", 25, "F", None, []),
    ],
    "cajas": [
        ("Serra, Mar",           "46221190L", 25, "M", None, []),
        ("Vidal, Joan",          "47883320T", 25, "T", None, []),
        ("Costa, Aina",          "45667712P", 25, "F", None, []),
        ("Mas, Nil",             "49001823R", 20, "M", None, []),
        ("Pons, Berta",          "46778201D", 25, "T", None, []),
        ("Ferrer, Ona",          "45112098X", 25, "M", None, []),
        ("Soler, Marc",          "47220981B", 25, "F", FIXED_MON_FRI_10, []),
        ("Camps, Lia",           "46339017K", 25, "T", None, []),
    ],
    "almacen": [
        ("Solé, Pere",           "46110023A", 40, "M", None, []),
        ("Riba, Toni",           "47220112C", 25, "F", None, []),
        ("Tomàs, Quim",          "45667234D", 25, "M", None, []),
        ("Vila, Aleix",          "49118822M", 25, "M", None, []),
    ],
}


def delete_collection(coll_ref, batch_size=100):
    """Delete all documents in a collection."""
    docs = coll_ref.limit(batch_size).stream()
    deleted = 0
    for doc in docs:
        doc.reference.delete()
        deleted += 1
    if deleted >= batch_size:
        # Recurse for remaining docs
        delete_collection(coll_ref, batch_size)
    return deleted


def seed():
    """Delete existing data and write all departments + employees to Firestore."""
    # Delete existing documents
    print("Deleting existing departments...")
    delete_collection(db.collection("departments"))
    print("Deleting existing employees...")
    delete_collection(db.collection("employees"))

    # Seed departments
    for dept_id, dept_info in DEPARTMENTS.items():
        doc = {
            "name": dept_info["name"],
            "color": dept_info["color"],
            "params": SHARED_PARAMS,
        }
        db.collection("departments").document(dept_id).set(doc)
        print(f"  Department: {dept_id} ({dept_info['name']})")

    # Seed employees
    total = 0
    for dept_id, emp_list in EMPLOYEES.items():
        print(f"\n  Employees for {dept_id}:")
        for (name, dni, weekly_hours, availability, fixed, absences) in emp_list:
            doc = {
                "name": name,
                "dni": dni,
                "department": dept_id,
                "weekly_hours": weekly_hours,
                "availability": availability,
                "fixed": fixed,
                "absences": absences,
            }
            db.collection("employees").document(dni).set(doc)
            print(f"    {dni}: {name}")
            total += 1

    print(f"\nDone. Seeded {len(DEPARTMENTS)} departments and {total} employees.")


def solve_from_firestore(department: str = "apparel", week_start: str = "2026-06-08"):
    """Read Firestore, build solver input, call /api/solve, save result."""
    # Read department
    dept_doc = db.collection("departments").document(department).get()
    if not dept_doc.exists:
        print(f"Department '{department}' not found. Run 'seed' first.")
        return
    dept = dept_doc.to_dict()

    # Read employees
    emps_query = db.collection("employees").where("department", "==", department).stream()
    employees = []
    for doc in emps_query:
        emp = doc.to_dict()
        emp["id"] = doc.id
        employees.append(emp)

    if not employees:
        print(f"No employees found for '{department}'.")
        return

    # Build solver input
    payload = {
        "department": {"id": department, "name": dept["name"]},
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
    doc_id = f"{department}_{week_start}"
    schedule_doc = {
        "weekStart": week_start,
        "department": department,
        **result,
    }
    db.collection("schedules").document(doc_id).set(schedule_doc)
    print(f"Saved to schedules/{doc_id}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "seed"
    if cmd == "seed":
        seed()
    elif cmd == "solve":
        dept = sys.argv[2] if len(sys.argv) > 2 else "apparel"
        week = sys.argv[3] if len(sys.argv) > 3 else "2026-06-08"
        solve_from_firestore(dept, week)
    else:
        print(f"Unknown command: {cmd}. Use 'seed' or 'solve'.")

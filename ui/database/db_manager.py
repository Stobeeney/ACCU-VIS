"""
Accu-Vis Clinical Database Manager

Dual-mode persistence layer:
- Local development (python3 server.py): SQLite file on disk.
- Vercel deployment (api/index.py): Postgres via the POSTGRES_URL env var
  that Vercel's Postgres integration injects automatically. Vercel's
  serverless filesystem has no writable/persistent local disk, so SQLite
  cannot be used there.

All CRUD functions below are written once and branch internally where the
two engines' SQL dialects differ (placeholders, autoincrement, migrations).
"""

import json
import os
import hashlib
from datetime import datetime

DB_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(DB_DIR, "accuvis_clinic.db")
PATIENTS_JSON = os.path.join(DB_DIR, "patients.json")
LOGS_JSON = os.path.join(DB_DIR, "clinic_records.json")
USERS_JSON = os.path.join(DB_DIR, "users.json")

AUTH_SALT = "accuvis_clinical_salt_2026"

POSTGRES_URL = os.environ.get("POSTGRES_URL") or os.environ.get("DATABASE_URL")
IS_POSTGRES = bool(POSTGRES_URL)

if IS_POSTGRES:
    import psycopg
    from psycopg.rows import dict_row
    IntegrityErrorType = psycopg.IntegrityError
else:
    import sqlite3
    IntegrityErrorType = sqlite3.IntegrityError


def hash_password(password: str) -> str:
    """Hash password using SHA-256 with clinical workstation salt."""
    return hashlib.sha256((password + AUTH_SALT).encode('utf-8')).hexdigest()


def q(sql):
    """Translate SQLite-style '?' placeholders to Postgres '%s' when needed."""
    return sql.replace("?", "%s") if IS_POSTGRES else sql


def get_connection():
    if IS_POSTGRES:
        return psycopg.connect(POSTGRES_URL, row_factory=dict_row)
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    if IS_POSTGRES:
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS patients (
            id SERIAL PRIMARY KEY,
            mrn TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            age INTEGER,
            gender TEXT,
            eye_preference TEXT DEFAULT 'OD',
            notes TEXT,
            created_at TEXT NOT NULL
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS clinical_logs (
            id SERIAL PRIMARY KEY,
            log_id TEXT UNIQUE NOT NULL,
            mrn TEXT NOT NULL,
            patient_name TEXT NOT NULL,
            test_type TEXT NOT NULL DEFAULT 'NPC',
            eye TEXT NOT NULL,
            distance_cm REAL NOT NULL,
            distance_mm INTEGER NOT NULL,
            verdict TEXT NOT NULL,
            symmetry TEXT,
            operator_notes TEXT,
            created_at TEXT NOT NULL
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'Optometrist',
            avatar TEXT,
            created_at TEXT NOT NULL
        )
        """)

        # Postgres supports idempotent column migrations directly
        cursor.execute("ALTER TABLE clinical_logs ADD COLUMN IF NOT EXISTS test_type TEXT NOT NULL DEFAULT 'NPC'")
        cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT")
    else:
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS patients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mrn TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            age INTEGER,
            gender TEXT,
            eye_preference TEXT DEFAULT 'OD',
            notes TEXT,
            created_at TEXT NOT NULL
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS clinical_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_id TEXT UNIQUE NOT NULL,
            mrn TEXT NOT NULL,
            patient_name TEXT NOT NULL,
            test_type TEXT NOT NULL DEFAULT 'NPC',
            eye TEXT NOT NULL,
            distance_cm REAL NOT NULL,
            distance_mm INTEGER NOT NULL,
            verdict TEXT NOT NULL,
            symmetry TEXT,
            operator_notes TEXT,
            created_at TEXT NOT NULL
        )
        """)

        # Migration: older databases created before test_type existed
        cursor.execute("PRAGMA table_info(clinical_logs)")
        existing_cols = {row[1] for row in cursor.fetchall()}
        if "test_type" not in existing_cols:
            cursor.execute("ALTER TABLE clinical_logs ADD COLUMN test_type TEXT NOT NULL DEFAULT 'NPC'")

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'Optometrist',
            avatar TEXT,
            created_at TEXT NOT NULL
        )
        """)

        # Migration: older databases created before avatar existed
        cursor.execute("PRAGMA table_info(users)")
        user_cols = {row[1] for row in cursor.fetchall()}
        if "avatar" not in user_cols:
            cursor.execute("ALTER TABLE users ADD COLUMN avatar TEXT")

    conn.commit()

    # Seed default clinical users if empty
    cursor.execute("SELECT COUNT(*) AS cnt FROM users")
    if cursor.fetchone()["cnt"] == 0:
        seed_users_data(conn)

    conn.close()
    sync_to_json()


def seed_users_data(conn):
    cursor = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    default_users = [
        ("dr.bea@accuvis.clinic", "Dr. Bea", "dr_bea", hash_password("password123"), "Optometrist", now),
        ("dr.rizal@accuvis.clinic", "Dr. Jose Rizal", "dr_rizal", hash_password("password123"), "Chief Optometrist", now)
    ]

    if IS_POSTGRES:
        cursor.executemany(q("""
        INSERT INTO users (email, full_name, username, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
        """), default_users)
    else:
        cursor.executemany("""
        INSERT OR IGNORE INTO users (email, full_name, username, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """, default_users)
    conn.commit()


def sync_to_json():
    """Mirror tables to local JSON files for easy inspection during local dev.
    Skipped entirely on Vercel/Postgres: the serverless filesystem is
    read-only/ephemeral and nothing in production reads these files anyway."""
    if IS_POSTGRES:
        return

    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM patients ORDER BY id DESC")
    patients = [dict(row) for row in cursor.fetchall()]
    with open(PATIENTS_JSON, "w", encoding="utf-8") as f:
        json.dump(patients, f, indent=2)

    cursor.execute("SELECT * FROM clinical_logs ORDER BY id DESC")
    logs = [dict(row) for row in cursor.fetchall()]
    with open(LOGS_JSON, "w", encoding="utf-8") as f:
        json.dump(logs, f, indent=2)

    # Safe user exports (excluding password hash)
    cursor.execute("SELECT id, email, full_name, username, role, avatar, created_at FROM users ORDER BY id DESC")
    users = [dict(row) for row in cursor.fetchall()]
    with open(USERS_JSON, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2)

    conn.close()

# =========================================================================
# PATIENT CRUD
# =========================================================================

def get_all_patients():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM patients ORDER BY id DESC")
    patients = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return patients

def create_patient(data):
    conn = get_connection()
    cursor = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    mrn = data.get("mrn")
    if not mrn:
        mrn = f"ACV-2026-{datetime.now().strftime('%M%S')}"

    cursor.execute(q("""
    INSERT INTO patients (mrn, full_name, age, gender, eye_preference, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mrn) DO UPDATE SET
        full_name=excluded.full_name,
        age=excluded.age,
        gender=excluded.gender,
        eye_preference=excluded.eye_preference,
        notes=excluded.notes
    """), (
        mrn,
        data.get("full_name", "Anonymous Patient"),
        int(data.get("age", 25)),
        data.get("gender", "Unspecified"),
        data.get("eye_preference", "OD"),
        data.get("notes", ""),
        now
    ))
    conn.commit()

    cursor.execute(q("SELECT * FROM patients WHERE mrn = ?"), (mrn,))
    patient = dict(cursor.fetchone())
    conn.close()
    sync_to_json()
    return patient

# =========================================================================
# CLINICAL LOGS CRUD
# =========================================================================

def get_all_logs():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM clinical_logs ORDER BY id DESC")
    logs = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return logs

def create_log(data):
    conn = get_connection()
    cursor = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_id = data.get("log_id") or f"LOG-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"

    params = (
        data.get("mrn", "ACV-GENERAL"),
        data.get("patient_name", "Patient"),
        data.get("test_type", "NPC"),
        data.get("eye", "OU"),
        float(data.get("distance_cm", 0.0)),
        int(data.get("distance_mm", 0)),
        data.get("verdict", "Normal"),
        data.get("symmetry", "99%"),
        data.get("operator_notes", ""),
        now
    )

    # Guard against a colliding log_id (e.g. a client-generated id reused
    # within the same second) by retrying once with a guaranteed-unique id
    # instead of letting the whole request fail with an uncaught error.
    for attempt in range(2):
        try:
            cursor.execute(q("""
            INSERT INTO clinical_logs (log_id, mrn, patient_name, test_type, eye, distance_cm, distance_mm, verdict, symmetry, operator_notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """), (log_id, *params))
            break
        except IntegrityErrorType:
            conn.rollback()
            if attempt == 1:
                conn.close()
                raise
            log_id = f"LOG-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"

    conn.commit()

    cursor.execute(q("SELECT * FROM clinical_logs WHERE log_id = ?"), (log_id,))
    log = dict(cursor.fetchone())
    conn.close()
    sync_to_json()
    return log

# =========================================================================
# USER AUTHENTICATION & REGISTRATION CRUD
# =========================================================================

def get_all_users():
    """Return all registered users (sanitized, no password hash)."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, email, full_name, username, role, avatar, created_at FROM users ORDER BY id DESC")
    users = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return users

def update_user_profile(user_id, data):
    """Update a doctor's own profile: full name, role, and/or avatar photo."""
    if not user_id:
        raise ValueError("A user id is required.")

    full_name = (data.get("full_name") or "").strip()
    role = (data.get("role") or "").strip()
    if not full_name:
        raise ValueError("Full name is required.")
    if not role:
        raise ValueError("Role is required.")

    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(q("SELECT id FROM users WHERE id = ?"), (user_id,))
    if not cursor.fetchone():
        conn.close()
        raise ValueError("User account not found.")

    # avatar: pass a data URL to set a photo, an empty string to clear it,
    # or omit the field entirely to leave the existing photo untouched.
    if "avatar" in data:
        cursor.execute(
            q("UPDATE users SET full_name = ?, role = ?, avatar = ? WHERE id = ?"),
            (full_name, role, data.get("avatar") or None, user_id)
        )
    else:
        cursor.execute(
            q("UPDATE users SET full_name = ?, role = ? WHERE id = ?"),
            (full_name, role, user_id)
        )
    conn.commit()

    cursor.execute(q("SELECT id, email, full_name, username, role, avatar, created_at FROM users WHERE id = ?"), (user_id,))
    user = dict(cursor.fetchone())
    conn.close()
    sync_to_json()
    return user

def register_user(data):
    """Register a new clinical user in the database."""
    email = (data.get("email") or "").strip().lower()
    full_name = (data.get("full_name") or "").strip()
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    role = data.get("role") or "Optometrist"

    if not email or "@" not in email:
        raise ValueError("A valid email address is required.")
    if not full_name:
        raise ValueError("Full name is required.")
    if not username or len(username) < 3:
        raise ValueError("Username must be at least 3 characters.")
    if not password or len(password) < 4:
        raise ValueError("Password must be at least 4 characters.")

    conn = get_connection()
    cursor = conn.cursor()

    # Check if email or username exists
    cursor.execute(q("SELECT id FROM users WHERE email = ?"), (email,))
    if cursor.fetchone():
        conn.close()
        raise ValueError("An account with this email already exists.")

    cursor.execute(q("SELECT id FROM users WHERE username = ?"), (username,))
    if cursor.fetchone():
        conn.close()
        raise ValueError("This username is already taken.")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    p_hash = hash_password(password)

    cursor.execute(q("""
    INSERT INTO users (email, full_name, username, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    """), (email, full_name, username, p_hash, role, now))
    conn.commit()

    cursor.execute(q("SELECT id, email, full_name, username, role, avatar, created_at FROM users WHERE email = ?"), (email,))
    user = dict(cursor.fetchone())
    conn.close()
    sync_to_json()
    return user

def authenticate_user(identifier, password):
    """
    Authenticate user by email or username + password.
    Returns user dict without password_hash if authenticated, None otherwise.
    """
    ident = (identifier or "").strip().lower()
    if not ident or not password:
        return None

    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(q("""
    SELECT id, email, full_name, username, password_hash, role, avatar, created_at
    FROM users
    WHERE email = ? OR username = ?
    """), (ident, ident))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return None

    user = dict(row)
    stored_hash = user["password_hash"]
    if hash_password(password) == stored_hash:
        del user["password_hash"]
        return user

    return None

def reset_password(email, new_password):
    """Reset user password by email."""
    email_clean = (email or "").strip().lower()
    if not email_clean or not new_password or len(new_password) < 4:
        raise ValueError("Valid email and password (min 4 chars) are required.")

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(q("SELECT id FROM users WHERE email = ?"), (email_clean,))
    if not cursor.fetchone():
        conn.close()
        raise ValueError("No registered account found with that email address.")

    p_hash = hash_password(new_password)
    cursor.execute(q("UPDATE users SET password_hash = ? WHERE email = ?"), (p_hash, email_clean))
    conn.commit()
    conn.close()
    sync_to_json()
    return True

# Initialize on import
init_db()

"""
Accu-Vis Rail Relay Service

Lets the hosted website control the rail without ever reaching it directly:
the rail (ESP8266) joins the clinic WiFi and checks in with this service; the
website posts commands here.

    Website (operator) --POST /api/rail/command--> [this service] <--POST /api/rail/sync-- Rail

Design rules (safety first, the rail moves toward a patient's face):
  * Operators authenticate with a server-side session token (Bearer).
  * The rail authenticates with its own secret (X-Rail-Id / X-Rail-Secret).
  * Motion commands are only accepted while the rail is ARMED (operator armed it
    in the last ARM_MINUTES) and not STOP-latched.
  * STOP is always accepted, is LATCHED until explicitly cleared, and is
    re-sent to the rail on every check-in (it never depends on one message).
  * Every command expires (COMMAND_TTL_S) so a late message can never move the rail.
  * The server tells the rail how often to check in (poll_ms): slow when idle,
    fast while armed/moving. That keeps usage inside the free-tier quotas.
  * All numeric parameters are range-checked here AND again in the firmware.

Used by both api/index.py (Vercel/Postgres) and server.py (local/SQLite).
"""

import hashlib
import hmac
import json
import math
import secrets
from datetime import datetime, timedelta, timezone

import db_manager as db

SESSION_TTL_HOURS = 12
ARM_MINUTES = 10
COMMAND_TTL_S = 5
STOP_TTL_S = 60
MAX_PENDING = 20
MAX_STATE_BYTES = 2048

POLL_IDLE_MS = 20000      # rail powered, nobody has armed it
POLL_ARMED_MS = 1000      # armed, standing still
POLL_MOVING_MS = 500      # armed and moving
MIN_SYNC_INTERVAL_MS = 250

ALLOWED_TYPES = {"arm", "disarm", "stop", "clear_stop", "calibrate", "home", "jog", "move", "start_profile"}
MOTION_TYPES = {"calibrate", "home", "jog", "move", "start_profile"}
STATE_KEYS = {"distance_cm", "moving", "calibrated", "mode", "fw", "error", "rssi", "uptime_ms",
              "profile_state", "limit_min_cm", "limit_max_cm", "stop_reason"}

RAIL_MIN_CM = 4.0
RAIL_MAX_CM = 40.0


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _num(value, lo, hi, label, default=None):
    if value is None:
        if default is None:
            raise ValueError(f"{label} is required.")
        return default
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number.")
    if not math.isfinite(v) or v < lo or v > hi:
        raise ValueError(f"{label} must be between {lo} and {hi}.")
    return v


# ---------------------------------------------------------------------------
# schema
# ---------------------------------------------------------------------------

def init_tables():
    conn = db.get_connection()
    cur = conn.cursor()
    pk = "SERIAL PRIMARY KEY" if db.IS_POSTGRES else "INTEGER PRIMARY KEY AUTOINCREMENT"

    cur.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    )""")
    cur.execute("""
    CREATE TABLE IF NOT EXISTS rails (
        rail_id TEXT PRIMARY KEY,
        name TEXT,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""")
    cur.execute("""
    CREATE TABLE IF NOT EXISTS rail_state (
        rail_id TEXT PRIMARY KEY,
        updated_at TEXT,
        state_json TEXT,
        armed_until TEXT,
        stop_latched INTEGER NOT NULL DEFAULT 0
    )""")
    cur.execute(f"""
    CREATE TABLE IF NOT EXISTS rail_commands (
        id {pk},
        rail_id TEXT NOT NULL,
        type TEXT NOT NULL,
        params TEXT,
        user_id INTEGER,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        delivered_at TEXT,
        acked_at TEXT,
        result TEXT
    )""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_rail_cmd_pending ON rail_commands (rail_id, delivered_at, id)")
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# operator sessions
# ---------------------------------------------------------------------------

def create_session(user_id, now=None):
    now = now or _now()
    token = secrets.token_urlsafe(32)
    conn = db.get_connection()
    cur = conn.cursor()
    cur.execute(db.q("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
                (_sha(token), user_id, _iso(now), _iso(now + timedelta(hours=SESSION_TTL_HOURS))))
    cur.execute(db.q("DELETE FROM sessions WHERE expires_at < ?"), (_iso(now),))
    conn.commit()
    conn.close()
    return token


def get_session_user(token, now=None):
    if not token:
        return None
    now = now or _now()
    conn = db.get_connection()
    cur = conn.cursor()
    cur.execute(db.q("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?"), (_sha(token),))
    row = cur.fetchone()
    user = None
    if row and _parse(row["expires_at"]) > now:
        cur.execute(db.q("SELECT id, email, full_name, username, role FROM users WHERE id = ?"), (row["user_id"],))
        u = cur.fetchone()
        user = dict(u) if u else None
    conn.close()
    return user


def revoke_session(token):
    if not token:
        return
    conn = db.get_connection()
    cur = conn.cursor()
    cur.execute(db.q("DELETE FROM sessions WHERE token_hash = ?"), (_sha(token),))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# rails
# ---------------------------------------------------------------------------

def provision_rail(rail_id, name="", now=None):
    """Create a rail (or rotate its secret). Returns the secret, which is shown ONCE."""
    rail_id = (rail_id or "").strip()
    if not rail_id or len(rail_id) > 64:
        raise ValueError("rail_id is required (max 64 characters).")
    now = now or _now()
    secret = secrets.token_urlsafe(24)
    conn = db.get_connection()
    cur = conn.cursor()
    cur.execute(db.q("""
        INSERT INTO rails (rail_id, name, secret_hash, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(rail_id) DO UPDATE SET secret_hash = excluded.secret_hash, name = excluded.name
    """), (rail_id, name, _sha(secret), _iso(now)))
    conn.commit()
    conn.close()
    return secret


def authenticate_rail(rail_id, secret):
    if not rail_id or not secret:
        return False
    conn = db.get_connection()
    cur = conn.cursor()
    cur.execute(db.q("SELECT secret_hash FROM rails WHERE rail_id = ?"), (rail_id,))
    row = cur.fetchone()
    conn.close()
    stored = row["secret_hash"] if row else _sha("no-such-rail")  # same work either way
    ok = hmac.compare_digest(stored, _sha(secret))
    return bool(row) and ok


def _rail_exists(cur, rail_id):
    cur.execute(db.q("SELECT 1 AS x FROM rails WHERE rail_id = ?"), (rail_id,))
    return cur.fetchone() is not None


def _ensure_state_row(cur, rail_id):
    cur.execute(db.q("INSERT INTO rail_state (rail_id, stop_latched) VALUES (?, 0) ON CONFLICT(rail_id) DO NOTHING"),
                (rail_id,))


def _clean_state(state):
    if not isinstance(state, dict):
        return {}
    clean = {}
    for k, v in state.items():
        if k in STATE_KEYS and isinstance(v, (int, float, str, bool)) or (k in STATE_KEYS and v is None):
            clean[k] = v[:120] if isinstance(v, str) else v
    return clean


def _poll_ms(armed, moving):
    if armed and moving:
        return POLL_MOVING_MS
    return POLL_ARMED_MS if armed else POLL_IDLE_MS


def rail_sync(rail_id, body, now=None):
    """The rail checks in: reports state + acks, receives pending commands and flags."""
    now = now or _now()
    body = body if isinstance(body, dict) else {}
    conn = db.get_connection()
    cur = conn.cursor()
    try:
        _ensure_state_row(cur, rail_id)
        cur.execute(db.q("SELECT updated_at, armed_until, stop_latched FROM rail_state WHERE rail_id = ?"), (rail_id,))
        row = cur.fetchone()
        armed = bool(row["armed_until"]) and _parse(row["armed_until"]) > now
        latched = bool(row["stop_latched"])
        prev = _parse(row["updated_at"]) if row["updated_at"] else None

        # A rail (or a bug) checking in too fast must not burn the quota
        if prev and (now - prev) < timedelta(milliseconds=MIN_SYNC_INTERVAL_MS):
            conn.rollback()
            return {"ok": True, "throttled": True, "armed": armed, "stop_latched": latched,
                    "poll_ms": _poll_ms(armed, False), "commands": [], "server_time": _iso(now)}

        for ack in (body.get("acks") or [])[:10]:
            if isinstance(ack, dict) and isinstance(ack.get("seq"), int):
                cur.execute(db.q("UPDATE rail_commands SET acked_at = ?, result = ? "
                                 "WHERE rail_id = ? AND id = ? AND acked_at IS NULL"),
                            (_iso(now), str(ack.get("result", "ok"))[:120], rail_id, ack["seq"]))

        state = _clean_state(body.get("state"))
        state_json = json.dumps(state)[:MAX_STATE_BYTES]
        cur.execute(db.q("UPDATE rail_state SET updated_at = ?, state_json = ? WHERE rail_id = ?"),
                    (_iso(now), state_json, rail_id))

        cur.execute(db.q("SELECT id, type, params FROM rail_commands "
                         "WHERE rail_id = ? AND delivered_at IS NULL AND expires_at > ? ORDER BY id ASC LIMIT 5"),
                    (rail_id, _iso(now)))
        pending = [dict(r) for r in cur.fetchall()]
        for cmd in pending:
            cur.execute(db.q("UPDATE rail_commands SET delivered_at = ? WHERE id = ?"), (_iso(now), cmd["id"]))
        conn.commit()

        return {
            "ok": True,
            "commands": [{"seq": c["id"], "type": c["type"], "params": json.loads(c["params"] or "{}")} for c in pending],
            "armed": armed,
            "stop_latched": latched,
            "poll_ms": _poll_ms(armed, bool(state.get("moving"))),
            "server_time": _iso(now),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# operator commands
# ---------------------------------------------------------------------------

def _validate_params(ctype, params):
    params = params if isinstance(params, dict) else {}
    if ctype in ("arm", "disarm", "stop", "clear_stop", "calibrate", "home"):
        return {}
    if ctype == "move":
        out = {"distance_cm": _num(params.get("distance_cm"), RAIL_MIN_CM, RAIL_MAX_CM, "distance_cm")}
        if params.get("speed_cm_s") is not None:
            out["speed_cm_s"] = _num(params["speed_cm_s"], 0.05, 3.0, "speed_cm_s")
        return out
    if ctype == "jog":
        out = {"delta_cm": _num(params.get("delta_cm"), -5.0, 5.0, "delta_cm")}
        if params.get("speed_cm_s") is not None:
            out["speed_cm_s"] = _num(params["speed_cm_s"], 0.05, 3.0, "speed_cm_s")
        return out
    if ctype == "start_profile":
        out = {
            "fast_end_cm": _num(params.get("fast_end_cm"), RAIL_MIN_CM, RAIL_MAX_CM, "fast_end_cm", 30.0),
            "target_cm": _num(params.get("target_cm"), RAIL_MIN_CM, RAIL_MAX_CM, "target_cm", 20.0),
            "step_cm": _num(params.get("step_cm"), 0.1, 5.0, "step_cm", 0.5),
            "dwell_ms": _num(params.get("dwell_ms"), 200, 10000, "dwell_ms", 2000),
            "fast_cm_s": _num(params.get("fast_cm_s"), 0.05, 3.0, "fast_cm_s", 0.75),
            "slow_cm_s": _num(params.get("slow_cm_s"), 0.05, 3.0, "slow_cm_s", 0.5),
        }
        if out["target_cm"] > out["fast_end_cm"]:
            raise ValueError("target_cm must not be farther than fast_end_cm.")
        return out
    raise ValueError("Unknown command type.")


def enqueue_command(rail_id, user, ctype, params=None, now=None):
    now = now or _now()
    if ctype not in ALLOWED_TYPES:
        raise ValueError("Unknown command type.")
    clean = _validate_params(ctype, params)

    conn = db.get_connection()
    cur = conn.cursor()
    try:
        if not _rail_exists(cur, rail_id):
            raise ValueError("Unknown rail.")
        _ensure_state_row(cur, rail_id)
        cur.execute(db.q("SELECT armed_until, stop_latched FROM rail_state WHERE rail_id = ?"), (rail_id,))
        row = cur.fetchone()
        armed = bool(row["armed_until"]) and _parse(row["armed_until"]) > now
        latched = bool(row["stop_latched"])

        if ctype == "arm":
            cur.execute(db.q("UPDATE rail_state SET armed_until = ? WHERE rail_id = ?"),
                        (_iso(now + timedelta(minutes=ARM_MINUTES)), rail_id))
            conn.commit()
            return {"queued": False, "armed": True, "armed_minutes": ARM_MINUTES}
        if ctype == "disarm":
            cur.execute(db.q("UPDATE rail_state SET armed_until = ? WHERE rail_id = ?"), (_iso(now), rail_id))
            conn.commit()
            return {"queued": False, "armed": False}
        if ctype == "clear_stop":
            cur.execute(db.q("UPDATE rail_state SET stop_latched = 0 WHERE rail_id = ?"), (rail_id,))
            conn.commit()
            return {"queued": False, "stop_latched": False}

        ttl = STOP_TTL_S if ctype == "stop" else COMMAND_TTL_S
        if ctype == "stop":
            cur.execute(db.q("UPDATE rail_state SET stop_latched = 1 WHERE rail_id = ?"), (rail_id,))
        else:
            if latched:
                raise ValueError("Rail is stopped. Clear the stop first.")
            if not armed:
                raise ValueError("Rail is not armed. Arm it first.")

        cur.execute(db.q("SELECT COUNT(*) AS n FROM rail_commands WHERE rail_id = ? AND delivered_at IS NULL AND expires_at > ?"),
                    (rail_id, _iso(now)))
        if cur.fetchone()["n"] >= MAX_PENDING and ctype != "stop":
            raise ValueError("Too many pending commands.")

        values = (rail_id, ctype, json.dumps(clean), user.get("id") if user else None, _iso(now),
                  _iso(now + timedelta(seconds=ttl)))
        if db.IS_POSTGRES:
            cur.execute("INSERT INTO rail_commands (rail_id, type, params, user_id, created_at, expires_at) "
                        "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id", values)
            seq = cur.fetchone()["id"]
        else:
            cur.execute("INSERT INTO rail_commands (rail_id, type, params, user_id, created_at, expires_at) "
                        "VALUES (?, ?, ?, ?, ?, ?)", values)
            seq = cur.lastrowid
        conn.commit()
        return {"queued": True, "seq": seq, "expires_in_s": ttl}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_status(rail_id, now=None):
    now = now or _now()
    conn = db.get_connection()
    cur = conn.cursor()
    try:
        if not _rail_exists(cur, rail_id):
            raise ValueError("Unknown rail.")
        cur.execute(db.q("SELECT updated_at, state_json, armed_until, stop_latched FROM rail_state WHERE rail_id = ?"), (rail_id,))
        row = cur.fetchone()
        if not row:
            return {"online": False, "armed": False, "stop_latched": False, "state": {}, "age_s": None, "recent": []}
        armed = bool(row["armed_until"]) and _parse(row["armed_until"]) > now
        age = (now - _parse(row["updated_at"])).total_seconds() if row["updated_at"] else None
        window = 5.0 if armed else (POLL_IDLE_MS / 1000.0) * 2.5
        cur.execute(db.q("SELECT id, type, created_at, delivered_at, acked_at, result FROM rail_commands "
                         "WHERE rail_id = ? ORDER BY id DESC LIMIT 5"), (rail_id,))
        recent = [dict(r) for r in cur.fetchall()]
        return {
            "online": age is not None and age <= window,
            "armed": armed,
            "stop_latched": bool(row["stop_latched"]),
            "state": json.loads(row["state_json"] or "{}"),
            "age_s": age,
            "poll_ms_hint": _poll_ms(armed, False),
            "recent": recent,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# request routing shared by api/index.py (Flask) and server.py (http.server)
# ---------------------------------------------------------------------------

def _bearer(headers):
    auth = headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


def is_rail_route(path):
    return path.startswith("/api/rail/") or path == "/api/auth/logout"


def handle_request(method, path, headers, query, body, now=None):
    """Returns (http_status, json_dict). `headers` keys are lower-cased by this function."""
    headers = {str(k).lower(): v for k, v in (headers or {}).items()}
    query = query or {}
    body = body if isinstance(body, dict) else {}

    try:
        if method == "POST" and path == "/api/rail/sync":
            rail_id = headers.get("x-rail-id", "")
            if not authenticate_rail(rail_id, headers.get("x-rail-secret", "")):
                return 401, {"ok": False, "error": "Unauthorized rail."}
            return 200, rail_sync(rail_id, body, now)

        if method == "POST" and path == "/api/auth/logout":
            revoke_session(_bearer(headers))
            return 200, {"status": "success"}

        if path in ("/api/rail/command", "/api/rail/status"):
            user = get_session_user(_bearer(headers), now)
            if not user:
                return 401, {"ok": False, "error": "Please sign in again."}
            if method == "POST" and path == "/api/rail/command":
                result = enqueue_command(body.get("rail_id", ""), user, body.get("type", ""), body.get("params"), now)
                return 200, {"ok": True, **result}
            if method == "GET" and path == "/api/rail/status":
                return 200, {"ok": True, **get_status(query.get("rail_id", ""), now)}
    except ValueError as e:
        return 400, {"ok": False, "error": str(e)}

    return 404, {"ok": False, "error": "Not found."}


init_tables()

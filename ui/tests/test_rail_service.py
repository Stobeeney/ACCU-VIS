"""
Tests for the rail relay service. Run from the ui/ folder:

    python -m unittest discover -s tests -v

Uses a temporary SQLite file, never the real local database.
"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "database"))

import db_manager  # noqa: E402

_tmpdir = tempfile.mkdtemp(prefix="accuvis-test-")
db_manager.DB_FILE = os.path.join(_tmpdir, "test.db")
db_manager.init_db()

import rail_service as rs  # noqa: E402

rs.init_tables()

T0 = datetime(2026, 10, 28, 12, 0, 0, tzinfo=timezone.utc)


def at(seconds):
    return T0 + timedelta(seconds=seconds)


class RailServiceTests(unittest.TestCase):
    def setUp(self):
        conn = db_manager.get_connection()
        cur = conn.cursor()
        for t in ("sessions", "rails", "rail_state", "rail_commands"):
            cur.execute(f"DELETE FROM {t}")
        conn.commit()
        conn.close()
        self.secret = rs.provision_rail("rail-1", "Test rail", now=at(0))
        self.user = {"id": 1}

    # --- sessions -----------------------------------------------------------
    def test_session_roundtrip_and_expiry_and_revoke(self):
        token = rs.create_session(1, now=at(0))
        self.assertEqual(rs.get_session_user(token, now=at(60))["id"], 1)
        self.assertIsNone(rs.get_session_user(token, now=at(60 * 60 * 13)))   # expired
        self.assertIsNone(rs.get_session_user("not-a-token", now=at(1)))
        self.assertIsNone(rs.get_session_user("", now=at(1)))
        token2 = rs.create_session(1, now=at(0))
        rs.revoke_session(token2)
        self.assertIsNone(rs.get_session_user(token2, now=at(1)))

    def test_token_is_not_stored_in_clear(self):
        token = rs.create_session(1, now=at(0))
        conn = db_manager.get_connection()
        rows = conn.cursor().execute("SELECT token_hash FROM sessions").fetchall()
        conn.close()
        self.assertTrue(all(token not in r["token_hash"] for r in rows))

    # --- rail auth ----------------------------------------------------------
    def test_rail_authentication(self):
        self.assertTrue(rs.authenticate_rail("rail-1", self.secret))
        self.assertFalse(rs.authenticate_rail("rail-1", "wrong"))
        self.assertFalse(rs.authenticate_rail("rail-2", self.secret))
        self.assertFalse(rs.authenticate_rail("", ""))

    def test_secret_rotation_invalidates_old_secret(self):
        new_secret = rs.provision_rail("rail-1", "Test rail", now=at(5))
        self.assertFalse(rs.authenticate_rail("rail-1", self.secret))
        self.assertTrue(rs.authenticate_rail("rail-1", new_secret))

    # --- arming and the stop latch -------------------------------------------
    def test_motion_requires_arming(self):
        with self.assertRaises(ValueError):
            rs.enqueue_command("rail-1", self.user, "home", now=at(1))
        rs.enqueue_command("rail-1", self.user, "arm", now=at(1))
        out = rs.enqueue_command("rail-1", self.user, "home", now=at(2))
        self.assertTrue(out["queued"])

    def test_arming_expires(self):
        rs.enqueue_command("rail-1", self.user, "arm", now=at(0))
        with self.assertRaises(ValueError):
            rs.enqueue_command("rail-1", self.user, "home", now=at(rs.ARM_MINUTES * 60 + 1))

    def test_stop_is_always_accepted_and_latches(self):
        # even unarmed
        out = rs.enqueue_command("rail-1", self.user, "stop", now=at(1))
        self.assertTrue(out["queued"])
        sync = rs.rail_sync("rail-1", {"state": {"moving": False}}, now=at(2))
        self.assertTrue(sync["stop_latched"])
        self.assertEqual([c["type"] for c in sync["commands"]], ["stop"])
        # stop stays latched on every later check-in, with no new command needed
        again = rs.rail_sync("rail-1", {"state": {}}, now=at(5))
        self.assertTrue(again["stop_latched"])
        # motion is refused until cleared
        rs.enqueue_command("rail-1", self.user, "arm", now=at(6))
        with self.assertRaises(ValueError):
            rs.enqueue_command("rail-1", self.user, "home", now=at(7))
        rs.enqueue_command("rail-1", self.user, "clear_stop", now=at(8))
        self.assertTrue(rs.enqueue_command("rail-1", self.user, "home", now=at(9))["queued"])

    # --- delivery, expiry, acks ------------------------------------------------
    def test_commands_delivered_once_in_order(self):
        rs.enqueue_command("rail-1", self.user, "arm", now=at(0))
        a = rs.enqueue_command("rail-1", self.user, "calibrate", now=at(1))["seq"]
        b = rs.enqueue_command("rail-1", self.user, "home", now=at(1))["seq"]
        first = rs.rail_sync("rail-1", {"state": {}}, now=at(2))
        self.assertEqual([c["seq"] for c in first["commands"]], [a, b])
        second = rs.rail_sync("rail-1", {"state": {}}, now=at(3))
        self.assertEqual(second["commands"], [])

    def test_stale_commands_never_delivered(self):
        rs.enqueue_command("rail-1", self.user, "arm", now=at(0))
        rs.enqueue_command("rail-1", self.user, "home", now=at(1))
        late = rs.rail_sync("rail-1", {"state": {}}, now=at(1 + rs.COMMAND_TTL_S + 1))
        self.assertEqual(late["commands"], [])

    def test_stop_outlives_normal_ttl(self):
        rs.enqueue_command("rail-1", self.user, "stop", now=at(0))
        late = rs.rail_sync("rail-1", {"state": {}}, now=at(rs.COMMAND_TTL_S + 20))
        self.assertEqual([c["type"] for c in late["commands"]], ["stop"])

    def test_acks_recorded(self):
        rs.enqueue_command("rail-1", self.user, "arm", now=at(0))
        seq = rs.enqueue_command("rail-1", self.user, "home", now=at(1))["seq"]
        rs.rail_sync("rail-1", {"state": {}}, now=at(2))
        rs.rail_sync("rail-1", {"state": {}, "acks": [{"seq": seq, "result": "done"}]}, now=at(4))
        recent = rs.get_status("rail-1", now=at(4))["recent"]
        self.assertEqual(recent[0]["result"], "done")
        self.assertIsNotNone(recent[0]["acked_at"])

    # --- polling rate (protects the free-tier quota) ----------------------------
    def test_poll_interval_adapts(self):
        idle = rs.rail_sync("rail-1", {"state": {}}, now=at(0))
        self.assertEqual(idle["poll_ms"], rs.POLL_IDLE_MS)
        rs.enqueue_command("rail-1", self.user, "arm", now=at(1))
        armed = rs.rail_sync("rail-1", {"state": {"moving": False}}, now=at(2))
        self.assertEqual(armed["poll_ms"], rs.POLL_ARMED_MS)
        moving = rs.rail_sync("rail-1", {"state": {"moving": True}}, now=at(4))
        self.assertEqual(moving["poll_ms"], rs.POLL_MOVING_MS)

    def test_fast_checkins_are_throttled(self):
        rs.rail_sync("rail-1", {"state": {}}, now=at(0))
        fast = rs.rail_sync("rail-1", {"state": {}}, now=at(0) + timedelta(milliseconds=50))
        self.assertTrue(fast.get("throttled"))

    # --- validation ---------------------------------------------------------------
    def test_parameter_validation(self):
        rs.enqueue_command("rail-1", self.user, "arm", now=at(0))
        bad = [
            ("move", {"distance_cm": 3}), ("move", {"distance_cm": 41}), ("move", {}),
            ("move", {"distance_cm": "abc"}), ("move", {"distance_cm": float("nan")}),
            ("move", {"distance_cm": 20, "speed_cm_s": 9}),
            ("jog", {"delta_cm": 50}),
            ("start_profile", {"target_cm": 35, "fast_end_cm": 30}),
            ("start_profile", {"dwell_ms": 5}),
            ("explode", {}),
        ]
        for ctype, params in bad:
            with self.assertRaises(ValueError, msg=f"{ctype} {params}"):
                rs.enqueue_command("rail-1", self.user, ctype, params, now=at(1))
        ok = rs.enqueue_command("rail-1", self.user, "start_profile", {}, now=at(2))
        self.assertTrue(ok["queued"])

    def test_unknown_rail_rejected(self):
        with self.assertRaises(ValueError):
            rs.enqueue_command("nope", self.user, "stop", now=at(0))

    def test_pending_queue_is_capped(self):
        rs.enqueue_command("rail-1", self.user, "arm", now=at(0))
        for _ in range(rs.MAX_PENDING):
            rs.enqueue_command("rail-1", self.user, "jog", {"delta_cm": 0.5}, now=at(1))
        with self.assertRaises(ValueError):
            rs.enqueue_command("rail-1", self.user, "jog", {"delta_cm": 0.5}, now=at(1))
        # but STOP still gets through a full queue
        self.assertTrue(rs.enqueue_command("rail-1", self.user, "stop", now=at(1))["queued"])

    def test_state_is_sanitised(self):
        rs.rail_sync("rail-1", {"state": {"distance_cm": 30.5, "evil": "x" * 5000, "mode": "y" * 500}}, now=at(0))
        state = rs.get_status("rail-1", now=at(1))["state"]
        self.assertEqual(state["distance_cm"], 30.5)
        self.assertNotIn("evil", state)
        self.assertLessEqual(len(state["mode"]), 120)

    # --- HTTP-level routing ---------------------------------------------------------
    def test_http_routes_and_auth(self):
        token = rs.create_session(1, now=at(0))
        auth = {"Authorization": f"Bearer {token}"}
        rail = {"X-Rail-Id": "rail-1", "X-Rail-Secret": self.secret}

        self.assertEqual(rs.handle_request("POST", "/api/rail/command", {}, {}, {"rail_id": "rail-1", "type": "stop"}, at(1))[0], 401)
        self.assertEqual(rs.handle_request("GET", "/api/rail/status", {}, {"rail_id": "rail-1"}, {}, at(1))[0], 401)
        self.assertEqual(rs.handle_request("POST", "/api/rail/sync", {"X-Rail-Id": "rail-1", "X-Rail-Secret": "bad"}, {}, {}, at(1))[0], 401)
        self.assertEqual(rs.handle_request("POST", "/api/rail/sync", {}, {}, {}, at(1))[0], 401)

        code, out = rs.handle_request("POST", "/api/rail/command", auth, {}, {"rail_id": "rail-1", "type": "arm"}, at(2))
        self.assertEqual((code, out["armed"]), (200, True))
        code, out = rs.handle_request("POST", "/api/rail/command", auth, {}, {"rail_id": "rail-1", "type": "move", "params": {"distance_cm": 99}}, at(3))
        self.assertEqual(code, 400)
        code, out = rs.handle_request("POST", "/api/rail/command", auth, {}, {"rail_id": "rail-1", "type": "move", "params": {"distance_cm": 25}}, at(3))
        self.assertEqual(code, 200)
        code, out = rs.handle_request("POST", "/api/rail/sync", rail, {}, {"state": {"distance_cm": 40}}, at(4))
        self.assertEqual(code, 200)
        self.assertEqual(out["commands"][0]["type"], "move")
        self.assertEqual(out["commands"][0]["params"]["distance_cm"], 25.0)
        code, out = rs.handle_request("GET", "/api/rail/status", auth, {"rail_id": "rail-1"}, {}, at(5))
        self.assertEqual(code, 200)
        self.assertTrue(out["online"])

        # logout kills the token
        rs.handle_request("POST", "/api/auth/logout", auth, {}, {}, at(6))
        self.assertEqual(rs.handle_request("GET", "/api/rail/status", auth, {"rail_id": "rail-1"}, {}, at(7))[0], 401)
        self.assertEqual(rs.handle_request("GET", "/api/rail/nothing", auth, {}, {}, at(7))[0], 404)

    def test_offline_detection(self):
        rs.rail_sync("rail-1", {"state": {}}, now=at(0))
        self.assertTrue(rs.get_status("rail-1", now=at(10))["online"])
        self.assertFalse(rs.get_status("rail-1", now=at(10 * 60))["online"])


if __name__ == "__main__":
    unittest.main()

"""
Accu-Vis Clinical API - Vercel Serverless Entry Point (Flask)

Mirrors the routes served locally by server.py (used for `python3 server.py`
during local development), but runs as a Vercel Python serverless function
backed by Postgres instead of the local SQLite file.

Deployment: import this repo into Vercel with the project's Root Directory
set to `ui`, add the Vercel Postgres integration (Storage tab -> Postgres),
which injects POSTGRES_URL automatically, then deploy.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "database"))
import db_manager  # noqa: E402

from flask import Flask, request, jsonify  # noqa: E402

app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response


@app.route('/api/patients', methods=['GET', 'OPTIONS'])
def patients():
    if request.method == 'OPTIONS':
        return '', 200
    return jsonify(db_manager.get_all_patients())


@app.route('/api/patients', methods=['POST'])
def create_patient():
    payload = request.get_json(silent=True) or {}
    patient = db_manager.create_patient(payload)
    return jsonify({"status": "success", "patient": patient}), 201


@app.route('/api/logs', methods=['GET', 'OPTIONS'])
def logs():
    if request.method == 'OPTIONS':
        return '', 200
    return jsonify(db_manager.get_all_logs())


@app.route('/api/logs', methods=['POST'])
def create_log():
    payload = request.get_json(silent=True) or {}
    log = db_manager.create_log(payload)
    return jsonify({"status": "success", "log": log}), 201


@app.route('/api/auth/users', methods=['GET', 'OPTIONS'])
def auth_users():
    if request.method == 'OPTIONS':
        return '', 200
    return jsonify(db_manager.get_all_users())


@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    payload = request.get_json(silent=True) or {}
    identifier = payload.get("email_or_username") or payload.get("email") or payload.get("username")
    password = payload.get("password")
    user = db_manager.authenticate_user(identifier, password)
    if user:
        return jsonify({"status": "success", "user": user}), 200
    return jsonify({"status": "error", "message": "Invalid email/username or password."}), 401


@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    payload = request.get_json(silent=True) or {}
    try:
        user = db_manager.register_user(payload)
        return jsonify({"status": "success", "user": user}), 201
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route('/api/auth/update-profile', methods=['POST'])
def auth_update_profile():
    payload = request.get_json(silent=True) or {}
    try:
        user = db_manager.update_user_profile(payload.get("id"), payload)
        return jsonify({"status": "success", "user": user}), 200
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route('/api/auth/reset-password', methods=['POST'])
def auth_reset_password():
    payload = request.get_json(silent=True) or {}
    try:
        db_manager.reset_password(payload.get("email"), payload.get("password"))
        return jsonify({"status": "success", "message": "Password updated successfully."}), 200
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route('/api/webrtc/start', methods=['POST'])
def webrtc_start():
    """Reset (or freshly create) a pairing session before the camera phone
    posts its offer. Called by whichever side starts first."""
    payload = request.get_json(silent=True) or {}
    try:
        db_manager.start_signal_session(payload.get("session_id"))
        return jsonify({"status": "success"}), 200
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route('/api/webrtc/signal', methods=['POST'])
def webrtc_signal():
    payload = request.get_json(silent=True) or {}
    try:
        db_manager.create_signal(
            payload.get("session_id"),
            payload.get("sender"),
            payload.get("msg_type"),
            payload.get("payload")
        )
        return jsonify({"status": "success"}), 201
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route('/api/webrtc/signal', methods=['GET'])
def webrtc_poll():
    try:
        rows = db_manager.get_signals(
            request.args.get("session_id"),
            request.args.get("since", 0),
            request.args.get("exclude")
        )
        return jsonify(rows), 200
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.errorhandler(404)
def not_found(e):
    return jsonify({"status": "error", "message": "Not found."}), 404

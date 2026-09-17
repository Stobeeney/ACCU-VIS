#!/usr/bin/env python3
"""
Accu-Vis UI Local Development & Clinic Database API Server
Provides zero-dependency static file serving, CORS headers,
and REST API endpoints backed by SQLite and JSON database.
"""

import http.server
import socketserver
import os
import sys
import json
import time
import socket
import webbrowser

DIRECTORY = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(DIRECTORY, "database"))

try:
    import db_manager
except Exception as e:
    print(f"Warning: db_manager import error: {e}")
    db_manager = None

PORT = 8080

# In-memory latest-frame relay for the "phone as remote camera" feature.
# The camera phone (camera.html) POSTs JPEG frames here; the controller
# (dot-measure view) polls GET to display them. Local-network only, by
# design -- this never touches Vercel/production, only python3 server.py.
LATEST_FRAME = {"data": None, "ts": 0.0}
CAMERA_STALE_SECONDS = 3.0

def get_lan_ip():
    """Best-effort LAN IP for display only; falls back to localhost."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return "localhost"

class AccuVisHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/patients':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            patients = db_manager.get_all_patients() if db_manager else []
            self.wfile.write(json.dumps(patients).encode('utf-8'))
            return
        elif self.path == '/api/logs':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            logs = db_manager.get_all_logs() if db_manager else []
            self.wfile.write(json.dumps(logs).encode('utf-8'))
            return
        elif self.path == '/api/auth/users':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            users = db_manager.get_all_users() if db_manager else []
            self.wfile.write(json.dumps(users).encode('utf-8'))
            return
        elif self.path.startswith('/api/camera/frame'):
            if LATEST_FRAME["data"] is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.end_headers()
            self.wfile.write(LATEST_FRAME["data"])
            return
        elif self.path == '/api/camera/status':
            age = (time.time() - LATEST_FRAME["ts"]) if LATEST_FRAME["ts"] else None
            connected = age is not None and age < CAMERA_STALE_SECONDS
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "connected": connected,
                "age_seconds": age,
                "lan_url": f"http://{get_lan_ip()}:{self.server.server_address[1]}/camera.html"
            }).encode('utf-8'))
            return

        super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))

        if self.path == '/api/camera/frame':
            # Raw JPEG bytes from camera.html, not JSON -- read before any UTF-8 decode.
            frame_bytes = self.rfile.read(content_length)
            LATEST_FRAME["data"] = frame_bytes
            LATEST_FRAME["ts"] = time.time()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
            return

        post_data = self.rfile.read(content_length).decode('utf-8')
        try:
            payload = json.loads(post_data) if post_data else {}
        except Exception:
            payload = {}

        if self.path == '/api/patients':
            if db_manager:
                patient = db_manager.create_patient(payload)
                self.send_response(201)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "patient": patient}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
            return
        elif self.path == '/api/logs':
            if db_manager:
                log = db_manager.create_log(payload)
                self.send_response(201)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "log": log}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
            return
        elif self.path == '/api/auth/login':
            if db_manager:
                identifier = payload.get("email_or_username") or payload.get("email") or payload.get("username")
                password = payload.get("password")
                user = db_manager.authenticate_user(identifier, password)
                if user:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "success", "user": user}).encode('utf-8'))
                else:
                    self.send_response(401)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": "Invalid email/username or password."}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
            return
        elif self.path == '/api/auth/register':
            if db_manager:
                try:
                    user = db_manager.register_user(payload)
                    self.send_response(201)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "success", "user": user}).encode('utf-8'))
                except ValueError as e:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
            return
        elif self.path == '/api/auth/update-profile':
            if db_manager:
                try:
                    user = db_manager.update_user_profile(payload.get("id"), payload)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "success", "user": user}).encode('utf-8'))
                except ValueError as e:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
            return
        elif self.path == '/api/auth/reset-password':
            if db_manager:
                try:
                    db_manager.reset_password(payload.get("email"), payload.get("password"))
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "success", "message": "Password updated successfully."}).encode('utf-8'))
                except ValueError as e:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
            return

        self.send_response(404)
        self.end_headers()

    def guess_type(self, path):
        mtype = super().guess_type(path)
        if path.endswith('.js'):
            return 'application/javascript'
        if path.endswith('.css'):
            return 'text/css'
        if path.endswith('.html'):
            return 'text/html'
        return mtype

def run_server(port=PORT):
    handler = AccuVisHTTPHandler
    socketserver.TCPServer.allow_reuse_address = True
    
    current_port = port
    max_attempts = 10
    httpd = None

    for i in range(max_attempts):
        try:
            httpd = socketserver.TCPServer(("", current_port), handler)
            break
        except OSError:
            current_port += 1

    if httpd is None:
        print(f"Error: Could not bind to any port in range {port}-{port + max_attempts}")
        sys.exit(1)

    url = f"http://localhost:{current_port}"
    lan_url = f"http://{get_lan_ip()}:{current_port}"
    print("=" * 64)
    print("   ACCU-VIS OPERATOR-ASSISTED CLINICAL UI SERVER")
    print("=" * 64)
    print(f" * Serving directory: {DIRECTORY}")
    print(f" * Database directory: {os.path.join(DIRECTORY, 'database')}")
    print(f" * Server running at: {url}")
    print(f" * On your local network: {lan_url}")
    print(f" * Camera phone page:     {lan_url}/camera.html")
    print(" * Open the controller (dashboard) and the camera phone page")
    print("   using the LAN address above -- both devices must be on the")
    print("   same WiFi network.")
    print(" * Press Ctrl+C to terminate the server.")
    print("=" * 64)

    if "--open" in sys.argv:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Accu-Vis UI server...")
        httpd.server_close()
        print("Server shutdown cleanly.")

if __name__ == "__main__":
    port_arg = PORT
    for arg in sys.argv[1:]:
        if arg.isdigit():
            port_arg = int(arg)
    run_server(port_arg)

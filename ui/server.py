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
import ssl
import threading
import subprocess
import webbrowser
from urllib.parse import urlparse, parse_qs

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

# Phone browsers only allow camera access on HTTPS (or localhost), so the
# server also listens on HTTPS with a self-signed certificate for the LAN IP.
HTTPS_PORT = 8443
HTTPS_ACTIVE = {"port": None}
CERT_DIR = os.path.join(DIRECTORY, "certs")

class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

def ensure_self_signed_cert(ip):
    """Create (once per LAN IP) a self-signed cert; returns (cert, key) or None."""
    os.makedirs(CERT_DIR, exist_ok=True)
    cert = os.path.join(CERT_DIR, f"accuvis-{ip}.crt")
    key = os.path.join(CERT_DIR, f"accuvis-{ip}.key")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    try:
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", key, "-out", cert, "-days", "825",
            "-subj", "/CN=Accu-Vis Local",
            "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost"
        ], check=True, capture_output=True)
        return cert, key
    except Exception as e:
        print(f"Warning: could not create HTTPS certificate: {e}")
        return None

def start_https_server(handler, ip):
    pair = ensure_self_signed_cert(ip)
    if not pair:
        return
    try:
        httpsd = ThreadedServer(("", HTTPS_PORT), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(pair[0], pair[1])
        httpsd.socket = ctx.wrap_socket(httpsd.socket, server_side=True)
        HTTPS_ACTIVE["port"] = HTTPS_PORT
        threading.Thread(target=httpsd.serve_forever, daemon=True).start()
    except OSError as e:
        print(f"Warning: HTTPS server could not start on port {HTTPS_PORT}: {e}")

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
        elif self.path.startswith('/api/webrtc/signal'):
            q = parse_qs(urlparse(self.path).query)
            try:
                rows = db_manager.get_signals(
                    q.get('session_id', [None])[0],
                    q.get('since', [0])[0],
                    q.get('exclude', [None])[0]
                ) if db_manager else []
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(rows).encode('utf-8'))
            except ValueError as e:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
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
                "lan_url": (f"https://{get_lan_ip()}:{HTTPS_ACTIVE['port']}/camera.html"
                            if HTTPS_ACTIVE["port"]
                            else f"http://{get_lan_ip()}:{self.server.server_address[1]}/camera.html")
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

        if self.path == '/api/webrtc/start':
            if db_manager:
                try:
                    db_manager.start_signal_session(payload.get("session_id"))
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
                except ValueError as e:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
            return
        elif self.path == '/api/webrtc/signal':
            if db_manager:
                try:
                    db_manager.create_signal(
                        payload.get("session_id"), payload.get("sender"),
                        payload.get("msg_type"), payload.get("payload")
                    )
                    self.send_response(201)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
                except ValueError as e:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
            return
        elif self.path == '/api/patients':
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
    current_port = port
    max_attempts = 10
    httpd = None

    for i in range(max_attempts):
        try:
            httpd = ThreadedServer(("", current_port), handler)
            break
        except OSError:
            current_port += 1

    if httpd is None:
        print(f"Error: Could not bind to any port in range {port}-{port + max_attempts}")
        sys.exit(1)

    url = f"http://localhost:{current_port}"
    lan_ip = get_lan_ip()
    lan_url = f"http://{lan_ip}:{current_port}"
    start_https_server(handler, lan_ip)
    https_url = f"https://{lan_ip}:{HTTPS_ACTIVE['port']}" if HTTPS_ACTIVE["port"] else None
    print("=" * 64)
    print("   ACCU-VIS OPERATOR-ASSISTED CLINICAL UI SERVER")
    print("=" * 64)
    print(f" * Serving directory: {DIRECTORY}")
    print(f" * Database directory: {os.path.join(DIRECTORY, 'database')}")
    print(f" * Server running at: {url}")
    print(f" * On your local network: {lan_url}")
    if https_url:
        print(f" * Camera phone page (HTTPS, required for camera): {https_url}/camera.html")
        print("   First visit shows a certificate warning: tap Advanced > Proceed.")
    else:
        print(f" * Camera phone page:     {lan_url}/camera.html")
    print(" * Both devices must be on the same WiFi network.")
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

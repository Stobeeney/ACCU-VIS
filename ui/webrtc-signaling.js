/**
 * Accu-Vis WebRTC Signaling Client
 *
 * Tiny polling-based signaling helper shared by camera.html (sender) and
 * the controller (app.js, receiver). Real video never touches this --
 * it only relays the small SDP offer/answer and ICE candidate messages
 * needed to establish a direct peer-to-peer WebRTC connection, via
 * /api/webrtc/* (same backend on server.py locally and api/index.py on
 * Vercel, both writing to the same database).
 *
 * The phone and the controller must reach the SAME backend: both on the
 * hosted site, or both on the local server.
 */

// STUN finds each device's public address; on the same WiFi, WebRTC connects
// directly over the LAN and needs no internet for the video itself.
// To relay video on networks where a direct link is impossible (some mobile
// carriers, strict firewalls), add a TURN server here, e.g.:
//   { urls: 'turn:turn.example.com:3478', username: '...', credential: '...' }
window.ACCUVIS_ICE_SERVERS = window.ACCUVIS_ICE_SERVERS || [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];

class AccuVisSignaling {
  constructor(sessionId, role) {
    this.sessionId = sessionId;
    this.role = role; // 'camera' or 'controller'
    this.lastId = 0;
    this.pollTimer = null;
    this.polling = false;
  }

  async start() {
    // Only the initiating side (the camera phone, which owns the code) should call this.
    const res = await fetch('/api/webrtc/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: this.sessionId })
    });
    if (!res.ok) throw new Error(`Could not start pairing session (HTTP ${res.status})`);
  }

  async send(msgType, payloadObj) {
    const body = JSON.stringify({
      session_id: this.sessionId,
      sender: this.role,
      msg_type: msgType,
      payload: JSON.stringify(payloadObj)
    });
    // A dropped message would stall pairing, so retry a couple of times.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('/api/webrtc/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        if (res.ok) return;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
    throw lastErr;
  }

  /**
   * Poll for messages from the other side and hand them to onMessage ONE AT A
   * TIME, in order (each handler is awaited). That ordering matters: an ICE
   * candidate must not be applied before the offer/answer it belongs to.
   * Polls fast while pairing, then backs off.
   */
  startPolling(onMessage, { fastMs = 300, slowMs = 1500, fastForMs = 20000 } = {}) {
    this.stopPolling();
    this.polling = true;
    const startedAt = Date.now();

    const loop = async () => {
      if (!this.polling) return;
      try {
        const url = `/api/webrtc/signal?session_id=${encodeURIComponent(this.sessionId)}&since=${this.lastId}&exclude=${this.role}`;
        const res = await fetch(url);
        if (res.ok) {
          const rows = await res.json();
          for (const row of rows) {
            if (!this.polling) return;
            this.lastId = Math.max(this.lastId, row.id);
            try {
              await onMessage(row.msg_type, JSON.parse(row.payload));
            } catch (e) {
              console.warn('Signaling message handling error:', e);
            }
          }
        }
      } catch (e) {
        // transient network hiccup; the next poll retries
      }
      if (!this.polling) return;
      const interval = Date.now() - startedAt < fastForMs ? fastMs : slowMs;
      this.pollTimer = setTimeout(loop, interval);
    };
    loop();
  }

  stopPolling() {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

window.AccuVisSignaling = AccuVisSignaling;

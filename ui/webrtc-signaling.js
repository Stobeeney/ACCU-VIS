/**
 * Accu-Vis WebRTC Signaling Client
 *
 * Tiny polling-based signaling helper shared by camera.html (sender) and
 * the controller (app.js, receiver). Real video never touches this --
 * it only relays the small SDP offer/answer and ICE candidate messages
 * needed to establish a direct peer-to-peer WebRTC connection, via
 * /api/webrtc/* (same backend on server.py locally and api/index.py on
 * Vercel, both writing to the same database).
 */

class AccuVisSignaling {
  constructor(sessionId, role) {
    this.sessionId = sessionId;
    this.role = role; // 'camera' or 'controller'
    this.lastId = 0;
    this.pollTimer = null;
  }

  async start() {
    // Only the initiating side (the camera phone, which owns the code) should call this.
    await fetch('/api/webrtc/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: this.sessionId })
    });
  }

  async send(msgType, payloadObj) {
    await fetch('/api/webrtc/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        sender: this.role,
        msg_type: msgType,
        payload: JSON.stringify(payloadObj)
      })
    });
  }

  startPolling(onMessage, intervalMs = 1000) {
    this.stopPolling();
    const poll = async () => {
      try {
        const url = `/api/webrtc/signal?session_id=${encodeURIComponent(this.sessionId)}&since=${this.lastId}&exclude=${this.role}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const rows = await res.json();
        for (const row of rows) {
          this.lastId = Math.max(this.lastId, row.id);
          try {
            onMessage(row.msg_type, JSON.parse(row.payload));
          } catch (e) {
            console.warn('Signaling message handling error:', e);
          }
        }
      } catch (e) {
        // transient network hiccup; next poll will retry
      }
    };
    poll();
    this.pollTimer = setInterval(poll, intervalMs);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

window.AccuVisSignaling = AccuVisSignaling;

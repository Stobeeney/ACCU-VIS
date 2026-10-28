/**
 * Accu-Vis Rail Cloud Client
 *
 * Talks to the rail THROUGH the server (/api/rail/*), so the hosted site never has to reach
 * the rail directly. Pure logic, no DOM: app.js builds the UI on top of it.
 *
 * Commands are asynchronous: the rail picks them up at its next check-in (about every second
 * while armed, every 20 s when idle) and acknowledges them at the check-in after that. So
 * command() can wait for the acknowledgement and report what the rail actually did.
 *
 * STOP is latched on the server and is never queued behind anything: stop() does not wait.
 */
class AccuVisRailCloud {
  constructor(opts = {}) {
    this.railId = opts.railId || 'rail-1';
    this.getToken = opts.getToken || (() => '');
    this.fetch = opts.fetch || ((...args) => window.fetch(...args));
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ackPollMs = opts.ackPollMs || 500;
    this.ackTimeoutMs = opts.ackTimeoutMs || 6000;
  }

  _headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getToken()}` };
  }

  async _json(url, init) {
    let res;
    try {
      res = await this.fetch(url, init);
    } catch (e) {
      return { ok: false, network: true, error: 'Cannot reach the server. Check this device\'s internet connection.' };
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
    if (res.status === 401) return { ok: false, authError: true, error: 'Please sign out and sign in again to control the rail.' };
    if (!res.ok || data.ok === false) return { ok: false, error: data.error || `Server error (${res.status}).` };
    return data;
  }

  _noToken() {
    return { ok: false, authError: true, error: 'Please sign out and sign in again to control the rail.' };
  }

  /** Current rail state as the server knows it. */
  async status() {
    if (!this.getToken()) return this._noToken();
    const d = await this._json(`/api/rail/status?rail_id=${encodeURIComponent(this.railId)}`, { headers: this._headers() });
    if (!d.ok) return d;
    return {
      ok: true,
      online: !!d.online,
      armed: !!d.armed,
      stopLatched: !!d.stop_latched,
      ageS: typeof d.age_s === 'number' ? d.age_s : null,
      state: d.state || {},
      recent: d.recent || []
    };
  }

  /**
   * Send a command. By default waits for the rail's acknowledgement.
   * Resolves { ok, result, error, seq, timeout }.
   */
  async command(type, params = {}, { wait = true } = {}) {
    if (!this.getToken()) return this._noToken();
    const d = await this._json('/api/rail/command', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ rail_id: this.railId, type, params })
    });
    if (!d.ok) return d;
    if (!d.queued || !wait) return { ok: true, queued: !!d.queued, seq: d.seq };
    return this._waitForAck(d.seq);
  }

  async _waitForAck(seq) {
    const attempts = Math.max(1, Math.ceil(this.ackTimeoutMs / this.ackPollMs));
    for (let i = 0; i < attempts; i++) {
      await this.sleep(this.ackPollMs);
      const s = await this.status();
      if (!s.ok) return s;
      const hit = s.recent.find((r) => r.id === seq && r.acked_at);
      if (hit) {
        const result = String(hit.result || '');
        const ok = result === 'ok' || result === 'stopped';
        return { ok, seq, result, error: ok ? undefined : AccuVisRailCloud.explain(result) };
      }
    }
    return { ok: false, seq, timeout: true, error: 'The rail did not confirm in time. Is it powered, on WiFi, and armed?' };
  }

  arm() { return this.command('arm', {}, { wait: false }); }
  disarm() { return this.command('disarm', {}, { wait: false }); }
  clearStop() { return this.command('clear_stop', {}, { wait: false }); }
  stop() { return this.command('stop', {}, { wait: false }); }   // latched; never waits

  static explain(result) {
    const map = {
      'rejected:not armed': 'The rail refused: it is not armed.',
      'rejected:stop latched': 'The rail refused: a stop is latched. Clear the stop first.',
      'rejected:not calibrated': 'The rail refused: it is not calibrated. Put the carriage at the 40 cm mark and calibrate.',
      'rejected:moving': 'The rail refused: it is moving. Stop it first.',
      'rejected:range': 'The rail refused: that distance is outside its travel limits.',
      'rejected:profile': 'The rail refused the approach settings.',
      'rejected:unknown': 'The rail does not understand that command (is its firmware up to date?).'
    };
    return map[result] || `The rail answered: ${result || 'no result'}.`;
  }

  /**
   * Convert a status() result to the shape the old direct (local) rail API returned, so the
   * existing approach/jog/home code in app.js keeps working unchanged.
   */
  static toLocalStatus(s) {
    if (!s || !s.ok) return null;
    const st = s.state || {};
    return {
      ok: s.online,                       // an offline rail is "not ok": its numbers are stale
      online: s.online,
      armed: s.armed,
      stop_latched: s.stopLatched,
      calibrated: !!st.calibrated,
      distance_cm: typeof st.distance_cm === 'number' ? st.distance_cm : null,
      moving: !!st.moving,
      min_cm: typeof st.limit_min_cm === 'number' ? st.limit_min_cm : 4.0,
      max_cm: typeof st.limit_max_cm === 'number' ? st.limit_max_cm : 40.0,
      profile_state: st.profile_state || 'IDLE',
      mode: st.mode || 'idle',
      stop_reason: st.stop_reason || '',
      age_s: s.ageS,
      rssi: st.rssi
    };
  }
}

window.AccuVisRailCloud = AccuVisRailCloud;

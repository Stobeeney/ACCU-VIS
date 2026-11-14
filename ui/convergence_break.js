/**
 * Convergence-break detector (NPC) for Accu-Vis.
 *
 * Input per camera frame: the two eyes' iris offsets (from MediaPipe landmarks), the rail's
 * last reported state, and a tracking-quality flag. Output: a break distance, or an honest
 * "no reading".
 *
 * What it measures
 *   vergence = (hA - hB) - baseline
 * where h is the iris offset along the eye axis in half-eye-widths (+ = toward image-right).
 * Eye A is image-left and eye B image-right, so turning both eyes toward the nose raises hA and
 * lowers hB: the SUM of the two nasal movements is the vergence. Head turns and sideways gaze move
 * both eyes the same way and cancel in this difference. Baseline = median at the start distance.
 * About 0.014 units per degree of rotation per eye.
 *
 * What a break is
 *   Vergence rises as the target comes closer. The break is where it stops rising and falls back by
 *   more than a threshold that is learned from the session's own noise, for CONFIRM_BINS dwell
 *   positions in a row. The reported distance is the FIRST position of that run, not the one that
 *   confirmed it.
 *
 * Position sampling
 *   Stepped mode only uses settled samples during each dwell window. Continuous mode projects the
 *   latest rail position forward using the reported motion speed and telemetry age, then bins frames
 *   by that estimated position. Stale continuous telemetry is discarded; its position estimate is
 *   approximate and still needs validation against the physical rail.
 *
 * No clinical validation exists yet: treat the result as a measurement to compare with a clinician,
 * not as a diagnosis.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConvergenceBreakDetector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    binCm: 0.5,               // rail positions closer than this are the same step
    baselineCm: 39.0,         // samples at or beyond this distance form the baseline
    baselineMinSamples: 20,
    minSamplesPerBin: 6,
    settleMs: 150,            // after the rail stops, wait for vibration to die down
    pollLagMs: 1000,          // how late the page may learn that the rail started moving again
    minDropUnits: 0.08,       // smallest drop that can count as a break (~6 degrees, both eyes)
    noiseK: 4,                // ...and at least this many noise sigmas
    maxThresholdUnits: 0.30,  // noisier than this: we cannot tell a break from noise
    confirmBins: 2,           // consecutive dropped positions needed
    minRiseUnits: 0.05,       // the eyes must first have converged by this much (else no evidence)
    minQuality: 0.6,
    minCoverage: 0.5,         // share of expected positions that need a usable reading
    continuous: false,
    maxStatusAgeMs: 1500      // reject continuous samples when rail telemetry is too stale
  };

  const median = (a) => {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mad = (a) => {                       // robust sigma estimate
    const m = median(a);
    return 1.4826 * median(a.map((v) => Math.abs(v - m)));
  };

  class ConvergenceBreakDetector {
    constructor(opts = {}) {
      this.o = Object.assign({}, DEFAULTS, opts);
      this.reset();
    }

    reset() {
      this.rail = {
        distanceCm: null, moving: true, stableSince: null, updatedAt: null,
        dwellMs: 2000, speedCmPerSec: 0, direction: -1, sampleEnabled: true
      };
      this.baselineRaw = [];
      this.bins = new Map();       // key -> { cm, vals: [] }
      this.frames = 0;
      this.used = 0;
      this.result = null;
      this.startCm = null;
      this.lowestCm = null;
    }

    /** dwellMs = the profile's pause at every step; startCm / endCm = expected range (for coverage) */
    configure({ dwellMs, startCm, endCm, continuous, minSamplesPerBin }) {
      if (dwellMs) this.rail.dwellMs = dwellMs;
      if (startCm !== undefined) this.startCm = startCm;
      if (endCm !== undefined) this.lowestCm = endCm;
      if (continuous !== undefined) this.o.continuous = !!continuous;
      if (Number.isInteger(minSamplesPerBin) && minSamplesPerBin >= 3) {
        this.o.minSamplesPerBin = minSamplesPerBin;
      }
    }

    /** Call with every rail status the page receives. t in ms. */
    updateRail({ t, distanceCm, moving, speedCmPerSec = 0, distanceAgeMs = 0, direction = -1, sampleEnabled = true }) {
      const r = this.rail;
      const isMoving = !!moving;
      const ageMs = Math.max(0, Number(distanceAgeMs) || 0);
      const stale = isMoving && this.o.continuous && ageMs > this.o.maxStatusAgeMs;
      const reportedDistanceCm = Number(distanceCm);
      const speed = Math.max(0, Number(speedCmPerSec) || 0);
      const travelDirection = direction < 0 ? -1 : 1;
      const correctedDistanceCm = reportedDistanceCm + (isMoving ? travelDirection * speed * ageMs / 1000 : 0);
      const changed = r.distanceCm === null || Math.abs(correctedDistanceCm - r.distanceCm) > 0.02 || isMoving;
      if (changed) r.stableSince = isMoving ? null : t;
      else if (r.stableSince === null) r.stableSince = t;
      r.distanceCm = correctedDistanceCm;
      r.moving = isMoving;
      r.updatedAt = t;
      r.speedCmPerSec = speed;
      r.direction = travelDirection;
      r.sampleEnabled = !!sampleEnabled && !stale;
    }

    positionAt(t) {
      const r = this.rail;
      if (r.distanceCm === null || !r.sampleEnabled) return null;
      if (!r.moving || !this.o.continuous || r.updatedAt === null) return r.distanceCm;
      const projected = r.distanceCm + r.direction * r.speedCmPerSec * Math.max(0, t - r.updatedAt) / 1000;
      return Math.max(this.lowestCm ?? 0, Math.min(40, projected));
    }

    /** raw = hA - hB for this frame; usable/quality come from the tracker. */
    addFrame({ t, raw, usable, quality }) {
      this.frames++;
      const r = this.rail;
      if (!usable || !(quality >= this.o.minQuality) || !Number.isFinite(raw)) return;
      if (r.distanceCm === null || !r.sampleEnabled || (r.moving && !this.o.continuous)) return;
      const movingContinuous = r.moving && this.o.continuous;
      const age = r.stableSince === null ? 0 : t - r.stableSince;
      if (!movingContinuous && (r.stableSince === null || age < this.o.settleMs)) return;
      const sampleDistanceCm = this.positionAt(t);
      if (sampleDistanceCm === null) return;

      if (!movingContinuous && sampleDistanceCm >= this.o.baselineCm) {
        this.baselineRaw.push(raw);               // rail resting at the start: no dwell to respect
        if (this.baselineRaw.length > 400) this.baselineRaw.shift();
        return;
      }
      if (sampleDistanceCm >= this.o.baselineCm) return;
      if (!movingContinuous && age > r.dwellMs - this.o.pollLagMs) return;

      const key = Math.round(sampleDistanceCm / this.o.binCm);
      let bin = this.bins.get(key);
      if (!bin) { bin = { cm: key * this.o.binCm, vals: [] }; this.bins.set(key, bin); }
      if (bin.vals.length < 300) bin.vals.push(raw);
      this.used++;
    }

    get baselineReady() { return this.baselineRaw.length >= this.o.baselineMinSamples; }
    get baseline() { return this.baselineReady ? median(this.baselineRaw) : null; }

    /** Per-position medians, farthest first. */
    series() {
      const base = this.baseline;
      if (base === null) return [];
      const out = [];
      for (const bin of this.bins.values()) {
        if (bin.vals.length < this.o.minSamplesPerBin) continue;
        out.push({ cm: bin.cm, vergence: median(bin.vals) - base, n: bin.vals.length, sigma: mad(bin.vals) });
      }
      return out.sort((a, b) => b.cm - a.cm);
    }

    /**
     * Current verdict. final=true when the approach is over (decides "no break" vs "no reading").
     * state: 'collecting' | 'break' | 'no_break' | 'unreliable'
     */
    evaluate(final = false) {
      const o = this.o;
      if (!this.baselineReady) {
        return this._done(final ? 'unreliable' : 'collecting', { reason: 'No steady reading of both eyes at the start distance.' });
      }
      const s = this.series();
      if (!s.length) {
        return this._done(final ? 'unreliable' : 'collecting', { reason: 'No usable readings during the approach.' });
      }

      // Use both the starting baseline noise and the per-position spread. The baseline
      // floor prevents small continuous-sweep bins from understating tracker noise.
      const binSigma = median(s.map((p) => p.sigma));
      const baselineSigma = mad(this.baselineRaw);
      const sigma = Math.max(binSigma, Number.isFinite(baselineSigma) ? baselineSigma : 0);
      const threshold = Math.max(o.minDropUnits, o.noiseK * sigma);
      if (threshold > o.maxThresholdUnits) {
        return this._done(final ? 'unreliable' : 'collecting', { reason: 'Eye readings are too noisy to tell a break from noise.', sigma, threshold });
      }

      let peak = -Infinity, peakCm = null;
      let run = [];
      for (const p of s) {
        if (p.vergence > peak) { peak = p.vergence; peakCm = p.cm; run = []; continue; }
        if (p.vergence < peak - threshold) {
          run.push(p);
          if (run.length >= o.confirmBins) {
            if (peak < o.minRiseUnits) {
              return this._done('unreliable', { reason: 'The eyes never showed convergence, so a break cannot be located.', sigma, threshold, peak });
            }
            return this._done('break', {
              breakCm: run[0].cm, confirmedCm: p.cm, peakCm, peakUnits: peak, sigma, threshold,
              approxDeg: peak / 0.014
            });
          }
        } else {
          run = [];
        }
      }

      if (!final) return this._done('collecting', { peakCm, peakUnits: peak, sigma, threshold });

      const expected = (this.startCm !== null && this.lowestCm !== null)
        ? Math.max(1, Math.round((Math.min(this.startCm, 30) - this.lowestCm) / o.binCm) + 1)
        : s.length;
      const coverage = s.length / expected;
      if (coverage < o.minCoverage) {
        return this._done('unreliable', { reason: 'Too many positions had no usable reading (face lost, blinks or head turn).', coverage, sigma, threshold });
      }
      if (peak < o.minRiseUnits) {
        return this._done('unreliable', { reason: 'No clear convergence was measured, so "no break" cannot be claimed.', coverage, sigma, threshold, peak });
      }
      return this._done('no_break', { peakCm, peakUnits: peak, approxDeg: peak / 0.014, coverage, sigma, threshold });
    }

    _done(state, info) {
      this.result = Object.assign({ state, framesSeen: this.frames, framesUsed: this.used }, info);
      return this.result;
    }
  }

  ConvergenceBreakDetector.DEFAULTS = DEFAULTS;
  return ConvergenceBreakDetector;
});

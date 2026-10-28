// Replay tests for ui/convergence_break.js. Run: node tests/convergence_break.test.js
// Simulates the real rail profile (fast sweep, 0.5 cm steps, dwell, page polling ~1 s late) and a
// 30 fps eye tracker with noise, then checks the detector's verdict.
const assert = require('assert');
const Detector = require('../convergence_break.js');

// small deterministic RNG so failures reproduce
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

const UNITS_PER_DEG = 0.014;
// both eyes' total convergence for a target at d cm (IPD 6.2 cm), as detector units, relative to 40 cm
const verg = (d) => (2 * Math.atan(3.1 / d) - 2 * Math.atan(3.1 / 40)) * 180 / Math.PI * UNITS_PER_DEG;

/**
 * opts: breakAtCm (eye drifts out from here on), dropUnits, noise (per-frame sigma), dwellMs,
 *       faceLossFrom/To (cm range with no face), pollMs, seed
 */
function simulate(opts = {}) {
  const o = Object.assign({ breakAtCm: null, dropUnits: 0.12, noise: 0.02, dwellMs: 2500, pollMs: 900, seed: 1, stepCm: 0.5, slowCms: 0.5 }, opts);
  const r = rng(o.seed);
  const det = new Detector();
  det.configure({ dwellMs: o.dwellMs, startCm: 30, endCm: 20 });

  let t = 0;
  let pos = 40, moving = false;
  let nextPoll = 0;
  const frameDt = 1000 / 30;
  let nextFrame = 0;

  const tick = (untilMs) => {
    while (t < untilMs) {
      t += 5;
      if (t >= nextPoll) { det.updateRail({ t, distanceCm: pos, moving }); nextPoll += o.pollMs + (r() - 0.5) * 200; }
      if (t >= nextFrame) {
        nextFrame += frameDt;
        let trueV = verg(pos);
        if (o.breakAtCm !== null && pos <= o.breakAtCm) trueV -= o.dropUnits;
        const hidden = o.faceLossFrom !== undefined && pos <= o.faceLossFrom && pos >= o.faceLossTo;
        det.addFrame({ t, raw: trueV + gauss(r) * o.noise, usable: !hidden, quality: hidden ? 0 : 0.9 });
      }
    }
  };
  const move = (to, cms) => {
    moving = true;
    const dur = Math.abs(pos - to) / cms * 1000;
    const from = pos, t0 = t;
    while (t < t0 + dur) { tick(t + 20); pos = from + (to - from) * Math.min(1, (t - t0) / dur); }
    pos = to; moving = false;
  };

  tick(1500);                                   // resting at 40 cm: baseline
  move(30, 0.75);                               // fast sweep
  let stopped = null;
  for (let cm = 30; cm >= 20 - 1e-9; cm -= o.stepCm) {
    tick(t + o.dwellMs);
    const ev = det.evaluate(false);
    if (ev.state === 'break') { stopped = ev; break; }
    if (cm > 20 + 1e-9) move(cm - o.stepCm, o.slowCms);
  }
  return { det, stopped, final: stopped || det.evaluate(true) };
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

test('healthy convergence, no break: reports "no_break", never a false stop', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { final } = simulate({ seed });
    assert.strictEqual(final.state, 'no_break', `seed ${seed}: ${JSON.stringify(final)}`);
  }
});

test('a clear break at 24 cm is located within one step, from the FIRST dropped position', () => {
  const errs = [];
  for (let seed = 1; seed <= 30; seed++) {
    const { stopped } = simulate({ seed, breakAtCm: 24 });
    assert.ok(stopped, `seed ${seed}: no break found`);
    errs.push(Math.abs(stopped.breakCm - 24));
  }
  assert.ok(Math.max(...errs) <= 0.5, 'worst error ' + Math.max(...errs));
});

test('the same results with the 2 s dwell used on the bench', () => {
  for (let seed = 1; seed <= 20; seed++) {
    assert.strictEqual(simulate({ seed, dwellMs: 2000 }).final.state, 'no_break');
    const b = simulate({ seed, dwellMs: 2000, breakAtCm: 26 }).stopped;
    assert.ok(b && Math.abs(b.breakCm - 26) <= 0.5, `seed ${seed}: ${JSON.stringify(b)}`);
  }
});

test('late rail polling does not shift the reported distance', () => {
  const b = simulate({ seed: 7, breakAtCm: 25, pollMs: 1400 }).stopped;
  assert.ok(b && Math.abs(b.breakCm - 25) <= 0.5, JSON.stringify(b));
});

test('a small wobble (smaller than the threshold) is not called a break', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { final } = simulate({ seed, breakAtCm: 24, dropUnits: 0.04 });
    assert.notStrictEqual(final.state, 'break', `seed ${seed}`);
  }
});

test('face lost through the middle of the approach: "unreliable", not "no break"', () => {
  const { final } = simulate({ seed: 3, faceLossFrom: 28, faceLossTo: 21 });
  assert.strictEqual(final.state, 'unreliable', JSON.stringify(final));
  assert.ok(/usable reading|face/i.test(final.reason), final.reason);
});

test('very noisy eyes: "unreliable", never a made-up distance', () => {
  const { final } = simulate({ seed: 5, noise: 0.25 });
  assert.strictEqual(final.state, 'unreliable', JSON.stringify(final));
});

test('no baseline (no face at the start): "unreliable"', () => {
  const d = new Detector();
  d.updateRail({ t: 0, distanceCm: 30, moving: false });
  const e = d.evaluate(true);
  assert.strictEqual(e.state, 'unreliable');
});

test('eyes that never converge cannot produce "no break"', () => {
  // flat vergence: baseline OK, positions OK, but no rise
  const d = new Detector();
  d.configure({ dwellMs: 2500, startCm: 30, endCm: 20 });
  let t = 0;
  d.updateRail({ t, distanceCm: 40, moving: false });
  for (let i = 0; i < 60; i++) { t += 33; d.addFrame({ t, raw: 0.5, usable: true, quality: 0.9 }); }
  for (let cm = 30; cm >= 20; cm -= 0.5) {
    t += 10; d.updateRail({ t, distanceCm: cm, moving: false });
    for (let i = 0; i < 60; i++) { t += 33; d.addFrame({ t, raw: 0.5, usable: true, quality: 0.9 }); }
  }
  const e = d.evaluate(true);
  assert.strictEqual(e.state, 'unreliable', JSON.stringify(e));
});

test('samples while the rail is moving are ignored', () => {
  const d = new Detector();
  d.updateRail({ t: 0, distanceCm: 35, moving: true });
  for (let i = 0; i < 100; i++) d.addFrame({ t: 100 + i * 33, raw: 1, usable: true, quality: 0.9 });
  assert.strictEqual(d.used, 0);
});

test('samples late in a dwell (when the distance label may be stale) are ignored', () => {
  const d = new Detector();
  d.configure({ dwellMs: 2500, startCm: 30, endCm: 20 });
  d.updateRail({ t: 0, distanceCm: 40, moving: false });
  for (let i = 0; i < 40; i++) d.addFrame({ t: 200 + i * 33, raw: 0, usable: true, quality: 0.9 });
  d.updateRail({ t: 3000, distanceCm: 29, moving: false });
  const base = d.used;
  d.addFrame({ t: 3100, raw: 0.1, usable: true, quality: 0.9 });      // too soon after stopping (settling)
  assert.strictEqual(d.used, base);
  d.addFrame({ t: 3600, raw: 0.1, usable: true, quality: 0.9 });      // inside the window
  assert.strictEqual(d.used, base + 1);
  d.addFrame({ t: 4800, raw: 0.1, usable: true, quality: 0.9 });      // 1.8 s into a 2.5 s dwell: past dwell - 1 s
  assert.strictEqual(d.used, base + 1);
});

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);

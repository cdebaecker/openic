// Rendering ZMUSIC songs / sound effects inside a Session, loop detection and trimming.
import { ZM } from './session.mjs';

const FPS = 55.46;            // frames per second of the emulated display (15 kHz mode)
export const SILENCE = 2e-4;  // |sample| threshold for "audible" (about -74 dBFS)

// ---- loop detection on the OPM/ADPCM event stream -------------------------------------------
// events: flat [t0, tok0, t1, tok1, ...] (t in samples). Looks for the period k (in events) for
// which the end of the stream repeats the furthest back: tok[i] == tok[i-k] for i in [r, N).
// Requires at least one full period of overlap (N - r >= k), i.e. two complete passes.
// Returns { s, k, start, period, jitter } or null. start/period in samples.
export function detectLoop(events, { window = 48, minPeriodSec = 2, rate = 48000 } = {}) {
  const N = events.length >> 1;
  if (N < window * 4) return null;
  const tok = new Int32Array(N), t = new Float64Array(N);
  for (let i = 0; i < N; i++) { t[i] = events[2 * i]; tok[i] = events[2 * i + 1]; }
  // rolling hash of `window` tokens
  const B = 0x01000193;
  let pw = 1; for (let i = 0; i < window; i++) pw = Math.imul(pw, B);
  const H = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) H[i + 1] = (Math.imul(H[i], B) + tok[i]) | 0;
  const hashAt = (j) => (H[j + window] - Math.imul(H[j], pw)) | 0;
  const tail = N - window, target = hashAt(tail);
  let best = null;
  for (let j = tail - 1; j >= 0; j--) {
    if (hashAt(j) !== target) continue;
    const k = tail - j;
    if (t[N - 1] - t[N - 1 - k] < minPeriodSec * rate) continue;
    let r = N;
    while (r - 1 - k >= 0 && tok[r - 1] === tok[r - 1 - k]) r--;
    if (N - r < k + window) continue;
    const s = r - k;
    if (!best || s < best.s) best = { s, k, r };
  }
  if (!best) return null;
  // period from the time differences over the matched region; reject unsteady timing
  const { s, k, r } = best;
  let sum = 0, n = 0, mn = Infinity, mx = -Infinity;
  for (let i = r; i < N; i++) { const d = t[i] - t[i - k]; sum += d; n++; if (d < mn) mn = d; if (d > mx) mx = d; }
  const period = sum / n;
  return { s, k, start: t[s], period, jitter: mx - mn, events: N };
}

// Half the peak-to-peak range of either channel in [from, to) (ignores a DC offset).
// Fallback when the whole stream never repeats within the render: some songs have tracks of
// slightly different lengths (e.g. 48.61 s and 48.48 s), so the exact period is their least
// common multiple. Find the period of each OPM channel (key on/off + key code writes) and use
// the period shared by most events; channels with another period drift at the loop seam.
export function detectChannelLoop(events, { rate = 48000 } = {}) {
  const per = [];
  for (let ch = 0; ch < 8; ch++) {
    const e = [];
    for (let i = 0; i < events.length; i += 2) {
      const r = events[i + 1] >> 8, v = events[i + 1] & 255;
      if ((r === 8 && (v & 7) === ch) || r === 0x28 + ch) e.push(events[i], events[i + 1]);
    }
    if (e.length < 64) continue;
    const L = detectLoop(e, { window: 16, rate });
    per.push({ ch, n: e.length / 2, loop: L && L.jitter < rate * 0.01 ? L : null });
  }
  // A channel fits period T if T is a whole multiple of its own period (ostinato channels
  // repeat a short figure). Pick the T covering most events (shortest on a tie).
  const total = per.reduce((a, c) => a + c.n, 0);
  let g = null;
  for (const cand of per) {
    if (!cand.loop) continue;
    const T = cand.loop.period;
    const chans = per.filter((c) => {
      if (!c.loop) return false;
      const m = Math.round(T / c.loop.period);
      return m >= 1 && Math.abs(T - m * c.loop.period) < rate * 0.002 * m;
    });
    const n = chans.reduce((a, c) => a + c.n, 0);
    if (!g || n > g.n || (n === g.n && T < g.period)) g = { period: T, n, chans };
  }
  if (!g || g.n < 0.6 * total) return null;
  const start = Math.max(...g.chans.map((c) => c.loop.start));
  const period = g.period;
  const drift = per.filter((c) => !g.chans.includes(c)).map((c) => ({ ch: c.ch + 1, period_sec: c.loop ? +(c.loop.period / rate).toFixed(3) : null }));
  return { start, period, approx: drift.length > 0, share: g.n / total, drift };
}

function peakFrom(au, from, to) {
  let p = 0;
  for (let c = 0; c < 2; c++) {
    let mn = Infinity, mx = -Infinity;
    for (let i = Math.max(0, from) * 2 + c; i < Math.min(to * 2, au.length); i += 2) { const v = au[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx > mn) p = Math.max(p, (mx - mn) / 2);
  }
  return p;
}
// One-pole DC blocker (about 4 Hz): the X68000 output is AC-coupled, and the emulated
// MSM6258 can stop on a non-zero level after an ADPCM sample, which leaves a DC offset.
export function dcBlock(au, R = 0.9995) {
  let xl = 0, yl = 0, xr = 0, yr = 0;
  for (let i = 0; i < au.length; i += 2) {
    const l = au[i], r = au[i + 1];
    yl = l - xl + R * yl; xl = l; yr = r - xr + R * yr; xr = r;
    au[i] = yl; au[i + 1] = yr;
  }
  return au;
}
export function firstAudible(au, from = 0) {
  for (let i = from * 2; i < au.length; i++) if (Math.abs(au[i]) > SILENCE) return i >> 1;
  return -1;
}
export function lastAudible(au) {
  for (let i = au.length - 1; i >= 0; i--) if (Math.abs(au[i]) > SILENCE) return i >> 1;
  return -1;
}
export function rms(au, from = 0, to = au.length >> 1) {
  let e = 0, n = 0;
  for (let i = from * 2; i < to * 2 && i < au.length; i++) { e += au[i] * au[i]; n++; }
  return n ? Math.sqrt(e / n) : 0;
}

export function envelope(au, from, len, win) {
  const n = Math.floor(len / win), e = new Float64Array(n);
  for (let w = 0; w < n; w++) {
    let acc = 0;
    for (let i = (from + w * win) * 2, end = i + win * 2; i < end && i < au.length; i++) acc += au[i] * au[i];
    e[w] = Math.sqrt(acc / (win * 2));
  }
  return e;
}
function pearson(a, b, lag) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) {
    const x = a[i], y = b[i + lag]; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; n++;
  }
  const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : (va === vb ? 1 : 0);
}
// Spectral similarity of au[a..a+len] and au[b..b+len]: 1024-point frames (mono, Hann), energy
// in 24 log-spaced bands (dB), Pearson correlation per frame pair averaged. FM phase drift and
// noise do not change the band energies, so this stays near 1 for the same music and drops
// for different notes. Also returns the same measure at b + len/3 as a baseline.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function bands(au, at, rate) {
  const N = 1024, re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { const k = (at + i) * 2; re[i] = ((au[k] ?? 0) + (au[k + 1] ?? 0)) * 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); }
  fft(re, im);
  const out = new Float64Array(24);
  for (let b = 0; b < 24; b++) {
    const f0 = 60 * Math.pow(16000 / 60, b / 24), f1 = 60 * Math.pow(16000 / 60, (b + 1) / 24);
    let e = 1e-10;
    for (let k = Math.max(1, Math.floor(f0 * N / rate)); k < Math.max(Math.floor(f0 * N / rate) + 1, Math.floor(f1 * N / rate)); k++) e += re[k] * re[k] + im[k] * im[k];
    out[b] = 10 * Math.log10(e);
  }
  return out;
}
export function spectralMatch(au, a, b, len, rate) {
  const step = Math.round(rate * 0.05), n = Math.max(1, Math.floor(len / step));
  const sim = (x, y) => { let t = 0; for (let i = 0; i < n; i++) t += pearson(bands(au, x + i * step, rate), bands(au, y + i * step, rate), 0); return t / n; };
  const r4 = (v) => Math.round(v * 1000) / 1000;
  return { match: r4(sim(a, b)), baseline: r4(sim(a, b + Math.round(len / 3) + 977)) };
}

// Last resort for songs whose tracks never line up again and share channels (so neither the
// whole stream nor single channels repeat): find the lag with the most similar spectra.
// Features every 50 ms; lag searched in [minSec, maxSec]; returns { start, period, score }.
export function audioLoop(au, rate, { minSec = 20, maxSec = 300 } = {}) {
  const hop = Math.round(rate * 0.05), nf = Math.floor((au.length / 2 - 1024) / hop);
  const F = [];
  for (let i = 0; i < nf; i++) {
    const b = bands(au, i * hop, rate);
    let m = 0; for (const v of b) m += v; m /= b.length;
    let sd = 0; for (let k = 0; k < b.length; k++) { b[k] -= m; sd += b[k] * b[k]; }
    sd = Math.sqrt(sd) || 1; for (let k = 0; k < b.length; k++) b[k] /= sd;
    F.push(b);
  }
  const dot = (x, y) => { let t = 0; for (let k = 0; k < x.length; k++) t += x[k] * y[k]; return t; };
  const W = Math.round(30 / 0.05), S0 = Math.round(20 / 0.05);
  let best = null;
  for (let L = Math.round(minSec / 0.05); L <= Math.round(maxSec / 0.05) && S0 + W + L < nf; L++) {
    let t = 0; for (let i = S0; i < S0 + W; i++) t += dot(F[i], F[i + L]);
    t /= W;
    if (!best || t > best.score) best = { L, score: t };
  }
  if (!best) return null;
  // earliest start whose next 10 s match one period later about as well as the best window
  const w = Math.round(10 / 0.05), local = (s0) => { let t = 0; for (let i = s0; i < s0 + w; i++) t += dot(F[i], F[i + best.L]); return t / w; };
  let ref = -1; for (let s0 = 0; s0 + w + best.L < nf && s0 < best.L; s0 += 20) ref = Math.max(ref, local(s0));
  let start = 0; for (let s0 = 0; s0 + w + best.L < nf; s0 += 20) if (local(s0) >= 0.97 * ref) { start = s0; break; }
  return { start: start * hop, period: best.L * hop, score: +best.score.toFixed(3) };
}

// Envelope similarity of au[a..a+len] and au[b..b+len] (10 ms windows, lag search +-50 ms).
export function envelopeMatch(au, a, b, len, rate) {
  const win = Math.round(rate / 100);
  const ea = envelope(au, a, len, win), eb = envelope(au, b, len, win);
  let best = { corr: -2, lagMs: 0 };
  for (let lag = -5; lag <= 5; lag++) { const c = pearson(ea, eb, lag); if (c > best.corr) best = { corr: c, lagMs: lag * 10 }; }
  best.corr = Math.round(best.corr * 10000) / 10000;
  return best;
}

// intro au[lead, S) + one loop body au[S + second, S + second + P), joined with short crossfades
// to what really follows / precedes each seam (au must extend at least P + 20 ms past the body).
export function assembleLoop(au, lead, S, P, second, rate) {
  const intro = au.subarray(lead * 2, S * 2);
  const body = au.subarray((S + second) * 2, (S + second + P) * 2);
  const out = new Float32Array(intro.length + body.length);
  out.set(intro); out.set(body, intro.length);
  // Seams: the passes are not sample-identical (FM phases, 64-sample register timing), so
  // the body's end does not meet its own start exactly. Over FADE samples, the start of the
  // body fades in from what really followed the body's end (one period later), and the end
  // of the intro fades toward what really preceded that point, so both the loop seam and
  // the intro -> loop seam join continuous signals.
  const FADE = Math.round(0.02 * rate), B0 = S + second, after = B0 + P;
  const ib = intro.length >> 1;
  if (after + FADE <= (au.length >> 1)) {
    for (let i = 0; i < FADE; i++) {
      const w = 0.5 - 0.5 * Math.cos(Math.PI * i / FADE);          // 0 -> 1
      for (let c = 0; c < 2; c++) {
        const o = (ib + i) * 2 + c;
        out[o] = au[(after + i) * 2 + c] * (1 - w) + au[(B0 + i) * 2 + c] * w;
      }
    }
    const F2 = Math.min(FADE, ib);
    if (F2 > 0) {
      for (let i = 0; i < F2; i++) {
        const w = 0.5 - 0.5 * Math.cos(Math.PI * (i + 1) / F2);      // -> 1 at the seam
        for (let c = 0; c < 2; c++) {
          const o = (ib - F2 + i) * 2 + c;
          out[o] = out[o] * (1 - w) + au[(after - F2 + i) * 2 + c] * w;
        }
      }
    }
  }
  return out;
}

// ---- music ---------------------------------------------------------------------------------
// Play compiled ZMUSIC data at `addr` (address of the "\x10ZmuSiC" header) and render until it
// ends or until a loop is found and confirmed. Returns the output clip and loop info.
export function renderMusic(sess, addr, { maxSec = 900, fallbackSec = 300, audioSec = 640, log = () => {} } = {}) {
  const rate = sess.rate;
  sess.reset();
  sess.call(ZM.PLAY_CNV_DATA, { a1: addr + 7 });
  const sec = () => sess.samples / rate;
  let ended = false, cand = null, confirmed = null, nextCheck = 20, endAt = Infinity, approx = null;
  while (sec() < maxSec) {
    sess.runFrames(Math.round(FPS));       // one second
    if (sess.call(ZM.M_STAT) === 0) {       // all tracks finished: let the release tails ring
      if (!ended) { ended = true; endAt = sec() + 3; }
    }
    if (ended) { if (sec() >= endAt) break; continue; }
    if (approx) { if (sess.samples >= approx.until) { confirmed = approx; break; } continue; }
    if (!cand && sec() >= fallbackSec) {
      const c = detectChannelLoop(sess.events, { rate });
      if (c) {
        approx = { ...c, until: c.start + 2 * c.period + 2 * rate };
        log(`  no exact loop; per-channel period ${(c.period / rate).toFixed(3)}s from ${(c.start / rate).toFixed(2)}s (${Math.round(c.share * 100)}% of events), drifting: ${JSON.stringify(c.drift)}`);
        continue;
      }
      fallbackSec = sec() + 60;
      if (sec() >= audioSec) {
        const a = audioLoop(dcBlock(sess.audio()), rate);
        if (a && a.score >= 0.9) {
          approx = { ...a, approx: true, method: 'audio', until: a.start + 2 * a.period + 2 * rate };
          log(`  no exact or per-channel loop; spectral period ${(a.period / rate).toFixed(2)}s from ${(a.start / rate).toFixed(2)}s (score ${a.score})`);
          continue;
        }
        audioSec = Infinity;
      }
    }
    if (cand) {
      if (sess.samples >= cand.until) {
        const c = detectLoop(sess.events, { rate });
        if (c && c.k === cand.k && Math.abs(c.start - cand.start) < 1 && c.jitter < rate * 0.004) { confirmed = c; break; }
        log(`  loop candidate rejected (k=${cand.k} start=${(cand.start / rate).toFixed(2)}s) -> ${c ? `k=${c.k} start=${(c.start / rate).toFixed(2)}s` : 'none'}`);
        cand = c && c.jitter < rate * 0.004 ? { ...c, until: c.start + 2 * c.period + Math.max(60 * rate, c.period) } : null;
      }
    } else if (sec() >= nextCheck) {
      nextCheck = sec() + 10;
      const c = detectLoop(sess.events, { rate });
      if (c && c.jitter < rate * 0.004) {
        cand = { ...c, until: c.start + 2 * c.period + Math.max(60 * rate, c.period) };
        log(`  loop candidate k=${c.k} start=${(c.start / rate).toFixed(2)}s period=${(c.period / rate).toFixed(2)}s; confirming`);
      }
    }
  }
  const au = dcBlock(sess.audio());
  const lead = Math.max(0, firstAudible(au));
  if (confirmed) {
    const P = Math.round(confirmed.period);
    let S = Math.max(Math.round(confirmed.start), lead);
    // The register streams of two passes can differ in details (several tracks sharing a
    // channel interleave their writes differently) although the music is the same. Move the
    // loop start back while the music one period later still sounds the same.
    // Both the band spectra and the loudness envelope must still match (spectra alone do not
    // tell apart different notes of similar timbre); songs with a flat envelope keep their
    // register-exact start.
    const win = 6 * rate, ref = spectralMatch(au, S, S + P, win, rate).match;
    const refEnv = envelopeMatch(au, S, S + P, win, rate).corr;
    const startBefore = S;
    for (let t = S - rate; t >= lead && refEnv >= 0.5; t -= rate) {
      if (spectralMatch(au, t, t + P, win, rate).match < Math.min(0.93, ref - 0.03)) break;
      if (envelopeMatch(au, t, t + P, win, rate).corr < Math.min(0.8, refEnv - 0.1)) break;
      S = t;
    }
    if (S !== startBefore) log(`  loop start moved back from ${(startBefore / rate).toFixed(2)}s to ${(S / rate).toFixed(2)}s (same music one period later)`);
    // Exact loops: intro from the first pass, loop body from the second pass, so the end of
    // the body flows into its own start exactly as the music does when it repeats.
    // For approximate loops (tracks of different lengths, or a track that stops after the
    // first pass) the first pass is what the game plays first, so it is used as the body.
    const out = assembleLoop(au, lead, S, P, confirmed.approx ? 0 : P, rate);
    // how well pass 2 matches pass 1 after the loop start: correlation of 10 ms loudness
    // envelopes over up to 20 s (sample-exact equality is not expected: the emulator applies
    // register writes at 64-sample granularity and FM phases drift), and the envelope lag.
    const sim = envelopeMatch(au, S, S + P, Math.min(P, 20 * rate), rate);
    const spec = spectralMatch(au, S, S + P, Math.min(P, 20 * rate), rate);
    return { audio: out, loop: { start: S - lead, end: (S - lead) + P }, ended: false,
      exactStart: (Math.max(Math.round(confirmed.start), lead) - lead) / rate,
      loopMatch: sim.corr, loopLagMs: sim.lagMs, specMatch: spec.match, specBaseline: spec.baseline, rendered: sec(),
      ...(confirmed.approx ? { approx: confirmed.method === 'audio' ? { method: 'audio', score: confirmed.score }
        : { method: 'channels', share: +confirmed.share.toFixed(3), drift: confirmed.drift } } : {}) };
  }
  const last = lastAudible(au);
  const end = Math.min(au.length >> 1, last + Math.round(0.05 * rate));
  return { audio: au.slice(lead * 2, Math.max(lead, end) * 2), loop: null, ended, rendered: sec() };
}

// ---- sound effects -------------------------------------------------------------------------
// Start an effect with `start()` (one trap #3 call) and render until it has been quiet for
// `quietSec` (after at least one key-on / ADPCM start), or `maxSec`.
export function renderEffect(sess, start, { maxSec = 20, quietSec = 0.6 } = {}) {
  const rate = sess.rate;
  sess.reset();
  start();
  const q = Math.round(quietSec * rate);
  let done = false;
  while (sess.samples < maxSec * rate) {
    sess.runFrames(6);
    if (sess.samples < q) continue;
    const au = sess.audio();
    const n = au.length >> 1;
    if (peakFrom(au, n - q, n) <= SILENCE && (sess.keyOns > 0 || n > 3 * rate)) { done = true; break; }
  }
  const au = dcBlock(sess.audio());
  const lead = Math.max(0, firstAudible(au));
  const last = lastAudible(au);
  const end = Math.min(au.length >> 1, last + Math.round(0.02 * rate));
  return { audio: au.slice(lead * 2, Math.max(lead, end) * 2), ended: done, keyOns: sess.keyOns };
}

// Interactive explainer of the contour options start point shift and line stipple (first border of the cylinder).
//   Start point   start points of 30 layers: top view of the ring and the unrolled side wall, where stacked seams
//                 form a vertical line. 'previous' and 'random_previous' follow lib/sorting/start_point_history.js
//                 (64 evenly spaced candidates, first one far enough from the last n layers wins, else the
//                 farthest). The random choice is simulated with its own generator, not ATU's.
//   Line stipple  the ring cut into dashes; pass k exposes every count-th dash, the next pass fills the gaps
import { COLOR, createCanvas, label, mountWalk, bindRanges } from "./plane.js";

const R = 11.94;                 // first border of the 24 mm cylinder: 12 mm - 0.06 mm beam compensation
const N_POINTS = 96;             // points of the ring
const MAX_CANDIDATES = 64;       // S_MAX_CANDIDATES
const LAYERS = 30;
const CIRC = 2 * Math.PI * R;
const MODES = ["off", "random", "previous", "random_previous"];
export const MODE_NAMES = { off: "Off", random: "Random", previous: "Previous layers", random_previous: "Random + previous layers" };
const DEFAULTS = {
  mode: "start", start: "random_previous", history: 3, minDist: 1, dash: 2, passes: 2, overlap: 0, progress: 100,
  randomStart: false, layer: 1,
};

/** Small seeded generator (mulberry32), so the picture is the same on every redraw. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pointAt = (i) => {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / N_POINTS;    // index 0 at the bottom, like the seam in the video
  return [12 + R * Math.cos(a), 12 + R * Math.sin(a)];
};

/** Start point index of every layer for one mode. */
export function startPoints(mode, historyLayers, minDist) {
  const out = [];
  const cands0 = [];
  for (let i = 0; i < MAX_CANDIDATES; i++) cands0.push(Math.floor((i * N_POINTS) / MAX_CANDIDATES));
  for (let layer = 0; layer < LAYERS; layer++) {
    const r = rng(1000 + layer);
    if (mode === "off") { out.push(0); continue; }
    if (mode === "random") { out.push(Math.floor(r() * N_POINTS)); continue; }
    const cands = cands0.slice();
    if (mode === "random_previous") {
      for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
    }
    const hist = out.slice(Math.max(0, out.length - historyLayers)).map(pointAt);
    let best = cands[0], bestScore = -1;
    for (const c of cands) {
      const [x, y] = pointAt(c);
      const score = hist.length ? Math.min(...hist.map(([hx, hy]) => Math.hypot(x - hx, y - hy))) : Infinity;
      if (score >= minDist) { best = c; break; }
      if (score > bestScore) { bestScore = score; best = c; }
    }
    out.push(best);
  }
  return out;
}

/** Dashes along the ring: [{from, to, pass}] in arc length (mm), in exposure order (pass by pass). */
export function dashes(len, passes, overlap, shift = 0) {
  const n = Math.max(passes, Math.round(CIRC / len));
  const step = CIRC / n;
  const all = [];
  for (let i = 0; i < n; i++) {
    all.push({ from: shift + i * step, to: shift + Math.min(CIRC, (i + 1) * step + overlap), pass: i % passes });
  }
  return all.sort((a, b) => a.pass - b.pass || a.from - b.from);
}

/** Where the dash pattern of a layer begins (mm along the ring): 0, or a random point within one dash. */
function dashShift(s, layer) {
  if (!s.randomStart) return 0;
  const n = Math.max(s.passes, Math.round(CIRC / s.dash));
  return rng(5000 + layer)() * (CIRC / n);
}

const PASS_COLORS = ["#dc3250", "#f08c3c", "#8c46c8", "#0a9b8c", "#3c78dc"];

function createScene(viewerEl) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");

  function ring(ctx, cx, cy, sc, color, width = 1.4) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(cx, cy, R * sc, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  function drawStart(ctx, w, h) {
    const pts = startPoints(s.start, s.history, s.minDist);
    // top view
    const size = Math.min(w * 0.42, h - 70);
    const cx = 18 + size / 2, cy = 30 + size / 2, sc = size / 2 / 13;
    ctx.fillStyle = "#e9f7ea";
    ctx.beginPath(); ctx.arc(cx, cy, R * sc, 0, 2 * Math.PI); ctx.fill();
    ring(ctx, cx, cy, sc, COLOR.border);
    pts.forEach((p, layer) => {
      const [x, y] = pointAt(p);
      const last = layer === LAYERS - 1;
      ctx.fillStyle = last ? COLOR.text : `rgba(60, 68, 77, ${0.15 + (0.55 * layer) / LAYERS})`;
      ctx.beginPath(); ctx.arc(cx + (x - 12) * sc, cy - (y - 12) * sc, last ? 5 : 3, 0, 2 * Math.PI); ctx.fill();
    });
    label(ctx, "top view: start points of 30 layers", cx, cy + size / 2 + 16, { size: 11, color: COLOR.muted, align: "center" });
    // unrolled side wall
    const L = cx + size / 2 + 34, Rr = w - 14, T = 30, B = h - 50;
    ctx.fillStyle = "#e3e7ec";
    ctx.fillRect(L, T, Rr - L, B - T);
    ctx.strokeStyle = COLOR.grid;
    for (let k = 0; k <= 4; k++) { const x = L + ((Rr - L) * k) / 4; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke(); }
    const rowH = (B - T) / LAYERS;
    pts.forEach((p, layer) => {
      const x = L + ((Rr - L) * p) / N_POINTS, y = B - (layer + 0.5) * rowH;
      ctx.fillStyle = COLOR.border;
      ctx.fillRect(x - 3, y - rowH * 0.35, 6, rowH * 0.7);
    });
    label(ctx, "side wall, unrolled: one row per layer", (L + Rr) / 2, 14, { size: 11, color: COLOR.muted, align: "center" });
    label(ctx, `0 … ${CIRC.toFixed(0)} mm around the part`, (L + Rr) / 2, B + 12, { size: 11, color: COLOR.muted, align: "center" });
    const moves = pts.slice(1).map((p, i) => {
      const d = Math.abs(p - pts[i]); return (Math.min(d, N_POINTS - d) * CIRC) / N_POINTS;
    });
    const stacked = moves.filter((m) => m < 0.5).length;
    label(ctx, s.start === "off" ? "Off: every seam on top of the one below, a vertical line on the wall"
      : `${MODE_NAMES[s.start]}: ${stacked} of ${LAYERS - 1} layers start less than 0.5 mm from the layer below`,
    12, h - 14, { size: 12, weight: 600 });
  }

  function drawStipple(ctx, w, h) {
    const shift = dashShift(s, s.layer);
    const list = dashes(s.dash, s.passes, s.overlap, shift);
    const shown = Math.round((list.length * s.progress) / 100);
    const size = Math.min(w - 40, (h - 60) * 2);
    // right half of the ring, enlarged
    const sc = size / 2 / 13, cx = w / 2 - size / 4, cy = (h - 40) / 2;
    const P = (arc, r = R) => { const a = -Math.PI / 2 + arc / R; return [cx + r * sc * Math.cos(a), cy - r * sc * Math.sin(a)]; };
    ctx.fillStyle = "#e9f7ea";
    ctx.beginPath(); ctx.arc(cx, cy, R * sc, 0, 2 * Math.PI); ctx.fill();
    ring(ctx, cx, cy, sc, "rgba(60, 68, 77, .25)", 1);
    // dash joints of the layer below, as ticks outside the ring
    if (s.layer > 1) {
      const below = dashes(s.dash, s.passes, 0, dashShift(s, s.layer - 1));
      ctx.strokeStyle = COLOR.muted;
      ctx.lineWidth = 1.5;
      for (const d of below) {
        const [x0, y0] = P(d.from, R + 0.35), [x1, y1] = P(d.from, R + 1.1);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.lineWidth = 1;
    }
    list.forEach((d, i) => {
      if (i >= shown) return;
      ctx.strokeStyle = PASS_COLORS[d.pass % PASS_COLORS.length];
      ctx.lineWidth = i === shown - 1 ? 6 : 4;
      ctx.beginPath();
      for (let k = 0; k <= 12; k++) { const [x, y] = P(d.from + ((d.to - d.from) * k) / 12); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    });
    ctx.lineWidth = 1;
    const cur = list[Math.max(0, shown - 1)];
    const n = list.length;
    label(ctx, shown === 0 ? "nothing exposed yet" : `pass ${cur.pass + 1} of ${s.passes}: ${shown} of ${n} dashes exposed`,
      12, h - 32, { size: 12, weight: 600 });
    const moved = s.layer > 1 ? Math.abs(shift - dashShift(s, s.layer - 1)) : 0;
    const joints = s.layer < 2 ? "" : s.randomStart ? ` · joints ${moved.toFixed(2)} mm away from layer ${s.layer - 1} (ticks)`
      : ` · joints on top of layer ${s.layer - 1} (ticks)`;
    label(ctx, `${n} dashes of ${(CIRC / n).toFixed(2)} mm${s.overlap ? `, each ${s.overlap} mm longer to overlap` : ""}${joints}`,
      12, h - 13, { size: 12, color: COLOR.muted });
  }

  const canvas = createCanvas(viewerEl, (ctx, w, h) => (s.mode === "stipple" ? drawStipple(ctx, w, h) : drawStart(ctx, w, h)));
  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = s.mode === "stipple" ? `Line stipple · dash ${s.dash} mm · ${s.passes} passes`
      : `Start point shift · ${MODE_NAMES[s.start]}`;
    canvas.redraw();
  }
  set({});
  return { set };
}

// ------------------------------------------------------------------ "Try it" panel

export function mount(root) {
  const scene = createScene(root.querySelector(".viewer"));
  let mode = "start";
  const select = root.querySelector("#startmode");
  const ranges = bindRanges(root, {
    history: (v) => `${v}`,
    mindist: (v) => `${v} mm`,
    dash: (v) => `${v} mm`,
    passes: (v) => `${v}`,
    overlap: (v) => `${v} mm`,
    progress: (v) => `${v} %`,
    dashlayer: (v) => `${v}`,
  }, () => apply());
  const randomStart = root.querySelector("#randomstart");
  function apply() {
    const v = ranges.values();
    scene.set({ mode, start: MODES.includes(select.value) ? select.value : "random", history: v.history,
      minDist: v.mindist, dash: v.dash, passes: v.passes, overlap: v.overlap, progress: v.progress,
      randomStart: randomStart.checked, layer: v.dashlayer });
  }
  [select, randomStart].forEach((el) => el.addEventListener("change", apply));
  root.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    root.querySelectorAll(".modes button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    root.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
    apply();
  }));
  apply();
}

export async function mountCode(walkRoot, recipesRoot, codeUrl) {
  const scene = createScene(walkRoot.querySelector(".viewer"));
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

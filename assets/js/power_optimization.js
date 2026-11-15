// Interactive explainer of the power optimization (lib/power/power_model.js).
//   Wedge   hatch of the power wedge (layer 50, lines at 133°), every vector coloured by its power. With segment
//           splitting the lines are cut into pieces like split_one_segment: each piece gets the power of its real
//           return time to the previous line on the laser timeline (one meander block in line order).
//   Curve   power over vector length: reference_time_ms turns the two lengths into return times, power_from_time
//           interpolates linearly between them
import { COLOR, createCanvas, frame, pathPoly, label, hatchLines, segLength, mountWalk, bindRanges } from "./plane.js";

const WEDGE = [[0, 0], [36, 0], [0, 18]];
const LINE_DIR = 133;           // line direction of layer 50 (start angle 0, +67° per layer)
const HATCH = 0.1;              // mm
const DRAW_EVERY = 4;           // draw every 4th line, 0.1 mm lines would merge on screen
const SPEED = 1200;             // volume hatch, mm/s
const TIMING = { jump: 7000, markUs: 10, jumpUs: 50 };
const DEFAULTS = {
  mode: "wedge", on: true, minPower: 150, maxPower: 280, minLen: 0.5, maxLen: 10,
  split: false, segLen: 0.5, merge: true,
};
const MAX_PIECES = 1000;
const NEIGHBOUR_FACTOR = 1.5;
const SCALE = [150, 280];       // colour range of the 'Laser power' colour mode in the video

/** Colour range: the range of the video, widened when the minimum or maximum power leaves it. */
export function scaleOf(s) {
  return [Math.min(SCALE[0], s.minPower), Math.max(SCALE[1], s.maxPower)];
}

/** Return time of a vector of length len (ms): marking, mark delay, jump of one hatch distance, jump delay. */
export function referenceTimeMs(len, speed = SPEED) {
  return (len / speed) * 1000 + TIMING.markUs / 1000 + (HATCH / TIMING.jump) * 1000 + TIMING.jumpUs / 1000;
}

/** Power for a return time (ms) like power_from_time, rounded to 0.1 W. */
function powerFromTime(t, s) {
  if (t === Infinity) return Math.round(s.maxPower * 10) / 10;
  const lo = referenceTimeMs(s.minLen), hi = referenceTimeMs(s.maxLen);
  const f = hi > lo ? Math.min(1, Math.max(0, (t - lo) / (hi - lo))) : 1;
  return Math.round((s.minPower + f * (s.maxPower - s.minPower)) * 10) / 10;
}

/** Power of a vector (W) with the vector's own reference time (no segment splitting). */
export function powerOf(len, s) {
  if (!s.on) return s.maxPower;
  return powerFromTime(referenceTimeMs(len), s);
}

/** Pieces {seg, power} of every line with segment splitting (split_hatch_segments), index = line index. */
function splitLines(lines, s) {
  const info = [];
  let t = 0, prev = null;
  for (const { seg, len } of lines) {
    if (prev) {
      const jump = Math.hypot(seg[0] - prev[2], seg[1] - prev[3]);
      t += (jump / TIMING.jump) * 1000 + (jump > 1e-6 ? TIMING.jumpUs / 1000 : 0);
    }
    info.push({ t0: t, len });
    t += (len / SPEED) * 1000 + TIMING.markUs / 1000;
    prev = seg;
  }
  return lines.map(({ seg, len }, k) => {
    const n = Math.min(MAX_PIECES, Math.max(1, Math.ceil(len / s.segLen)));
    const dx = len > 0 ? (seg[2] - seg[0]) / len : 0, dy = len > 0 ? (seg[3] - seg[1]) / len : 0;
    const pieces = [];
    for (let j = 0; j < n; j++) {
      const s0 = (j / n) * len, s1 = ((j + 1) / n) * len, mid = ((j + 0.5) / n) * len;
      const qx = seg[0] + dx * mid, qy = seg[1] + dy * mid;
      let interval;
      if (k > 0) {
        const p = lines[k - 1].seg, pl = info[k - 1].len;
        const ux = pl > 0 ? (p[2] - p[0]) / pl : 0, uy = pl > 0 ? (p[3] - p[1]) / pl : 0;
        const along = Math.min(pl, Math.max(0, (qx - p[0]) * ux + (qy - p[1]) * uy));
        const dist = Math.hypot(qx - (p[0] + ux * along), qy - (p[1] + uy * along));
        interval = dist <= NEIGHBOUR_FACTOR * HATCH
          ? info[k].t0 + (mid / SPEED) * 1000 - (info[k - 1].t0 + (along / SPEED) * 1000) : Infinity;
      } else {
        interval = referenceTimeMs(len);
      }
      const piece = { seg: [seg[0] + dx * s0, seg[1] + dy * s0, seg[0] + dx * s1, seg[1] + dy * s1], power: powerFromTime(interval, s) };
      const last = pieces[pieces.length - 1];
      if (s.merge && last && last.power === piece.power) { last.seg[2] = piece.seg[2]; last.seg[3] = piece.seg[3]; }
      else pieces.push(piece);
    }
    return pieces;
  });
}

// viridis, as in the colormap of the 'Laser power' colour mode
const VIRIDIS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
export function viridis(t) {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x)), f = x - i;
  const c = VIRIDIS[i].map((v, k) => Math.round(v + f * (VIRIDIS[i + 1][k] - v)));
  return `rgb(${c.join(",")})`;
}
const powerColor = (p, [lo, hi]) => viridis((p - lo) / (hi - lo));

const LINES = hatchLines(WEDGE, LINE_DIR, HATCH).map((l) => ({ ...l, len: segLength(l.seg) }));

function createScene(viewerEl) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");

  function colourBar(ctx, x, y, w) {
    for (let i = 0; i < w; i++) {
      ctx.fillStyle = viridis(i / (w - 1));
      ctx.fillRect(x + i, y, 1, 10);
    }
    const [lo, hi] = scaleOf(s);
    label(ctx, `${lo} W`, x, y + 20, { size: 11, color: COLOR.muted });
    label(ctx, `${hi} W`, x + w, y + 20, { size: 11, color: COLOR.muted, align: "right" });
  }

  function drawWedge(ctx, w, h) {
    const f = frame([0, 0, w, h - 44], [-1, -1, 37, 19], 18);
    ctx.fillStyle = "#ffffff";
    pathPoly(ctx, f, WEDGE);
    ctx.fill();
    ctx.lineWidth = 1.6;
    const pieces = splitting() ? splitCached() : LINES.map(({ seg, len }) => [{ seg, power: powerOf(len, s) }]);
    const every = drawEvery();
    LINES.forEach(({ c }, k) => {
      if (c % every !== 0) return;
      for (const { seg, power } of pieces[k]) {
        ctx.strokeStyle = powerColor(power, scaleOf(s));
        ctx.beginPath();
        ctx.moveTo(f.x(seg[0]), f.y(seg[1]));
        ctx.lineTo(f.x(seg[2]), f.y(seg[3]));
        ctx.stroke();
      }
    });
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLOR.outline;
    pathPoly(ctx, f, WEDGE);
    ctx.stroke();
    // where the vectors become shorter than the maximum length
    if (s.on && !splitting()) {
      const edge = LINES.filter((l) => l.len < s.maxLen).sort((a, b) => b.len - a.len)[0];
      if (edge) {
        const [x1, y1, x2, y2] = edge.seg;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = COLOR.text;
        ctx.beginPath(); ctx.moveTo(f.x(x1), f.y(y1)); ctx.lineTo(f.x(x2), f.y(y2)); ctx.stroke();
        ctx.setLineDash([]);
        label(ctx, `vectors shorter than ${s.maxLen} mm →`, f.x(Math.max(x1, x2)) - 6, f.y(Math.min(y1, y2)) + 14,
          { size: 11, color: COLOR.text, align: "right" });
      }
    }
    colourBar(ctx, w - 180, h - 38, 160);
    let text;
    if (!s.on) text = `Power optimization off: all ${LINES.length} vectors at ${s.maxPower} W`;
    else if (splitting()) {
      const all = pieces.flat();
      const low = all.filter((p) => p.power < s.maxPower).length;
      text = `${LINES.length} vectors \u2192 ${all.length} segments, ${low} below ${s.maxPower} W`;
    } else {
      const low = LINES.filter((l) => powerOf(l.len, s) < s.maxPower).length;
      text = `${low} of ${LINES.length} vectors get less than ${s.maxPower} W`;
    }
    label(ctx, text, 12, h - 28, { size: 12, weight: 600 });
  }

  const splitting = () => s.on && s.split;
  // an odd step draws lines of both scan directions, so both turning ends of the meander show their ramp
  const drawEvery = () => (splitting() ? DRAW_EVERY - 1 : DRAW_EVERY);
  let cache = { key: "", pieces: null };
  function splitCached() {
    const key = [s.minPower, s.maxPower, s.minLen, s.maxLen, s.segLen, s.merge].join("|");
    if (cache.key !== key) cache = { key, pieces: splitLines(LINES, s) };
    return cache.pieces;
  }

  function drawCurve(ctx, w, h) {
    const L = 58, R = w - 20, T = 24, B = h - 74;
    const lenMax = Math.max(15, Math.ceil(s.maxLen * 1.5 / 5) * 5), pMax = Math.max(300, Math.ceil(s.maxPower / 50) * 50 + 50);
    const X = (len) => L + (len / lenMax) * (R - L), Y = (p) => B - (p / pMax) * (B - T);
    ctx.strokeStyle = COLOR.grid;
    for (let p = 0; p <= pMax; p += 50) {
      ctx.beginPath(); ctx.moveTo(L, Y(p)); ctx.lineTo(R, Y(p)); ctx.stroke();
      label(ctx, `${p} W`, L - 6, Y(p), { size: 11, color: COLOR.muted, align: "right" });
    }
    const step = lenMax > 20 ? 5 : 2.5;
    for (let len = 0; len <= lenMax; len += step) {
      label(ctx, `${len}`, X(len), B + 12, { size: 11, color: COLOR.muted, align: "center" });
      label(ctx, `${referenceTimeMs(len).toFixed(1)}`, X(len), B + 28, { size: 10, color: COLOR.muted, align: "center" });
    }
    label(ctx, "vector length (mm)", R, B + 12, { size: 11, color: COLOR.muted, align: "right", base: "bottom" });
    label(ctx, "return time (ms) at 1200 mm/s", L - 52, B + 28, { size: 10, color: COLOR.muted, base: "middle" });
    // vectors of the wedge as ticks
    for (const { len } of LINES) {
      ctx.fillStyle = powerColor(powerOf(len, s), scaleOf(s));
      ctx.fillRect(X(len) - 1, Y(powerOf(len, s)) - 1, 3, 3);
    }
    // the curve
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 300; i++) {
      const len = (i / 300) * lenMax;
      if (i) ctx.lineTo(X(len), Y(powerOf(len, s))); else ctx.moveTo(X(len), Y(powerOf(len, s)));
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    if (s.on) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = COLOR.muted;
      for (const len of [s.minLen, s.maxLen]) { ctx.beginPath(); ctx.moveTo(X(len), T); ctx.lineTo(X(len), B); ctx.stroke(); }
      ctx.setLineDash([]);
      label(ctx, `${s.minPower} W up to ${s.minLen} mm`, X(s.minLen) + 6, Y(s.minPower) + 14, { size: 11 });
      label(ctx, `${s.maxPower} W from ${s.maxLen} mm`, X(s.maxLen) + 6, Y(s.maxPower) - 12, { size: 11 });
    }
    label(ctx, splitting() ? "Dots: the vectors of the wedge without splitting (with splitting see Wedge)"
      : "Dots: the vectors of the wedge in layer 50", 12, h - 13, { size: 12, weight: 600 });
  }

  const canvas = createCanvas(viewerEl, (ctx, w, h) => (s.mode === "curve" ? drawCurve(ctx, w, h) : drawWedge(ctx, w, h)));
  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = s.mode === "curve" ? "Power over vector length"
      : `Power wedge · layer 50 · every ${drawEvery() === 3 ? "3rd" : `${drawEvery()}th`} hatch line drawn`;
    canvas.redraw();
  }
  set({});
  return { set };
}

// ------------------------------------------------------------------ "Try it" panel

export function mount(root) {
  const scene = createScene(root.querySelector(".viewer"));
  let mode = "wedge";
  const on = root.querySelector("#enabled");
  const split = root.querySelector("#split"), merge = root.querySelector("#merge");
  const ranges = bindRanges(root, {
    minpower: (v) => `${v} W`,
    maxpower: (v) => `${v} W`,
    minlen: (v) => `${v} mm`,
    maxlen: (v) => `${v} mm`,
    seglen: (v) => `${v.toFixed(2)} mm`,
  }, (id) => {
    const v = ranges.values();
    if (id === "minpower" && v.minpower >= v.maxpower) ranges.setValue("maxpower", v.minpower + 10);
    if (id === "maxpower" && v.maxpower <= v.minpower) ranges.setValue("minpower", v.maxpower - 10);
    if (id === "minlen" && v.minlen >= v.maxlen) ranges.setValue("maxlen", v.minlen + 0.5);
    if (id === "maxlen" && v.maxlen <= v.minlen) ranges.setValue("minlen", v.maxlen - 0.5);
    apply();
  });
  function apply() {
    const v = ranges.values();
    root.querySelectorAll("[data-split]").forEach((el) => { el.hidden = !split.checked; });
    scene.set({ mode, on: on.checked, minPower: v.minpower, maxPower: v.maxpower, minLen: v.minlen, maxLen: v.maxlen,
      split: split.checked, segLen: v.seglen, merge: merge.checked });
    const [lo, hi] = scaleOf({ minPower: v.minpower, maxPower: v.maxpower });
    const legend = root.querySelector("[data-scale]");
    if (legend) {
      legend.textContent = `${lo} W … ${hi} W` +
        (lo === SCALE[0] && hi === SCALE[1] ? " (like the colour mode in the video)" : "");
    }
  }
  [on, split, merge].forEach((el) => el.addEventListener("change", apply));
  root.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    root.querySelectorAll(".modes button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    apply();
  }));
  apply();
}

export async function mountCode(walkRoot, recipesRoot, codeUrl) {
  const scene = createScene(walkRoot.querySelector(".viewer"));
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

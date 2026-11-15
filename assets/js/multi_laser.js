// Interactive explainer of the laser assignment (lib/multi_laser/*.js) on the two plates of the videos: thirteen
// parts on 60 x 60 mm (parts/laser_parts.stl) or the laser plate (40 x 40 mm, round hole r = 5 mm). Same rules as
// the buildstyle: scanners row by row, laser colours
// around the colour wheel, hatch vectors cut at the field borders ('field_split') or at the swimlane borders,
// greedy choice of the candidate with the smallest load after taking the piece (ties: lower laser index), load
// metric 'time'. The hatch is coarser than in ATU (0.8 instead of 0.1 mm), so times are shown relative to one laser.
import { COLOR, createCanvas, frame, label, arrowHead, mountWalk, bindRanges } from "./plane.js";

const DEG = Math.PI / 180;
const HATCH_DIST = 0.8, HATCH_ANGLE = 67;
const COST = { mark: 1200, jump: 7000, markDelay: 0.01, jumpDelay: 0.05 };   // mm/s and ms (grp_laser_timing)
export const STRATEGY_NAMES = {
  field_split: "Field split", swimlane: "Swimlane", swimlane_clip: "Swimlane + clipping",
  swimlane_reassign: "Swimlane + reassign",
};
/** Settings of the two videos; choosing a plate in "Try it" loads its video settings. */
export const PLATE_SETTINGS = {
  parts: { strategy: "swimlane", spacing: 20, field: 80, lane: 60 },
  plate: { strategy: "field_split", spacing: 24, field: 32, lane: 10 },
};
const DEFAULTS = { parts: "parts", enabled: true, countX: 2, countY: 2, gas: 0, showFields: true,
  ...PLATE_SETTINGS.parts };

// ------------------------------------------------------------------ geometry

const plateSize = (kind) => (kind === "plate" ? 40 : 60);
const platformOf = (kind) => ({ minX: 0, maxX: plateSize(kind), minY: 0, maxY: plateSize(kind) });

function partsOf(kind) {
  if (kind === "plate") return [{ x0: 0, y0: 0, x1: 40, y1: 40, hole: { cx: 20, cy: 20, r: 5 } }];
  // laser_parts in tools/make_parts.py
  const sq = (cx, cy, w, h) => ({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 });
  const disc = (cx, cy, r) => ({ x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, disc: { cx, cy, r } });
  return [
    ...[[8, 8], [52, 8], [8, 52], [52, 52]].map(([x, y]) => sq(x, y, 10, 10)),
    ...[[30, 7], [30, 53], [7, 30], [53, 30]].map(([x, y]) => disc(x, y, 5)),
    disc(30, 30, 7),
    sq(18, 19, 12, 6), sq(42, 41, 12, 6), sq(42, 18, 7, 7), sq(18, 42, 7, 7),
  ];
}

/** Hatch vectors of one part (rectangle, rectangle with a round hole, or disc), in meander order. */
function hatchPart(p) {
  const dx = Math.cos(HATCH_ANGLE * DEG), dy = Math.sin(HATCH_ANGLE * DEG), nx = -dy, ny = dx;
  const corners = [[p.x0, p.y0], [p.x1, p.y0], [p.x1, p.y1], [p.x0, p.y1]];
  const offs = corners.map(([x, y]) => x * nx + y * ny);
  const out = [];
  let flip = false;
  for (let o = Math.min(...offs) + HATCH_DIST / 2; o < Math.max(...offs); o += HATCH_DIST) {
    // line: o * n + t * d, clipped to the rectangle
    let t0 = -Infinity, t1 = Infinity;
    const px = o * nx, py = o * ny;
    for (const [d, q, lo, hi] of [[dx, px, p.x0, p.x1], [dy, py, p.y0, p.y1]]) {
      if (Math.abs(d) < 1e-12) { if (q < lo || q > hi) { t0 = 1; t1 = 0; } continue; }
      const a = (lo - q) / d, b = (hi - q) / d;
      t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
    }
    if (t1 - t0 < 1e-6) continue;
    let spans = [[t0, t1]];
    if (p.disc) {
      const { cx, cy, r } = p.disc;
      const tc = (cx - px) * dx + (cy - py) * dy, dist = Math.abs((cx - px) * nx + (cy - py) * ny);
      if (dist >= r) continue;
      const h = Math.sqrt(r * r - dist * dist);
      spans = [[tc - h, tc + h]];
    }
    if (p.hole) {
      const { cx, cy, r } = p.hole;
      const tc = (cx - px) * dx + (cy - py) * dy, dist = Math.abs((cx - px) * nx + (cy - py) * ny);
      if (dist < r) {
        const h = Math.sqrt(r * r - dist * dist);
        spans = [[t0, Math.min(t1, tc - h)], [Math.max(t0, tc + h), t1]].filter(([a, b]) => b - a > 1e-6);
      }
    }
    if (flip) spans = spans.reverse().map(([a, b]) => [b, a]);
    for (const [a, b] of spans) out.push([px + a * dx, py + a * dy, px + b * dx, py + b * dy]);
    flip = !flip;
  }
  return out;
}

/** build_scanner_array: symmetric grid around the platform centre, laser index row by row. */
export function scanners(s) {
  const out = [], n = s.countX * s.countY, cx = plateSize(s.parts) / 2, cy = cx;
  for (let iy = 0; iy < s.countY; iy++) {
    for (let ix = 0; ix < s.countX; ix++) {
      const x = cx + (ix - (s.countX - 1) / 2) * s.spacing, y = cy + (iy - (s.countY - 1) / 2) * s.spacing;
      const i = iy * s.countX + ix, h = s.field / 2;
      out.push({ i, x, y, minX: x - h, maxX: x + h, minY: y - h, maxY: y + h, color: laserColor(i, n) });
    }
  }
  return out;
}

/** generate_laser_color: hue 360 * i / n, saturation 0.7, value 0.95. */
export function laserColor(i, n) {
  const v = 0.95, c = v * 0.7, h = ((360 * i) / n % 360) / 60, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
}

const lerp = (v, t) => [v[0] + (v[2] - v[0]) * t, v[1] + (v[3] - v[1]) * t];
const mid = (v) => lerp(v, 0.5);
const inField = (f, [x, y]) => x >= f.minX && x <= f.maxX && y >= f.minY && y <= f.maxY;

/** partition_segment_by_fields: pieces between all field entries and exits, candidates = fields at the middle. */
function splitByFields(v, fields) {
  const ts = [0, 1];
  for (const f of fields) {
    for (const [d, q, lo, hi] of [[v[2] - v[0], v[0], f.minX, f.maxX], [v[3] - v[1], v[1], f.minY, f.maxY]]) {
      if (Math.abs(d) < 1e-12) continue;
      for (const t of [(lo - q) / d, (hi - q) / d]) if (t > 1e-7 && t < 1 - 1e-7) ts.push(t);
    }
  }
  ts.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    if (ts[k + 1] - ts[k] < 1e-7) continue;
    const a = lerp(v, ts[k]), b = lerp(v, ts[k + 1]);
    const ids = fields.filter((f) => inField(f, mid([...a, ...b]))).map((f) => f.i);
    const last = out[out.length - 1];
    if (last && last.ids.join() === ids.join()) { last.v[2] = b[0]; last.v[3] = b[1]; } else out.push({ v: [...a, ...b], ids });
  }
  return out;
}

// ------------------------------------------------------------------ costs (laser_assignment_math.js, metric 'time')

const jumpCost = (from, to) => (from ? Math.hypot(to[0] - from[0], to[1] - from[1]) / COST.jump * 1000 + COST.jumpDelay : 0);
const markCost = (v) => Math.hypot(v[2] - v[0], v[3] - v[1]) / COST.mark * 1000 + COST.markDelay;
function pathCost(vecs, from) {
  let c = 0, pos = from;
  for (const v of vecs) { c += jumpCost(pos, [v[0], v[1]]) + markCost(v); pos = [v[2], v[3]]; }
  return c;
}
const newStates = (n) => Array.from({ length: n }, () => ({ load: 0, end: null }));

function nearest(p, fields) {
  let best = fields[0].i, d = Infinity;
  for (const f of fields) { const e = Math.hypot(p[0] - f.x, p[1] - f.y); if (e < d) { d = e; best = f.i; } }
  return best;
}

/** choose_laser_for_segment / assign_path_to_laser: greedy, '<' keeps the lower index on ties. */
function choose(ids, states, vecs, p, fields) {
  if (!ids.length) return nearest(p, fields);
  if (ids.length === 1) return ids[0];
  let best = ids[0], cost = Infinity;
  for (const i of ids) {
    const c = states[i].load + pathCost(vecs, states[i].end);
    if (c < cost) { cost = c; best = i; }
  }
  return best;
}
function addLoad(state, vecs) {
  state.load += pathCost(vecs, state.end);
  const v = vecs[vecs.length - 1];
  state.end = [v[2], v[3]];
}

// ------------------------------------------------------------------ strategies (laser_assignment.js)

/** Swimlanes along the gas flow, lane 0 furthest downstream (build_swimlanes). */
function lanesOf(s) {
  const g = [Math.cos(s.gas * DEG), Math.sin(s.gas * DEG)];
  const key = ([x, y]) => -(x * g[0] + y * g[1]);
  const pf = platformOf(s.parts);
  const ks = [[pf.minX, pf.minY], [pf.maxX, pf.minY], [pf.minX, pf.maxY], [pf.maxX, pf.maxY]].map(key);
  const lo = Math.min(...ks), hi = Math.max(...ks), n = Math.max(1, Math.ceil((hi - lo) / s.lane));
  const borders = Array.from({ length: n - 1 }, (_, k) => lo + (k + 1) * s.lane);
  const index = (k) => { for (let i = 0; i < borders.length; i++) if (k < borders[i]) return i; return n - 1; };
  return { g, key, lo, hi, n, borders, index };
}

/** Layer result: pieces [{v, laser}] in exposure order, time per laser (ms), single-laser time. */
export function assignLayer(s) {
  const parts = partsOf(s.parts);
  const lanes = lanesOf(s);
  // exposure order of the parts: downstream first (one pass: all volume hatches, build order 'Platform')
  const ordered = parts.map((p) => ({ p, vecs: hatchPart(p), k: lanes.key([(p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2]) }))
    .sort((a, b) => a.k - b.k);
  const all = ordered.flatMap((o) => o.vecs);
  const single = pathCost(all, null);
  const fields = scanners(s);
  const pieces = [];
  if (!s.enabled) {
    all.forEach((v) => pieces.push({ v, laser: -1 }));
    return { pieces, times: [single], single, fields, lanes };
  }
  if (s.strategy === "field_split") {
    const states = newStates(fields.length);
    for (const v of all) {
      for (const piece of splitByFields(v, fields)) {
        const laser = choose(piece.ids, states, [piece.v], mid(piece.v), fields);
        addLoad(states[laser], [piece.v]);
        pieces.push({ v: piece.v, laser });
      }
    }
  } else {
    // pieces of the pass: whole part hatch ('swimlane'), cut at lane borders ('clip'), or by vector middle ('reassign')
    const bucket = [];
    for (const o of ordered) {
      if (s.strategy === "swimlane") { bucket.push(o.vecs); continue; }
      const byLane = new Map();
      for (const v of o.vecs) {
        const add = (lane, w) => { if (!byLane.has(lane)) byLane.set(lane, []); byLane.get(lane).push(w); };
        if (s.strategy === "swimlane_reassign") { add(lanes.index(lanes.key(mid(v))), v); continue; }
        const k0 = lanes.key([v[0], v[1]]), dk = lanes.key([v[2], v[3]]) - k0;
        const ts = [0, 1];
        if (Math.abs(dk) > 1e-9) lanes.borders.forEach((b) => { const t = (b - k0) / dk; if (t > 0 && t < 1) ts.push(t); });
        ts.sort((a, b) => a - b);
        for (let q = 0; q + 1 < ts.length; q++) {
          const w = [...lerp(v, ts[q]), ...lerp(v, ts[q + 1])];
          add(lanes.index(lanes.key(mid(w))), w);
        }
      }
      [...byLane.keys()].sort((a, b) => a - b).forEach((lane) => bucket.push(byLane.get(lane)));
    }
    const center = (vecs) => {
      let x = 0, y = 0;
      vecs.forEach((v) => { x += v[0] + v[2]; y += v[1] + v[3]; });
      return [x / (2 * vecs.length), y / (2 * vecs.length)];
    };
    const perLane = Array.from({ length: lanes.n }, () => []);
    bucket.forEach((vecs) => perLane[lanes.index(lanes.key(center(vecs)))].push(vecs));
    perLane.forEach((list) => {
      const states = newStates(fields.length);          // the load starts empty in every lane
      for (const vecs of list) {
        const c = center(vecs);
        const ids = fields.filter((f) => inField(f, c)).map((f) => f.i);
        const laser = choose(ids, states, vecs, c, fields);
        addLoad(states[laser], vecs);
        vecs.forEach((v) => pieces.push({ v, laser }));
      }
    });
  }
  // estimate_layer_time_ms: every laser works through its own pieces in exposure order; the slowest one counts
  const times = fields.map(() => 0), ends = fields.map(() => null);
  for (const { v, laser } of pieces) {
    times[laser] += jumpCost(ends[laser], [v[0], v[1]]) + markCost(v);
    ends[laser] = [v[2], v[3]];
  }
  return { pieces, times, single, fields, lanes };
}

// ------------------------------------------------------------------ drawing

function createScene(viewerEl, legendEl) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");
  let result = assignLayer(s);

  function draw(ctx, w, h) {
    const r = result, PLATFORM = platformOf(s.parts), size = plateSize(s.parts);
    const xs = [PLATFORM.minX, PLATFORM.maxX], ys = [PLATFORM.minY, PLATFORM.maxY];
    if (s.enabled && s.showFields) r.fields.forEach((f) => { xs.push(f.minX, f.maxX); ys.push(f.minY, f.maxY); });
    const clampV = (v) => Math.max(-0.2 * size, Math.min(1.2 * size, v));
    const f = frame([0, 0, w, h - 34], [clampV(Math.min(...xs)) - 2, clampV(Math.min(...ys)) - 2,
      clampV(Math.max(...xs)) + 2, clampV(Math.max(...ys)) + 2], 14);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, h - 34); ctx.clip();      // large scan fields reach past the drawing
    ctx.fillStyle = "#f4f6f8";
    ctx.fillRect(f.x(PLATFORM.minX), f.y(PLATFORM.maxY), size * f.s, size * f.s);
    ctx.strokeStyle = "rgba(60,68,77,.35)"; ctx.lineWidth = 1;
    ctx.strokeRect(f.x(PLATFORM.minX), f.y(PLATFORM.maxY), size * f.s, size * f.s);
    if (s.enabled && s.showFields) {
      for (const fl of r.fields) {
        ctx.fillStyle = fl.color.replace("rgb", "rgba").replace(")", ",.08)");
        ctx.fillRect(f.x(fl.minX), f.y(fl.maxY), s.field * f.s, s.field * f.s);
      }
    }
    if (s.enabled && s.strategy !== "field_split") {
      ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(6,150,215,.7)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(f.x(PLATFORM.minX), f.y(PLATFORM.maxY), size * f.s, size * f.s); ctx.clip();
      const [gx, gy] = r.lanes.g;
      for (const b of r.lanes.borders) {
        // points with key b: -(x gx + y gy) = b, drawn across the platform
        const px = -b * gx, py = -b * gy, L = 2 * size;
        ctx.beginPath(); ctx.moveTo(f.x(px - gy * L), f.y(py + gx * L)); ctx.lineTo(f.x(px + gy * L), f.y(py - gx * L)); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.lineWidth = Math.max(1, Math.min(2.2, HATCH_DIST * f.s * 0.6));
    for (const { v, laser } of r.pieces) {
      ctx.strokeStyle = laser < 0 ? "rgb(25,250,45)" : r.fields[laser].color;
      ctx.beginPath(); ctx.moveTo(f.x(v[0]), f.y(v[1])); ctx.lineTo(f.x(v[2]), f.y(v[3])); ctx.stroke();
    }
    ctx.lineWidth = 1;
    if (s.enabled && s.showFields) {
      for (const fl of r.fields) {
        ctx.strokeStyle = fl.color; ctx.lineWidth = 2;
        ctx.strokeRect(f.x(fl.minX), f.y(fl.maxY), s.field * f.s, s.field * f.s);
        ctx.fillStyle = fl.color; ctx.beginPath(); ctx.arc(f.x(fl.x), f.y(fl.y), 4, 0, 2 * Math.PI); ctx.fill();
        label(ctx, `${fl.i + 1}`, f.x(fl.x) + 7, f.y(fl.y) - 7, { size: 11, weight: 700, color: COLOR.text });
      }
      ctx.lineWidth = 1;
    }
    // gas flow arrow, left of the platform
    const a = -s.gas * DEG, gx = Math.max(22, f.x(PLATFORM.minX) - 26), gy = f.y(PLATFORM.maxY) + 18, len = 30;
    ctx.strokeStyle = "#0696d7"; ctx.fillStyle = "#0696d7"; ctx.lineWidth = 2;
    const sx = gx - Math.cos(a) * len / 2, sy = gy - Math.sin(a) * len / 2, ex = gx + Math.cos(a) * len / 2, ey = gy + Math.sin(a) * len / 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke(); arrowHead(ctx, ex, ey, a, 8);
    ctx.lineWidth = 1;
    ctx.restore();
    const slow = Math.max(...r.times), share = Math.round((100 * slow) / r.single);
    const text = !s.enabled ? "Laser assignment off: one laser exposes everything (100 %)"
      : `Layer time: ${share} % of one laser · slowest: laser ${r.times.indexOf(slow) + 1}`;
    label(ctx, text, 12, h - 14, { size: 12, weight: 600 });
  }

  function legend() {
    if (!legendEl) return;
    const r = result;
    legendEl.replaceChildren();
    const item = (color, text) => {
      const span = document.createElement("span"), i = document.createElement("i");
      i.style.background = color;
      span.append(i, document.createTextNode(text));
      legendEl.append(span);
    };
    if (!s.enabled) { item("rgb(25,250,45)", "volume hatch, one laser"); return; }
    r.fields.forEach((fl, k) => item(fl.color, `laser ${k + 1}: ${Math.round((100 * r.times[k]) / r.single)} %`));
    if (s.strategy !== "field_split") item("#0696d7", "swimlane borders, gas flow");
  }

  const canvas = createCanvas(viewerEl, draw);
  function set(patch) {
    Object.assign(s, patch);
    result = assignLayer(s);
    if (tag) {
      tag.textContent = `${s.parts === "plate" ? "Laser plate" : "Thirteen parts"} · `
        + (s.enabled ? `${s.countX} × ${s.countY} scanners · ${STRATEGY_NAMES[s.strategy]}` : "laser assignment off");
    }
    legend();
    canvas.redraw();
  }
  set({});
  return { set };
}

// ------------------------------------------------------------------ "Try it" panel

export function mount(root) {
  const scene = createScene(root.querySelector(".viewer"), root.querySelector("[data-lasers]"));
  const sel = (id) => root.querySelector(`#${id}`);
  const ranges = bindRanges(root, {
    countx: (v) => `${v}`, county: (v) => `${v}`, spacing: (v) => `${v} mm`, field: (v) => `${v} mm`,
    lane: (v) => `${v} mm`, gas: (v) => `${v}°`,
  }, () => apply());
  const plateOf = () => (sel("parts").value === "plate" ? "plate" : "parts");
  function apply() {
    const v = ranges.values();
    const strategy = sel("strategy").value in STRATEGY_NAMES ? sel("strategy").value : "field_split";
    sel("lane").disabled = strategy === "field_split";
    scene.set({ parts: plateOf(), enabled: sel("enabled").checked, strategy,
      countX: v.countx, countY: v.county, spacing: v.spacing, field: v.field, lane: v.lane, gas: v.gas,
      showFields: sel("showfields").checked });
  }
  function loadPlate() {
    const p = PLATE_SETTINGS[plateOf()];
    sel("strategy").value = p.strategy;
    ["spacing", "field", "lane"].forEach((id) => ranges.setValue(id, p[id]));
    apply();
  }
  sel("parts").addEventListener("change", loadPlate);
  ["strategy", "enabled", "showfields"].forEach((id) => sel(id).addEventListener("change", apply));
  loadPlate();
}

export async function mountCode(walkRoot, recipesRoot, codeUrl) {
  const scene = createScene(walkRoot.querySelector(".viewer"), walkRoot.querySelector("[data-lasers]"));
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

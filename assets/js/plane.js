// Shared 2D helpers of the flat feature explainers (hatching, hull and core, first border): a canvas that redraws
// on resize, mm-to-pixel frames, hatch lines clipped to polygons, iso-lines of a distance field (offset rings) and the
// code walkthrough wiring.
import { renderWalkthrough, renderRecipes } from "./code.js";

export const COLOR = {
  border: "#dc3250",
  blocked: "#c800c8",
  volume: "#19c42d",
  core: "#00a046",
  downskin: "#0078ff",
  outline: "#3c444d",
  part: "#d9dde2",
  powder: "#efe6d2",
  powderDot: "#d8ccb0",
  grid: "rgba(60, 68, 77, .22)",
  text: "#3c444d",
  muted: "#6b7480",
};

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ canvas

/** Canvas inside viewerEl; draw(ctx, width, height) in CSS pixels, called on resize and on redraw(). */
export function createCanvas(viewerEl, draw) {
  const canvas = viewerEl.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, queued = false;
  function paint() {
    queued = false;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
  }
  const redraw = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  new ResizeObserver(() => { w = viewerEl.clientWidth; h = viewerEl.clientHeight; redraw(); }).observe(viewerEl);
  return { redraw, size: () => [w, h] };
}

/**
 * Map the mm rectangle bounds = [x0, y0, x1, y1] into the pixel box [left, top, width, height] (uniform scale,
 * centred, y up). Returns {s, x(mm), y(mm), X(px), Y(px)}.
 */
export function frame(box, bounds, pad = 12) {
  const [L, T, W, H] = box;
  const [x0, y0, x1, y1] = bounds;
  const s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
  const ox = L + (W - s * (x1 - x0)) / 2 - s * x0;
  const oy = T + (H + s * (y1 - y0)) / 2 + s * y0;
  return { s, x: (x) => ox + s * x, y: (y) => oy - s * y, X: (px) => (px - ox) / s, Y: (py) => (oy - py) / s };
}

export function pathPoly(ctx, f, poly, close = true) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(f.x(x), f.y(y)) : ctx.moveTo(f.x(x), f.y(y))));
  if (close) ctx.closePath();
}

export function strokeSegments(ctx, f, segs, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of segs) { ctx.moveTo(f.x(x1), f.y(y1)); ctx.lineTo(f.x(x2), f.y(y2)); }
  ctx.stroke();
}

export function label(ctx, text, x, y, { color = COLOR.text, align = "left", base = "middle", size = 12, weight = 500 } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillText(text, x, y);
}

/** Small arrow head at (x, y) pointing along angle a (radians, screen coordinates). */
export function arrowHead(ctx, x, y, a, size = 7) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(a - 0.45), y - size * Math.sin(a - 0.45));
  ctx.lineTo(x - size * Math.cos(a + 0.45), y - size * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

// ------------------------------------------------------------------ geometry

export function bounds(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const segLength = ([x1, y1, x2, y2]) => Math.hypot(x2 - x1, y2 - y1);

/**
 * Hatch lines with line direction dirDeg (degrees from +X) and the given spacing, clipped to the polygon (even-odd).
 * The lines lie on multiples of the spacing measured from the origin (like nHatchFlagFixedZeroOrigin) and alternate
 * their direction (meander). Returns [{seg: [x1, y1, x2, y2], c}] where c is the line offset index.
 */
export function hatchLines(poly, dirDeg, spacing) {
  const ux = Math.cos(dirDeg * DEG), uy = Math.sin(dirDeg * DEG);
  const nx = -uy, ny = ux;
  const ns = poly.map(([x, y]) => x * nx + y * ny);
  const k0 = Math.ceil(Math.min(...ns) / spacing), k1 = Math.floor(Math.max(...ns) / spacing);
  const out = [];
  for (let k = k0; k <= k1; k++) {
    const c = k * spacing;
    const ts = [];
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const sa = ns[i] - c, sb = ns[j] - c;
      if ((sa > 0) === (sb > 0)) continue;
      const r = sa / (sa - sb);
      const x = poly[i][0] + (poly[j][0] - poly[i][0]) * r, y = poly[i][1] + (poly[j][1] - poly[i][1]) * r;
      ts.push(x * ux + y * uy);
    }
    ts.sort((a, b) => a - b);
    const flip = (k & 1) === 1;
    const pieces = [];
    for (let i = 0; i + 1 < ts.length; i += 2) {
      const p = [nx * c + ux * ts[i], ny * c + uy * ts[i], nx * c + ux * ts[i + 1], ny * c + uy * ts[i + 1]];
      pieces.push(flip ? [p[2], p[3], p[0], p[1]] : p);
    }
    if (flip) pieces.reverse();
    for (const seg of pieces) out.push({ seg, c: k });
  }
  return out;
}

/** Cut a segment at the multiples of size along the axis (ax, ay); calls emit(piece, cellIndex). */
export function splitAlong(seg, ax, ay, size, emit) {
  const [x1, y1, x2, y2] = seg;
  const a = x1 * ax + y1 * ay, b = x2 * ax + y2 * ay;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (hi - lo < 1e-9) { emit(seg, Math.floor(a / size)); return; }
  const cuts = [lo];
  for (let m = Math.floor(lo / size) + 1; m * size < hi; m++) cuts.push(m * size);
  cuts.push(hi);
  const at = (t) => { const r = (t - a) / (b - a); return [x1 + (x2 - x1) * r, y1 + (y2 - y1) * r]; };
  const parts = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [px, py] = at(cuts[i]), [qx, qy] = at(cuts[i + 1]);
    parts.push([[px, py, qx, qy], Math.floor((cuts[i] + cuts[i + 1]) / 2 / size)]);
  }
  if (b < a) parts.reverse().forEach((p) => { const s = p[0]; p[0] = [s[2], s[3], s[0], s[1]]; });
  for (const [piece, cell] of parts) emit(piece, cell);
}

/** Clip a segment to a convex counter-clockwise polygon (Cyrus-Beck); null if nothing is left. */
export function clipConvex(seg, cell) {
  const [x1, y1, x2, y2] = seg;
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (let i = 0; i < cell.length; i++) {
    const [ax, ay] = cell[i], [bx, by] = cell[(i + 1) % cell.length];
    const nx = ay - by, ny = bx - ax;              // inward normal of a counter-clockwise edge
    const num = nx * (x1 - ax) + ny * (y1 - ay);
    const den = nx * dx + ny * dy;
    if (Math.abs(den) < 1e-12) { if (num < 0) return null; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return [x1 + dx * t0, y1 + dy * t0, x1 + dx * t1, y1 + dy * t1];
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Inside distance to the outline on a grid (0 outside): {x0, y0, step, nx, ny, d}. */
export function distanceField(poly, step) {
  const [x0, y0, x1, y1] = bounds(poly);
  const nx = Math.ceil((x1 - x0) / step) + 1, ny = Math.ceil((y1 - y0) / step) + 1;
  const d = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * step;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * step;
      if (!pointInPoly(x, y, poly)) continue;
      let m = Infinity;
      for (let k = 0; k < poly.length; k++) {
        const [ax, ay] = poly[k], [bx, by] = poly[(k + 1) % poly.length];
        m = Math.min(m, distToSegment(x, y, ax, ay, bx, by));
      }
      d[j * nx + i] = m;
    }
  }
  return { x0, y0, step, nx, ny, d };
}

/** Marching squares: segments where the field equals level. */
export function isoLine(field, level) {
  const { x0, y0, step, nx, ny, d } = field;
  const out = [];
  const lerp = (a, b, va, vb) => a + ((level - va) / (vb - va)) * (b - a);
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const v = [d[j * nx + i], d[j * nx + i + 1], d[(j + 1) * nx + i + 1], d[(j + 1) * nx + i]];
      const x = x0 + i * step, y = y0 + j * step;
      const corner = [[x, y], [x + step, y], [x + step, y + step], [x, y + step]];
      const pts = [];
      for (let e = 0; e < 4; e++) {
        const a = e, b = (e + 1) % 4;
        if ((v[a] >= level) !== (v[b] >= level)) {
          pts.push([lerp(corner[a][0], corner[b][0], v[a], v[b]), lerp(corner[a][1], corner[b][1], v[a], v[b])]);
        }
      }
      if (pts.length === 2) out.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
      else if (pts.length === 4) {
        out.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]], [pts[2][0], pts[2][1], pts[3][0], pts[3][1]]);
      }
    }
  }
  return out;
}

export function signedArea(poly) {
  let a = 0;
  poly.forEach(([x, y], i) => { const [u, v] = poly[(i + 1) % poly.length]; a += x * v - u * y; });
  return a / 2;
}

/** Join the marching-squares pieces of one iso level into closed loops (point lists). */
export function chainLoops(segs) {
  const key = (x, y) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
  const ends = new Map();
  segs.forEach((s, i) => {
    for (const e of [0, 1]) {
      const k = key(s[2 * e], s[2 * e + 1]);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push([i, e]);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [[segs[i][0], segs[i][1]], [segs[i][2], segs[i][3]]];
    for (;;) {
      const [x, y] = pts[pts.length - 1];
      const next = (ends.get(key(x, y)) || []).find(([j]) => !used[j]);
      if (!next) break;
      const [j, e] = next;
      used[j] = 1;
      pts.push(e === 0 ? [segs[j][2], segs[j][3]] : [segs[j][0], segs[j][1]]);
    }
    if (pts.length > 3) loops.push(pts);
  }
  return loops;
}

/** Arrow heads every 'every' pixels along a point list in mm (direction of the list). */
export function arrowsAlong(ctx, f, pts, every, size = 8) {
  let next = every / 2, walked = 0;
  for (let k = 1; k < pts.length; k++) {
    const ax = f.x(pts[k - 1][0]), ay = f.y(pts[k - 1][1]), bx = f.x(pts[k][0]), by = f.y(pts[k][1]);
    const len = Math.hypot(bx - ax, by - ay);
    while (len > 0 && next <= walked + len) {
      const t = (next - walked) / len;
      arrowHead(ctx, ax + t * (bx - ax), ay + t * (by - ay), Math.atan2(by - ay, bx - ax), size);
      next += every;
    }
    walked += len;
  }
}

export function maxOf(field) {
  let m = 0;
  for (const v of field.d) if (v > m) m = v;
  return m;
}

// ------------------------------------------------------------------ walkthrough

/** Code walkthrough and recipes; scene.set(step.scene) whenever a step becomes active. */
export async function mountWalk(walkRoot, recipesRoot, codeUrl, scene) {
  const code = await (await fetch(codeUrl)).json();
  const caption = walkRoot.querySelector(".walk-caption");
  renderWalkthrough(walkRoot.querySelector(".walk-steps"), code, (i, step) => {
    scene.set(step.scene || {});
    if (caption) caption.textContent = `${i + 1} \u00b7 ${step.title}`;
  });
  if (recipesRoot) renderRecipes(recipesRoot, code);
}

/** Wire range inputs to outputs: spec = {id: format(value)}; returns a reader of the numeric values. */
export function bindRanges(root, spec, onInput) {
  const els = {};
  for (const [id, fmt] of Object.entries(spec)) {
    const input = root.querySelector(`#${id}`);
    const out = root.querySelector(`#${id}-out`);
    els[id] = { input, out, fmt };
    input.addEventListener("input", () => { if (out) out.value = fmt(Number(input.value)); onInput(id); });
  }
  const values = () => Object.fromEntries(Object.entries(els).map(([id, e]) => [id, Number(e.input.value)]));
  const show = () => Object.values(els).forEach((e) => { if (e.out) e.out.value = e.fmt(Number(e.input.value)); });
  const setValue = (id, v) => { els[id].input.value = String(v); show(); };
  show();
  return { values, setValue, show };
}

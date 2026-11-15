// Interactive hatching explainer: the hatch plate outline (same as the STL of the ATU demo) filled with the five
// patterns of lib/exposure/hatch_patterns.js. Angle convention as in the code: the hatch angle value θ gives lines
// at θ + 90° (θ = 0 means lines parallel to Y); stripes, chess fields and hexagon cells are laid out on a grid that
// is rotated by θ around the origin. Line spacing is exaggerated, all other sizes are real millimetres.
// Order: inside a stripe, field or cell the hatch front moves against the gas flow (block sort, downstream first);
// stripes are taken downstream first (improved stripe sorting), chess and hexagon groups one after the other. Every
// hatch alternates its line direction (nHatchFlagAlternating); "alternate stripe direction" reverses every second
// stripe. Offset rings are closed loops, every second one reversed, outside in unless "inside out" is set.
import {
  COLOR, createCanvas, frame, pathPoly, strokeSegments, label, arrowHead, bounds, segLength, hatchLines,
  clipConvex, distanceField, isoLine, maxOf, mountWalk, bindRanges, signedArea, chainLoops,
} from "./plane.js";

const INCREMENT = 67;
const GAS = [1, 0];                  // gas flow towards +X (platform default 0°)
const GROUP_COLORS = ["#19c42d", "#0f8a7a", "#8a9a00"];
const REMOVED = "#e8202a";
const SIZE = {
  stripe: { label: "Stripe width", min: 3, max: 20, step: 0.5, value: 10, overlap: "Stripe overlap" },
  chess: { label: "Field size", min: 2, max: 12, step: 0.5, value: 5, overlap: "Field overlap" },
  hexagon: { label: "Hexagon side", min: 1.5, max: 8, step: 0.5, value: 3, overlap: "Hexagon overlap" },
};
const DEFAULTS = {
  pattern: "meander", layer: 1, spacing: 0.8, size: null, overlap: 0.05, minLen: 0.05, hatchOffset: 0.05,
  alternate: false, insideOut: false, arrows: true, progress: 1,
};
const DEG = Math.PI / 180;
const mod = (a, n) => ((a % n) + n) % n;
const dot = (x, y, v) => x * v[0] + y * v[1];
const mid = (s) => [(s[0] + s[2]) / 2, (s[1] + s[3]) / 2];
const flipSeg = (s) => [s[2], s[3], s[0], s[1]];
const downKey = (x, y) => -(x * GAS[0] + y * GAS[1]);

/** Hexagon group as in get_hexagon_group: along a row x mod 3, every second row shifted by 2. */
const hexGroup = (x, y) => (mod(y, 2) === 0 ? mod(x, 3) : mod(x + 2, 3));

/** Inset (d > 0) or outset (d < 0) of a smooth simple polygon: every vertex moves along its bisector (miter). */
function offsetPolygon(poly, d) {
  if (Math.abs(d) < 1e-9) return poly;
  const s = signedArea(poly) > 0 ? 1 : -1;
  const n = poly.length;
  const normal = ([ax, ay], [bx, by]) => {
    const l = Math.hypot(bx - ax, by - ay);
    return [(-s * (by - ay)) / l, (s * (bx - ax)) / l];
  };
  return poly.map((p, i) => {
    const n1 = normal(poly[(i - 1 + n) % n], p), n2 = normal(p, poly[(i + 1) % n]);
    const mx = n1[0] + n2[0], my = n1[1] + n2[1], ml = Math.hypot(mx, my) || 1;
    const c = Math.max(0.3, (mx * n1[0] + my * n1[1]) / ml);
    return [p[0] + (mx / ml) * (d / c), p[1] + (my / ml) * (d / c)];
  });
}

/**
 * Sort key of the lines of one family: the hatch front moves against the gas flow, so the line furthest downstream
 * comes first. Lines parallel to the gas flow keep their geometric order.
 */
function frontKey(dirDeg) {
  const n = [-Math.sin(dirDeg * DEG), Math.cos(dirDeg * DEG)];
  const g = n[0] * GAS[0] + n[1] * GAS[1];
  const sign = Math.abs(g) < 1e-6 ? 1 : -Math.sign(g);
  return (seg) => { const [x, y] = mid(seg); return sign * dot(x, y, n); };
}
const byFront = (dirDeg) => { const k = frontKey(dirDeg); return (a, b) => k(a) - k(b); };

/**
 * Cut a segment into the cells [j·size − ov/2, (j+1)·size + ov/2] along the axis (ax, ay): neighbouring cells overlap
 * by ov (a negative ov leaves a gap). Calls emit(piece, j) in the direction of the segment.
 */
function splitOverlap(seg, ax, ay, size, ov, emit) {
  const [x1, y1, x2, y2] = seg;
  const a = x1 * ax + y1 * ay, b = x2 * ax + y2 * ay;
  const lo = Math.min(a, b), hi = Math.max(a, b), h = ov / 2;
  if (hi - lo < 1e-9) return;
  const at = (t) => { const r = (t - a) / (b - a); return [x1 + (x2 - x1) * r, y1 + (y2 - y1) * r]; };
  const parts = [];
  for (let j = Math.floor((lo - h) / size) - 1; j * size - h < hi; j++) {
    const s0 = Math.max(lo, j * size - h), s1 = Math.min(hi, (j + 1) * size + h);
    if (s1 - s0 < 1e-6) continue;
    const [px, py] = at(s0), [qx, qy] = at(s1);
    parts.push([[px, py, qx, qy], j]);
  }
  if (b < a) parts.reverse().forEach((p) => { p[0] = flipSeg(p[0]); });
  for (const [piece, j] of parts) emit(piece, j);
}

/** Cell indices whose band [i·size − ov/2, (i+1)·size + ov/2] contains the coordinate c (one or, in an overlap, two). */
function bandsAt(c, size, ov) {
  const h = ov / 2, out = [];
  for (let i = Math.floor((c - h) / size) - 1; i * size - h <= c; i++) if (c <= (i + 1) * size + h) out.push(i);
  return out;
}

/** Cell borders of one family (lines with direction dirDeg every size mm); with an overlap both edges of the band. */
function borderLines(poly, dirDeg, size, ov) {
  const n = [-Math.sin(dirDeg * DEG), Math.cos(dirDeg * DEG)];
  const shifted = (h) => hatchLines(poly.map(([x, y]) => [x - h * n[0], y - h * n[1]]), dirDeg, size)
    .map(({ seg }) => [seg[0] + h * n[0], seg[1] + h * n[1], seg[2] + h * n[0], seg[3] + h * n[1]]);
  return Math.abs(ov) > 1e-6 ? [...shifted(ov / 2), ...shifted(-ov / 2)] : shifted(0);
}

function meanKey(segs) {
  let sx = 0, sy = 0;
  for (const s of segs) { const [x, y] = mid(s); sx += x; sy += y; }
  return downKey(sx / segs.length, sy / segs.length);
}

function meanderVectors(area, phi, d) {
  const segs = hatchLines(area, phi, d).map((l) => l.seg).sort(byFront(phi));
  return { order: segs.map((s) => [s, 0]), grid: [] };
}

function stripeVectors(area, phi, d, W, ov, alternate) {
  const ax = Math.cos(phi * DEG), ay = Math.sin(phi * DEG);
  const byStripe = new Map();
  for (const { seg } of hatchLines(area, phi, d)) {
    splitOverlap(seg, ax, ay, W, ov, (piece, j) => {
      if (!byStripe.has(j)) byStripe.set(j, []);
      byStripe.get(j).push(piece);
    });
  }
  const stripes = [...byStripe.entries()].map(([j, segs]) => ({ j, segs: segs.sort(byFront(phi)), key: meanKey(segs) }));
  stripes.sort((a, b) => a.key - b.key || a.j - b.j);
  const order = [];
  stripes.forEach((st, i) => {
    const segs = alternate && i % 2 === 1 ? st.segs.slice().reverse().map(flipSeg) : st.segs;
    for (const s of segs) order.push([s, mod(st.j, 2)]);
  });
  return { order, grid: borderLines(area, phi - 90, W, ov) };
}

function chessVectors(area, theta, phi, d, S, ov) {
  const u = [Math.cos(theta * DEG), Math.sin(theta * DEG)], v = [Math.cos(phi * DEG), Math.sin(phi * DEG)];
  const cells = new Map();
  const add = (g, i, j, piece) => {
    const k = `${g},${i},${j}`;
    if (!cells.has(k)) {
      const cu = (i + 0.5) * S, cv = (j + 0.5) * S;
      cells.set(k, { g, segs: [], key: downKey(cu * u[0] + cv * v[0], cu * u[1] + cv * v[1]) });
    }
    cells.get(k).segs.push(piece);
  };
  // even fields: lines along v (angle φ); odd fields: lines along u (angle θ = φ − 90°)
  for (const { seg } of hatchLines(area, phi, d)) {
    const [mx, my] = mid(seg);
    for (const i of bandsAt(dot(mx, my, u), S, ov)) {
      splitOverlap(seg, v[0], v[1], S, ov, (piece, j) => { if (mod(i + j, 2) === 0) add(0, i, j, piece); });
    }
  }
  for (const { seg } of hatchLines(area, theta, d)) {
    const [mx, my] = mid(seg);
    for (const j of bandsAt(dot(mx, my, v), S, ov)) {
      splitOverlap(seg, u[0], u[1], S, ov, (piece, i) => { if (mod(i + j, 2) === 1) add(1, i, j, piece); });
    }
  }
  const order = [];
  for (const g of [0, 1]) {
    const sorted = [...cells.values()].filter((c) => c.g === g).sort((a, b) => a.key - b.key);
    const cmp = byFront(g === 0 ? phi : theta);
    for (const c of sorted) for (const s of c.segs.sort(cmp)) order.push([s, g]);
  }
  return { order, grid: [...borderLines(area, theta, S, ov), ...borderLines(area, phi, S, ov)] };
}

function hexagonVectors(area, theta, phi, d, a, ov) {
  const u = [Math.cos(theta * DEG), Math.sin(theta * DEG)], v = [Math.cos(phi * DEG), Math.sin(phi * DEG)];
  const world = (cu, cv) => [cu * u[0] + cv * v[0], cu * u[1] + cv * v[1]];
  const pu = area.map(([x, y]) => dot(x, y, u)), pv = area.map(([x, y]) => dot(x, y, v));
  const w = Math.sqrt(3) * a, rowH = 1.5 * a;
  const grow = a + ov / Math.sqrt(3);           // apothem + ov/2: neighbouring cells overlap by ov
  const rows = [Math.floor(Math.min(...pv) / rowH) - 1, Math.ceil(Math.max(...pv) / rowH) + 1];
  const cols = [Math.floor(Math.min(...pu) / w) - 1, Math.ceil(Math.max(...pu) / w) + 1];
  const cells = [[], [], []];
  for (let r = rows[0]; r <= rows[1]; r++) {
    for (let c = cols[0]; c <= cols[1]; c++) {
      const cu = c * w + (mod(r, 2) === 1 ? w / 2 : 0), cv = r * rowH;
      const hex = (side) => Array.from({ length: 6 }, (_, k) =>
        world(cu + side * Math.cos((30 + 60 * k) * DEG), cv + side * Math.sin((30 + 60 * k) * DEG)));
      const [cx, cy] = world(cu, cv);
      cells[hexGroup(c, r)].push({ poly: hex(a), clip: hex(grow), key: downKey(cx, cy) });
    }
  }
  const order = [];
  const grid = [];
  for (let g = 0; g < 3; g++) {
    const dir = phi + 60 * g;
    const lines = hatchLines(area, dir, d).map((l) => l.seg);
    const cmp = byFront(dir);
    for (const cell of cells[g].sort((p, q) => p.key - q.key)) {
      const [x0, y0, x1, y1] = bounds(cell.clip);
      const segs = [];
      for (const seg of lines) {
        if (Math.max(seg[0], seg[2]) < x0 || Math.min(seg[0], seg[2]) > x1 ||
            Math.max(seg[1], seg[3]) < y0 || Math.min(seg[1], seg[3]) > y1) continue;
        const piece = clipConvex(seg, cell.clip);
        if (piece && segLength(piece) > 1e-6) segs.push(piece);
      }
      for (const s of segs.sort(cmp)) order.push([s, g]);
      if (segs.length) cell.poly.forEach((p, k) => { const q = cell.poly[(k + 1) % 6]; grid.push([p[0], p[1], q[0], q[1]]); });
    }
  }
  return { order, grid };
}

function offsetVectors(field, d, start, insideOut) {
  const rings = [];
  const top = maxOf(field);
  for (let k = 0; start + 0.5 * d + k * d < top; k++) {
    const level = Math.max(0.02, start + 0.5 * d + k * d);
    const loops = chainLoops(isoLine(field, level)).map((pts) => {
      // borderToHatch: the outer ring runs counter-clockwise; every second ring is flipped
      const ccw = signedArea(pts) > 0;
      return ccw === (k % 2 === 0) ? pts : pts.slice().reverse();
    });
    rings.push(loops);
  }
  if (insideOut) rings.reverse();
  const order = [];
  const ringLengths = [];
  for (const loops of rings) {
    let len = 0;
    for (const pts of loops) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const s = [pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]];
        len += segLength(s);
        order.push([s, 0]);
      }
    }
    ringLengths.push(len);
  }
  return { order, grid: [], rings: ringLengths };
}

/** Flat view of the hatch plate; set(patch) changes the pattern and its parameters, progress (0..1) animates. */
function createScene(viewerEl, part) {
  const outline = part.outline;
  const [x0, y0, x1, y1] = bounds(outline);
  let field = null;
  const s = { ...DEFAULTS };
  let result = null;
  const tag = viewerEl.querySelector(".layer-tag");
  const listeners = [];

  const theta = () => mod((s.layer - 1) * INCREMENT, 360);
  const size = () => s.size ?? (SIZE[s.pattern] ? SIZE[s.pattern].value : 0);
  const area = () => offsetPolygon(outline, s.hatchOffset);

  function compute() {
    const th = theta(), phi = th + 90, d = s.spacing, ov = s.overlap;
    if (s.pattern === "stripe") result = stripeVectors(area(), phi, d, size(), ov, s.alternate);
    else if (s.pattern === "chess") result = chessVectors(area(), th, phi, d, size(), ov);
    else if (s.pattern === "hexagon") result = hexagonVectors(area(), th, phi, d, size(), ov);
    else if (s.pattern === "offset") {
      if (!field) field = distanceField(outline, 0.1);
      result = offsetVectors(field, d, s.hatchOffset, s.insideOut);
    } else result = meanderVectors(area(), phi, d);

    result.removed = [];
    if (s.pattern !== "offset" && s.minLen > 0) {
      result.removed = result.order.filter(([seg]) => segLength(seg) < s.minLen).map(([seg]) => seg);
      result.order = result.order.filter(([seg]) => segLength(seg) >= s.minLen);
    }
    const lengths = s.pattern === "offset" ? result.rings : result.order.map(([seg]) => segLength(seg));
    result.stats = {
      count: lengths.length,
      removed: result.removed.length,
      longest: Math.max(0, ...lengths),
      mean: lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0,
    };
  }

  function stats() {
    return { ...result.stats, theta: theta(), pattern: s.pattern, layer: s.layer };
  }

  function drawArrows(ctx, f, segs, color) {
    ctx.fillStyle = color;
    const every = s.pattern === "offset" ? 40 : 1;
    segs.forEach((seg, i) => {
      if (i % every !== 0) return;
      const ax = f.x(seg[0]), ay = f.y(seg[1]), bx = f.x(seg[2]), by = f.y(seg[3]);
      if (every === 1 && Math.hypot(bx - ax, by - ay) < 14) return;
      arrowHead(ctx, (ax + bx) / 2, (ay + by) / 2, Math.atan2(by - ay, bx - ax), 5);
    });
  }

  function draw(ctx, w, h) {
    const f = frame([0, 0, w - 70, h - 18], [x0 - 1.5, y0 - 1.5, x1 + 1.5, y1 + 1.5], 14);
    pathPoly(ctx, f, outline);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.save();
    pathPoly(ctx, f, s.hatchOffset < 0 ? area() : outline);
    ctx.clip();
    strokeSegments(ctx, f, result.grid, COLOR.grid, 1);
    const n = Math.round(result.order.length * s.progress);
    if (n < result.order.length) {
      strokeSegments(ctx, f, result.order.slice(n).map(([seg]) => seg), "rgba(60, 68, 77, .12)", 1);
    }
    const byGroup = [[], [], []];
    for (let i = 0; i < n; i++) byGroup[result.order[i][1]].push(result.order[i][0]);
    byGroup.forEach((segs, g) => strokeSegments(ctx, f, segs, GROUP_COLORS[g], 1.4));
    if (s.arrows) byGroup.forEach((segs, g) => drawArrows(ctx, f, segs, GROUP_COLORS[g]));
    if (result.removed.length) {
      ctx.setLineDash([3, 3]);
      strokeSegments(ctx, f, result.removed, REMOVED, 1.4);
      ctx.setLineDash([]);
    }
    ctx.restore();
    if (Math.abs(s.hatchOffset) > 0.01) {
      ctx.setLineDash([4, 4]);
      pathPoly(ctx, f, area());
      ctx.strokeStyle = COLOR.muted;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pathPoly(ctx, f, outline);
    ctx.strokeStyle = COLOR.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (n > 0 && n < result.order.length) {
      const seg = result.order[n - 1][0];
      ctx.fillStyle = "#e8202a";
      ctx.beginPath();
      ctx.arc(f.x(seg[2]), f.y(seg[3]), 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    if (s.pattern !== "offset") drawCompass(ctx, w - 40, 54, theta());
    drawGas(ctx, 16, h - 12);
  }

  function drawCompass(ctx, cx, cy, th) {
    ctx.fillStyle = "rgba(255, 255, 255, .85)";
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, 2 * Math.PI);
    ctx.fill();
    const a = -(th + 90) * DEG;
    const dx = Math.cos(a) * 20, dy = Math.sin(a) * 20;
    ctx.strokeStyle = COLOR.volume;
    ctx.fillStyle = COLOR.volume;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - dx, cy - dy);
    ctx.lineTo(cx + dx, cy + dy);
    ctx.stroke();
    arrowHead(ctx, cx + dx, cy + dy, a, 8);
    label(ctx, `θ ${th}°`, cx, cy + 40, { align: "center", size: 11, color: COLOR.muted });
  }

  function drawGas(ctx, x, y) {
    ctx.strokeStyle = COLOR.downskin;
    ctx.fillStyle = COLOR.downskin;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 34, y);
    ctx.stroke();
    arrowHead(ctx, x + 36, y, 0, 7);
    label(ctx, "gas flow (0°)", x + 44, y, { size: 11, color: COLOR.muted });
  }

  const canvas = createCanvas(viewerEl, draw);
  function set(patch) {
    const keys = ["pattern", "layer", "spacing", "size", "overlap", "minLen", "hatchOffset", "alternate", "insideOut"];
    const recompute = keys.some((k) => k in patch && patch[k] !== s[k]);
    if ("pattern" in patch && patch.pattern !== s.pattern && !("size" in patch)) patch = { ...patch, size: null };
    Object.assign(s, patch);
    if (recompute || !result) compute();
    if (tag) tag.textContent = tagText(stats());
    listeners.forEach((cb) => cb(stats()));
    canvas.redraw();
  }
  set({});
  return { set, state: () => ({ ...s }), stats, onStats: (cb) => listeners.push(cb), sizeOf: size };
}

const NAMES = { meander: "Meander", stripe: "Stripes", chess: "Chessboard", hexagon: "Hexagon", offset: "Offset" };

function tagText(st) {
  if (st.pattern === "offset") return `Offset \u00b7 layer ${st.layer} \u00b7 rings follow the outline, no angle`;
  return `${NAMES[st.pattern]} \u00b7 layer ${st.layer} \u00b7 θ = ${st.theta}° (lines at ${mod(st.theta + 90, 180)}°)`;
}

// ------------------------------------------------------------------ "Try it" panel

export async function mount(root, partUrl) {
  const part = await (await fetch(partUrl)).json();
  const scene = createScene(root.querySelector(".viewer"), part);
  const $ = (sel) => root.querySelector(sel);
  const buttons = root.querySelectorAll(".modes button");
  const checks = { alternate: $("#alternate"), insideOut: $("#insideout"), arrows: $("#arrows") };
  let timer = null;

  const stop = () => {
    if (timer !== null) cancelAnimationFrame(timer);
    timer = null;
    $("#play").textContent = "Play creation order";
  };
  const ranges = bindRanges(root, {
    layer: (v) => String(v),
    spacing: (v) => `${v.toFixed(1)} mm`,
    size: (v) => `${v.toFixed(1)} mm`,
    overlap: (v) => `${v.toFixed(2)} mm`,
    minlen: (v) => `${v.toFixed(2)} mm`,
    hatchoffset: (v) => `${v.toFixed(2)} mm`,
  }, () => { stop(); apply(); });

  function apply() {
    const v = ranges.values();
    const p = scene.state().pattern;
    scene.set({
      layer: v.layer, spacing: v.spacing, size: SIZE[p] ? v.size : null, overlap: v.overlap, minLen: v.minlen,
      hatchOffset: v.hatchoffset, alternate: checks.alternate.checked, insideOut: checks.insideOut.checked,
      arrows: checks.arrows.checked, progress: 1,
    });
  }

  function setPattern(p) {
    stop();
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pattern === p)));
    root.querySelectorAll("[data-patterns]").forEach((el) => { el.hidden = !el.dataset.patterns.split(" ").includes(p); });
    const spec = SIZE[p];
    if (spec) {
      Object.assign($("#size"), { min: spec.min, max: spec.max, step: spec.step });
      ranges.setValue("size", spec.value);
      $("label[for='size']").textContent = spec.label;
      $("label[for='overlap']").textContent = spec.overlap;
    }
    scene.set({ pattern: p });
    apply();
  }

  scene.onStats((st) => {
    $("#stat-count").textContent = String(st.count);
    $("#stat-longest").textContent = `${st.longest.toFixed(1)} mm`;
    $("#stat-mean").textContent = `${st.mean.toFixed(1)} mm`;
    $("#stat-unit").textContent = st.pattern === "offset" ? "rings"
      : st.removed ? `vectors, ${st.removed} removed as too short` : "vectors";
  });

  $("#play").addEventListener("click", () => {
    if (timer !== null) { stop(); scene.set({ progress: 1 }); return; }
    const t0 = performance.now(), ms = 8000;
    $("#play").textContent = "Stop";
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      scene.set({ progress: k });
      if (k < 1) timer = requestAnimationFrame(step); else stop();
    };
    timer = requestAnimationFrame(step);
  });
  Object.values(checks).forEach((c) => c.addEventListener("change", () => { stop(); apply(); }));
  buttons.forEach((b) => b.addEventListener("click", () => setPattern(b.dataset.pattern)));
  setPattern("meander");
}

export async function mountCode(walkRoot, recipesRoot, partUrl, codeUrl) {
  const part = await (await fetch(partUrl)).json();
  const scene = createScene(walkRoot.querySelector(".viewer"), part);
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

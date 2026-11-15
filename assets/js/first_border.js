// Interactive first border explainer.
//   Edge      section through the part edge: the beam runs b inside the outline, the melt track (width w) ends at
//             -b + w/2, so the part keeps its size when b = w/2.
//   Thin fin  top view of a fin of width W on a block: the border is the outline shifted inwards by b (with arcs of
//             radius b around the inner corners). If W < 2b nothing of the fin is left after the offset and the
//             blocked path, a single line along its middle, exposes it instead.
//   Direction the border of the demo block, reversed on every second layer, with a random start point per layer.
import { COLOR, createCanvas, frame, pathPoly, label, arrowHead, bounds, mountWalk, bindRanges } from "./plane.js";

const DEFAULTS = { mode: "edge", b: 0.06, w: 0.12, fin: 0.1, blocked: true, minLen: 0.02, layer: 1, alternate: true };
const HATCH_OFFSET = 0.05;
const HATCH_DISTANCE = 0.1;
const FIN_LENGTH = 1.3;
const LAYERS = 6;

function arc(cx, cy, r, a0, a1, n = 16) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Inward offset by b of block (x <= 0) plus fin (0 <= x <= L, |y| <= W/2), between y = -top and y = top. */
export function finBorder(b, W, L, top) {
  const h = W / 2, c = h - b;
  if (b <= 0) return [[0, top], [0, h], [L, h], [L, -h], [0, -h], [0, -top]];
  if (c > 0) {
    return [[-b, top], ...arc(0, h, b, Math.PI, 1.5 * Math.PI), [L - b, c], [L - b, -c],
      ...arc(0, -h, b, 0.5 * Math.PI, Math.PI), [-b, -top]];
  }
  const xs = -Math.sqrt(b * b - h * h);
  return [[-b, top], ...arc(0, h, b, Math.PI, Math.atan2(-h, xs) + 2 * Math.PI),
    ...arc(0, -h, b, Math.atan2(h, xs), Math.PI), [-b, -top]];
}

/** Blocked path of the fin as [xStart, xEnd] (schematic end trim), or null when the fin keeps a border. */
export function blockedPath(b, W, L) {
  const h = W / 2;
  if (W >= 2 * b || b <= 0.001) return null;
  const trim = 1.2 * b;
  return [-Math.sqrt(b * b - h * h), L - Math.sqrt(Math.max(0, trim * trim - h * h))];
}

function createScene(viewerEl, part) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");
  const listeners = [];

  // ---------------------------------------------------------------- edge
  function drawEdge(ctx, w, h) {
    const f = frame([0, 0, w, h], [-0.42, -0.17, 0.24, 0.16], 20);
    const T = 0.03, top = T;
    // previous layers: solid left of the outline, powder right of it
    for (let k = 0; k < 5; k++) {
      const za = -(k + 1) * T, zb = -k * T;
      ctx.fillStyle = COLOR.part;
      ctx.fillRect(f.x(-0.42), f.y(zb), 0.42 * f.s, T * f.s - 1);
    }
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(f.x(0), f.y(0), 0.24 * f.s, 5 * T * f.s);
    ctx.fillRect(f.x(-0.42), f.y(top), 0.66 * f.s, T * f.s);
    powderDots(ctx, f, [0, -5 * T, 0.24, 0]);
    powderDots(ctx, f, [-0.42, 0, 0.24, top]);
    // hatch area of the current layer
    const xh = -(s.b + HATCH_OFFSET);
    ctx.fillStyle = "rgba(25, 196, 45, .55)";
    ctx.fillRect(f.x(-0.42), f.y(top), (xh + 0.42) * f.s, T * f.s);
    // melt track of the border: half ellipse below the powder surface
    const xc = -s.b, rx = s.w / 2, rz = 0.055;
    ctx.fillStyle = "rgba(220, 50, 80, .55)";
    ctx.beginPath();
    ctx.ellipse(f.x(xc), f.y(top), rx * f.s, rz * f.s, 0, 0, Math.PI);
    ctx.fill();
    // beam
    ctx.fillStyle = "rgba(232, 32, 42, .18)";
    ctx.beginPath();
    ctx.moveTo(f.x(xc - 0.05), f.y(0.15));
    ctx.lineTo(f.x(xc + 0.05), f.y(0.15));
    ctx.lineTo(f.x(xc + 0.012), f.y(top));
    ctx.lineTo(f.x(xc - 0.012), f.y(top));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = COLOR.border;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(f.x(xc), f.y(0.15));
    ctx.lineTo(f.x(xc), f.y(top - rz));
    ctx.stroke();
    // outline
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(f.x(0), f.y(0.15));
    ctx.lineTo(f.x(0), f.y(-0.16));
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, "part outline", f.x(0) + 6, f.y(0.135), { size: 11, color: COLOR.muted });
    label(ctx, "solid (layers below)", f.x(-0.4), f.y(-0.06), { size: 11, color: COLOR.muted });
    label(ctx, "powder", f.x(0.12), f.y(-0.06), { size: 11, color: "#8a7a55", align: "center" });
    if (xh > -0.4) label(ctx, "hatch", f.x(Math.max(-0.4, xh - 0.06)), f.y(top / 2), { size: 11, color: "#0d5c18", align: "center" });
    // dimensions
    dimension(ctx, f, 0, xc, 0.095, `b = ${(s.b * 1000).toFixed(0)} µm`, COLOR.text);
    dimension(ctx, f, xc, xc + rx, top - rz - 0.025, `w/2 = ${(rx * 1000).toFixed(0)} µm`, COLOR.border);
    const edge = xc + rx;
    ctx.strokeStyle = COLOR.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(f.x(edge), f.y(top + 0.012));
    ctx.lineTo(f.x(edge), f.y(top - 0.012));
    ctx.stroke();
    return edge;
  }

  function powderDots(ctx, f, [xa, za, xb, zb]) {
    ctx.fillStyle = COLOR.powderDot;
    const step = 0.012;
    for (let x = xa + step / 2; x < xb; x += step) {
      for (let z = za + step / 2, r = 0; z < zb; z += step, r++) {
        ctx.beginPath();
        ctx.arc(f.x(x + (r % 2) * step / 2), f.y(z), 1.1, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  function dimension(ctx, f, xa, xb, z, text, color) {
    if (Math.abs(xb - xa) < 1e-6) return;
    const y = f.y(z), pa = f.x(xa), pb = f.x(xb);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pa, y);
    ctx.lineTo(pb, y);
    ctx.stroke();
    const dir = pb > pa ? 0 : Math.PI;
    arrowHead(ctx, pb, y, dir, 6);
    arrowHead(ctx, pa, y, dir + Math.PI, 6);
    label(ctx, text, (pa + pb) / 2, y - 10, { align: "center", size: 11, color });
  }

  // ---------------------------------------------------------------- fin
  function drawFin(ctx, w, h) {
    const top = 0.75, L = FIN_LENGTH, half = s.fin / 2;
    const f = frame([0, 0, w, h], [-1.1, -top, L + 0.25, top], 16);
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(f.x(-1.1), f.y(top), (L + 1.35) * f.s, 2 * top * f.s);
    const material = [[-1.1, top], [0, top], [0, half], [L, half], [L, -half], [0, -half], [0, -top], [-1.1, -top]];
    pathPoly(ctx, f, material);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    // hatch (vertical lines on the 0.1 mm grid) inside the hatch inset
    const inset = s.b + HATCH_OFFSET;
    ctx.strokeStyle = COLOR.volume;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = Math.ceil(-1.1 / HATCH_DISTANCE) * HATCH_DISTANCE; x <= -inset + 1e-9; x += HATCH_DISTANCE) {
      ctx.moveTo(f.x(x), f.y(top - inset));
      ctx.lineTo(f.x(x), f.y(-top + inset));
    }
    const hin = half - inset;
    if (hin > 0) {
      for (let x = Math.ceil(-inset / HATCH_DISTANCE) * HATCH_DISTANCE; x <= L - inset + 1e-9; x += HATCH_DISTANCE) {
        ctx.moveTo(f.x(x), f.y(hin));
        ctx.lineTo(f.x(x), f.y(-hin));
      }
    }
    ctx.stroke();
    // border with its melt track
    const border = finBorder(s.b, s.fin, L, top + 0.2);
    track(ctx, f, border, "rgba(220, 50, 80, .22)");
    pathPoly(ctx, f, border, false);
    ctx.strokeStyle = COLOR.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    const bp = s.blocked ? blockedPath(s.b, s.fin, L) : null;
    let status;
    if (s.fin >= 2 * s.b) status = { text: `Fin ${mm(s.fin)} \u2265 2 \u00d7 b: the border runs around the fin`, color: COLOR.text };
    else if (bp && bp[1] - bp[0] >= s.minLen) {
      const line = [[bp[0], 0], [bp[1], 0]];
      track(ctx, f, line, "rgba(200, 0, 200, .25)");
      pathPoly(ctx, f, line, false);
      ctx.strokeStyle = COLOR.blocked;
      ctx.lineWidth = 2;
      ctx.stroke();
      status = { text: `Fin ${mm(s.fin)} < 2 \u00d7 b: no border fits, the blocked path melts it`, color: COLOR.blocked };
    } else {
      ctx.save();
      pathPoly(ctx, f, [[0, half], [L, half], [L, -half], [0, -half]]);
      ctx.clip();
      ctx.strokeStyle = "rgba(232, 32, 42, .7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -0.2; x < L + 0.2; x += 0.04) { ctx.moveTo(f.x(x), f.y(-half)); ctx.lineTo(f.x(x + 0.08), f.y(half)); }
      ctx.stroke();
      ctx.restore();
      status = bp
        ? { text: `Blocked path ${mm(bp[1] - bp[0])} < minimum length ${mm(s.minLen)}: removed, the fin is not exposed`, color: "#b42318" }
        : { text: `Fin ${mm(s.fin)} < 2 \u00d7 b and no blocked path: the fin is not exposed`, color: "#b42318" };
    }
    pathPoly(ctx, f, material, false);
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, status.text, 12, h - 16, { size: 12, color: status.color, weight: 600 });
  }

  function track(ctx, f, poly, color) {
    pathPoly(ctx, f, poly, false);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, s.w * f.s);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
  }

  // ---------------------------------------------------------------- direction
  function drawDirection(ctx, w, h) {
    const outline = part.outline;
    const [x0, y0, x1, y1] = bounds(outline);
    const f = frame([0, 0, w, h], [x0 - 1, y0 - 1.5, x1 + 1, y1 + 1], 18);
    pathPoly(ctx, f, outline);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = COLOR.border;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    const flipped = s.alternate && s.layer % 2 === 0;
    const path = flipped ? [...outline].reverse() : outline;
    const n = path.length;
    // start points of this and the earlier layers (random per layer, reproducible)
    for (let k = 1; k <= s.layer; k++) {
      const [px, py] = outline[startIndex(k, n)];
      ctx.fillStyle = k === s.layer ? "#1d2126" : "rgba(29, 33, 38, .25)";
      ctx.beginPath();
      ctx.arc(f.x(px), f.y(py), k === s.layer ? 6 : 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    // arrows along the path
    const start = startIndex(s.layer, n);
    const from = flipped ? n - 1 - start : start;
    ctx.fillStyle = COLOR.border;
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const p = path[(from + k) % n];
      pts.push([f.x(p[0]), f.y(p[1])]);
    }
    let total = 0;
    for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const ARROWS = 8;
    let next = total / ARROWS / 2, walked = 0;
    for (let k = 1; k < pts.length && next < total; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
      const len = Math.hypot(bx - ax, by - ay);
      while (len > 0 && next <= walked + len) {
        const t = (next - walked) / len;
        arrowHead(ctx, ax + t * (bx - ax), ay + t * (by - ay), Math.atan2(by - ay, bx - ax), 11);
        next += total / ARROWS;
      }
      walked += len;
    }
    const [sx, sy] = outline[start];
    label(ctx, "start", f.x(sx) + 9, f.y(sy) - 10, { size: 12, weight: 600 });
    label(ctx, flipped ? "reversed direction" : "original direction", 12, h - 16,
      { size: 12, color: COLOR.text, weight: 600 });
  }

  function startIndex(layer, n) {
    let x = (layer * 2654435761) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 1274126177) >>> 0;
    return (x >>> 0) % n;
  }

  function draw(ctx, w, h) {
    if (s.mode === "fin") drawFin(ctx, w, h);
    else if (s.mode === "direction") drawDirection(ctx, w, h);
    else {
      const edge = drawEdge(ctx, w, h);
      const d = Math.round(edge * 1000);
      const text = Math.abs(d) < 3 ? "Melted edge lies on the outline: the part keeps its size"
        : d > 0 ? `Melted edge ${d} µm outside the outline: the part grows`
          : `Melted edge ${-d} µm inside the outline: the part shrinks`;
      label(ctx, text, 12, h - 16, { size: 12, weight: 600, color: Math.abs(d) < 3 ? "#1a7f37" : "#b42318" });
    }
  }

  const canvas = createCanvas(viewerEl, draw);
  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = tagText(s);
    listeners.forEach((cb) => cb({ ...s }));
    canvas.redraw();
  }
  set({});
  return { set, state: () => ({ ...s }) };
}

const mm = (v) => `${v.toFixed(2)} mm`;

function tagText(s) {
  if (s.mode === "fin") return `Thin fin \u00b7 b = ${mm(s.b)} \u00b7 fin ${mm(s.fin)} \u00b7 track ${mm(s.w)}`;
  if (s.mode === "direction") return `Layer ${s.layer} \u00b7 alternate every layer ${s.alternate ? "on" : "off"}`;
  return `Edge section \u00b7 b = ${mm(s.b)} \u00b7 melt track ${mm(s.w)}`;
}

// ------------------------------------------------------------------ "Try it" panel

export async function mount(root, partUrl) {
  const part = await (await fetch(partUrl)).json();
  const scene = createScene(root.querySelector(".viewer"), part);
  const $ = (sel) => root.querySelector(sel);
  const buttons = root.querySelectorAll(".modes button");
  const ranges = bindRanges(root, {
    b: (v) => `${v.toFixed(3)} mm`,
    w: (v) => `${v.toFixed(3)} mm`,
    fin: (v) => `${v.toFixed(2)} mm`,
    minlen: (v) => `${v.toFixed(2)} mm`,
    layer: (v) => String(v),
  }, () => apply());
  function apply() {
    const v = ranges.values();
    scene.set({ b: v.b, w: v.w, fin: v.fin, minLen: v.minlen, layer: v.layer, blocked: $("#blocked").checked,
      alternate: $("#alternate").checked });
  }
  function setMode(mode) {
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    root.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
    scene.set({ mode });
  }
  $("#blocked").addEventListener("change", apply);
  $("#alternate").addEventListener("change", apply);
  buttons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#layer").max = String(LAYERS);
  apply();
  setMode("edge");
}

export async function mountCode(walkRoot, recipesRoot, partUrl, codeUrl) {
  const part = await (await fetch(partUrl)).json();
  const scene = createScene(walkRoot.querySelector(".viewer"), part);
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

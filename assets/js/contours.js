// Interactive explainer of the contour rings (following borders and fill contours) on the contour plate.
//   Top view  every ring is the iso-line of the inside distance at its inset (compute_insets in exposure_layer.js);
//             the hatch fills what is further inside than the hatch inset.
//   Section   a cut across the 1 mm tab: one melt track per ring on each side, the hatch tracks in the middle.
//   Direction the rings of one layer with their scan direction (apply_direction_and_start in lib/exposure/contours.js):
//             reversed if exactly one rule asks for it, "alternate every layer" on odd layer indices, "alternate
//             between contours" on odd ring indices. Ring spacing is exaggerated in this view.
import { COLOR, createCanvas, frame, pathPoly, label, bounds, distanceField, isoLine, strokeSegments, hatchLines,
  mountWalk, bindRanges, chainLoops, signedArea, arrowsAlong } from "./plane.js";

export const CONTOUR_COLOR = { following: "#dc1428", fill: "#ff8c00" };
const DEFAULTS = {
  kind: "following", mode: "top", view: "plate", b: 0.06, firstOn: true,
  follow: 0, followFirst: 0.08, followDist: 0.08,
  fill: 0, fillFirst: 0.1, fillDist: 0.1,
  hatchOffset: 0.05, hatchDist: 0.1, track: 0.12,
  layer: 1, altLayer: true, altContour: false,
};
const DIRECTION_STEP = 0.9;       // exaggerated ring spacing of the direction view (mm)
const VIEWS = {
  plate: [-0.6, -0.6, 24.6, 10.6],
  chamfer: [14.2, -0.4, 18.8, 2.2],
  tab: [19.6, 3.7, 24.4, 6.3],
};
const TAB_HALF = 0.5;
const FIELD_STEP = 0.025;
const fields = new WeakMap();   // the explainer and the walkthrough share one distance field (about 1.5 s to build)

function fieldOf(outline) {
  if (!fields.has(outline)) fields.set(outline, distanceField(outline, FIELD_STEP));
  return fields.get(outline);
}

const partCache = new Map();
function loadPart(url) {
  if (!partCache.has(url)) partCache.set(url, fetch(url).then((r) => r.json()));
  return partCache.get(url);
}

/** Same rules as compute_insets: all insets in mm from the island outline. */
export function computeInsets(s) {
  const r = { first: s.firstOn ? s.b : 0, following: [], fill: [], hatch: 0 };
  let inner = r.first;
  for (let i = 1; i <= s.follow; i++) {
    inner = r.first + s.followFirst + (i - 1) * s.followDist;
    r.following.push(inner);
  }
  const base = inner;
  for (let j = 0; j < s.fill; j++) {
    inner = base + s.fillFirst + j * s.fillDist;
    r.fill.push(inner);
  }
  r.hatch = Math.max(inner + s.hatchOffset, r.first);
  return r;
}

function fieldAt(field, x, y) {
  const { x0, y0, step, nx, ny, d } = field;
  const i = Math.floor((x - x0) / step), j = Math.floor((y - y0) / step);
  if (i < 0 || j < 0 || i + 1 >= nx || j + 1 >= ny) return 0;
  const fx = (x - x0) / step - i, fy = (y - y0) / step - j;
  const v00 = d[j * nx + i], v10 = d[j * nx + i + 1], v01 = d[(j + 1) * nx + i], v11 = d[(j + 1) * nx + i + 1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

/** Pieces of a segment where the inside distance is at least 'inset' (sampled every 0.01 mm). */
function keepInside(field, [x1, y1, x2, y2], inset, out) {
  const len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(len / 0.01));
  let start = null;
  for (let k = 0; k <= n; k++) {
    const t = k / n, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    const ok = fieldAt(field, x, y) >= inset;
    if (ok && start === null) start = [x, y];
    if ((!ok || k === n) && start !== null) {
      out.push([start[0], start[1], x, y]);
      start = null;
    }
  }
}

function createScene(viewerEl, part) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");
  const outline = part.outline;
  let field = null;
  let hatchSegs = null;          // cached for the last hatch inset
  let hatchKey = "";

  function hatchFor(inset) {
    const key = inset.toFixed(4);
    if (key !== hatchKey) {
      hatchSegs = [];
      for (const { seg } of hatchLines(outline, 45, s.hatchDist)) keepInside(field, seg, inset - 1e-6, hatchSegs);
      hatchKey = key;
    }
    return hatchSegs;
  }

  function drawTop(ctx, w, h) {
    if (!field) field = fieldOf(outline);
    const box = VIEWS[s.view];
    const f = frame([0, 0, w, h - 26], box, 16);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h - 26);
    ctx.clip();
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(0, 0, w, h - 26);
    pathPoly(ctx, f, outline);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    const ins = computeInsets(s);
    const thin = s.view === "plate" ? 1.2 : 1.6;
    strokeSegments(ctx, f, hatchFor(ins.hatch), COLOR.volume, s.view === "plate" ? 0.6 : 1);
    ins.fill.forEach((d) => strokeSegments(ctx, f, isoLine(field, d), CONTOUR_COLOR.fill, thin));
    ins.following.forEach((d) => strokeSegments(ctx, f, isoLine(field, d), CONTOUR_COLOR.following, thin));
    if (s.firstOn) strokeSegments(ctx, f, isoLine(field, ins.first), COLOR.border, thin + 0.4);
    pathPoly(ctx, f, outline);
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    const rings = ins.following.length + ins.fill.length;
    const tabRings = [...ins.following, ...ins.fill].filter((d) => d < TAB_HALF).length;
    const text = s.view === "tab"
      ? (ins.hatch < TAB_HALF ? `Tab: ${tabRings} rings, hatch ${(2 * (TAB_HALF - ins.hatch)).toFixed(2)} mm wide in the middle`
        : `Tab: the rings meet in the middle (${tabRings} fit), no hatch is left`)
      : `${rings} ring${rings === 1 ? "" : "s"} inside the first border, hatch starts ${ins.hatch.toFixed(2)} mm inside`;
    label(ctx, text, 12, h - 13, { size: 12, weight: 600 });
  }

  function drawSection(ctx, w, h) {
    const T = 0.03, depth = 0.055;
    const f = frame([0, 0, w, h - 26], [-0.72, -0.2, 0.72, 0.12], 14);
    // previous layers (solid) and powder beside the tab
    ctx.fillStyle = COLOR.part;
    ctx.fillRect(f.x(-TAB_HALF), f.y(0), 2 * TAB_HALF * f.s, 0.2 * f.s);
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(f.x(-0.72), f.y(T), (0.72 - TAB_HALF) * f.s, (0.2 + T) * f.s);
    ctx.fillRect(f.x(TAB_HALF), f.y(T), (0.72 - TAB_HALF) * f.s, (0.2 + T) * f.s);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(f.x(-TAB_HALF), f.y(T), 2 * TAB_HALF * f.s, T * f.s);
    const ins = computeInsets(s);
    const tracks = [];
    if (s.firstOn) tracks.push([ins.first, COLOR.border]);
    ins.following.forEach((d) => tracks.push([d, CONTOUR_COLOR.following]));
    ins.fill.forEach((d) => tracks.push([d, CONTOUR_COLOR.fill]));
    const melt = (x, color) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.ellipse(f.x(x), f.y(T), (s.track / 2) * f.s, depth * f.s, 0, 0, Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(f.x(x), f.y(T), 3, 0, 2 * Math.PI);
      ctx.fill();
    };
    // hatch tracks: hatch lines along the tab, every hatch distance inside the hatch inset
    const hin = TAB_HALF - ins.hatch;
    for (let x = -Math.floor(hin / s.hatchDist) * s.hatchDist; x <= hin + 1e-9; x += s.hatchDist) {
      if (hin >= 0) melt(x, COLOR.volume);
    }
    for (const [d, color] of tracks) {
      if (d >= TAB_HALF) continue;           // the offset of this ring leaves nothing of the tab
      melt(-TAB_HALF + d, color);
      melt(TAB_HALF - d, color);
    }
    ctx.strokeStyle = COLOR.outline;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    [-TAB_HALF, TAB_HALF].forEach((x) => { ctx.moveTo(f.x(x), f.y(0.11)); ctx.lineTo(f.x(x), f.y(-0.19)); });
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, "outline", f.x(-TAB_HALF) - 4, f.y(0.1), { size: 11, color: COLOR.muted, align: "right" });
    label(ctx, "powder", f.x(0.61), f.y(-0.08), { size: 11, color: "#8a7a55", align: "center" });
    label(ctx, "1 mm tab, layers below", f.x(0), f.y(-0.15), { size: 11, color: COLOR.muted, align: "center" });
    const gap = s.kind === "following" ? s.followDist : s.fillDist;
    const overlap = s.track - gap;
    const text = overlap > 0 ? `Neighbouring tracks overlap by ${(overlap * 1000).toFixed(0)} µm (track ${mm(s.track)}, rings ${mm(gap)} apart)`
      : `Gap of ${(-overlap * 1000).toFixed(0)} µm between the tracks: powder stays unmelted`;
    label(ctx, text, 12, h - 13, { size: 12, weight: 600, color: overlap > 0 ? COLOR.text : "#b42318" });
  }

  /** Is ring i (0-based in its contour type) reversed in the current layer? */
  function reversed(i) {
    const flipLayer = s.altLayer && (s.layer - 1) % 2 === 1;
    const flipContour = s.altContour && i % 2 === 1;
    return flipLayer !== flipContour;
  }

  function drawDirection(ctx, w, h) {
    if (!field) field = fieldOf(outline);
    const f = frame([0, 0, w, h - 26], VIEWS.plate, 16);
    pathPoly(ctx, f, outline);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    const n = s.kind === "following" ? s.follow : s.fill;
    const color = CONTOUR_COLOR[s.kind];
    let flips = 0;
    for (let i = 0; i < n; i++) {
      const rev = reversed(i);
      if (rev) flips++;
      for (const loop of chainLoops(isoLine(field, (i + 1) * DIRECTION_STEP))) {
        const ccw = signedArea(loop) > 0;
        const pts = ccw !== rev ? loop : loop.slice().reverse();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        pathPoly(ctx, f, pts, false);
        ctx.stroke();
        ctx.fillStyle = rev ? "#1d2126" : color;
        arrowsAlong(ctx, f, pts, 70, 9);
      }
    }
    const text = n === 0 ? "No rings: set the number of rings above"
      : `Layer ${s.layer}: ${flips} of ${n} ring${n === 1 ? "" : "s"} reversed (dark arrows)`;
    label(ctx, text, 12, h - 13, { size: 12, weight: 600 });
  }

  const canvas = createCanvas(viewerEl, (ctx, w, h) => (s.mode === "section" ? drawSection(ctx, w, h)
    : s.mode === "direction" ? drawDirection(ctx, w, h) : drawTop(ctx, w, h)));
  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = tagText(s);
    canvas.redraw();
  }
  set({});
  return { set, state: () => ({ ...s }) };
}

const mm = (v) => `${v.toFixed(2)} mm`;

function tagText(s) {
  if (s.mode === "direction") {
    return `Direction \u00b7 layer ${s.layer} \u00b7 every layer ${s.altLayer ? "on" : "off"} \u00b7 between contours `
      + `${s.altContour ? "on" : "off"} \u00b7 spacing exaggerated`;
  }
  const ins = computeInsets(s);
  const parts = [`first ${mm(ins.first)}`];
  if (ins.following.length) parts.push(`following ${ins.following.map((d) => d.toFixed(2)).join(" / ")}`);
  if (ins.fill.length) parts.push(`fill ${ins.fill.map((d) => d.toFixed(2)).join(" / ")}`);
  parts.push(`hatch ${mm(ins.hatch)}`);
  return (s.mode === "section" ? "Section across the tab \u00b7 " : "Insets \u00b7 ") + parts.join(" \u00b7 ");
}

// ------------------------------------------------------------------ "Try it" panel

/** kind: "following" or "fill"; the sliders of that contour type are in the panel (ids follow, fill, dist). */
export async function mount(root, partUrl, kind) {
  const part = await loadPart(partUrl);
  const scene = createScene(root.querySelector(".viewer"), part);
  const $ = (sel) => root.querySelector(sel);
  const ranges = bindRanges(root, {
    count: (v) => String(v),
    first: (v) => `${v.toFixed(2)} mm`,
    dist: (v) => `${v.toFixed(2)} mm`,
    other: (v) => String(v),
    layer: (v) => String(v),
  }, () => apply());
  function apply() {
    const v = ranges.values();
    const common = { kind, layer: v.layer, altLayer: $("#altlayer").checked, altContour: $("#altcontour").checked };
    const patch = kind === "following"
      ? { follow: v.count, followFirst: v.first, followDist: v.dist, fill: v.other }
      : { fill: v.count, fillFirst: v.first, fillDist: v.dist, follow: v.other };
    scene.set({ ...common, ...patch });
  }
  root.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    root.querySelectorAll(".modes button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    const [mode, view] = b.dataset.mode.split(":");
    root.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
    scene.set({ mode, view: view || "plate" });
  }));
  ["#altlayer", "#altcontour"].forEach((id) => $(id).addEventListener("change", apply));
  if ($("#count")) apply();
}

export async function mountCode(walkRoot, recipesRoot, partUrl, codeUrl, kind) {
  const part = await loadPart(partUrl);
  const scene = createScene(walkRoot.querySelector(".viewer"), part);
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, kind, ...sc }) });
}

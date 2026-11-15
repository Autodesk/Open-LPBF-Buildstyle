// Interactive hull and core explainer: the cylinder of the ATU demo (Ø 24 mm, 6 mm high) as top view of one layer
// and as section through the layer stack. The hull ring keeps the volume hatch on every layer; the core gets its
// own, coarser hatch on every n-th layer only and then melts the powder of n layers at once. The section shows 12
// layers of 0.5 mm instead of 200 layers of 30 µm; hatch spacing is exaggerated, the other sizes are real.
import {
  COLOR, createCanvas, frame, pathPoly, strokeSegments, label, bounds, hatchLines, mountWalk, bindRanges,
} from "./plane.js";

const LAYERS = 12;
const INCREMENT = 67;
const SPACING = 0.8;
const CORE_SPACING = SPACING * 1.2;      // core hatch 0.12 mm vs. volume 0.1 mm
const SECTION_STRETCH = 3;               // heights in the section are drawn three times larger
const DEFAULTS = { enabled: true, hull: 2, n: 2, layer: LAYERS };
const mod = (a, n) => ((a % n) + n) % n;

/** Parameter range of a segment inside the circle, or null. */
function circleSpan(seg, cx, cy, r) {
  const [x1, y1, x2, y2] = seg;
  const dx = x2 - x1, dy = y2 - y1, fx = x1 - cx, fy = y1 - cy;
  const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null;
  const q = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - q) / (2 * a)), t1 = Math.min(1, (-b + q) / (2 * a));
  return t0 < t1 ? [t0, t1] : null;
}
const at = ([x1, y1, x2, y2], t) => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
const piece = (seg, ta, tb) => [...at(seg, ta), ...at(seg, tb)];

function insideCircle(segs, cx, cy, r) {
  const out = [];
  for (const s of segs) { const sp = circleSpan(s, cx, cy, r); if (sp) out.push(piece(s, sp[0], sp[1])); }
  return out;
}
function outsideCircle(segs, cx, cy, r) {
  const out = [];
  for (const s of segs) {
    const sp = circleSpan(s, cx, cy, r);
    if (!sp) { out.push(s); continue; }
    if (sp[0] > 1e-9) out.push(piece(s, 0, sp[0]));
    if (sp[1] < 1 - 1e-9) out.push(piece(s, sp[1], 1));
  }
  return out;
}

/** Is the core exposed on layer i (1-based)?  Every n-th layer, as needCoreExposure in the demo build. */
export const coreOn = (i, n) => i % n === 0;

function createScene(viewerEl, part) {
  const outline = part.outline;
  const [x0, y0, x1, y1] = bounds(outline);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = (x1 - x0) / 2;
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");
  const listeners = [];

  function drawTop(ctx, box, layer) {
    const f = frame(box, [x0 - 1, y0 - 1, x1 + 1, y1 + 1], 18);
    const th = mod((layer - 1) * INCREMENT, 360);
    const rIn = Math.max(0, R - s.hull);
    const core = s.enabled && rIn > 0;
    pathPoly(ctx, f, outline);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    const vol = hatchLines(outline, th + 90, SPACING).map((l) => l.seg);
    strokeSegments(ctx, f, core ? outsideCircle(vol, cx, cy, rIn) : vol, COLOR.volume, 1.3);
    if (core) {
      if (coreOn(layer, s.n)) {
        const segs = hatchLines(outline, th + 90, CORE_SPACING).map((l) => l.seg);
        strokeSegments(ctx, f, insideCircle(segs, cx, cy, rIn), COLOR.core, 1.6);
      } else {
        ctx.fillStyle = COLOR.powder;
        ctx.beginPath();
        ctx.arc(f.x(cx), f.y(cy), rIn * f.s, 0, 2 * Math.PI);
        ctx.fill();
        label(ctx, "core: powder only", f.x(cx), f.y(cy), { align: "center", color: "#8a7a55", size: 12, weight: 600 });
      }
      ctx.strokeStyle = "rgba(60, 68, 77, .45)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(f.x(cx), f.y(cy), rIn * f.s, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pathPoly(ctx, f, outline);
    ctx.strokeStyle = COLOR.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    label(ctx, `Top view \u00b7 layer ${layer}`, box[0] + box[2] / 2, box[1] + box[3] - 14,
      { size: 12, color: COLOR.muted, weight: 600, align: "center" });
  }

  function drawSection(ctx, box, layer) {
    const H = part.height * SECTION_STRETCH;
    const t = H / LAYERS;
    const f = frame(box, [x0 - 2, -1.5, x1 + 2, H + 3], 18);
    const h = Math.min(s.hull, R);
    const slab = (xa, xb, za, zb, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(f.x(xa), f.y(zb), (xb - xa) * f.s, (zb - za) * f.s);
    };
    // build plate
    ctx.fillStyle = "#b9bfc6";
    ctx.fillRect(f.x(x0 - 2), f.y(0), (x1 - x0 + 4) * f.s, 0.4 * f.s);
    const gap = Math.max(1, 0.08 * t * f.s);
    let lastCore = 0;
    for (let i = 1; i <= layer; i++) {
      const za = (i - 1) * t, zb = i * t;
      if (!s.enabled) { slab(x0, x1, za, zb, COLOR.volume); continue; }
      slab(x0, x0 + h, za, zb, COLOR.volume);
      slab(x1 - h, x1, za, zb, COLOR.volume);
      if (R - h <= 0) continue;
      if (coreOn(i, s.n)) { slab(x0 + h, x1 - h, lastCore * t, zb, COLOR.core); lastCore = i; }
      else slab(x0 + h, x1 - h, za, zb, COLOR.powder);
    }
    // layer gaps, so the single layers stay visible
    ctx.fillStyle = "rgba(255, 255, 255, .85)";
    for (let i = 1; i < layer; i++) {
      const y = f.y(i * t);
      if (!s.enabled) { ctx.fillRect(f.x(x0), y - gap / 2, (x1 - x0) * f.s, gap); continue; }
      ctx.fillRect(f.x(x0), y - gap / 2, h * f.s, gap);
      ctx.fillRect(f.x(x1 - h), y - gap / 2, h * f.s, gap);
      if (i % s.n === 0 && R - h > 0) ctx.fillRect(f.x(x0 + h), y - gap / 2, (x1 - x0 - 2 * h) * f.s, gap);
    }
    // outline of the full part and the current layer
    ctx.strokeStyle = "rgba(60, 68, 77, .35)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(f.x(x0), f.y(H), (x1 - x0) * f.s, H * f.s);
    ctx.setLineDash([]);
    ctx.strokeStyle = "#1d2126";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(f.x(x0) - 3, f.y(layer * t), (x1 - x0) * f.s + 6, t * f.s);
    label(ctx, "Section through the layers (height exaggerated)", box[0] + box[2] / 2, box[1] + box[3] - 14,
      { size: 12, color: COLOR.muted, weight: 600, align: "center" });
    if (s.enabled && R - h > 0) {
      label(ctx, "hull", f.x(x0 + h / 2), f.y(H) - 10, { align: "center", size: 11, color: COLOR.muted });
      label(ctx, "core", f.x(cx), f.y(H) - 10, { align: "center", size: 11, color: COLOR.muted });
    }
  }

  function draw(ctx, w, h) {
    const split = Math.round(w * 0.46);
    drawTop(ctx, [0, 0, split, h], s.layer);
    ctx.strokeStyle = "rgba(60, 68, 77, .15)";
    ctx.beginPath();
    ctx.moveTo(split + 0.5, 12);
    ctx.lineTo(split + 0.5, h - 12);
    ctx.stroke();
    drawSection(ctx, [split, 0, w - split, h], s.layer);
  }

  const canvas = createCanvas(viewerEl, draw);
  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = tagText(s);
    listeners.forEach((cb) => cb({ ...s }));
    canvas.redraw();
  }
  set({});
  return { set, state: () => ({ ...s }), onChange: (cb) => listeners.push(cb) };
}

function tagText(s) {
  const head = `Layer ${s.layer} of ${LAYERS}`;
  if (!s.enabled) return `${head} \u00b7 hull and core off: volume hatch everywhere`;
  if (s.n === 1) return `${head} \u00b7 hull + core on every layer`;
  if (coreOn(s.layer, s.n)) return `${head} \u00b7 core exposed, melts ${s.n} layers of powder`;
  const next = Math.ceil(s.layer / s.n) * s.n;
  return `${head} \u00b7 core skipped, melted with layer ${next}`;
}

// ------------------------------------------------------------------ "Try it" panel

export async function mount(root, partUrl) {
  const part = await (await fetch(partUrl)).json();
  const scene = createScene(root.querySelector(".viewer"), part);
  const $ = (sel) => root.querySelector(sel);
  const enabled = $("#enabled");
  let timer = null;
  const stop = () => { if (timer !== null) clearInterval(timer); timer = null; $("#play").textContent = "Build up"; };
  const ranges = bindRanges(root, {
    hull: (v) => `${v.toFixed(1)} mm`,
    n: (v) => String(v),
    layer: (v) => String(v),
  }, (id) => { if (id !== "layer") stop(); apply(); });

  function apply() {
    const v = ranges.values();
    root.querySelectorAll("[data-needs-enabled]").forEach((el) => { el.disabled = !enabled.checked; });
    scene.set({ enabled: enabled.checked, hull: v.hull, n: v.n, layer: v.layer });
  }
  enabled.addEventListener("change", apply);
  $("#play").addEventListener("click", () => {
    if (timer !== null) { stop(); return; }
    let i = 0;
    $("#play").textContent = "Pause";
    timer = setInterval(() => {
      i += 1;
      ranges.setValue("layer", i);
      apply();
      if (i >= LAYERS) stop();
    }, 450);
  });
  apply();
}

export async function mountCode(walkRoot, recipesRoot, partUrl, codeUrl) {
  const part = await (await fetch(partUrl)).json();
  const scene = createScene(walkRoot.querySelector(".viewer"), part);
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

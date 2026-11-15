// Interactive explainer of the solid supports (support areas, BSID 710) on the six 3 x 3 mm pillars.
//   The area is shrunk by the support inset (process_solid_support_island), then hatched with meander lines or
//   offset rings (make_offset_hatch: ring k at 0.5 * d + k * d inside the area). No border.
import { COLOR, createCanvas, frame, label, hatchLines, strokeSegments, mountWalk, bindRanges } from "./plane.js";

export const SOLID = "#5a5a5a";
const DEFAULTS = { mode: "all", inset: 0, pattern: "meander", hd: 0.2, layer: 1, insideOut: false };
const INCREMENT = 67;           // rotation of the support hatch per layer (start angle 0)

function boxOf(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const rect = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const angleOf = (s) => ((s.layer - 1) * INCREMENT) % 360;

/** Exposure of one rectangular pillar: {area, segs (meander), rings (offset), length in mm}. */
function pillarHatch(box, s) {
  const [x0, y0, x1, y1] = box;
  const area = [x0 + s.inset, y0 + s.inset, x1 - s.inset, y1 - s.inset];
  if (area[2] <= area[0] || area[3] <= area[1]) return { area: null, segs: [], rings: [], length: 0 };
  if (s.pattern === "offset") {
    const rings = [];
    for (let k = 0; k < 1000; k++) {
      const d = 0.5 * s.hd + k * s.hd;
      const r = [area[0] + d, area[1] + d, area[2] - d, area[3] - d];
      if (r[2] <= r[0] || r[3] <= r[1]) break;
      rings.push(r);
    }
    const length = rings.reduce((a, r) => a + 2 * (r[2] - r[0] + r[3] - r[1]), 0);
    return { area, segs: [], rings, length };
  }
  const segs = hatchLines(rect(area), angleOf(s), s.hd).map((q) => q.seg);
  // the meander length is about area / hatch distance (lines across, connections not counted)
  const length = ((area[2] - area[0]) * (area[3] - area[1])) / s.hd;
  return { area, segs, rings: [], length };
}

function createScene(viewerEl, table, solids) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");
  const boxes = solids.pillars.map(boxOf);

  const canvas = createCanvas(viewerEl, (ctx, w, h) => {
    const view = s.mode === "one" ? [0.4, 0.4, 4.6, 4.6] : [-0.6, -0.6, 16.6, 10.6];
    const f = frame([0, 0, w, h - 26], view, 14);
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(0, 0, w, h - 26);
    ctx.strokeStyle = COLOR.grid;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(f.x(0), f.y(10), 16 * f.s, 10 * f.s);
    ctx.setLineDash([]);
    let total = 0, rings = 0;
    for (const b of boxes) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(f.x(b[0]), f.y(b[3]), (b[2] - b[0]) * f.s, (b[3] - b[1]) * f.s);
      ctx.strokeStyle = COLOR.outline;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(f.x(b[0]), f.y(b[3]), (b[2] - b[0]) * f.s, (b[3] - b[1]) * f.s);
      ctx.setLineDash([]);
      const p = pillarHatch(b, s);
      total += p.length;
      rings += p.rings.length;
      if (p.area && s.inset > 0) {
        ctx.fillStyle = "rgba(90, 90, 90, .08)";
        ctx.fillRect(f.x(p.area[0]), f.y(p.area[3]), (p.area[2] - p.area[0]) * f.s, (p.area[3] - p.area[1]) * f.s);
      }
      const lw = s.mode === "one" ? 2 : 1.2;
      strokeSegments(ctx, f, p.segs, SOLID, lw);
      ctx.lineWidth = lw;
      const n = p.rings.length;
      p.rings.forEach((r, k) => {
        // exposure order: the first ring is the darkest
        const order = s.insideOut ? n - 1 - k : k;
        const t = n > 1 ? order / (n - 1) : 0;
        ctx.strokeStyle = `rgb(${Math.round(40 + t * 150)}, ${Math.round(40 + t * 150)}, ${Math.round(40 + t * 150)})`;
        ctx.strokeRect(f.x(r[0]), f.y(r[3]), (r[2] - r[0]) * f.s, (r[3] - r[1]) * f.s);
      });
      ctx.lineWidth = 1;
    }
    if (s.mode === "one" && s.inset > 0) {
      const b = boxes[0];
      ctx.strokeStyle = COLOR.muted;
      ctx.beginPath();
      ctx.moveTo(f.x(b[0]), f.y(b[1] - 0.15));
      ctx.lineTo(f.x(b[0] + s.inset), f.y(b[1] - 0.15));
      ctx.stroke();
      label(ctx, `inset ${s.inset.toFixed(2)} mm`, f.x(b[0] + s.inset) + 6, f.y(b[1] - 0.15), { size: 11, color: COLOR.muted });
    }
    const what = s.pattern === "offset"
      ? `${rings / boxes.length} rings per pillar, ${total.toFixed(0)} mm, ${s.insideOut ? "inside ring first" : "outside ring first"}`
      : `meander at ${angleOf(s)}°, about ${total.toFixed(0)} mm`;
    label(ctx, `6 pillars · ${what} · no border`, 12, h - 13, { size: 12, weight: 600 });
  });

  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = `Inset ${s.inset.toFixed(2)} mm · ${s.pattern === "offset" ? "Offset" : `Meander · layer ${s.layer}`} · hatch distance ${s.hd.toFixed(2)} mm`;
    canvas.redraw();
  }
  set({});
  return { set };
}

async function load(tableUrl, solidsUrl) {
  return Promise.all([fetch(tableUrl).then((r) => r.json()), fetch(solidsUrl).then((r) => r.json())]);
}

// ------------------------------------------------------------------ "Try it" panel

export async function mount(root, tableUrl, solidsUrl) {
  const [table, solids] = await load(tableUrl, solidsUrl);
  const scene = createScene(root.querySelector(".viewer"), table, solids);
  let mode = "all";
  const ranges = bindRanges(root, {
    inset: (v) => `${v.toFixed(2)} mm`,
    hd: (v) => `${v.toFixed(2)} mm`,
    layer: (v) => String(v),
  }, () => apply());
  const pattern = root.querySelector("#pattern"), insideOut = root.querySelector("#insideout");
  [pattern, insideOut].forEach((el) => el.addEventListener("change", () => apply()));
  function apply() {
    const v = ranges.values();
    root.querySelectorAll("[data-pattern-only]").forEach((el) => { el.hidden = el.dataset.patternOnly !== pattern.value; });
    scene.set({ mode, inset: v.inset, hd: v.hd, pattern: pattern.value, layer: v.layer, insideOut: insideOut.checked });
  }
  root.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    root.querySelectorAll(".modes button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    apply();
  }));
  apply();
}

export async function mountCode(walkRoot, recipesRoot, tableUrl, solidsUrl, codeUrl) {
  const [table, solids] = await load(tableUrl, solidsUrl);
  const scene = createScene(walkRoot.querySelector(".viewer"), table, solids);
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

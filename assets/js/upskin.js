// Interactive explainer of the single-layer upskin on the step block (three steps, tops at z = 2, 4 and 6 mm).
//   Section     side view: which layer is part, which is upskin (not covered by the next layer above)
//   Top view    one layer from above: upskin area grown by 'overlap' into the volume, both clipped to the hatch area
//   Sloped top  why 'min width' matters: on a sloped top every layer leaves a strip of t / tan(angle)
import { COLOR, createCanvas, frame, label, hatchLines, strokeSegments, mountWalk, bindRanges } from "./plane.js";

export const UPSKIN = "#e6c800";
const T = 0.03;                    // layer thickness of the demo (mm)
const HATCH_INSET = 0.11;          // beam compensation 0.06 + hatch offset 0.05
const DEFAULTS = { mode: "section", z: 1.98, overlap: 0.1, minWidth: 0.1, angle: 30, enabled: true };

/** Part and upskin of one layer: x ranges [x0, x1] with their kind, from the step table of the part. */
function layerRanges(part, z, enabled) {
  const out = [];
  for (const st of part.steps) {
    if (z > st.z + 1e-9) continue;                       // above this step: no part
    const top = enabled && z + T > st.z + 1e-9;           // the layer above does not cover it
    out.push({ x0: st.x0, x1: st.x1, upskin: top });
  }
  return out.sort((a, b) => a.x0 - b.x0);
}

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** Hatch rectangles of one layer: hatch area = footprint inset by HATCH_INSET; upskin grown by overlap, clipped. */
function layerAreas(part, s) {
  const r = layerRanges(part, s.z, s.enabled);
  if (!r.length) return null;
  const fx0 = Math.min(...r.map((q) => q.x0)), fx1 = Math.max(...r.map((q) => q.x1));
  const hx0 = fx0 + HATCH_INSET, hx1 = fx1 - HATCH_INSET, hy0 = HATCH_INSET, hy1 = part.depth - HATCH_INSET;
  const us = r.filter((q) => q.upskin);
  let ux0 = null, ux1 = null;
  if (us.length) {
    ux0 = Math.max(hx0, Math.min(...us.map((q) => q.x0)) - s.overlap);
    ux1 = Math.min(hx1, Math.max(...us.map((q) => q.x1)) + s.overlap);
  }
  const vol = [];
  if (ux0 === null) vol.push([hx0, hx1]);
  else {
    if (ux0 > hx0 + 1e-9) vol.push([hx0, ux0]);
    if (ux1 < hx1 - 1e-9) vol.push([ux1, hx1]);
  }
  return { fx0, fx1, hy0, hy1, us: ux0 === null ? null : [ux0, ux1], vol };
}

function createScene(viewerEl, part) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");
  const H = part.depth;

  function drawSection(ctx, w, h) {
    const f = frame([0, 0, w, h - 26], [-1, -0.6, 25, 6.8], 14);
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(f.x(-1), f.y(6.8), 26 * f.s, 7.4 * f.s);
    for (const st of part.steps) {
      ctx.fillStyle = COLOR.part;
      ctx.fillRect(f.x(st.x0), f.y(st.z), (st.x1 - st.x0) * f.s, st.z * f.s);
      if (s.enabled) {
        // the top layer of every step is upskin (drawn at least 3 px thick)
        ctx.fillStyle = UPSKIN;
        ctx.fillRect(f.x(st.x0), f.y(st.z), (st.x1 - st.x0) * f.s, Math.max(3, T * f.s));
      }
      label(ctx, `top z = ${st.z} mm`, f.x((st.x0 + st.x1) / 2), f.y(st.z) - 10, { size: 11, color: COLOR.muted, align: "center" });
    }
    // current layer band
    const band = Math.max(5, T * f.s);
    for (const r of layerRanges(part, s.z, s.enabled)) {
      ctx.fillStyle = r.upskin ? UPSKIN : COLOR.volume;
      ctx.fillRect(f.x(r.x0), f.y(s.z) - band / 2, (r.x1 - r.x0) * f.s, band);
    }
    ctx.strokeStyle = COLOR.outline;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(f.x(-1), f.y(s.z));
    ctx.lineTo(f.x(25), f.y(s.z));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#8a7a55";
    ctx.fillRect(f.x(-1), f.y(0), 26 * f.s, 2);
    label(ctx, "build plate", f.x(-0.8), f.y(0) + 12, { size: 11, color: COLOR.muted });
    const r = layerRanges(part, s.z, s.enabled);
    const n = r.filter((q) => q.upskin).length;
    label(ctx, r.length === 0 ? `z = ${s.z.toFixed(2)} mm: above the part`
      : n ? `z = ${s.z.toFixed(2)} mm: the layer above (z = ${(s.z + T).toFixed(2)}) leaves ${n === 1 ? "one step" : n + " steps"} uncovered: upskin`
        : `z = ${s.z.toFixed(2)} mm: covered by the next layer everywhere, volume hatch only`, 12, h - 13, { size: 12, weight: 600 });
  }

  function drawTop(ctx, w, h) {
    const f = frame([0, 0, w, h - 26], [-0.6, -0.6, 24.6, H + 0.6], 14);
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(0, 0, w, h - 26);
    const a = layerAreas(part, s);
    if (!a) { label(ctx, "Above the part", 12, h - 13, { size: 12, weight: 600 }); return; }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(f.x(a.fx0), f.y(H), (a.fx1 - a.fx0) * f.s, H * f.s);
    // previous step outlines for orientation
    ctx.strokeStyle = COLOR.grid;
    for (const st of part.steps) ctx.strokeRect(f.x(st.x0), f.y(H), (st.x1 - st.x0) * f.s, H * f.s);
    let volLen = 0, usLen = 0;
    for (const [x0, x1] of a.vol) {
      strokeSegments(ctx, f, hatchLines(rect(x0, a.hy0, x1, a.hy1), 45, 0.25).map((q) => q.seg), COLOR.volume, 1);
      volLen += ((x1 - x0) * (a.hy1 - a.hy0)) / 0.1;
    }
    if (a.us) {
      const [x0, x1] = a.us;
      ctx.fillStyle = "rgba(230, 200, 0, .16)";
      ctx.fillRect(f.x(x0), f.y(a.hy1), (x1 - x0) * f.s, (a.hy1 - a.hy0) * f.s);
      strokeSegments(ctx, f, hatchLines(rect(x0, a.hy0, x1, a.hy1), -45, 0.2).map((q) => q.seg), UPSKIN, 1.2);
      usLen = ((x1 - x0) * (a.hy1 - a.hy0)) / 0.08;
    }
    ctx.strokeStyle = COLOR.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(f.x(a.fx0 + 0.06), f.y(H - 0.06), (a.fx1 - a.fx0 - 0.12) * f.s, (H - 0.12) * f.s);
    ctx.lineWidth = 1;
    const parts = [];
    if (volLen) parts.push(`volume hatch ≈ ${volLen.toFixed(0)} mm`);
    if (usLen) parts.push(`upskin hatch ≈ ${usLen.toFixed(0)} mm (0.08 mm apart)`);
    label(ctx, `z = ${s.z.toFixed(2)} mm · ${parts.join(" · ")}`, 12, h - 13, { size: 12, weight: 600 });
  }

  function drawSlope(ctx, w, h) {
    const strip = T / Math.tan((s.angle * Math.PI) / 180);
    const n = 5;
    const span = Math.max(n * strip, 0.25);
    // exaggerate z so the 30 µm layers stay visible: draw z with its own scale
    const left = 50, right = w - 30, top = 30, bottom = h - 70;
    const sx = (right - left) / (span * 1.15), sz = (bottom - top) / (n * T * 1.25);
    const X = (x) => left + x * sx, Z = (z) => bottom - z * sz;
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(0, 0, w, h - 26);
    const kept = strip >= s.minWidth - 1e-9;
    for (let i = 0; i < n; i++) {
      const xEnd = span - i * strip;          // each layer ends one strip earlier than the one below
      if (xEnd <= 0) break;
      ctx.fillStyle = COLOR.part;
      ctx.fillRect(X(0), Z((i + 1) * T), (xEnd) * sx, T * sz - 1);
      const x0 = Math.max(0, xEnd - strip);
      ctx.fillStyle = kept ? UPSKIN : "rgba(180, 35, 24, .25)";
      ctx.fillRect(X(x0), Z((i + 1) * T), (xEnd - x0) * sx, T * sz - 1);
      if (!kept) {
        ctx.strokeStyle = "#b42318";
        ctx.strokeRect(X(x0) + 0.5, Z((i + 1) * T) + 0.5, (xEnd - x0) * sx - 1, T * sz - 2);
      }
    }
    // the sloped surface of the design
    ctx.strokeStyle = COLOR.outline;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(X(span), Z(0));
    ctx.lineTo(X(span - n * strip), Z(n * T));
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, `slope ${s.angle}° from horizontal`, X(span) - 6, Z(0) + 14, { size: 11, color: COLOR.muted, align: "right" });
    label(ctx, "layers drawn much thicker than to scale", left, h - 46, { size: 11, color: COLOR.muted });
    label(ctx, kept ? `Strip t / tan(angle) = ${(strip * 1000).toFixed(0)} µm ≥ min width ${(s.minWidth * 1000).toFixed(0)} µm: upskin on every layer`
      : `Strip ${(strip * 1000).toFixed(0)} µm < min width ${(s.minWidth * 1000).toFixed(0)} µm: removed, no upskin strips`, 12, h - 13,
      { size: 12, weight: 600, color: kept ? COLOR.text : "#b42318" });
  }

  const canvas = createCanvas(viewerEl, (ctx, w, h) => {
    if (s.mode === "top") drawTop(ctx, w, h);
    else if (s.mode === "slope") drawSlope(ctx, w, h);
    else drawSection(ctx, w, h);
  });
  function set(patch) {
    Object.assign(s, patch);
    if (tag) {
      tag.textContent = s.mode === "slope" ? `min width ${s.minWidth.toFixed(2)} mm · layer ${(T * 1000).toFixed(0)} µm`
        : `Layer z = ${s.z.toFixed(2)} mm · overlap ${s.overlap.toFixed(2)} mm`;
    }
    canvas.redraw();
  }
  set({});
  return { set };
}

// ------------------------------------------------------------------ "Try it" panel

export async function mount(root, partUrl) {
  const part = await (await fetch(partUrl)).json();
  const scene = createScene(root.querySelector(".viewer"), part);
  let mode = "section";
  const ranges = bindRanges(root, {
    z: (v) => `${v.toFixed(2)} mm`,
    overlap: (v) => `${v.toFixed(2)} mm`,
    angle: (v) => `${v}°`,
    minw: (v) => `${v.toFixed(2)} mm`,
  }, () => apply());
  const enabled = root.querySelector("#enabled");
  enabled.addEventListener("change", () => apply());
  function apply() {
    const v = ranges.values();
    scene.set({ mode, z: v.z, overlap: v.overlap, angle: v.angle, minWidth: v.minw, enabled: enabled.checked });
  }
  root.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    root.querySelectorAll(".modes button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    root.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
    apply();
  }));
  apply();
}

export async function mountCode(walkRoot, recipesRoot, partUrl, codeUrl) {
  const part = await (await fetch(partUrl)).json();
  const scene = createScene(walkRoot.querySelector(".viewer"), part);
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

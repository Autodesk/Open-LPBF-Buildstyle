// Interactive explainer of the hatch rotation and its limitation window (lib/exposure/pattern_rotation.js).
//   Dial    line direction of the current layer on a patch of the plate, and the directions of the layers so far
//           on a half circle (a line has no front and back, so directions repeat after 180°), window shaded
//   Layers  a strip of twelve consecutive layers, each with its line direction
// All angles in the settings are hatch angle VALUES (0 = lines parallel to Y). The value also gives the order of the
// lines: they are exposed one after another along (cos a, sin a); a and a + 180 are the same lines in reverse order.
import { COLOR, createCanvas, label, arrowHead, mountWalk, bindRanges } from "./plane.js";

const DEG = Math.PI / 180;
const LINE_OFFSET = 90;          // angle value 0 = lines parallel to Y: line direction = value + 90
const DEFAULTS = { mode: "dial", layer: 49, start: 0, increment: 67, limit: false, centerMode: "gas_flow", center: 0,
  width: 120, gas: 0, against: true };

const mod = (a, m) => ((a % m) + m) % m;

/** against_gas_flow: turn an angle value whose lines are exposed downstream by 180° (same lines). */
function againstGas(s, a) {
  const v = mod(a, 360);
  if (!s.against) return v;
  return Math.cos((v - s.gas) * DEG) > 1e-9 ? mod(v + 180, 360) : v;
}

/** Window center as an angle value (gas_flow mode: gas + 180 + direction, so the lines run against the flow). */
const windowCenter = (s) => (s.centerMode === "gas_flow" ? s.gas + 180 + s.center : s.center);

/** Hatch angle value like get_line_angle (degrees, 0 ... 360). */
export function lineAngle(s, layerIndex) {
  const raw = s.start + layerIndex * s.increment;
  if (!s.limit || !(s.width > 0) || s.width >= 180) return againstGas(s, raw);
  const center = windowCenter(s);
  const p = mod(raw - center + 90, 180);
  return againstGas(s, center + (p * s.width) / 180 - s.width / 2);
}
/** Geometric line direction, 0 ... 180 degrees from +X. */
export const lineDirection = (s, layerIndex) => mod(lineAngle(s, layerIndex) + LINE_OFFSET, 180);

function createScene(viewerEl) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");

  function patch(ctx, x, y, size, dir, { spacing = 9, color = COLOR.volume, width = 1.2 } = {}) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, size, size); ctx.clip();
    ctx.fillStyle = "#ffffff"; ctx.fillRect(x, y, size, size);
    const cx = x + size / 2, cy = y + size / 2, ux = Math.cos(dir * DEG), uy = -Math.sin(dir * DEG);
    ctx.strokeStyle = color; ctx.lineWidth = width;
    for (let k = -size; k <= size; k += spacing) {
      const ox = cx - uy * k, oy = cy + ux * k;
      ctx.beginPath(); ctx.moveTo(ox - ux * size, oy - uy * size); ctx.lineTo(ox + ux * size, oy + uy * size); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = COLOR.outline; ctx.lineWidth = 1; ctx.strokeRect(x, y, size, size);
  }

  function gasArrow(ctx, x, y, len) {
    const a = -s.gas * DEG;
    ctx.strokeStyle = "#0696d7"; ctx.fillStyle = "#0696d7"; ctx.lineWidth = 2;
    const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    arrowHead(ctx, x2, y2, a, 9);
    ctx.lineWidth = 1;
    label(ctx, `gas flow ${s.gas}°`, x, y + 16, { size: 11, color: "#0670a3" });
  }

  /** Window as line directions (0 ... 180, may wrap). */
  function windowRange() {
    if (!s.limit || s.width >= 180) return null;
    const c = mod(windowCenter(s) + LINE_OFFSET, 180);
    return [c - s.width / 2, c + s.width / 2];
  }

  /** Arrow along the exposure progress (cos a, sin a) of the angle value a, over a patch. */
  function progressArrow(ctx, x, y, size, a) {
    const ux = Math.cos(a * DEG), uy = -Math.sin(a * DEG), cx = x + size / 2, cy = y + size / 2, l = size * 0.36;
    ctx.strokeStyle = COLOR.text; ctx.fillStyle = COLOR.text; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx - ux * l, cy - uy * l); ctx.lineTo(cx + ux * l, cy + uy * l); ctx.stroke();
    arrowHead(ctx, cx + ux * l, cy + uy * l, Math.atan2(uy, ux), Math.max(7, size * 0.07));
    ctx.lineWidth = 1;
  }

  function drawDial(ctx, w, h) {
    const top = 44, size = Math.min(w * 0.4, h - 100);
    const dir = lineDirection(s, s.layer);
    patch(ctx, 16, top, size, dir);
    progressArrow(ctx, 16, top, size, lineAngle(s, s.layer));
    gasArrow(ctx, 20, top + size + 22, Math.min(80, size * 0.4));
    // half circle of line directions
    const cx = 16 + size + (w - size - 16) / 2, cy = top + size * 0.82, r = Math.min((w - size - 60) / 2, size * 0.75);
    const win = windowRange();
    ctx.strokeStyle = COLOR.grid;
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
    for (const d of [0, 45, 90, 135, 180]) {
      label(ctx, `${d}°`, cx + Math.cos(d * DEG) * (r + 14), cy - Math.sin(d * DEG) * (r + 14), { size: 10, color: COLOR.muted, align: "center" });
    }
    // the window: line directions repeat every 180°, so it can wrap around 0° / 180°
    if (win) {
      ctx.fillStyle = "rgba(25, 196, 45, .16)";
      for (const shift of [-180, 0, 180]) {
        const a0 = Math.max(0, win[0] + shift), a1 = Math.min(180, win[1] + shift);
        if (a1 <= a0) continue;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, -a1 * DEG, -a0 * DEG); ctx.closePath(); ctx.fill();
      }
    }
    // gas flow as a line direction
    const g = mod(s.gas, 180);
    ctx.strokeStyle = "#0696d7"; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(g * DEG) * r, cy - Math.sin(g * DEG) * r); ctx.stroke();
    ctx.setLineDash([]);
    // directions of the layers so far (the last 20)
    const first = Math.max(0, s.layer - 19);
    for (let i = first; i <= s.layer; i++) {
      const d = lineDirection(s, i), cur = i === s.layer;
      const rr = r * (0.45 + (0.5 * (i - first + 1)) / (s.layer - first + 1));
      ctx.fillStyle = cur ? COLOR.text : "rgba(25, 196, 45, .75)";
      ctx.beginPath(); ctx.arc(cx + Math.cos(d * DEG) * rr, cy - Math.sin(d * DEG) * rr, cur ? 6 : 3.5, 0, 2 * Math.PI); ctx.fill();
      if (cur) {
        ctx.strokeStyle = COLOR.text; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(d * DEG) * rr, cy - Math.sin(d * DEG) * rr); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    label(ctx, "line directions of the last 20 layers (outer = newer)", cx, cy + 18, { size: 11, color: COLOR.muted, align: "center" });
    const close = [];
    for (let i = first; i <= s.layer; i++) {
      const d = Math.abs(lineDirection(s, i) - g);
      if (Math.min(d, 180 - d) < 15) close.push(i);
    }
    label(ctx, win ? `Window ${mod(win[0], 360).toFixed(0)}° … ${mod(win[1], 360).toFixed(0)}°: ${close.length} of these layers within 15° of the gas flow`
      : `No window: ${close.length} of these layers within 15° of the gas flow`, 12, h - 13, { size: 12, weight: 600 });
  }

  function drawStrip(ctx, w, h) {
    const n = 12, cols = 6, gap = 12;
    const size = Math.min((w - 24 - gap * (cols - 1)) / cols, (h - 100) / 2 - 22);
    const first = Math.max(0, s.layer - 5);
    for (let k = 0; k < n; k++) {
      const i = first + k, col = k % cols, row = Math.floor(k / cols);
      const x = 12 + col * (size + gap), y = 46 + row * (size + 34);
      const d = lineDirection(s, i);
      patch(ctx, x, y, size, d, { spacing: 7, color: i === s.layer ? COLOR.core : COLOR.volume, width: 1 });
      progressArrow(ctx, x, y, size, lineAngle(s, i));
      label(ctx, `layer ${i + 1}`, x, y - 9, { size: 11, color: i === s.layer ? COLOR.text : COLOR.muted, weight: i === s.layer ? 700 : 500 });
      label(ctx, `${d.toFixed(1)}°`, x + size, y + size + 11, { size: 11, align: "right", weight: 600 });
    }
    gasArrow(ctx, 16, h - 34, 60);
    const down = Array.from({ length: n }, (_, k) => first + k)
      .filter((i) => Math.cos((lineAngle(s, i) - s.gas) * DEG) > 1e-9).length;
    label(ctx, (s.limit ? `Window on: every layer still differs, all inside ${s.width}°` : `+${s.increment}° per layer`)
      + (down ? ` · ${down} of ${n} exposed downstream` : " · all exposed against the gas flow"),
      w - 12, h - 13, { size: 12, weight: 600, align: "right" });
  }

  const canvas = createCanvas(viewerEl, (ctx, w, h) => (s.mode === "strip" ? drawStrip(ctx, w, h) : drawDial(ctx, w, h)));
  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = s.mode === "strip"
      ? `Hatch plate · +${s.increment}° per layer` + (s.limit ? ` · window ${s.width}°` : "")
      : `Hatch plate · layer ${s.layer + 1}: lines at ${lineDirection(s, s.layer).toFixed(1)}°`;
    canvas.redraw();
  }
  set({});
  return { set };
}

// ------------------------------------------------------------------ "Try it" panel

export function mount(root) {
  const scene = createScene(root.querySelector(".viewer"));
  let mode = "dial";
  const limit = root.querySelector("#limit"), centerMode = root.querySelector("#centermode");
  const against = root.querySelector("#against");
  const centerLabel = root.querySelector("#center-label");
  const ranges = bindRanges(root, {
    layer: (v) => `${v + 1}`,
    start: (v) => `${v}°`,
    increment: (v) => `${v}°`,
    width: (v) => `${v}°`,
    center: (v) => `${v}°`,
    gas: (v) => `${v}°`,
  }, () => apply());
  function apply() {
    const v = ranges.values();
    centerLabel.textContent = centerMode.value === "gas_flow" ? "Window direction (relative to gas flow)"
      : "Window direction (absolute)";
    scene.set({ mode, layer: v.layer, start: v.start, increment: v.increment, limit: limit.checked,
      centerMode: centerMode.value, width: v.width, center: v.center, gas: v.gas, against: against.checked });
  }
  [limit, centerMode, against].forEach((el) => el.addEventListener("change", apply));
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

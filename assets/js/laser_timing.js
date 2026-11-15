// Interactive explainer of the Laser timing group (platform): jump speed, mark delay, jump delay and the jump delay
// scaling (minimum jump delay, jump length limit).
//   Build time   simplified EXPOSURE_TIME.estimate_layer_time_ms for the hatch plate (100 layers): marking
//                (length / speed) + one mark delay per hatch vector and one per contour + the jumps of one hatch
//                distance inside the 3 hatch blocks and their (scaled) jump delays + the jumps between the paths.
//                Layer 50 in ATU: 471 hatch vectors in 3 blocks, one border.
//   One vector   the cycle of one hatch vector as in POWER_MODEL.reference_time_ms: marking, mark delay, jump to the
//                next line, jump delay. For short vectors the delays are a large share of the time.
//   Jump delay   SCANNER_DELAYS.scaled_jump_delay over the jump length.
import { COLOR, createCanvas, label, mountWalk, bindRanges } from "./plane.js";

const PLATE = { layers: 100, hatchLen: 10404.8, borderLen: 137.4, hatchVectors: 471, blocks: 3, contours: 1, hd: 0.1,
  hatchSpeed: 1200, borderSpeed: 600 };
const PATHS = PLATE.blocks + PLATE.contours;
const SKIPS = PLATE.hatchVectors - PLATE.blocks;          // jumps between the vectors of a hatch block
const MARK_DELAYS = PLATE.hatchVectors + PLATE.contours;  // after every hatch vector, once per contour
const DEFAULTS = { mode: "time", jumpSpeed: 7000, markDelay: 10, jumpDelay: 50, minJumpDelay: 0, jumpLimit: 0, length: 2 };
const C = { mark: COLOR.volume, border: COLOR.border, markDelay: "#f0a020", jump: "#0696d7", jumpDelay: "#7a4fd0" };

/** SCANNER_DELAYS.scaled_jump_delay: delay (µs) of a jump of the given length (mm). */
export function jumpDelayUs(t, length) {
  if (!(length > 1e-6)) return 0;
  if (!(t.jumpLimit > 0) || !(t.minJumpDelay >= 0) || !(t.minJumpDelay < t.jumpDelay) || length >= t.jumpLimit) {
    return t.jumpDelay;
  }
  return t.minJumpDelay + (t.jumpDelay - t.minJumpDelay) * (length / t.jumpLimit);
}

/** Seconds for the whole build, split into its parts. The jumps between the paths count with the full delay. */
export function buildTime(t) {
  const p = PLATE;
  const per = {
    mark: p.hatchLen / p.hatchSpeed + p.borderLen / p.borderSpeed,
    markDelay: MARK_DELAYS * t.markDelay * 1e-6,
    jump: (SKIPS * p.hd) / t.jumpSpeed,
    jumpDelay: (SKIPS * jumpDelayUs(t, p.hd) + (PATHS - 1) * t.jumpDelay) * 1e-6,
  };
  return Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v * p.layers]));
}

/** Milliseconds of one hatch vector cycle (POWER_MODEL.reference_time_ms). */
export function vectorCycle(t, length) {
  return { mark: (length / PLATE.hatchSpeed) * 1000, markDelay: t.markDelay / 1000,
    jump: (PLATE.hd / t.jumpSpeed) * 1000, jumpDelay: jumpDelayUs(t, PLATE.hd) / 1000 };
}

const hms = (s) => {
  const r = Math.round(s);
  return `${Math.floor(r / 3600)}:${String(Math.floor((r % 3600) / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}`;
};
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const NAMES = { mark: "marking", markDelay: "mark delays", jump: "jumps", jumpDelay: "jump delays" };
const scaling = (t) => t.jumpLimit > 0 && t.minJumpDelay < t.jumpDelay;

function bar(ctx, x, y, w, h, parts, total) {
  let px = x;
  for (const [k, v] of Object.entries(parts)) {
    const pw = (v / total) * w;
    ctx.fillStyle = C[k];
    ctx.fillRect(px, y, pw, h);
    px += pw;
  }
  ctx.strokeStyle = COLOR.grid;
  ctx.strokeRect(x, y, w, h);
}

function createScene(viewerEl) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");

  function drawTime(ctx, w, h) {
    const L = 24, R = w - 24, W = R - L;
    const t = buildTime(s), total = sum(t), marking = t.mark;
    // whole build: almost all of it is marking
    label(ctx, `Whole build: ${hms(total)}`, L, 52, { size: 13, weight: 600 });
    bar(ctx, L, 64, W, 26, t, total);
    // zoom into everything except the marking
    const other = total - marking;
    label(ctx, `Everything except the marking: ${other.toFixed(1)} s`, L, 124, { size: 13, weight: 600 });
    const scale = Math.max(other, 60);
    let x = L;
    for (const k of ["markDelay", "jump", "jumpDelay"]) {
      const pw = (t[k] / scale) * W;
      ctx.fillStyle = C[k];
      ctx.fillRect(x, 136, pw, 26);
      x += pw;
    }
    ctx.strokeStyle = COLOR.grid;
    ctx.strokeRect(L, 136, W, 26);
    label(ctx, `scale: 0 … ${scale.toFixed(0)} s`, R, 176, { size: 11, color: COLOR.muted, align: "right" });
    const hatchDelay = jumpDelayUs(s, PLATE.hd);
    let ly = 200;
    for (const k of ["mark", "markDelay", "jump", "jumpDelay"]) {
      ctx.fillStyle = C[k];
      ctx.fillRect(L, ly - 6, 12, 12);
      const detail = k === "mark" ? "hatch 10 405 mm at 1200 mm/s, border 137 mm at 600 mm/s"
        : k === "markDelay" ? `${PLATE.hatchVectors} hatch vectors + ${PLATE.contours} border × ${s.markDelay} µs`
          : k === "jump" ? `${SKIPS} jumps of 0.1 mm at ${s.jumpSpeed} mm/s`
            : `${SKIPS} × ${+hatchDelay.toFixed(1)} µs + ${PATHS - 1} × ${s.jumpDelay} µs`;
      label(ctx, `${NAMES[k]}: ${t[k] < 100 ? t[k].toFixed(1) + " s" : hms(t[k])} (${detail}) per layer × 100`, L + 20, ly,
        { size: 12 });
      ly += 22;
    }
    label(ctx, `Hatch plate, 100 layers: ${hms(total)}, ${(total / PLATE.layers).toFixed(2)} s per layer`, 12, h - 14,
      { size: 12, weight: 600 });
  }

  function drawVector(ctx, w, h) {
    const L = 24, R = w - 24, W = R - L;
    const c = vectorCycle(s, s.length), total = sum(c);
    const delays = c.markDelay + c.jumpDelay + c.jump;
    label(ctx, `One hatch vector of ${s.length} mm and the way back to the next line: ${total.toFixed(3)} ms`, L, 52,
      { size: 13, weight: 600 });
    bar(ctx, L, 64, W, 30, c, total);
    let ly = 124;
    for (const k of ["mark", "markDelay", "jump", "jumpDelay"]) {
      ctx.fillStyle = C[k];
      ctx.fillRect(L, ly - 6, 12, 12);
      label(ctx, `${NAMES[k] === "jumps" ? "jump" : NAMES[k].replace(/s$/, "")}: ${c[k].toFixed(3)} ms (${((c[k] / total) * 100).toFixed(0)} %)`,
        L + 20, ly, { size: 12 });
      ly += 22;
    }
    // share of the time without laser on, over the vector length
    const gx = L + 30, gy = ly + 20, gw = W - 40, gh = h - gy - 50;
    if (gh > 40) {
      ctx.strokeStyle = COLOR.grid;
      ctx.strokeRect(gx, gy, gw, gh);
      ctx.strokeStyle = COLOR.outline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 100; i++) {
        const len = 0.05 + (i / 100) * 9.95, v = vectorCycle(s, len), share = 1 - v.mark / sum(v);
        const px = gx + (i / 100) * gw, py = gy + gh - share * gh;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      const cx = gx + ((s.length - 0.05) / 9.95) * gw, share = delays / total;
      ctx.fillStyle = COLOR.volume;
      ctx.beginPath(); ctx.arc(cx, gy + gh - share * gh, 5, 0, 2 * Math.PI); ctx.fill();
      label(ctx, "100 %", gx - 4, gy, { size: 10, color: COLOR.muted, align: "right" });
      label(ctx, "0", gx - 4, gy + gh, { size: 10, color: COLOR.muted, align: "right" });
      label(ctx, "share without laser on, over the vector length 0 … 10 mm", gx + gw / 2, gy + gh + 12,
        { size: 11, color: COLOR.muted, align: "center" });
    }
    label(ctx, `Delays and jump: ${((delays / total) * 100).toFixed(0)} % of the cycle`, 12, h - 14, { size: 12, weight: 600 });
  }

  function drawJump(ctx, w, h) {
    const gx = 64, gy = 56, gw = w - gx - 32, gh = h - gy - 84;
    const maxLen = Math.max(2, s.jumpLimit * 2), maxDelay = Math.max(s.jumpDelay, 10) * 1.15;
    const px = (len) => gx + (len / maxLen) * gw, py = (us) => gy + gh - (us / maxDelay) * gh;
    label(ctx, "Jump delay over the jump length", gx, 40, { size: 13, weight: 600 });
    ctx.strokeStyle = COLOR.grid;
    ctx.strokeRect(gx, gy, gw, gh);
    ctx.strokeStyle = C.jumpDelay;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= 200; i++) {
      const len = Math.max(2e-6, (i / 200) * maxLen), x = px(len), y = py(jumpDelayUs(s, len));
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    if (scaling(s)) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = COLOR.muted;
      ctx.beginPath(); ctx.moveTo(px(s.jumpLimit), gy); ctx.lineTo(px(s.jumpLimit), gy + gh); ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, `limit ${s.jumpLimit} mm`, px(s.jumpLimit) + 4, gy + 14, { size: 11, color: COLOR.muted });
    }
    // the jump to the next hatch line
    const hd = jumpDelayUs(s, PLATE.hd);
    ctx.fillStyle = C.jump;
    ctx.beginPath(); ctx.arc(px(PLATE.hd), py(hd), 6, 0, 2 * Math.PI); ctx.fill();
    label(ctx, `hatch jump 0.1 mm: ${+hd.toFixed(1)} µs`, px(PLATE.hd) + 10, py(hd) - 10, { size: 12, weight: 600 });
    label(ctx, `${s.jumpDelay} µs`, gx - 6, py(s.jumpDelay), { size: 10, color: COLOR.muted, align: "right" });
    label(ctx, "0", gx - 6, gy + gh, { size: 10, color: COLOR.muted, align: "right" });
    label(ctx, `jump length 0 … ${maxLen} mm`, gx + gw / 2, gy + gh + 16, { size: 11, color: COLOR.muted, align: "center" });
    const saved = SKIPS * (s.jumpDelay - hd) * 1e-6 * PLATE.layers;
    label(ctx, scaling(s)
      ? `Scaling on: the ${SKIPS} hatch jumps per layer save ${saved.toFixed(1)} s on the hatch plate`
      : "Scaling off (jump length limit 0): every jump waits the full jump delay", 12, h - 14, { size: 12, weight: 600 });
  }

  const DRAW = { time: drawTime, vector: drawVector, jump: drawJump };
  const canvas = createCanvas(viewerEl, (ctx, w, h) => (DRAW[s.mode] || drawTime)(ctx, w, h));
  function set(patch) {
    Object.assign(s, patch);
    const what = s.mode === "vector" ? "One hatch vector, 1200 mm/s" : s.mode === "jump" ? "One jump" : "Hatch plate, 100 layers";
    if (tag) tag.textContent = `${what} · jump ${s.jumpSpeed} mm/s · mark delay ${s.markDelay} µs · jump delay ${s.jumpDelay} µs`
      + (scaling(s) ? ` (min ${s.minJumpDelay} µs below ${s.jumpLimit} mm)` : "");
    canvas.redraw();
  }
  set({});
  return { set };
}

// ------------------------------------------------------------------ "Try it" panel

export function mount(root) {
  const scene = createScene(root.querySelector(".viewer"));
  let mode = "time";
  const ranges = bindRanges(root, {
    jumpspeed: (v) => `${v} mm/s`,
    markdelay: (v) => `${v} µs`,
    jumpdelay: (v) => `${v} µs`,
    minjumpdelay: (v) => `${v} µs`,
    jumplimit: (v) => (v > 0 ? `${v} mm` : "0 (off)"),
    length: (v) => `${v} mm`,
  }, () => apply());
  function apply() {
    const v = ranges.values();
    scene.set({ mode, jumpSpeed: v.jumpspeed, markDelay: v.markdelay, jumpDelay: v.jumpdelay,
      minJumpDelay: v.minjumpdelay, jumpLimit: v.jumplimit, length: v.length });
  }
  root.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    root.querySelectorAll(".modes button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    root.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
    apply();
  }));
  apply();
}

export async function mountCode(walkRoot, recipesRoot, codeUrl) {
  const scene = createScene(walkRoot.querySelector(".viewer"));
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

// Interactive explainer of the Scanning group (laser settings per BSID).
//   Build time     simplified version of EXPOSURE_TIME.estimate_layer_time_ms for the hatch plate (100 layers):
//                  marking (length / speed) + mark and jump delays + jumps; the two ATU estimates are drawn as dots
//   Energy         volume energy density P / (v · h · t) of the volume hatch
//   Vector types   default power, speed and line energy P / v of every vector type (main/vector_types.js)
import { COLOR, createCanvas, label, mountWalk, bindRanges } from "./plane.js";

// Defaults of main/vector_types.js: key, bsid, power W, speed mm/s, scan order, colour.
export const VECTOR_TYPES = [
  ["First border", 100, 150, 600, 80, [220, 50, 80]],
  ["First border (downskin)", 101, 100, 900, 81, [240, 120, 60]],
  ["Blocked path", 110, 150, 600, 85, [200, 0, 200]],
  ["Following border", 200, 180, 800, 70, [220, 20, 40]],
  ["Following border (downskin)", 201, 100, 900, 71, [240, 150, 90]],
  ["Fill contour", 300, 200, 1000, 60, [255, 140, 0]],
  ["Fill contour (downskin)", 301, 110, 1000, 61, [255, 190, 100]],
  ["Volume hatch", 500, 280, 1200, 40, [25, 250, 45]],
  ["Downskin hatch", 501, 120, 1000, 30, [0, 120, 255]],
  ["Core hatch", 510, 350, 1300, 45, [0, 170, 70]],
  ["Upskin hatch", 520, 220, 900, 50, [255, 230, 0]],
  ["Open part path", 600, 150, 600, 90, [150, 0, 0]],
  ["Wall support", 700, 180, 1000, 10, [128, 128, 128]],
  ["Solid support", 710, 200, 1200, 20, [90, 90, 90]],
];

// Hatch plate: 40 x 28 mm with round corners, 3 mm high, 30 µm layers -> 100 layers.
// Layer 50 in ATU: 471 hatch vectors in 3 blocks and one border. Mark delays: one per hatch vector, one per contour;
// jump delays: one per jump inside a block and one between the 4 paths (EXPOSURE_TIME.add_path_time).
const PLATE = {
  layers: 100, hatchLen: 10404.8, borderLen: 137.4, markDelays: 472, hatchJumps: 468, jumpDelays: 471,
  hd: 0.1, t: 0.03, borderSpeed: 600,
  jumpSpeed: 7000, markDelayUs: 10, jumpDelayUs: 50,               // Laser timing defaults (platform)
};
// Estimates of the video, recorded with the previous version of the buildstyle (Build Style Log).
export const ATU_ESTIMATES = [[1200, 14 * 60 + 54], [1600, 11 * 60 + 18]];
const DEFAULTS = { mode: "time", speed: 1200, power: 280 };

/** Seconds for the whole build, split into marking of the hatch, marking of the border and delays + jumps. */
export function buildTime(speed) {
  const p = PLATE;
  const hatch = p.hatchLen / speed;
  const border = p.borderLen / p.borderSpeed;
  const other = (p.markDelays * p.markDelayUs + p.jumpDelays * p.jumpDelayUs) * 1e-6 + (p.hatchJumps * p.hd) / p.jumpSpeed;
  return { hatch: hatch * p.layers, border: border * p.layers, other: other * p.layers };
}
const hms = (s) => {
  const r = Math.round(s);
  return `${Math.floor(r / 3600)}:${String(Math.floor((r % 3600) / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}`;
};
const energy = (power, speed) => power / (speed * PLATE.hd * PLATE.t);

function createScene(viewerEl) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");

  function drawTime(ctx, w, h) {
    const L = 64, R = w - 24, T = 40, B = h - 96;
    const vMin = 400, vMax = 3000, tMax = 45 * 60;
    const X = (v) => L + ((v - vMin) / (vMax - vMin)) * (R - L), Y = (sec) => B - (sec / tMax) * (B - T);
    ctx.strokeStyle = COLOR.grid;
    ctx.fillStyle = COLOR.muted;
    for (let m = 0; m <= 45; m += 15) {
      ctx.beginPath(); ctx.moveTo(L, Y(m * 60)); ctx.lineTo(R, Y(m * 60)); ctx.stroke();
      label(ctx, `${m} min`, L - 6, Y(m * 60), { size: 11, color: COLOR.muted, align: "right" });
    }
    for (let v = 500; v <= 3000; v += 500) label(ctx, String(v), X(v), B + 12, { size: 11, color: COLOR.muted, align: "center" });
    label(ctx, "volume hatch speed (mm/s)", (L + R) / 2, B + 28, { size: 11, color: COLOR.muted, align: "center" });
    // model curve
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let v = vMin; v <= vMax; v += 20) {
      const t = buildTime(v), sum = t.hatch + t.border + t.other;
      if (v === vMin) ctx.moveTo(X(v), Y(sum)); else ctx.lineTo(X(v), Y(sum));
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    // ATU estimates
    for (const [v, sec] of ATU_ESTIMATES) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#0696d7";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(v), Y(sec), 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1;
      label(ctx, `video ${hms(sec)}`, X(v) + 9, Y(sec) - 12, { size: 11, color: "#0670a3", weight: 600 });
    }
    // current point
    const t = buildTime(s.speed), sum = t.hatch + t.border + t.other;
    ctx.fillStyle = COLOR.volume;
    ctx.beginPath(); ctx.arc(X(s.speed), Y(sum), 5, 0, 2 * Math.PI); ctx.fill();
    // stacked bar of the parts of the time
    const barY = h - 56, barW = R - L, scale = barW / Math.max(sum, 1);
    const parts = [["hatch marking", t.hatch, COLOR.volume], ["border marking", t.border, COLOR.border], ["delays and jumps", t.other, "#9aa3ad"]];
    let x = L;
    for (const [name, sec, color] of parts) {
      ctx.fillStyle = color;
      ctx.fillRect(x, barY, sec * scale, 14);
      x += sec * scale;
    }
    label(ctx, parts.map(([n, sec]) => `${n} ${hms(sec)}`).join(" · "), L, barY + 26, { size: 11, color: COLOR.muted });
    label(ctx, `${s.speed} mm/s → estimate ${hms(sum)} for 100 layers`, 12, h - 13, { size: 12, weight: 600 });
  }

  function drawEnergy(ctx, w, h) {
    const E = energy(s.power, s.speed), E0 = energy(280, 1200);
    const L = 40, R = w - 40, top = Math.max(80, h * 0.28);
    const max = 160, X = (e) => L + (Math.min(e, max) / max) * (R - L);
    // typical window (illustrative): too little energy -> lack of fusion, too much -> keyholing
    ctx.fillStyle = "rgba(220, 50, 80, .10)";
    ctx.fillRect(L, top, X(40) - L, 46);
    ctx.fillRect(X(110), top, R - X(110), 46);
    ctx.fillStyle = "rgba(25, 196, 45, .12)";
    ctx.fillRect(X(40), top, X(110) - X(40), 46);
    label(ctx, "too little: unmelted powder, pores", L + 6, top + 60, { size: 11, color: COLOR.muted });
    label(ctx, "too much: keyhole pores, spatter", R - 6, top + 60, { size: 11, color: COLOR.muted, align: "right" });
    for (let e = 0; e <= max; e += 40) label(ctx, `${e}`, X(e), top - 10, { size: 11, color: COLOR.muted, align: "center" });
    label(ctx, "J/mm³", R, top - 26, { size: 11, color: COLOR.muted, align: "right" });
    label(ctx, "window for illustration only: it depends on material and machine", (L + R) / 2, top + 140,
      { size: 11, color: COLOR.muted, align: "center" });
    const mark = (e, color, text, dy) => {
      ctx.fillStyle = color;
      ctx.fillRect(X(e) - 2, top - 2, 4, 50);
      label(ctx, text, X(e), top + 82 + dy, { size: 12, weight: 600, color, align: "center" });
    };
    mark(E0, "#0670a3", `default ${E0.toFixed(1)}`, 0);
    mark(E, "#127a20", `now ${E.toFixed(1)}`, 20);
    const keep = (E0 * s.speed * PLATE.hd * PLATE.t);
    label(ctx, `E = P / (v · h · t) = ${s.power} W / (${s.speed} mm/s · 0.1 mm · 0.03 mm)`, 12, h - 48, { size: 12 });
    label(ctx, `Same energy as the default at ${s.speed} mm/s needs ${keep.toFixed(0)} W`, 12, h - 13, { size: 12, weight: 600 });
  }

  function drawTypes(ctx, w, h) {
    const rows = VECTOR_TYPES.length, top = 14, rowH = (h - 40 - top) / rows;
    const L = Math.min(210, w * 0.36), R = w - 70;
    const max = 0.3;
    for (let i = 0; i < rows; i++) {
      const [name, bsid, P, v, order, rgb] = VECTOR_TYPES[i];
      const y = top + i * rowH;
      const e = P / v;
      label(ctx, `${name} (${bsid})`, L - 8, y + rowH / 2, { size: 11, align: "right" });
      ctx.fillStyle = `rgb(${rgb.join(",")})`;
      ctx.fillRect(L, y + 3, ((R - L) * e) / max, rowH - 6);
      label(ctx, `${P} W · ${v} mm/s`, L + ((R - L) * e) / max + 6, y + rowH / 2, { size: 11, color: COLOR.muted });
    }
    label(ctx, "Line energy P / v (J/mm) of the defaults: the downskin types get the least energy per mm", 12, h - 13,
      { size: 12, weight: 600 });
  }

  const canvas = createCanvas(viewerEl, (ctx, w, h) => {
    if (s.mode === "energy") drawEnergy(ctx, w, h);
    else if (s.mode === "types") drawTypes(ctx, w, h);
    else drawTime(ctx, w, h);
  });
  function set(patch) {
    Object.assign(s, patch);
    if (tag) {
      tag.textContent = s.mode === "types" ? "Scanning defaults of all vector types"
        : `Volume hatch (BSID 500) · ${s.power} W · ${s.speed} mm/s`;
      tag.hidden = s.mode === "types";
    }
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
    speed: (v) => `${v} mm/s`,
    power: (v) => `${v} W`,
  }, () => apply());
  function apply() {
    const v = ranges.values();
    scene.set({ mode, speed: v.speed, power: v.power });
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

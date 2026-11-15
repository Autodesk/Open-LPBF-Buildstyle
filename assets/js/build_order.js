// Interactive explainer of build order, scanning order and gas flow (lib/sorting/exposure_sorter.js) on the island
// grid: six 6 x 6 mm islands, each with a volume hatch (BSID 500, scanning order 40) and a first border (BSID 100).
// The paths are sorted with the same key tuples as make_sort_key; downstream_key = -(position along the gas flow),
// in 1 mm buckets. The island ids are the ones ATU gave the islands in the demo.
import { COLOR, createCanvas, frame, label, arrowHead, mountWalk, bindRanges } from "./plane.js";

const DEG = Math.PI / 180;
const ISLANDS = [
  { name: "top right", cx: 23, cy: 13, islid: 0 }, { name: "top left", cx: 3, cy: 13, islid: 1 },
  { name: "top middle", cx: 13, cy: 13, islid: 2 }, { name: "bottom middle", cx: 13, cy: 3, islid: 3 },
  { name: "bottom right", cx: 23, cy: 3, islid: 4 }, { name: "bottom left", cx: 3, cy: 3, islid: 5 },
];
const HATCH_ORDER = 40;
export const BUILD_ORDER_NAMES = { platform: "Platform", model: "Model", island: "Island", global: "Global" };
// separate: every island is its own model (model index = island id); sortModels: compute_model_ranks along the gas
const DEFAULTS = { mode: "platform", border: 80, gas: 0, progress: 100, separate: false, sortModels: true };

/** Rank of every island's model like compute_model_ranks (all 0 for one model). */
function modelRanks(s, dx, dy) {
  if (!s.separate) return ISLANDS.map(() => 0);
  if (!s.sortModels) return ISLANDS.map((isl) => isl.islid);
  const byIndex = ISLANDS.map((isl, i) => ({ i, index: isl.islid, key: -(isl.cx * dx + isl.cy * dy) }))
    .sort((a, b) => a.key - b.key || a.index - b.index);
  const ranks = [];
  byIndex.forEach((e, k) => { ranks[e.i] = k; });
  return ranks;
}

/** Paths of the layer in exposure order: [{island, kind: 'hatch' | 'border'}]. */
export function exposureOrder(s) {
  const dx = Math.cos(s.gas * DEG), dy = Math.sin(s.gas * DEG);
  const ranks = modelRanks(s, dx, dy);
  const items = [];
  ISLANDS.forEach((isl, i) => {
    const bucket = Math.floor(-(isl.cx * dx + isl.cy * dy) / 1.0);
    const cross = isl.cx * -dy + isl.cy * dx;          // GAS_FLOW.cross_key, used by 'global'
    for (const kind of ["hatch", "border"]) {
      const order = kind === "hatch" ? HATCH_ORDER : s.border;
      const orig = items.length;
      const rank = ranks[i];
      // no supports: support_rank 1 (part); one hatch block per island, so 'global' places it like its island
      const key = s.mode === "island" ? [rank, 1, bucket, isl.islid, order, orig]
        : s.mode === "model" ? [rank, order, bucket, isl.islid, orig]
          : s.mode === "global" ? [order, bucket, cross, orig]
            : s.sortModels ? [order, bucket, rank, isl.islid, orig] : [order, rank, bucket, isl.islid, orig];
      items.push({ island: i, kind, key });
    }
  });
  items.sort((a, b) => { for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k]; return 0; });
  return items;
}

const VIRIDIS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
function viridis(t) {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x)), f = x - i;
  return `rgb(${VIRIDIS[i].map((v, k) => Math.round(v + f * (VIRIDIS[i + 1][k] - v))).join(",")})`;
}

function createScene(viewerEl) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");

  function draw(ctx, w, h) {
    const list = exposureOrder(s);
    const shown = (list.length * s.progress) / 100;
    const f = frame([0, 0, w, h - 40], [-2, -2, 30, 18], 16);
    const rank = new Map(list.map((it, k) => [`${it.island}:${it.kind}`, k]));
    ISLANDS.forEach((isl, i) => {
      const x0 = f.x(isl.cx - 3), y0 = f.y(isl.cy + 3), sz = 6 * f.s;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(x0, y0, sz, sz);
      const kh = rank.get(`${i}:hatch`), kb = rank.get(`${i}:border`);
      const part = (k) => Math.min(1, Math.max(0, shown - k));       // 0 = not yet, 1 = done
      // hatch: diagonal lines, drawn up to the exposed share
      const ph = part(kh);
      if (ph > 0) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, sz, sz); ctx.clip();
        ctx.strokeStyle = viridis(kh / (list.length - 1)); ctx.lineWidth = 1.3;
        const n = 14;
        for (let j = 0; j < Math.ceil(n * 2 * ph); j++) {
          const t = (j / n) * sz;
          ctx.beginPath(); ctx.moveTo(x0 + t, y0); ctx.lineTo(x0 + t - sz, y0 + sz); ctx.stroke();
        }
        ctx.restore();
      }
      // border: along the outline, drawn up to the exposed share
      ctx.strokeStyle = "rgba(60, 68, 77, .25)"; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, sz, sz);
      const pb = part(kb);
      if (pb > 0) {
        ctx.strokeStyle = viridis(kb / (list.length - 1)); ctx.lineWidth = 3.5;
        const pts = [[x0, y0 + sz], [x0 + sz, y0 + sz], [x0 + sz, y0], [x0, y0], [x0, y0 + sz]];
        let left = pb * 4;
        ctx.beginPath(); ctx.moveTo(...pts[0]);
        for (let e = 0; e < 4 && left > 0; e++, left--) {
          const r = Math.min(1, left);
          ctx.lineTo(pts[e][0] + (pts[e + 1][0] - pts[e][0]) * r, pts[e][1] + (pts[e + 1][1] - pts[e][1]) * r);
        }
        ctx.stroke(); ctx.lineWidth = 1;
      }
      label(ctx, `hatch ${kh + 1} · border ${kb + 1}`, x0 + sz / 2, y0 + sz + 11, { size: 11, color: COLOR.muted, align: "center" });
    });
    // gas flow arrow at the left side
    const a = -s.gas * DEG, gx = f.x(-1) + 6, gy = f.y(8), len = 40;
    ctx.strokeStyle = "#0696d7"; ctx.fillStyle = "#0696d7"; ctx.lineWidth = 2;
    const sx = gx - Math.cos(a) * len / 2, sy = gy - Math.sin(a) * len / 2, ex = gx + Math.cos(a) * len / 2, ey = gy + Math.sin(a) * len / 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke(); arrowHead(ctx, ex, ey, a, 9);
    ctx.lineWidth = 1;
    label(ctx, "gas", gx, gy + 30, { size: 11, color: "#0670a3", align: "center" });
    const first = list[0];
    let text;
    if (s.separate && (s.mode === "model" || s.mode === "island")) {
      text = `${BUILD_ORDER_NAMES[s.mode]}: part by part, the ${ISLANDS[first.island].name} part first `
        + (s.sortModels ? "(furthest downstream)" : "(the order the parts were added)");
    } else if (s.mode === "island") {
      text = `${BUILD_ORDER_NAMES[s.mode]}: the ${ISLANDS[first.island].name} island first, `
        + (s.border < HATCH_ORDER ? "border before hatch" : "hatch before border");
    } else {
      text = `${BUILD_ORDER_NAMES[s.mode]}: all ${s.border < HATCH_ORDER ? "borders" : "hatches"} first, starting ${ISLANDS[first.island].name}`;
    }
    label(ctx, text, 12, h - 14, { size: 12, weight: 600 });
  }

  const canvas = createCanvas(viewerEl, draw);
  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = `${s.separate ? "Six parts" : "Island grid"} · ${BUILD_ORDER_NAMES[s.mode]} · first border ${s.border} · gas ${s.gas}°`
      + (s.separate ? ` · sort models ${s.sortModels ? "on" : "off"}` : "");
    canvas.redraw();
  }
  set({});
  return { set };
}

// ------------------------------------------------------------------ "Try it" panel

export function mount(root) {
  const scene = createScene(root.querySelector(".viewer"));
  const select = root.querySelector("#buildorder");
  const play = root.querySelector("#play");
  let anim = 0;
  const ranges = bindRanges(root, {
    border: (v) => `${v}`,
    gas: (v) => `${v}°`,
    progress: (v) => `${v} %`,
  }, (id) => { if (id === "progress") cancelAnimationFrame(anim); apply(); });
  const separate = root.querySelector("#separate"), sortModels = root.querySelector("#sortmodels");
  function apply() {
    const v = ranges.values();
    scene.set({ mode: select.value in BUILD_ORDER_NAMES ? select.value : "platform", border: v.border, gas: v.gas,
      progress: v.progress, separate: separate.checked, sortModels: sortModels.checked });
  }
  [select, separate, sortModels].forEach((el) => el.addEventListener("change", apply));
  play.addEventListener("click", () => {
    cancelAnimationFrame(anim);
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(100, Math.round(((t - t0) / 4000) * 100));
      ranges.setValue("progress", p);
      apply();
      if (p < 100) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  });
  apply();
}

export async function mountCode(walkRoot, recipesRoot, codeUrl) {
  const scene = createScene(walkRoot.querySelector(".viewer"));
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

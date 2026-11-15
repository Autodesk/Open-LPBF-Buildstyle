// Interactive explainer of the wall supports (open support polylines, BSID 700).
//   Top view    one layer of the 13 support walls under the support table: a single scan line per wall, or nothing
//               on a skipped layer (LAYER_SKIP.is_active)
//   Layer skip  side view of one wall over twelve layers: which layers are exposed for every_nth / offset
//   Clean-up    the three steps of make_wall_support_hatch on a wall that arrives in five pieces
import { COLOR, createCanvas, frame, label, arrowHead, mountWalk, bindRanges } from "./plane.js";

export const WALL = "#808080";
export const RAW = "#ff8c00";
const T = 0.03;
const DEFAULTS = { mode: "top", z: 2.01, nth: 1, offset: 0, stage: 0 };

/** Same rule as lib/util/layer_skip.js is_active. */
export function isActive(index, nth, offset) {
  if (!(nth > 1)) return true;
  if (index < 0) return true;
  let r = (index - offset) % nth;
  if (r < 0) r += nth;
  return r === 0;
}
const layerIndex = (z) => Math.round(z / T) - 1;   // the first layer of the walls is z = 0.03 mm, index 0

// Pieces of the clean-up example: [x_start, x_end] along one wall (y = 0), in arrival order.
const PIECES = [[6.0, 4.2], [4.2, 3.0], [3.0, 1.0], [6.3, 9.0], [11.0, 9.4]];
function blocksAt(stage) {
  if (stage === 0) return PIECES.map((p) => ({ parts: [p], pts: 2 }));
  // 1: connect end points closer than 0.001 mm and drop the points on a straight line
  const connected = [{ parts: [[6.0, 1.0]], pts: 2 }, { parts: [PIECES[3]], pts: 2 }, { parts: [PIECES[4]], pts: 2 }];
  if (stage === 1) return connected;
  // 2: merge collinear lines across gaps up to 4 mm, flipping lines that point the other way
  const merged = [{ parts: [[11.0, 9.4], [9.0, 6.3], [6.0, 1.0]], pts: 6 }];
  if (stage === 2) return merged;
  // 3: sort for short jumps starting at (0, 0): the block is flipped to start at its end nearest the origin
  return [{ parts: [[1.0, 6.0], [6.3, 9.0], [9.4, 11.0]], pts: 6 }];
}
const STAGE_TEXT = [
  "As sliced: 5 separate pieces, 5 laser on/off switches and jumps in between",
  "connectHatchBlocks: touching pieces become one line (3 blocks)",
  "mergeCollinearLines: collinear lines up to 4 mm apart form one block, flipped to one direction",
  "sortHatchBlocksForMinJumpLength: the block starts at the end nearest (0, 0)",
];

function createScene(viewerEl, table, walls) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");

  function drawTop(ctx, w, h) {
    const f = frame([0, 0, w, h - 26], [-0.6, -0.6, 16.6, 10.6], 14);
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(0, 0, w, h - 26);
    ctx.strokeStyle = COLOR.grid;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(f.x(0), f.y(10), 16 * f.s, 10 * f.s);
    ctx.setLineDash([]);
    label(ctx, "dashed: support table above (z = 4 mm)", f.x(16), f.y(0) + 9, { size: 11, color: COLOR.muted, align: "right" });
    const idx = layerIndex(s.z);
    const on = isActive(idx, s.nth, s.offset);
    for (const [[x1, y1], [x2, y2]] of walls.walls) {
      // the sliced wall line (input geometry), drawn under the exposure
      ctx.strokeStyle = RAW;
      ctx.lineWidth = 1;
      ctx.setLineDash(on ? [] : [4, 3]);
      ctx.beginPath();
      ctx.moveTo(f.x(x1), f.y(y1));
      ctx.lineTo(f.x(x2), f.y(y2));
      ctx.stroke();
      ctx.setLineDash([]);
      if (on) {
        ctx.strokeStyle = WALL;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(f.x(x1), f.y(y1));
        ctx.lineTo(f.x(x2), f.y(y2));
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
    const len = walls.walls.reduce((a, [[x1, y1], [x2, y2]]) => a + Math.hypot(x2 - x1, y2 - y1), 0);
    label(ctx, on ? `z = ${s.z.toFixed(2)} mm (layer index ${idx}): 13 scan lines, ${len.toFixed(0)} mm, no border, no hatch`
      : `z = ${s.z.toFixed(2)} mm (layer index ${idx}): skipped, only the sliced lines (orange), no exposure`, 12, h - 13,
      { size: 12, weight: 600 });
  }

  function drawSkip(ctx, w, h) {
    const n = 12, first = Math.max(0, layerIndex(s.z) - 5);
    const left = 120, right = w - 40, top = 34, bottom = h - 60;
    const rowH = (bottom - top) / n;
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(0, 0, w, h - 26);
    const cx = (left + right) / 2, ww = Math.min(140, (right - left) / 3);
    for (let k = 0; k < n; k++) {
      const i = first + k;
      const y = bottom - (k + 1) * rowH;
      const on = isActive(i, s.nth, s.offset);
      label(ctx, `layer ${i}`, left - 12, y + rowH / 2, { size: 11, color: COLOR.muted, align: "right" });
      ctx.strokeStyle = "rgba(60, 68, 77, .15)";
      ctx.strokeRect(left, y, right - left, rowH);
      if (on) {
        // one exposure melts this layer and all skipped layers below down to the last exposed one
        let depth = 1;
        while (depth < s.nth && k - depth >= 0 && !isActive(i - depth, s.nth, s.offset)) depth++;
        ctx.fillStyle = "rgba(128, 128, 128, .85)";
        ctx.fillRect(cx - ww / 2, y + 2, ww, depth * rowH - 4);
        label(ctx, depth > 1 ? `exposed, melts ${depth} × 30 µm` : "exposed", cx + ww / 2 + 10, y + rowH / 2, { size: 11 });
      } else {
        ctx.fillStyle = "rgba(128, 128, 128, .18)";
        ctx.fillRect(cx - ww / 2, y + 2, ww, rowH - 4);
        label(ctx, "skipped: not exposed", cx + ww / 2 + 10, y + rowH / 2, { size: 11, color: COLOR.muted });
      }
    }
    label(ctx, `exposed if (layer index − ${s.offset}) % ${s.nth} === 0`, 12, h - 13, { size: 12, weight: 600 });
  }

  function drawCleanup(ctx, w, h) {
    const f = frame([0, 0, w, h - 26], [0, -1.6, 12, 1.6], 24);
    ctx.fillStyle = COLOR.powder;
    ctx.fillRect(0, 0, w, h - 26);
    const blocks = blocksAt(s.stage);
    const y0 = 0;
    // origin marker
    ctx.fillStyle = COLOR.outline;
    ctx.beginPath();
    ctx.arc(f.x(0), f.y(0), 3, 0, 2 * Math.PI);
    ctx.fill();
    label(ctx, "(0, 0)", f.x(0), f.y(0) + 14, { size: 11, color: COLOR.muted, align: "center" });
    const palette = ["#4e79a7", "#e15759", "#59a14f", "#b07aa1", "#f28e2b"];
    blocks.forEach((b, bi) => {
      const color = s.stage >= 2 ? WALL : palette[bi % palette.length];
      b.parts.forEach(([xa, xb], pi) => {
        const yy = y0 + (s.stage === 0 ? (bi % 2 ? 0.25 : -0.25) : 0);
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(f.x(xa), f.y(yy));
        ctx.lineTo(f.x(xb), f.y(yy));
        ctx.stroke();
        ctx.fillStyle = color;
        arrowHead(ctx, f.x(xb), f.y(yy), xb > xa ? 0 : Math.PI, 9);
        if (pi > 0) {
          // laser skips the gap inside the block
          const prev = b.parts[pi - 1][1];
          ctx.strokeStyle = COLOR.muted;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(f.x(prev), f.y(yy) - 10);
          ctx.quadraticCurveTo(f.x((prev + xa) / 2), f.y(yy) - 22, f.x(xa), f.y(yy) - 10);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      });
    });
    ctx.lineWidth = 1;
    label(ctx, `${blocks.length} block${blocks.length === 1 ? "" : "s"} · ${STAGE_TEXT[s.stage]}`, 12, h - 13, { size: 12, weight: 600 });
  }

  const canvas = createCanvas(viewerEl, (ctx, w, h) => {
    if (s.mode === "skip") drawSkip(ctx, w, h);
    else if (s.mode === "cleanup") drawCleanup(ctx, w, h);
    else drawTop(ctx, w, h);
  });
  function set(patch) {
    Object.assign(s, patch);
    if (tag) {
      tag.textContent = s.mode === "cleanup" ? `Step ${s.stage} of 3 · one wall, sketch`
        : `Layer z = ${s.z.toFixed(2)} mm · every ${s.nth === 1 ? "" : s.nth + ". "}layer${s.nth > 1 ? `, offset ${s.offset}` : ""}`;
    }
    canvas.redraw();
  }
  set({});
  return { set };
}

async function load(tableUrl, wallsUrl) {
  return Promise.all([fetch(tableUrl).then((r) => r.json()), fetch(wallsUrl).then((r) => r.json())]);
}

// ------------------------------------------------------------------ "Try it" panel

export async function mount(root, tableUrl, wallsUrl) {
  const [table, walls] = await load(tableUrl, wallsUrl);
  const scene = createScene(root.querySelector(".viewer"), table, walls);
  let mode = "top";
  const ranges = bindRanges(root, {
    z: (v) => `${v.toFixed(2)} mm`,
    nth: (v) => (v === 1 ? "every layer" : `every ${v}.`),
    offset: (v) => String(v),
    stage: (v) => `${v} / 3`,
  }, () => apply());
  function apply() {
    const v = ranges.values();
    if (v.offset >= v.nth) ranges.setValue("offset", Math.max(0, v.nth - 1));
    const u = ranges.values();
    scene.set({ mode, z: u.z, nth: u.nth, offset: u.offset, stage: u.stage });
  }
  root.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    root.querySelectorAll(".modes button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    root.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
    apply();
  }));
  apply();
}

export async function mountCode(walkRoot, recipesRoot, tableUrl, wallsUrl, codeUrl) {
  const [table, walls] = await load(tableUrl, wallsUrl);
  const scene = createScene(walkRoot.querySelector(".viewer"), table, walls);
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

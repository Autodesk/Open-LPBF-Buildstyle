// Interactive explainer of the layer skip (lib/util/layer_skip.js): a side view through a stack of layers with the
// first border (BSID 100) at both walls and the volume hatch (BSID 500) between them. A vector type is exposed on a
// layer if (layer_index - offset) is a multiple of n; layer_index counts from the part's first layer (0-based), so
// ATU's layer number is layer_index + 1 for a part that starts on the platform.
import { COLOR, createCanvas, label, mountWalk, bindRanges } from "./plane.js";

export const LAYERS = 16;
const DEFAULTS = { border: 1, borderOffset: 0, hatch: 1, hatchOffset: 0, first: 97 };

/** Same rule as LAYER_SKIP.is_active, with the offset taken modulo n like READ.read_layer_skip. */
export function isActive(index, n, offset) {
  if (!(n > 1)) return true;
  let r = (index - (offset % n)) % n;
  if (r < 0) r += n;
  return r === 0;
}

function createScene(viewerEl) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");

  function draw(ctx, w, h) {
    const L = 92, R = w - 24, T = 36, B = h - 48;
    const rowH = (B - T) / LAYERS, wall = Math.max(10, (R - L) * 0.06);
    let borders = 0, hatches = 0, empty = [];
    for (let k = 0; k < LAYERS; k++) {
      const nr = s.first + k, index = nr - 1;
      const y = B - (k + 1) * rowH;
      const b = isActive(index, s.border, s.borderOffset), hh = isActive(index, s.hatch, s.hatchOffset);
      borders += b; hatches += hh;
      if (!b && !hh) empty.push(nr);
      ctx.strokeStyle = COLOR.grid;
      ctx.strokeRect(L, y + 1, R - L, rowH - 2);
      if (hh) {
        ctx.fillStyle = "rgba(25, 196, 45, .55)";
        ctx.fillRect(L + wall + 3, y + 2, R - L - 2 * wall - 6, rowH - 4);
      }
      if (b) {
        ctx.fillStyle = COLOR.border;
        ctx.fillRect(L, y + 2, wall, rowH - 4);
        ctx.fillRect(R - wall, y + 2, wall, rowH - 4);
      }
      label(ctx, `layer ${nr}`, L - 8, y + rowH / 2, { size: 11, align: "right",
        color: b && hh ? COLOR.text : COLOR.muted, weight: b && hh ? 600 : 500 });
    }
    label(ctx, "first border", L, T - 14, { size: 11, color: COLOR.border, weight: 600 });
    label(ctx, "volume hatch", (L + R) / 2, T - 14, { size: 11, color: "#127a20", weight: 600, align: "center" });
    label(ctx, "first border", R, T - 14, { size: 11, color: COLOR.border, weight: 600, align: "right" });
    const text = empty.length
      ? `Layer ${empty[0]}${empty.length > 1 ? ` and ${empty.length - 1} more` : ""}: nothing exposed at all`
      : `Border on ${borders} of ${LAYERS} layers, hatch on ${hatches} of ${LAYERS}`;
    label(ctx, text, 12, h - 16, { size: 12, weight: 600, color: empty.length ? COLOR.border : COLOR.text });
  }

  const canvas = createCanvas(viewerEl, draw);
  function set(patch) {
    Object.assign(s, patch);
    if (tag) tag.textContent = `Side view, layers ${s.first}–${s.first + LAYERS - 1} · border every ${s.border}`
      + (s.border > 1 ? `, offset ${s.borderOffset % s.border}` : "")
      + ` · hatch every ${s.hatch}` + (s.hatch > 1 ? `, offset ${s.hatchOffset % s.hatch}` : "");
    canvas.redraw();
  }
  set({});
  return { set };
}

// ------------------------------------------------------------------ "Try it" panel

export function mount(root) {
  const scene = createScene(root.querySelector(".viewer"));
  const ranges = bindRanges(root, {
    border: (v) => `${v}`,
    borderoffset: (v) => `${v}`,
    hatch: (v) => `${v}`,
    hatchoffset: (v) => `${v}`,
  }, () => apply());
  function apply() {
    const v = ranges.values();
    scene.set({ border: v.border, borderOffset: v.borderoffset, hatch: v.hatch, hatchOffset: v.hatchoffset });
  }
  apply();
}

export async function mountCode(walkRoot, recipesRoot, codeUrl) {
  const scene = createScene(walkRoot.querySelector(".viewer"));
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

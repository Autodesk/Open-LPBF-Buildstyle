// Interactive explainer of the export formats: one small layer (a triangular island with four hatch vectors and its
// contour) written the way the three writers of the buildstyle write it.
//   LSR    lib/export/lsr_writer.js: one line per vector, 9 significant digits, start time from the laser timing
//          defaults (jump 7000 mm/s, mark delay 10 µs, jump delay 50 µs).
//   CLI+   lib/export/cli_plus_writer.js: $$PARAM/$$POWER/$$SPEED/$$FOCUS before every record, $$POWERS when the power
//          changes along the record, coordinates with 5 decimals, closed polylines repeat their first point.
//   3MF    lib/export/tp3mf_writer.js: one layer XML, coordinates in µm, one segment per path, power as factor of the
//          profile maximum on every child: 'f' per hatch line or point, with ramps 'f1'/'f2' where touching collinear
//          hatch pieces meet.
// The hatch powers are made up the way the power optimization behaves (shorter vector, less power); segment splitting
// cuts every vector into 1.2 mm pieces whose power rises along the vector.
import { COLOR, createCanvas, frame, label, mountWalk } from "./plane.js";

const Z = 1.5;                       // layer 50 at 30 µm
const TIMING = { jumpSpeed: 7000, markDelay: 10, jumpDelay: 50 };
const HATCH = { bsid: 500, name: "hatch_volume", power: 280, speed: 1200 };
const BORDER = { bsid: 100, name: "border_first", power: 150, speed: 600 };
const MAX_POWER = 280;               // highest power of the power optimization = maximum of every 3MF profile
const PIECE = 1.2;                   // micro vector length with segment splitting (mm)
const TRIANGLE = [[10, 5], [16, 5], [10, 8]];
const HATCH_Y = [5.4, 6.0, 6.6, 7.2];
const DEFAULTS = { mode: "lsr", split: false, ramps: true, perLayer: false, pick: 1 };
const HL = "#e8202a";

// ------------------------------------------------------------------ the layer as PathRecords (toolpath_reader.js)

const roundTo = (v, step) => Number((Math.round(v / step) * step).toPrecision(12));

function hatchRecord(split) {
  const coords = [], edges = [];
  HATCH_Y.forEach((y, i) => {
    const xEnd = 16 - 2 * (y - 5) - 0.2, xStart = 10.2, len = xEnd - xStart;
    const linePower = roundTo(150 + 130 * Math.min(1, len / 5), 0.1);
    const [a, b] = i % 2 ? [xEnd, xStart] : [xStart, xEnd];      // serpentine
    const n = split ? Math.max(1, Math.round(len / PIECE)) : 1;
    for (let j = 0; j < n; j++) {
      const x0 = a + ((b - a) * j) / n, x1 = a + ((b - a) * (j + 1)) / n;
      const p = n === 1 ? linePower : roundTo(150 + ((linePower - 150) * (j + 1)) / n, 0.1);
      coords.push(x0, y, x1, y);
      edges.push({ a: coords.length / 2 - 2, b: coords.length / 2 - 1, power: p, line: i });
    }
  });
  return { ...HATCH, kind: "hatch", coords, edges, variation: edges.some((e) => Math.abs(e.power - HATCH.power) > 0.05) };
}

function borderRecord() {
  const coords = TRIANGLE.flat();
  const edges = TRIANGLE.map((_, i) => ({ a: i, b: (i + 1) % TRIANGLE.length, power: BORDER.power }));
  return { ...BORDER, kind: "closed", coords, edges, variation: false };
}

export function layerRecords(split) {
  return [hatchRecord(split), borderRecord()];     // hatch first, as in the exported power wedge
}

const pt = (rec, i) => [rec.coords[2 * i], rec.coords[2 * i + 1]];
const seg = (rec, e) => [...pt(rec, e.a), ...pt(rec, e.b)];
const dist = (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0);

// ------------------------------------------------------------------ LSR (lsr_writer.js)

const fmt9 = (v) => Number(v.toPrecision(9)).toString();

/** [{text, segs, info}] one entry per line of layer 50. In a single file the clock runs on from layer 1: the layers
 *  before are taken to look like this one. */
export function lsrLines(records, perLayer, timing = TIMING) {
  let out = [];
  let t = 0, pos;
  for (let layer = perLayer ? 50 : 1; layer <= 50; layer++) {
    out = [];
    for (const rec of records) {
      rec.edges.forEach((e, k) => {
        const [x0, y0, x1, y1] = seg(rec, e);
        if (pos) {
          const jump = dist(pos[0], pos[1], x0, y0);
          t += jump / timing.jumpSpeed;
          if (jump > 1e-6) t += timing.jumpDelay * 1e-6;
        }
        const z = fmt9(Z);
        out.push({ text: `${fmt9(e.power)} 0 0 -1 ${fmt9(x0)} ${fmt9(y0)} ${z} ${fmt9(x1)} ${fmt9(y1)} ${z} 0 ${fmt9(rec.speed)} ${fmt9(t)}`,
          segs: [[x0, y0, x1, y1]],
          info: `${rec.kind === "hatch" ? "hatch vector" : "contour edge"}, ${e.power} W, starts at ${t < 1 ? (t * 1000).toFixed(3) + " ms" : t.toFixed(4) + " s"}` });
        t += dist(x0, y0, x1, y1) / rec.speed;
        if (rec.kind === "hatch" || k === rec.edges.length - 1) t += timing.markDelay * 1e-6;
        pos = [x1, y1];
      });
    }
  }
  return perLayer ? out : [{ text: "…  (layers 1 to 49)" }, ...out, { text: "…  (layers 51 to 100)" }];
}

// ------------------------------------------------------------------ CLI+ (cli_plus_writer.js)

const c5 = (v) => v.toFixed(5);

function powersLine(rec) {
  if (!rec.variation) return null;
  const parts = [];
  let last;
  rec.edges.forEach((e, k) => {
    const p = roundTo(e.power, 0.1);
    if (p === last) return;
    parts.push(`${rec.kind === "hatch" ? k : e.a},${p.toFixed(1)}`);
    last = p;
  });
  return `$$POWERS/${parts.join(",")}`;
}

/** [{text, segs?, info?, group}] header and footer lines have no geometry; the lines of one record share a group. */
export function cliLines(records, perLayer) {
  const out = ["$$HEADERSTART", "$$ASCII", "$$UNITS/1.000000", "$$VERSION/200", "$$DATE/081126", "$$LABEL/1,Part 1",
    `$$LAYERS/${perLayer ? 1 : 100}`, "$$HEADEREND", "$$GEOMETRYSTART"].map((text) => ({ text }));
  if (!perLayer) out.push({ text: "…  (layers 1 to 49)" });
  out.push({ text: `$$LAYER/${c5(Z)}` });
  records.forEach((rec, g) => {
    const segs = rec.edges.map((e) => seg(rec, e));
    const info = rec.kind === "hatch"
      ? `hatch record: ${rec.edges.length} vectors, ${rec.variation ? "powers in $$POWERS" : "one power"}`
      : "contour record: closed polyline, first point repeated";
    const lines = [`$$PARAM/bsid,int,${rec.bsid}`, "$$PARAM/laser_index,int,1", `$$POWER/${rec.power.toFixed(3)}`,
      `$$SPEED/${rec.speed.toFixed(3)}`, "$$FOCUS/0.000"];
    const pw = powersLine(rec);
    if (pw) lines.push(pw);
    if (rec.kind === "hatch") {
      lines.push(`$$HATCHES/1,${rec.edges.length},${segs.flat().map(c5).join(",")}`);
    } else {
      const pts = [...rec.coords, rec.coords[0], rec.coords[1]];
      lines.push(`$$POLYLINE/1,1,${pts.length / 2},${pts.map(c5).join(",")}`);
    }
    for (const text of lines) out.push({ text, segs, info, group: g });
  });
  if (!perLayer) out.push({ text: "…  (layers 51 to 100)" });
  out.push({ text: "$$GEOMETRYEND" });
  return out;
}

// ------------------------------------------------------------------ 3MF (tp3mf_writer.js)

const um = (mm) => Math.round(mm * 1000);
const factor = (p) => Number(Math.min(1, Math.max(0, p / MAX_POWER)).toFixed(6));
const num6 = (v) => Number(v.toFixed(6)).toString();

function touching(rec, j, k) {
  const [, , x1, y1] = seg(rec, rec.edges[j]);
  const [x0, y0] = seg(rec, rec.edges[k]);
  return dist(x1, y1, x0, y0) < 1e-6;
}

function collinear(rec, j, k) {
  const [ax0, ay0, ax1, ay1] = seg(rec, rec.edges[j]);
  const [bx0, by0, bx1, by1] = seg(rec, rec.edges[k]);
  const ux = ax1 - ax0, uy = ay1 - ay0, vx = bx1 - bx0, vy = by1 - by0;
  return Math.abs(ux * vy - uy * vx) <= 1e-6 * Math.hypot(ux, uy) * Math.hypot(vx, vy) && ux * vx + uy * vy > 0;
}

/** Power at the start and the end of every hatch line (compute_hatch_ramp_powers): touching collinear pieces meet at
 *  their mean power. Without ramps both are the power of the line. */
function hatchPowers(rec, ramps) {
  const p0 = rec.edges.map((e) => e.power), p1 = rec.edges.map((e) => e.power);
  if (ramps) {
    for (let k = 1; k < rec.edges.length; k++) {
      if (!touching(rec, k - 1, k) || !collinear(rec, k - 1, k)) continue;
      const mean = 0.5 * (rec.edges[k - 1].power + rec.edges[k].power);
      p1[k - 1] = mean;
      p0[k] = mean;
    }
  }
  return { p0, p1 };
}

const factorAttrs = (f1, f2) => (f1 === f2 ? `f="${num6(f1)}"` : `f1="${num6(f1)}" f2="${num6(f2)}"`);
const watts = (f) => (f * MAX_POWER).toFixed(1);

/** Child elements of the one segment of a record (hatch_body / loop_body): {text, segs, info}. */
export function segmentChildren(rec, ramps) {
  if (rec.kind === "hatch") {
    const { p0, p1 } = hatchPowers(rec, ramps);
    return rec.edges.map((e, k) => {
      const [x0, y0, x1, y1] = seg(rec, e);
      const f1 = factor(p0[k]), f2 = factor(p1[k]);
      return { text: `<hatch x1="${um(x0)}" y1="${um(y0)}" x2="${um(x1)}" y2="${um(y1)}" ${factorAttrs(f1, f2)}/>`,
        segs: [[x0, y0, x1, y1]],
        info: `hatch line ${k + 1}: ${f1 === f2 ? `${watts(f1)} W` : `${watts(f1)} → ${watts(f2)} W`}` };
    });
  }
  // A point carries the factor of the line it closes; the first point closes the implied line back from the last.
  const n = rec.edges.length;
  return rec.edges.map((e, j) => {
    const closed = rec.edges[(j + n - 1) % n];
    const [x, y] = pt(rec, e.a);
    return { text: `<point x="${um(x)}" y="${um(y)}" ${factorAttrs(factor(closed.power), factor(closed.power))}/>`,
      segs: [seg(rec, closed)], info: `loop point ${j + 1}: closes a line at ${closed.power.toFixed(1)} W` };
  });
}

/** The layer XML. The writer puts every segment on one line; here its children get a line each for reading. */
export function tp3mfLines(records, ramps) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<layer xmlns="http://schemas.3mf.io/3dmanufacturing/toolpath/2026/03">',
    " <parts>", '  <part id="1" uuid="…"/>', " </parts>", " <profiles>", '  <profile id="1" uuid="…"/>',
    '  <profile id="2" uuid="…"/>', " </profiles>", " <data/>", " <segments>"].map((text) => ({ text }));
  records.forEach((rec, r) => {
    const type = rec.kind === "hatch" ? "hatch" : "loop";
    out.push({ text: `   <segment type="${type}" profileid="${r + 1}" partid="1">`, segs: rec.edges.map((e) => seg(rec, e)),
      info: `${type} segment: ${rec.edges.length} ${type === "hatch" ? "lines" : "points"} (profile ${r === 0 ? HATCH.name : BORDER.name})` });
    for (const c of segmentChildren(rec, ramps)) out.push({ ...c, text: `    ${c.text}` });
    out.push({ text: "   </segment>" });
  });
  out.push({ text: " </segments>" }, { text: "</layer>" });
  return out;
}

// ------------------------------------------------------------------ what a package contains

const COMMON = ["build_job_image.png", "parameters/platform_parameters.json", "parameters/model_001_Part_1.json",
  "export_info.json"];

export function packageEntries(mode, perLayer) {
  if (mode === "3mf") {
    return ["_rels/.rels", "[Content_Types].xml", "Metadata/build_job_image.png", "Toolpath/layer30.xml", "…",
      "Toolpath/layer1500.xml", "…", "Toolpath/layer3000.xml", "3D/3dmodel.model", "3D/_rels/3dmodel.model.rels",
      ...COMMON.slice(1).map((n) => `Metadata/${n}`)];
  }
  const ext = mode === "lsr" ? "lsr" : "cli";
  const layers = [`layers/layer_00001.${ext}`, "…", `layers/layer_00050.${ext}`, "…", `layers/layer_00100.${ext}`];
  return [...(perLayer ? layers : [`toolpath.${ext}`]), ...COMMON];
}

export function entryName(mode, perLayer) {
  if (mode === "3mf") return "Toolpath/layer1500.xml";
  const ext = mode === "lsr" ? "lsr" : "cli";
  return perLayer ? `layers/layer_00050.${ext}` : `toolpath.${ext}`;
}

/** Lines of the current view and the indices of the lines that can be highlighted (one per group). */
export function view(s) {
  const records = layerRecords(s.split);
  const lines = s.mode === "lsr" ? lsrLines(records, s.perLayer) : s.mode === "cli" ? cliLines(records, s.perLayer) : tp3mfLines(records, s.ramps);
  const picks = [];
  lines.forEach((l, i) => {
    if (!l.segs) return;
    if (l.group !== undefined && picks.some((p) => lines[p].group === l.group)) return;
    picks.push(i);
  });
  return { records, lines, picks };
}

// ------------------------------------------------------------------ drawing

function createScene(viewerEl, textRoot) {
  const s = { ...DEFAULTS };
  const tag = viewerEl.querySelector(".layer-tag");
  let current = view(s);

  function selected() {
    const i = current.picks[Math.min(current.picks.length, Math.max(1, s.pick)) - 1];
    const line = current.lines[i];
    const group = line.group === undefined ? [i] : current.lines.flatMap((l, j) => (l.group === line.group ? [j] : []));
    return { index: i, line, group };
  }

  function draw(ctx, w, h) {
    const f = frame([0, 48, w, h - 150], [9.6, 4.6, 16.4, 8.4], 18);
    ctx.fillStyle = COLOR.part;
    ctx.beginPath();
    TRIANGLE.forEach(([x, y], i) => (i ? ctx.lineTo(f.x(x), f.y(y)) : ctx.moveTo(f.x(x), f.y(y))));
    ctx.closePath();
    ctx.fill();
    const [hatch, border] = current.records;
    for (const e of hatch.edges) {
      const [x0, y0, x1, y1] = seg(hatch, e);
      ctx.strokeStyle = COLOR.volume;
      ctx.lineWidth = 1.5 + 3 * ((e.power - 150) / 130);
      ctx.beginPath(); ctx.moveTo(f.x(x0), f.y(y0)); ctx.lineTo(f.x(x1), f.y(y1)); ctx.stroke();
      if (s.split) { ctx.fillStyle = COLOR.outline; ctx.fillRect(f.x(x1) - 1, f.y(y1) - 4, 2, 8); }
    }
    ctx.strokeStyle = COLOR.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    border.edges.forEach((e) => { const [x0, y0, x1, y1] = seg(border, e); ctx.moveTo(f.x(x0), f.y(y0)); ctx.lineTo(f.x(x1), f.y(y1)); });
    ctx.stroke();

    const sel = selected();
    ctx.strokeStyle = HL;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of sel.line.segs) { ctx.moveTo(f.x(x0), f.y(y0)); ctx.lineTo(f.x(x1), f.y(y1)); }
    ctx.stroke();
    ctx.lineCap = "butt";
    const [sx, sy] = sel.line.segs[0];
    ctx.fillStyle = HL;
    ctx.beginPath(); ctx.arc(f.x(sx), f.y(sy), 5, 0, 2 * Math.PI); ctx.fill();
    ctx.lineWidth = 1;

    // the highlighted text under the drawing
    const top = h - 96;
    ctx.fillStyle = "#1e2329";
    ctx.fillRect(12, top, w - 24, 84);
    ctx.font = "12px 'Cascadia Code', Consolas, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const maxChars = Math.max(20, Math.floor((w - 48) / 7.2));
    sel.group.slice(0, 4).forEach((j, k) => {
      const t = current.lines[j].text.trim();
      ctx.fillStyle = "#d7dde4";
      ctx.fillText(t.length > maxChars ? t.slice(0, maxChars - 1) + "…" : t, 24, top + 14 + k * 18);
    });
    if (sel.group.length > 4) label(ctx, `+ ${sel.group.length - 4} more lines`, w - 24, top + 70, { size: 11, color: "#9aa3ad", align: "right" });
    label(ctx, sel.line.info, 12, 44, { size: 12, weight: 600 });
  }

  const canvas = createCanvas(viewerEl, draw);

  function renderText() {
    if (!textRoot) return;
    const pre = textRoot.querySelector("pre");
    const file = textRoot.querySelector(".file");
    const lines = textRoot.querySelector(".lines");
    const pkg = textRoot.querySelector(".pkg");
    const sel = selected();
    file.textContent = entryName(s.mode, s.perLayer);
    lines.textContent = `${current.lines.length} lines`;
    pre.replaceChildren(...current.lines.map((l, i) => {
      const span = document.createElement("span");
      span.className = "ln" + (sel.group.includes(i) ? " hl" : "") + (l.segs ? " pick" : "");
      span.dataset.n = String(i + 1);
      span.textContent = l.text;
      if (l.segs) span.addEventListener("click", () => textRoot.dispatchEvent(new CustomEvent("pickline", { detail: i })));
      return span;
    }));
    const hl = pre.querySelector(".ln.hl");
    if (hl) pre.scrollTop = Math.max(0, hl.offsetTop - pre.clientHeight / 3);
    if (pkg) pkg.replaceChildren(...packageEntries(s.mode, s.perLayer).map((n) => {
      const li = document.createElement("li");
      li.textContent = n;
      if (n === entryName(s.mode, s.perLayer)) li.className = "hit current";
      else if (n.startsWith("layers/") || n.startsWith("Toolpath/")) li.className = "hit";
      return li;
    }));
  }

  function set(patch) {
    Object.assign(s, patch);
    current = view(s);
    s.pick = Math.min(Math.max(1, s.pick), current.picks.length);
    const names = { lsr: "LSR", cli: "CLI+", "3mf": "3MF toolpath" };
    if (tag) tag.textContent = `${names[s.mode]} · line ${current.picks[s.pick - 1] + 1} of ${current.lines.length}`
      + (s.split ? " · segment splitting" : "");
    canvas.redraw();
    renderText();
  }
  set({});
  return { set, state: () => s, picks: () => current.picks.length, lineToPick: (i) => {
    const l = current.lines[i];
    return current.picks.findIndex((p) => p === i || (l.group !== undefined && current.lines[p].group === l.group)) + 1;
  } };
}

// ------------------------------------------------------------------ "Try it" panel

export function mount(root) {
  const textRoot = root.querySelector(".export-text");
  const scene = createScene(root.querySelector(".viewer"), textRoot);
  const pick = root.querySelector("#pick"), pickOut = root.querySelector("#pick-out");
  const split = root.querySelector("#split"), perLayer = root.querySelector("#perlayer"), ramps = root.querySelector("#ramps");

  function syncPick() {
    pick.max = String(scene.picks());
    pick.value = String(scene.state().pick);
    pickOut.value = `${scene.state().pick} / ${scene.picks()}`;
  }
  pick.addEventListener("input", () => { scene.set({ pick: Number(pick.value) }); syncPick(); });
  split.addEventListener("change", () => { scene.set({ split: split.checked }); syncPick(); });
  perLayer.addEventListener("change", () => { scene.set({ perLayer: perLayer.checked }); syncPick(); });
  ramps.addEventListener("change", () => { scene.set({ ramps: ramps.checked }); syncPick(); });
  textRoot.addEventListener("pickline", (ev) => { scene.set({ pick: scene.lineToPick(ev.detail) }); syncPick(); });
  root.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
    const mode = b.dataset.mode;
    root.querySelectorAll(".modes button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    root.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
    scene.set({ mode, pick: 1 });
    syncPick();
  }));
  syncPick();
}

export async function mountCode(walkRoot, recipesRoot, codeUrl) {
  const scene = createScene(walkRoot.querySelector(".viewer"), null);
  await mountWalk(walkRoot, recipesRoot, codeUrl, { set: (sc) => scene.set({ ...DEFAULTS, ...sc }) });
}

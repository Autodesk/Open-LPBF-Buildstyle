// Interactive downskin explainer: the overhang bracket (same profile as the STL used in the ATU demo video).
//
// "Surfaces" colours every down-facing face whose angle to the build plate is smaller than the surface angle.
// "Layers" slices the part into (exaggerated) layers and applies the multi-layer rule per layer: an area is
// downskin when one of the reference layers below does not support it. A layer j levels below supports
// the area it covers plus a lateral reach of j * thickness / tan(surface angle) - the overhang that a surface
// at exactly the limit angle would add over j layers.
import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { renderWalkthrough, renderRecipes } from "./code.js";

const COLOR = {
  part: 0x7b838d,
  downskin: 0x0078ff,
  overlap: 0x8cc4ff,
  volume: 0x34c759,
  plate: 0xb9bfc6,
  ghost: 0x59616b,
  border: 0xdc3250,
  borderDs: 0x1b2f6b,
  fill: 0xff8c00,
  fillDs: 0x8a5cf6,
};
const EPS = 1e-6;
const OVERLAP_DISPLAY = 2.5;   // mm, exaggerated like the layers (the real default is 0.1 mm)
const CONTOUR_BAND = 0.8;      // mm per contour band, exaggerated

// ------------------------------------------------------------------ 1D interval sets (sorted, disjoint [a, b])

function merge(iv) {
  const s = iv.filter(([a, b]) => b - a > EPS).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of s) {
    if (out.length && a <= out[out.length - 1][1] + EPS) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
const grow = (iv, d) => merge(iv.map(([a, b]) => [a - d, b + d]));
function intersect(p, q) {
  const out = [];
  for (const [a, b] of p) for (const [c, d] of q) {
    const lo = Math.max(a, c), hi = Math.min(b, d);
    if (hi - lo > EPS) out.push([lo, hi]);
  }
  return merge(out);
}
function subtract(p, q) {
  let cur = p.map((x) => x.slice());
  for (const [c, d] of q) {
    const next = [];
    for (const [a, b] of cur) {
      if (d <= a || c >= b) { next.push([a, b]); continue; }
      if (c > a) next.push([a, c]);
      if (d < b) next.push([d, b]);
    }
    cur = next;
  }
  return merge(cur);
}

// ------------------------------------------------------------------ profile geometry

function edges(profile) {
  return profile.map((a, i) => {
    const b = profile[(i + 1) % profile.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    // Counter-clockwise profile (x right, z up): the outward normal is (dz, -dx) / len.
    const nz = -dx / len;
    const angle = THREE.MathUtils.radToDeg(Math.atan2(Math.abs(dz), Math.abs(dx)));
    const onPlate = Math.max(a[1], b[1]) < EPS;
    return { a, b, nz, angle, down: nz < -EPS && !onPlate };
  });
}

function section(profile, z) {
  const xs = [];
  for (const { a, b } of edges(profile)) {
    const [z0, z1] = [a[1], b[1]];
    if ((z0 <= z && z < z1) || (z1 <= z && z < z0)) xs.push(a[0] + ((z - z0) * (b[0] - a[0])) / (z1 - z0));
  }
  xs.sort((p, q) => p - q);
  const iv = [];
  for (let i = 0; i + 1 < xs.length; i += 2) iv.push([xs[i], xs[i + 1]]);
  return merge(iv);
}

/** 1D morphological opening: drops the intervals narrower than w. */
const opening = (iv, w) => (w > 0 ? iv.filter(([a, b]) => b - a >= w - EPS) : iv);

/** The bands [from, to] mm inside both ends of every interval. */
function endBands(iv, from, to) {
  const out = [];
  for (const [a, b] of iv) {
    const mid = (a + b) / 2;
    out.push([a + from, Math.min(a + to, mid)], [Math.max(b - to, mid), b - from]);
  }
  return merge(out);
}

/**
 * Per display layer: {z0, z1, volume, downskin, overlap, border, borderDs, fill, fillDs} (interval sets along x).
 * o: {angle, refs, overlap (mm), minWidth (mm), contours (bool), splitBorder, splitFill}.
 * With contours a border band and a fill contour band are cut off both ends of the section first; the hatch areas
 * lie inside them. Splitting gives the part of a band inside the downskin its own (downskin) type.
 */
export function sliceLayers(profile, height, thickness, o) {
  const n = Math.ceil(height / thickness - EPS);
  const sections = [];
  for (let i = 0; i < n; i++) sections.push(section(profile, Math.min((i + 0.5) * thickness, height - EPS)));
  const reachPerLayer = thickness / Math.tan(THREE.MathUtils.degToRad(o.angle));
  const band = o.contours ? CONTOUR_BAND : 0;
  return sections.map((s, i) => {
    let supported = [[-1e9, 1e9]];
    for (let j = 1; j <= o.refs && i - j >= 0; j++) supported = intersect(supported, grow(sections[i - j], j * reachPerLayer));
    const ds = opening(subtract(s, supported), o.minWidth);
    const area = band ? subtract(s, endBands(s, 0, 2 * band)) : s;
    const downskin = intersect(ds, area);
    const grown = o.overlap > 0 && ds.length ? subtract(intersect(grow(ds, o.overlap), area), ds) : [];
    const L = {
      z0: i * thickness, z1: Math.min((i + 1) * thickness, height),
      volume: subtract(subtract(area, downskin), grown), downskin, overlap: grown,
      border: [], borderDs: [], fill: [], fillDs: [],
    };
    if (band) {
      const border = endBands(s, 0, band), fill = endBands(s, band, 2 * band);
      L.borderDs = o.splitBorder ? intersect(border, ds) : [];
      L.border = subtract(border, L.borderDs);
      L.fillDs = o.splitFill ? intersect(fill, ds) : [];
      L.fill = subtract(fill, L.fillDs);
    }
    return L;
  });
}

// ------------------------------------------------------------------ meshes

function prismGeometry(profile, depth, faceColor) {
  const pos = [], col = [];
  const c = new THREE.Color();
  const push = (p, color) => { pos.push(...p); c.set(color); col.push(c.r, c.g, c.b); };
  const contour = profile.map(([x, z]) => new THREE.Vector2(x, z));
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    let [p, q, r] = [profile[i], profile[j], profile[k]];
    if ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) < 0) [q, r] = [r, q];
    // front cap (y = 0) faces -Y with the counter-clockwise order, the back cap (y = depth) reversed
    for (const v of [p, q, r]) push([v[0], 0, v[1]], COLOR.part);
    for (const v of [p, r, q]) push([v[0], depth, v[1]], COLOR.part);
  }
  edges(profile).forEach((e, idx) => {
    const color = faceColor(e, idx);
    const a0 = [e.a[0], 0, e.a[1]], b0 = [e.b[0], 0, e.b[1]];
    const aD = [e.a[0], depth, e.a[1]], bD = [e.b[0], depth, e.b[1]];
    for (const v of [a0, bD, b0, a0, aD, bD]) push(v, color);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function boxMesh(x0, x1, y0, y1, z0, z1, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), material);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return m;
}

// ------------------------------------------------------------------ viewer

// overlap: false | true (exaggerated display value) | mm
const DEFAULTS = {
  mode: "surfaces", angle: 45, refs: 3, thick: 1, dimVolume: false, overlap: false, upTo: null,
  minWidth: 0, contours: false, splitBorder: true, splitFill: true,
};

/**
 * Three.js view of the part inside viewerEl (which contains a <canvas>).
 * set(partialState) changes mode / angle / refs / thick / dimVolume / overlap / upTo (layer count, null = all).
 * onLayer(cb) is called with (n, count, layer) whenever the shown layer count changes.
 */
function createViewer(viewerEl, part) {
  const { profile, depth } = part;
  const height = Math.max(...profile.map((p) => p[1]));
  const xMin = Math.min(...profile.map((p) => p[0])), xMax = Math.max(...profile.map((p) => p[0]));
  const center = new THREE.Vector3((xMin + xMax) / 2, depth / 2, height / 2);

  const canvas = viewerEl.querySelector("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 16 / 10, 1, 1000);
  camera.up.set(0, 0, 1);
  // Undersides face down: the surfaces view looks from slightly below the plate, the layers view from above.
  const VIEW = {
    surfaces: center.clone().add(new THREE.Vector3(55, -95, -24)),
    layers: center.clone().add(new THREE.Vector3(-70, -95, 55)),
  };
  camera.position.copy(VIEW.surfaces);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 50;
  controls.maxDistance = 260;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-40, -60, 90);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(60, 40, -30);
  scene.add(fill);

  scene.add(boxMesh(xMin - 6, xMax + 6, -6, depth + 6, -0.8, 0,
    new THREE.MeshStandardMaterial({ color: COLOR.plate, roughness: 0.9, transparent: true, opacity: 0.35,
      depthWrite: false })));

  const partMesh = new THREE.Mesh(new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }));
  scene.add(partMesh);
  const ghost = new THREE.LineSegments(
    new THREE.EdgesGeometry(prismGeometry(profile, depth, () => COLOR.part), 20),
    new THREE.LineBasicMaterial({ color: COLOR.ghost, transparent: true, opacity: 0.45 }));
  scene.add(ghost);
  const layerGroup = new THREE.Group();
  scene.add(layerGroup);
  const mat = {
    volume: new THREE.MeshStandardMaterial({ color: COLOR.volume, roughness: 0.7, transparent: true }),
    downskin: new THREE.MeshStandardMaterial({ color: COLOR.downskin, roughness: 0.5 }),
    overlap: new THREE.MeshStandardMaterial({ color: COLOR.overlap, roughness: 0.5 }),
    border: new THREE.MeshStandardMaterial({ color: COLOR.border, roughness: 0.5 }),
    borderDs: new THREE.MeshStandardMaterial({ color: COLOR.borderDs, roughness: 0.5 }),
    fill: new THREE.MeshStandardMaterial({ color: COLOR.fill, roughness: 0.5 }),
    fillDs: new THREE.MeshStandardMaterial({ color: COLOR.fillDs, roughness: 0.5 }),
  };

  const s = { ...DEFAULTS };
  let layers = [];
  let listeners = [];
  let timer = null;
  let flight = null;

  function flyTo(target, ms = 700) {
    const from = camera.position.clone(), t0 = performance.now();
    flight = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      camera.position.lerpVectors(from, target, k * k * (3 - 2 * k));
      if (k >= 1) flight = null;
    };
  }

  function rebuild() {
    partMesh.geometry.dispose();
    partMesh.geometry = prismGeometry(profile, depth, (e) => (e.down && e.angle < s.angle ? COLOR.downskin : COLOR.part));
    const overlap = s.overlap === true ? OVERLAP_DISPLAY : Number(s.overlap) || 0;
    layers = sliceLayers(profile, height, s.thick, { ...s, overlap });
    layerGroup.children.forEach((m) => m.geometry.dispose());
    layerGroup.clear();
    layers.forEach((L, i) => {
      const gap = Math.min(0.12, (L.z1 - L.z0) * 0.12);
      for (const key of ["volume", "downskin", "overlap", "border", "borderDs", "fill", "fillDs"]) {
        for (const [a, b] of L[key]) {
          const m = boxMesh(a, b, 0, depth, L.z0, L.z1 - gap, mat[key]);
          m.userData.layer = i;
          layerGroup.add(m);
        }
      }
    });
  }

  function showUpTo(n) {
    layerGroup.children.forEach((m) => { m.visible = m.userData.layer < n; });
    listeners.forEach((cb) => cb(n, layers.length, layers[n - 1]));
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function set(patch) {
    const modeChanged = patch.mode !== undefined && patch.mode !== s.mode;
    Object.assign(s, patch);
    stop();
    if (modeChanged) flyTo(VIEW[s.mode]);
    partMesh.visible = s.mode === "surfaces";
    layerGroup.visible = ghost.visible = s.mode === "layers";
    mat.volume.opacity = s.dimVolume ? 0.22 : 1;
    mat.volume.depthWrite = !s.dimVolume;
    rebuild();
    showUpTo(s.upTo === null ? layers.length : Math.min(s.upTo, layers.length));
  }

  /** Build the layers up one by one; onDone is called at the top. */
  function play(onDone) {
    stop();
    let n = 0;
    timer = setInterval(() => {
      n += 1;
      showUpTo(n);
      if (n >= layers.length) { stop(); if (onDone) onDone(); }
    }, Math.max(40, 2400 / layers.length));
  }

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(viewerEl);
  const resize = () => {
    const w = viewerEl.clientWidth, h = viewerEl.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(viewerEl);
  resize();
  renderer.setAnimationLoop(() => {
    if (!visible) return;
    if (flight) flight();
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    set, play, stop, showUpTo,
    state: () => ({ ...s }),
    layerCount: () => layers.length,
    playing: () => timer !== null,
    onLayer: (cb) => listeners.push(cb),
  };
}

function layerText(n, count, L) {
  if (!L) return "";
  const ds = L.downskin.reduce((sum, [a, b]) => sum + b - a, 0);
  return `Layer ${n} of ${count} \u00b7 z ${L.z1.toFixed(2)} mm` + (ds > EPS ? ` \u00b7 downskin ${ds.toFixed(1)} mm wide` : "");
}

// ------------------------------------------------------------------ "Try it" panel

export async function mount(root, partUrl) {
  const part = await (await fetch(partUrl)).json();
  const viewerEl = root.querySelector(".viewer");
  const viewer = createViewer(viewerEl, part);
  const $ = (sel) => root.querySelector(sel);
  const ui = {
    angle: $("#angle"), angleOut: $("#angle-out"),
    refs: $("#refs"), refsOut: $("#refs-out"),
    thick: $("#thick"), thickOut: $("#thick-out"),
    minw: $("#minw"), minwOut: $("#minw-out"),
    overlap: $("#overlap"), overlapOut: $("#overlap-out"),
    contours: $("#contours"), splitBorder: $("#splitborder"), splitFill: $("#splitfill"),
    layer: $("#layer"), layerOut: $("#layer-out"),
    play: $("#play"), tag: viewerEl.querySelector(".layer-tag"),
    verdicts: root.querySelectorAll(".verdicts li"),
    modeButtons: root.querySelectorAll(".modes button"),
    layerRows: root.querySelectorAll("[data-mode-only='layers']"),
  };

  viewer.onLayer((n, count, L) => {
    ui.layer.max = String(count);
    ui.layer.value = String(n);
    ui.layerOut.value = String(n);
    if (ui.tag) ui.tag.textContent = layerText(n, count, L);
  });
  const playLabel = () => { ui.play.textContent = viewer.playing() ? "Pause" : "Build up"; };
  const play = () => {
    if (viewer.playing()) viewer.stop(); else viewer.play(playLabel);
    playLabel();
  };
  const params = () => ({
    angle: Number(ui.angle.value), refs: Number(ui.refs.value), thick: Number(ui.thick.value), upTo: null,
    minWidth: Number(ui.minw.value), overlap: Number(ui.overlap.value),
    contours: ui.contours.checked, splitBorder: ui.splitBorder.checked, splitFill: ui.splitFill.checked,
  });

  function setMode(mode) {
    ui.modeButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    ui.layerRows.forEach((el) => { el.hidden = mode !== "layers"; });
    if (ui.tag) ui.tag.hidden = mode !== "layers";
    viewer.set({ mode, ...params() });
    if (mode === "layers") play(); else playLabel();
  }
  function changed() {
    ui.angleOut.value = `${ui.angle.value}\u00b0`;
    ui.refsOut.value = ui.refs.value;
    ui.thickOut.value = `${Number(ui.thick.value).toFixed(2)} mm`;
    ui.minwOut.value = `${Number(ui.minw.value).toFixed(1)} mm`;
    ui.overlapOut.value = `${Number(ui.overlap.value).toFixed(1)} mm`;
    ui.splitBorder.disabled = ui.splitFill.disabled = !ui.contours.checked;
    ui.verdicts.forEach((li) => li.classList.toggle("on", Number(li.dataset.angle) < Number(ui.angle.value)));
    viewer.set(params());
    playLabel();
  }
  [ui.angle, ui.refs, ui.thick, ui.minw, ui.overlap].forEach((el) => el.addEventListener("input", changed));
  [ui.contours, ui.splitBorder, ui.splitFill].forEach((el) => el.addEventListener("change", changed));
  ui.layer.addEventListener("input", () => { viewer.stop(); viewer.showUpTo(Number(ui.layer.value)); playLabel(); });
  ui.play.addEventListener("click", play);
  ui.modeButtons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  changed();
  setMode("surfaces");
}

// ------------------------------------------------------------------ code walkthrough and recipes

/** The walkthrough's own viewer follows the step in the middle of the window (scene from code.json). */
export async function mountCode(walkRoot, recipesRoot, partUrl, codeUrl) {
  const [part, code] = await Promise.all([fetch(partUrl).then((r) => r.json()), fetch(codeUrl).then((r) => r.json())]);
  const viewerEl = walkRoot.querySelector(".viewer");
  const viewer = createViewer(viewerEl, part);
  const tag = viewerEl.querySelector(".layer-tag");
  viewer.onLayer((n, count, L) => { if (tag) tag.textContent = layerText(n, count, L); });
  const caption = walkRoot.querySelector(".walk-caption");
  renderWalkthrough(walkRoot.querySelector(".walk-steps"), code, (i, step) => {
    const sc = step.scene || {};
    const thick = sc.thick ?? DEFAULTS.thick;
    const upTo = sc.upToZ !== undefined ? Math.round(sc.upToZ / thick) : null;
    viewer.set({ ...DEFAULTS, ...sc, upTo, mode: sc.mode || "surfaces" });
    if (tag) tag.hidden = viewer.state().mode !== "layers";
    if (caption) caption.textContent = `${i + 1} \u00b7 ${step.title}`;
  });
  if (recipesRoot) renderRecipes(recipesRoot, code);
}

/************************************************************
 * MODULE NAME: contours.js
 *
 * PURPOSE:
 *   Create contour (border) vectors from an island and modify
 *   them: direction, start point, line stipple and splitting into
 *   a part inside / outside of another area (e.g. downskin).
 *
 * WORKFLOW:
 *   Called from makeExposureLayer for the first border, the
 *   following borders and the fill contours of every part island.
 *
 * USAGE:
 *   var CONTOURS = require('../exposure/contours.js');
 *   let l_res = CONTOURS.make_contour_hatch(a_island, 0.06);
 *   CONTOURS.apply_direction_and_start(l_res.hatch, { alternate_per_layer: true,
 *     alternate_per_contour: false, layer_index: 3, ring_index: 0,
 *     start_point: { mode: 'random' }, seed: 1234 });
 *
 * DEPENDENCIES:
 *   Builtins: bsHatch
 *   Modules : ../geometry/island_ops.js, ../util/log.js, ../util/random.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *
 * BACKGROUND:
 *   - A contour (border) is a closed laser path that follows the
 *     outline of an island (outer boundary and the boundaries of holes).
 *     The hatch (parallel fill lines) melts the inside; the contours
 *     give the part a clean, dense and accurate side surface.
 *   - Beam compensation / inset: the melt track has a width of roughly
 *     0.1 mm. If the beam center ran exactly on the outline, half of the
 *     track would lie outside and the part would grow. Therefore the
 *     first border is shifted inwards by the beam compensation (about
 *     half the track width). Further borders and fill contours lie
 *     further inside with their own offsets.
 *   - Start point: a closed contour starts and ends at the same point.
 *     There the melt pool is switched on/off, which leaves a small mark.
 *     If this point is at the same place in every layer, the marks stack
 *     up to a visible seam; a random start point spreads them out.
 *   - A bsHatch is a container for exposure vectors (polylines); one
 *     "hatch block" is one polyline plus its attributes.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HATCH = requireBuiltin('bsHatch');
var ISL = require('../geometry/island_ops.js');
var LOG = require('../util/log.js');
var RANDOM = require('../util/random.js');

/**
 * Contour of an island, shifted inwards by a_inset.
 * The inset is always measured from the ORIGINAL island outline (not
 * from the previous contour), see compute_insets in exposure_layer.js.
 * If the island is narrower than 2 * a_inset everywhere, the offset
 * area is empty and no contour is created. Such thin regions are
 * handled by the blocked paths (narrow_paths.js) instead.
 * Tip: The result is returned as { ok, hatch } instead of
 * throwing an exception; this function currently always succeeds, but
 * all exposure helpers use the same result shape.
 * @param {bsIsland} a_island  Island (not modified)
 * @param {number} a_inset     Inset from the island outline in mm (>= 0)
 * @return {{ok:boolean, hatch:bsHatch}} hatch is empty if nothing is left after the inset
 */
exports.make_contour_hatch = function(a_island, a_inset)
{
  let r_hatch = new HATCH.bsHatch();
  let l_isl = ISL.offset(a_island, -a_inset);
  if (l_isl.isEmpty())
  {
    return { ok: true, hatch: r_hatch };
  }
  // borderToHatch: every boundary of the area (outer contour and holes)
  // becomes one closed polyline in the hatch.
  l_isl.borderToHatch(r_hatch);
  return { ok: true, hatch: r_hatch };
};

/**
 * Set the exposure direction and (optionally) a random start point.
 * The direction is flipped if exactly one of the two alternation rules
 * requests it (alternate per layer XOR alternate per contour).
 * The start point modes 'previous' and 'random_previous' need the
 * results of previous layers and are applied later in post-processing.
 * MPBF background: The melt pool and the spatter are not symmetric to
 * the scan direction. Changing the direction from layer to layer (or
 * from ring to ring) avoids that such direction effects add up at the
 * same side of the part in every layer.
 * Example: per layer ON, per contour ON -> ring 0 of layer 1 is flipped
 * (layer odd), ring 1 of layer 1 is NOT flipped (both rules cancel out).
 * @param {bsHatch} a_hatch  Contour hatch (modified)
 * @param {{alternate_per_layer:boolean, alternate_per_contour:boolean,
 *          layer_index:number, ring_index:number,
 *          start_point:{mode:string}, seed:number}} a_opts
 *        layer_index: 0-based layer index of the part,
 *        ring_index : 0-based index of the ring inside its contour type,
 *        start_point.mode: 'off', 'random', 'previous' or 'random_previous',
 *        seed: random seed (same seed -> same start points, reproducible)
 * @return {void}
 */
exports.apply_direction_and_start = function(a_hatch, a_opts)
{
  if (a_hatch.isEmpty()) return;

  // Odd layer / ring indices request a flip (index % 2 === 1).
  let l_flip_layer = (a_opts.alternate_per_layer === true) && ((a_opts.layer_index % 2) === 1);
  let l_flip_contour = (a_opts.alternate_per_contour === true) && ((a_opts.ring_index % 2) === 1);
  if (l_flip_layer !== l_flip_contour)
  {
    // flip(false, true): flip every contour, keep the order of the contours.
    a_hatch.flip(false, true);
  }

  // A missing start_point object is treated like 'off' (keep the start
  // point that the geometry functions produced).
  let l_mode = a_opts.start_point ? a_opts.start_point.mode : 'off';
  if ((l_mode === 'random') || (l_mode === 'random_previous'))
  {
    // 'random_previous' gets a random start here as a first guess; the
    // post-processing may move it again based on the previous layers.
    // The seed is derived from layer, island and ring, so the result is
    // reproducible: recalculating a layer gives the same start points.
    // For closed polygons one of the existing polygon points is chosen.
    a_hatch.setRandomStartPoint(HATCH.nLoopModeFlagClosedPolygon, RANDOM.to_builtin_seed(a_opts.seed));
  }
};

/**
 * Line stipple: the contour is split into dashes that are exposed in
 * several interleaved passes. This reduces local heat accumulation.
 * MPBF background: On a long contour the laser comes back to the same
 * region only after a full round. With stippling, e.g. 2 passes, the
 * laser first exposes every second dash and then fills the gaps. Each
 * dash has time to cool down before its neighbor is melted, which
 * helps thin walls and small features that overheat easily.
 * @param {bsHatch} a_hatch  Contour hatch (not modified)
 * @param {{length:number, overlap:number, count:number, random_start:boolean}} a_stipple
 *        length : dash length in mm,
 *        overlap: extension of each dash in mm so that neighboring dashes
 *                 overlap and no gap stays unmelted (negative = gaps),
 *        count  : number of passes (>= 2),
 *        random_start: true = the dash pattern starts at a random position
 * @param {number} a_seed    Random seed
 * @param {string} [a_start_mode]  Start point mode of the contour (used for a hint only)
 * @return {bsHatch} New hatch with the dashes
 */
exports.apply_stipple = function(a_hatch, a_stipple, a_seed, a_start_mode)
{
  let r_hatch = new HATCH.bsHatch();
  if (a_hatch.isEmpty()) return r_hatch;
  // Last argument: maximum number of segments per result block
  // (0 = no limit).
  a_hatch.lineStippling(r_hatch, a_stipple.length, a_stipple.overlap, a_stipple.count,
    a_stipple.random_start === true, RANDOM.to_builtin_seed(a_seed), 0);

  // Dashes are open paths. The start point history (post-processing)
  // only works on closed contours and has no effect on them.
  // warning_once: the hint is printed only once per script context,
  // not once per contour (that would flood the log).
  if ((a_start_mode === 'previous') || (a_start_mode === 'random_previous'))
  {
    LOG.warning_once('stipple_start',
      'Line stipple creates open paths: the start point mode "previous layers" has no effect on stippled contours.');
  }
  return r_hatch;
};

/**
 * Split a hatch into the part inside and the part outside of an area.
 * The area is enlarged by 2 micrometers before clipping. This avoids
 * tiny clipping artifacts where contour and area are almost congruent.
 * Typical use: the part of a border that lies above the downskin
 * (overhang) gets the downskin vector type (BSID + 1, usually lower
 * power), the rest keeps the normal vector type.
 * MPBF background: Above loose powder the heat cannot flow away into
 * solid metal (powder is a poor heat conductor). With full power the
 * melt pool would become too deep and too large, sink into the powder
 * and create dross and a rough down-facing surface.
 * @param {bsHatch} a_hatch       Hatch (not modified)
 * @param {bsIsland} a_split_isl  Area (not modified)
 * @return {{inside:bsHatch, outside:bsHatch}} New hatches
 */
exports.split_by_island = function(a_hatch, a_split_isl)
{
  // 0.002 mm = 2 micrometers guard distance (see function comment).
  let l_guard = ISL.offset(a_split_isl, 0.002);
  // clip(area, true) keeps the vectors inside the area, clip(area, false)
  // keeps the vectors outside. Both work in place, hence the clones.
  let l_inside = a_hatch.clone();
  l_inside.clip(l_guard, true);
  let l_outside = a_hatch.clone();
  l_outside.clip(l_guard, false);
  return { inside: l_inside, outside: l_outside };
};

/************************************************************
 * MODULE NAME: exposure_layer.js
 *
 * PURPOSE:
 *   Create all exposure vectors of one layer of one model:
 *   contours, blocked paths, hatches (volume, core, downskin,
 *   upskin), solid supports, wall supports and open polylines.
 *
 * WORKFLOW:
 *   Called from makeExposureLayer. Reads NO parameters: all settings
 *   come from the model attributes written in prepareModelExposure.
 *   For every part island (in this order):
 *     1. skin areas (downskin has priority over upskin)
 *     2. contour insets, all measured from the island outline
 *     3. first border (+ blocked paths), following borders,
 *        fill contours
 *     4. hatch areas: downskin, upskin, volume (hull / core)
 *   Then solid support islands and open polylines.
 *   The order in which the vectors are CREATED here is not the order in
 *   which the laser EXPOSES them: post-processing sorts all vectors of
 *   the layer by the scanning order of their BSID (main/postprocess.js).
 *
 * BACKGROUND (terms: see the glossary in main/main.js):
 *   - Every vector gets a BSID. Inside a downskin area contours can get
 *     the downskin BSID (normal BSID + 1), so the machine uses lower
 *     power there; this is called "splitting" below.
 *   - All contour rings are offsets of the island outline: first border
 *     (beam compensation), following borders, fill contours. The hatch
 *     area starts inside the innermost ring (hatch offset).
 *   - The hatch area is divided into downskin, upskin and volume. The
 *     downskin wins where an area is both: loose powder below is the
 *     bigger risk (melt pool sags into the powder), so its lower power
 *     settings are needed there.
 *   - The volume can be divided further into hull and core.
 *   - Layer skip: a vector type can be exposed only every n-th layer.
 *   - Random choices (contour start points, dashes) use seeds made from
 *     layer number, island number and BSID, so a recalculation always
 *     gives exactly the same toolpath.
 *
 * USAGE:
 *   var EXPOSURE_LAYER = require('main/exposure_layer.js');
 *   let l_res = EXPOSURE_LAYER.make_layer({ model_data, model, layer_nr, part, platform, info }, hatchResult);
 *
 * DEPENDENCIES:
 *   Builtins: bsModel, bsPolylineIterator, bsHatch
 *   Modules : main/vector_types.js, main/settings.js, lib/... (geometry,
 *             exposure, util)
 *
 * EXTENSION NOTES:
 *   - New vector type: add it to main/vector_types.js, create the
 *     hatch here and call add_hatch(..., <new bsid>, ...).
 *   - New hatch pattern: lib/exposure/hatch_patterns.js.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var MODEL = requireBuiltin('bsModel');
var POLY_IT = requireBuiltin('bsPolylineIterator');
var HATCH = requireBuiltin('bsHatch');
var VECTOR_TYPES = require('main/vector_types.js');
var SETTINGS = require('main/settings.js');
var ISL = require('lib/geometry/island_ops.js');
var GAS_FLOW = require('lib/geometry/gas_flow.js');
var CONTOURS = require('lib/exposure/contours.js');
var NARROW = require('lib/exposure/narrow_paths.js');
var SKIN = require('lib/exposure/skin_split.js');
var HULL_CORE = require('lib/exposure/hull_core.js');
var PATTERNS = require('lib/exposure/hatch_patterns.js');
var ROTATION = require('lib/exposure/pattern_rotation.js');
var SUPPORTS = require('lib/exposure/supports.js');
var EXPOSURE_ATTRIBUTES = require('lib/exposure/exposure_attributes.js');
var LAYER_SKIP = require('lib/util/layer_skip.js');
var RANDOM = require('lib/util/random.js');
var LOG = require('lib/util/log.js');

// Map vector type key -> BSID, e.g. BSID.hatch_volume === 500.
var BSID = VECTOR_TYPES.BSID;

/**
 * Minimum beam compensation (mm) for blocked paths.
 * Blocked paths fill regions that are narrower than the compensated
 * border. With (almost) no beam compensation the border itself still
 * covers these regions, so no blocked paths are needed (1 micrometer).
 */
var S_MIN_BEAM_COMP_FOR_BLOCKED_PATHS = 0.001;

// -----------------------------------------------------------
// Attributes and result handling
// -----------------------------------------------------------

/**
 * Attribute values of a vector type.
 * The laser settings (power W, speed mm/s, focus mm) come from the scan
 * settings of the BSID, i.e. from the 'Scanning' parameter group.
 * @param {Object} a_ctx     Layer context (see make_layer)
 * @param {number} a_bsid    Vector type id
 * @param {number} a_island_id  1-based island number in this layer, 0 = no island
 * @param {Object|undefined} a_bounds  Island bounds {min_x, min_y, max_x, max_y} in mm,
 *                           undefined for vectors without island (open polylines)
 * @return {Object} Info object for EXPOSURE_ATTRIBUTES.apply
 */
function make_attr_info(a_ctx, a_bsid, a_island_id, a_bounds)
{
  // The scan settings are stored with the BSID as string key, because
  // the settings object must survive a JSON round trip (see settings.js).
  let l_scan = a_ctx.scan_by_bsid[String(a_bsid)];
  // Tip: The UI shows laser numbers starting at 1, the toolpath
  // attribute uses 0-based laser indices.
  return {
    bsid: a_bsid,
    island_id: a_island_id,
    bounds: a_bounds,
    laser_index: l_scan.laser_index - 1,
    power: l_scan.power,
    speed: l_scan.speed,
    focus: l_scan.focus,
    color_int: VECTOR_TYPES.get_display_color_int(a_bsid)
  };
}

/**
 * Set the attributes of a hatch and move it into the layer result.
 * Tip: a bsHatch is a container of vector blocks (contours,
 * hatch lines, open paths). moveDataFrom moves the blocks instead of
 * copying them, which is faster; the source hatch is empty afterwards.
 * @param {Object} a_ctx      Layer context
 * @param {bsHatch} a_result  Layer result (hatchResult)
 * @param {bsHatch} a_hatch   Hatch (emptied afterwards)
 * @param {number} a_bsid     Vector type id written to all blocks
 * @param {number} a_island_id  Island number (0 = no island)
 * @param {Object|undefined} a_bounds  Island bounds in mm or undefined
 * @return {void}
 */
function add_hatch(a_ctx, a_result, a_hatch, a_bsid, a_island_id, a_bounds)
{
  // Nothing to do (e.g. the island was too small for this contour ring).
  if (a_hatch.isEmpty()) return;
  EXPOSURE_ATTRIBUTES.apply(a_hatch, make_attr_info(a_ctx, a_bsid, a_island_id, a_bounds));
  a_result.moveDataFrom(a_hatch);
}

/**
 * Add a hatch, split into the part outside of the downskin (normal
 * vector type) and the part inside (downskin vector type).
 * MPBF background: a contour that runs over an overhang lies above
 * loose powder. With the downskin BSID only that piece of the contour
 * gets the gentler downskin laser settings.
 * @param {Object} a_ctx      Layer context
 * @param {bsHatch} a_result  Layer result (hatchResult)
 * @param {bsHatch} a_hatch   Hatch to add (not used afterwards)
 * @param {boolean} a_split   false: everything gets the normal vector type
 * @param {bsIsland} a_ds     Downskin area
 * @param {number} a_bsid     BSID outside of the downskin
 * @param {number} a_bsid_ds  BSID inside of the downskin
 * @param {number} a_island_id  Island number
 * @param {Object|undefined} a_bounds  Island bounds in mm
 * @return {void}
 */
function add_hatch_split(a_ctx, a_result, a_hatch, a_split, a_ds, a_bsid, a_bsid_ds, a_island_id, a_bounds)
{
  // No splitting requested or no downskin in this island: one vector type.
  if (!a_split || a_ds.isEmpty())
  {
    add_hatch(a_ctx, a_result, a_hatch, a_bsid, a_island_id, a_bounds);
    return;
  }
  let l_parts = CONTOURS.split_by_island(a_hatch, a_ds);
  add_hatch(a_ctx, a_result, l_parts.outside, a_bsid, a_island_id, a_bounds);
  add_hatch(a_ctx, a_result, l_parts.inside, a_bsid_ds, a_island_id, a_bounds);
}

// -----------------------------------------------------------
// Contours
// -----------------------------------------------------------

/**
 * Direction, start point and stipple of one contour ring, then add it.
 * MPBF background:
 * - Direction: alternating the scan direction (per layer and/or per
 *   ring) spreads the heat and avoids that small direction dependent
 *   errors add up on the same side of the part in every layer.
 * - Start point: where a closed contour starts and ends a small seam
 *   remains. Moving the start point avoids that all seams line up into
 *   a visible line on the part surface.
 * - Stipple: the contour is split into dashes that are exposed in
 *   several passes, which reduces local heat accumulation.
 * @param {Object} a_ctx     Layer context
 * @param {bsHatch} a_result Layer result (hatchResult)
 * @param {bsHatch} a_hatch  Contour ring (modified)
 * @param {Object} a_cfg   Contour settings (border_first / border_following / fill_contour)
 * @param {number} a_ring  Ring index (0 = outermost ring of this contour type)
 * @param {number} a_bsid     BSID of this contour type
 * @param {number} a_bsid_ds  Downskin BSID of this contour type
 * @param {Object} a_isl_info { islid, bounds, ds, split }
 * @return {void}
 */
function emit_contour(a_ctx, a_result, a_hatch, a_cfg, a_ring, a_bsid, a_bsid_ds, a_isl_info)
{
  if (a_hatch.isEmpty()) return;
  // The ring index is part of the seed, so every ring gets its own start point.
  // a_bsid * 1000 + a_ring keeps the values of different contour types
  // apart (fewer than 1000 rings per type).
  let l_seed = RANDOM.make_seed(a_ctx.layer_nr, a_isl_info.islid, a_bsid * 1000 + a_ring);
  CONTOURS.apply_direction_and_start(a_hatch, {
    alternate_per_layer: a_cfg.alternate_per_layer === true,
    alternate_per_contour: a_cfg.alternate_per_contour === true,
    layer_index: a_ctx.layer_index,
    ring_index: a_ring,
    start_point: a_cfg.start_point,
    seed: l_seed
  });

  // The stipple creates a NEW hatch of dashes; without stipple the ring
  // itself is used. The direction and random start point above were set
  // first, so the dashes follow them.
  let l_hatch = a_hatch;
  if (a_cfg.stipple && a_cfg.stipple.enabled)
  {
    l_hatch = CONTOURS.apply_stipple(a_hatch, a_cfg.stipple, l_seed, a_cfg.start_point ? a_cfg.start_point.mode : 'off');
  }
  add_hatch_split(a_ctx, a_result, l_hatch, a_isl_info.split, a_isl_info.ds, a_bsid, a_bsid_ds,
    a_isl_info.islid, a_isl_info.bounds);
}

/**
 * Insets of all contour rings, measured from the island outline.
 * Tip: Offsets are always measured from the original island
 * outline, so changing one contour does not move the others unexpectedly.
 * Example (beam compensation 0.06, following borders switched on with
 * count 1 and first offset 0.08, fill contours off, hatch offset 0.05):
 *   first = 0.06, following = [0.14], fill = [], hatch = 0.14 + 0.05 = 0.19 mm.
 * Disabled contour types take no space: the next type starts at the
 * innermost ring so far. The insets are computed even if a contour type
 * is skipped on this layer (layer skip), so the hatch area does not
 * change from layer to layer.
 * The hatch inset is never smaller than the inset of the first border
 * (0 if the first border is off), so the hatch stays inside the part.
 * @param {Object} a_part  PartSettings
 * @return {{first:number, following:number[], fill:number[], hatch:number}}
 *         All values are inward offsets in mm from the island outline.
 */
function compute_insets(a_part)
{
  let r_ins = { first: 0.0, following: [], fill: [], hatch: 0.0 };
  let l_bf = a_part.border_first;
  let l_bo = a_part.border_following;
  let l_fc = a_part.fill_contour;

  // MPBF background: the laser melts a track that is wider than the
  // beam center line. The first border runs half a track width (beam
  // compensation) inside the outline, so the melted edge ends exactly
  // on the outline of the part.
  r_ins.first = l_bf.enabled ? l_bf.beam_comp : 0.0;
  // l_innermost = inset of the innermost ring created so far.
  let l_innermost = r_ins.first;
  if (l_bo.enabled)
  {
    // Ring i (1-based): first_offset from the first border, then one
    // following_offset per additional ring.
    for (let i = 1; i <= l_bo.count; ++i)
    {
      l_innermost = r_ins.first + l_bo.first_offset + (i - 1) * l_bo.following_offset;
      r_ins.following.push(l_innermost);
    }
  }
  // Fill contours continue inside the innermost border.
  if (l_fc.enabled)
  {
    let l_base = l_innermost;
    for (let j = 0; j < l_fc.count; ++j)
    {
      l_innermost = l_base + l_fc.first_offset + j * l_fc.following_offset;
      r_ins.fill.push(l_innermost);
    }
  }
  // The hatch offset may be negative (down to -2 mm): the hatch lines
  // then overlap the contours, which improves the bonding between
  // contour and hatch.
  // The overlap ends at the first border (or at the island outline if
  // the first border is off): a smaller inset would grow the hatch area
  // beyond the part outline, and nothing downstream clips it back.
  // Example: contours off, hatch offset -2.0 -> inset 0 instead of -2.0.
  r_ins.hatch = l_innermost + a_part.hatching.hatch_offset;
  if (r_ins.hatch < r_ins.first)
  {
    LOG.warning_once('hatch_offset_clamped',
      'Negative hatch offset reaches beyond the first border; the hatch area is limited to the first border (or to the part outline).');
    r_ins.hatch = r_ins.first;
  }
  return r_ins;
}

/**
 * First border and blocked paths.
 * The first border is the outermost contour; it defines the surface
 * and the dimensions of the part.
 * @param {Object} a_ctx       Layer context
 * @param {bsIsland} a_island  Part island (not modified)
 * @param {bsHatch} a_result   Layer result (hatchResult)
 * @param {Object} a_insets    Result of compute_insets
 * @param {Object} a_isl_info  { islid, bounds, ds }
 * @return {void}
 */
function process_first_border(a_ctx, a_island, a_result, a_insets, a_isl_info)
{
  let l_bf = a_ctx.part.border_first;
  // Disabled, or this layer is skipped ("expose every n-th layer").
  if (!l_bf.enabled || !LAYER_SKIP.is_active(a_ctx.layer_index, l_bf.layer_skip)) return;
  // Splitting into the downskin BSID requires the overhang detection to
  // be enabled AND the border splitting option.
  let l_split_info = {
    islid: a_isl_info.islid, bounds: a_isl_info.bounds, ds: a_isl_info.ds,
    split: a_ctx.part.overhang.enabled && a_ctx.part.overhang.border_splitting
  };

  let l_res = CONTOURS.make_contour_hatch(a_island, a_insets.first);
  emit_contour(a_ctx, a_result, l_res.hatch, l_bf, 0, BSID.border_first, BSID.border_first_ds, l_split_info);

  // Blocked paths: center lines of regions that are too narrow for the compensated border.
  // Example: a wall of 0.1 mm with a beam compensation of 0.06 mm
  // vanishes when shifted inwards by 0.06 mm, so it would get no border
  // and no hatch. A single line along its center keeps the thin wall.
  // Inside the downskin they get the downskin BSID of the first border
  // (there is no separate downskin BSID for blocked paths).
  if (l_bf.blocked_path.enabled && (l_bf.beam_comp > S_MIN_BEAM_COMP_FOR_BLOCKED_PATHS))
  {
    let l_paths = NARROW.create_blocked_paths(a_island, l_bf.beam_comp, l_bf.blocked_path.min_length);
    add_hatch_split(a_ctx, a_result, l_paths, l_split_info.split, a_isl_info.ds,
      BSID.blocked_path, BSID.border_first_ds, a_isl_info.islid, a_isl_info.bounds);
  }
}

/**
 * Following borders or fill contours (several rings).
 * MPBF background: following borders give a thicker, denser outer wall;
 * fill contours can replace the hatch in thin regions or form a
 * transition between the borders and the hatch.
 * @param {Object} a_ctx       Layer context
 * @param {bsIsland} a_island  Part island (not modified)
 * @param {bsHatch} a_result   Layer result (hatchResult)
 * @param {Object} a_cfg       Contour settings (border_following or fill_contour)
 * @param {number[]} a_insets  Inset in mm of every ring (outer ring first)
 * @param {number} a_bsid      BSID of the rings
 * @param {number} a_bsid_ds   Downskin BSID of the rings
 * @param {boolean} a_split    true: split the rings at the downskin area
 * @param {Object} a_isl_info  { islid, bounds, ds }
 * @return {void}
 */
function process_contour_rings(a_ctx, a_island, a_result, a_cfg, a_insets, a_bsid, a_bsid_ds, a_split, a_isl_info)
{
  if (!a_cfg.enabled || !LAYER_SKIP.is_active(a_ctx.layer_index, a_cfg.layer_skip)) return;
  let l_split_info = { islid: a_isl_info.islid, bounds: a_isl_info.bounds, ds: a_isl_info.ds, split: a_split };
  for (let i = 0; i < a_insets.length; ++i)
  {
    // The ring is empty if the island is too small for this inset;
    // emit_contour then does nothing.
    let l_res = CONTOURS.make_contour_hatch(a_island, a_insets[i]);
    emit_contour(a_ctx, a_result, l_res.hatch, a_cfg, i, a_bsid, a_bsid_ds, l_split_info);
  }
}

// -----------------------------------------------------------
// Hatches
// -----------------------------------------------------------

/**
 * Hatch one area with its HATCH settings.
 * @param {Object} a_ctx        Layer context
 * @param {bsHatch} a_result    Layer result (hatchResult)
 * @param {bsIsland} a_area     Area to fill (not modified)
 * @param {Object} a_hatch_cfg  HATCH object (pattern, hatch distance, rotation, ...)
 * @param {number} a_bsid       Vector type of the hatch lines
 * @param {number} a_islid      Island number
 * @param {Object} a_bounds     Island bounds in mm (for the sorting)
 * @param {boolean} a_is_support  true: hatch gets the model subtype "support"
 * @return {void}
 */
function hatch_area(a_ctx, a_result, a_area, a_hatch_cfg, a_bsid, a_islid, a_bounds, a_is_support)
{
  if (a_area.isEmpty()) return;
  if (!LAYER_SKIP.is_active(a_ctx.layer_index, a_hatch_cfg.layer_skip)) return;

  // Hatch angle of this layer: start angle + layer index * increment
  // (default 67 degrees), optionally kept inside a window, e.g. "never
  // parallel to the gas flow" (lib/exposure/pattern_rotation.js).
  // MPBF background: rotating the lines from layer to layer avoids that
  // hatch lines lie exactly on top of each other. The material gets more
  // uniform and the residual stress (which is highest along the scan
  // direction) is spread over all directions. 67 degrees is a common
  // choice because the same angle repeats only after many layers.
  let l_angle = ROTATION.get_line_angle(a_hatch_cfg.rotation, a_ctx.layer_index, a_ctx.gas_angle, 0.0);
  // gas_dir: the hatch block sorting exposes downstream blocks first.
  // rotation: chess and hexagon patterns compute the angles of their
  // sub-groups (+90 / +60 / +120 degrees) inside the same window.
  // seed and layer_index are passed for patterns with random or layer
  // dependent choices (none of the current patterns uses the seed).
  let l_res = PATTERNS.create_pattern_hatch(a_area, a_hatch_cfg, {
    line_angle: l_angle,
    gas_dir: a_ctx.gas_dir,
    layer_index: a_ctx.layer_index,
    seed: RANDOM.make_seed(a_ctx.layer_nr, a_islid, a_bsid),
    rotation: { rot: a_hatch_cfg.rotation, layer_index: a_ctx.layer_index, gas_angle: a_ctx.gas_angle }
  });
  if (!l_res.ok)
  {
    // One problematic island must not abort the whole layer.
    // This is why create_pattern_hatch returns {ok, message} instead of
    // throwing: the caller decides that a warning is enough here.
    LOG.warning('Layer ' + a_ctx.layer_nr + ', vector type ' + a_bsid + ': ' + l_res.message);
    return;
  }
  // The model subtype tells post-processing and export whether a vector
  // belongs to the part or to a support (e.g. supports first in the
  // 'island' build order).
  if (a_is_support) l_res.hatch.setModelSubtype(MODEL.nSubtypeSupport);
  add_hatch(a_ctx, a_result, l_res.hatch, a_bsid, a_islid, a_bounds);
}

/**
 * Downskin, upskin and volume (hull / core) hatches of a part island.
 * The three areas do not overlap: downskin first, then upskin without
 * the downskin, the rest is volume. So every point is hatched once.
 * @param {Object} a_ctx       Layer context
 * @param {bsIsland} a_island  Part island (not modified)
 * @param {bsHatch} a_result   Layer result (hatchResult)
 * @param {Object} a_insets    Result of compute_insets (uses .hatch)
 * @param {Object} a_isl_info  { islid, bounds, ds (downskin area) }
 * @param {bsIsland} a_us      Upskin area (already without the downskin)
 * @return {void}
 */
function process_part_hatches(a_ctx, a_island, a_result, a_insets, a_isl_info, a_us)
{
  let l_part = a_ctx.part;
  // Area inside the innermost contour ring (plus hatch offset).
  let l_area = ISL.offset(a_island, -a_insets.hatch);
  if (l_area.isEmpty()) return;

  // The skin areas are grown by their 'overlap' (mm) before they are
  // clipped to the hatch area. The skin hatch then reaches a little into
  // the neighboring volume, which bonds both areas and avoids a gap at
  // the border between them.
  let l_ds_area = a_isl_info.ds.isEmpty() ? ISL.empty() :
    ISL.intersect(ISL.offset(a_isl_info.ds, l_part.overhang.overlap), l_area);
  let l_us_area = a_us.isEmpty() ? ISL.empty() :
    ISL.subtract(ISL.intersect(ISL.offset(a_us, l_part.upskin.overlap), l_area), l_ds_area);
  let l_vol_area = ISL.subtract(ISL.subtract(l_area, l_ds_area), l_us_area);

  // Without hull / core the whole volume is "hull" (volume hatch).
  let l_split = { hull: l_vol_area, core: ISL.empty(), core_active: false };
  if (l_part.hull_core.enabled && !l_vol_area.isEmpty())
  {
    l_split = HULL_CORE.split(l_vol_area, SETTINGS.HULL_CORE_PARAM_SET);
  }

  let l_id = a_isl_info.islid;
  let l_b = a_isl_info.bounds;
  hatch_area(a_ctx, a_result, l_split.hull, l_part.hatching.volume, BSID.hatch_volume, l_id, l_b, false);
  // core_active is false on layers where the core is skipped (core
  // every n-th layer): then nothing is exposed in the core area.
  if (l_split.core_active)
  {
    hatch_area(a_ctx, a_result, l_split.core, l_part.hatching.core, BSID.hatch_core, l_id, l_b, false);
  }
  hatch_area(a_ctx, a_result, l_ds_area, l_part.overhang.hatch, BSID.hatch_downskin, l_id, l_b, false);
  hatch_area(a_ctx, a_result, l_us_area, l_part.upskin.hatch, BSID.hatch_upskin, l_id, l_b, false);
}

// -----------------------------------------------------------
// Islands and open polylines
// -----------------------------------------------------------

/**
 * Island bounds as plain object.
 * The bounds are stored at every vector of the island, so the sorting
 * in post-processing can order whole islands along the gas flow.
 * @param {bsIsland} a_island  Island
 * @return {{min_x:number, min_y:number, max_x:number, max_y:number}} Bounds in mm
 */
function get_island_bounds(a_island)
{
  let l_b = a_island.getBounds();
  return { min_x: l_b.minX, min_y: l_b.minY, max_x: l_b.maxX, max_y: l_b.maxY };
}

/**
 * All vectors of one part island.
 * @param {Object} a_ctx       Layer context (island_counter is increased)
 * @param {bsIsland} a_island  Part island (copy, not modified)
 * @param {bsHatch} a_result   Layer result (hatchResult)
 * @return {void}
 */
function process_part_island(a_ctx, a_island, a_result)
{
  let l_part = a_ctx.part;
  // Island numbers start at 1 in every layer; 0 means "no island".
  a_ctx.island_counter += 1;

  // Skin areas: downskin has priority over upskin.
  // MPBF background: downskin = area whose surface is flatter than the
  // 'surface angle' compared with the reference layers below (powder
  // below); upskin = area not covered by the next layer above (top
  // surface). Slivers narrower than 'min width' are dropped, because
  // they would only create very short vectors.
  let l_ds = l_part.overhang.enabled ? SKIN.split_downskin(a_ctx.model, a_island, l_part.overhang) : ISL.empty();
  let l_us = l_part.upskin.enabled ? SKIN.split_upskin_one_layer(a_island, l_part.upskin) : ISL.empty();
  if (!l_us.isEmpty() && !l_ds.isEmpty()) l_us = ISL.subtract(l_us, l_ds);

  // Island data shared by all contour and hatch helpers below.
  let l_isl_info = { islid: a_ctx.island_counter, bounds: get_island_bounds(a_island), ds: l_ds };
  let l_insets = compute_insets(l_part);
  let l_border_split = l_part.overhang.enabled && l_part.overhang.border_splitting;
  let l_fill_split = l_part.overhang.enabled && l_part.overhang.fill_contour_splitting;

  // Creation order: outer contours first, hatches last. The exposure
  // order is set later by the sorting (scanning order per BSID).
  process_first_border(a_ctx, a_island, a_result, l_insets, l_isl_info);
  process_contour_rings(a_ctx, a_island, a_result, l_part.border_following, l_insets.following,
    BSID.border_following, BSID.border_following_ds, l_border_split, l_isl_info);
  process_contour_rings(a_ctx, a_island, a_result, l_part.fill_contour, l_insets.fill,
    BSID.fill_contour, BSID.fill_contour_ds, l_fill_split, l_isl_info);
  process_part_hatches(a_ctx, a_island, a_result, l_insets, l_isl_info, l_us);
}

/**
 * Hatch of one solid support island.
 * MPBF background: solid supports are support areas below overhangs
 * (they come with the sliced model data). They only need to hold the
 * part and lead heat into the plate, so they get a plain hatch without
 * contours; a larger hatch distance (default 0.2 mm) is enough and
 * saves build time.
 * @param {Object} a_ctx       Layer context (island_counter is increased)
 * @param {bsIsland} a_island  Support island (copy)
 * @param {bsHatch} a_result   Layer result (hatchResult)
 * @return {void}
 */
function process_solid_support_island(a_ctx, a_island, a_result)
{
  let l_cfg = a_ctx.part.support_solid;
  if (!l_cfg.enabled) return;
  a_ctx.island_counter += 1;
  // Optional inset (mm): keeps the support hatch away from its outline.
  let l_area = (l_cfg.inset > 0.0) ? ISL.offset(a_island, -l_cfg.inset) : a_island;
  hatch_area(a_ctx, a_result, l_area, l_cfg.hatch, BSID.support_solid, a_ctx.island_counter,
    get_island_bounds(a_island), true);
}

/**
 * Open polylines: part paths and wall supports.
 * Open polylines are lines without area in the sliced data: thin part
 * features given as lines, and wall supports (thin support walls that
 * are exposed as single laser lines).
 * They get island number 0 and no island bounds; the sorting then uses
 * the bounds of the path itself.
 * @param {Object} a_ctx      Layer context
 * @param {bsHatch} a_result  Layer result (hatchResult)
 * @return {void}
 */
function process_open_polylines(a_ctx, a_result)
{
  let l_wall = a_ctx.part.support_wall;
  // Tip: an iterator points to one polyline at a time;
  // isValid() is false after the last one, next() moves on.
  let l_it = a_ctx.model_data.getFirstLayerPolyline(a_ctx.layer_nr, POLY_IT.nLayerOpenPolylines);
  while (l_it.isValid())
  {
    let l_subtype = l_it.getModelSubtype();
    // Part paths are exposed as they are (no layer skip, no options).
    if (l_subtype === MODEL.nSubtypePart)
    {
      let l_hatch = new HATCH.bsHatch();
      l_it.polylineToHatch(l_hatch);
      add_hatch(a_ctx, a_result, l_hatch, BSID.part_open_path, 0, undefined);
    }
    else if ((l_subtype === MODEL.nSubtypeSupport) && l_wall.enabled &&
             LAYER_SKIP.is_active(a_ctx.layer_index, l_wall.layer_skip))
    {
      // The support lines are connected and sorted for short jumps.
      let l_support = SUPPORTS.make_wall_support_hatch(l_it);
      add_hatch(a_ctx, a_result, l_support, BSID.support_wall, 0, undefined);
    }
    l_it.next();
  }
}

/**
 * Create all exposure vectors of one layer.
 * Tip: this function only uses its arguments and local
 * variables, so it is safe when several threads run it at the same
 * time for different layers.
 * @param {{model_data:bsModelData, model:bsModel, layer_nr:number,
 *          part:Object, platform:Object, info:Object}} a_input
 *        part / platform / info: settings objects stored in prepareModelExposure
 * @param {bsHatch} a_hatch_result  Result of the layer (filled here)
 * @return {{ok:boolean, message:string}}  Currently always ok; problems
 *         of single islands are reported as warnings
 */
exports.make_layer = function(a_input, a_hatch_result)
{
  // Context object passed to all helpers of this file.
  // Tip: one object instead of many single arguments keeps the
  // helper signatures short; it lives only during this call.
  let l_ctx = {
    model_data: a_input.model_data,
    model: a_input.model,
    layer_nr: a_input.layer_nr,
    part: a_input.part,
    platform: a_input.platform,
    info: a_input.info,
    // 0-based layer index of the part, used for layer skip and rotation.
    layer_index: Math.max(0, a_input.layer_nr - a_input.info.min_layer_nr),
    // Shielding gas flow as unit vector (direction INTO which it flows)
    // and as angle in degrees (for the hatch rotation window).
    gas_dir: GAS_FLOW.flow_direction(a_input.platform.gas_flow.angle),
    gas_angle: a_input.platform.gas_flow.angle,
    // Counts the islands of this layer (part and solid support islands).
    island_counter: 0,
    // Scan settings per BSID: { '<bsid>': { laser_index, power, speed, focus } }
    scan_by_bsid: a_input.part.scanning
  };

  // Closed areas first: part islands and solid support islands.
  let l_it = l_ctx.model_data.getFirstIsland(l_ctx.layer_nr);
  while (l_it && l_it.isValid())
  {
    let l_subtype = l_it.getModelSubtype();
    // The original islands are read-only: work on a copy.
    let l_island = l_it.getIsland().clone();
    if (l_subtype === MODEL.nSubtypePart)
    {
      process_part_island(l_ctx, l_island, a_hatch_result);
    }
    else if (l_subtype === MODEL.nSubtypeSupport)
    {
      process_solid_support_island(l_ctx, l_island, a_hatch_result);
    }
    // Other subtypes are not exposed by this build style.
    l_it.next();
  }

  // Then lines without area: part paths and wall supports.
  process_open_polylines(l_ctx, a_hatch_result);
  return { ok: true, message: '' };
};

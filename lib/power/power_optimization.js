/************************************************************
 * MODULE NAME: power_optimization.js
 *
 * PURPOSE:
 *   Apply the power model (power_model.js) to the hatch vectors of
 *   one layer: every hatch vector (or micro vector) gets its own
 *   laser power, computed along the sequence of vectors that each
 *   laser really scans.
 *
 * BACKGROUND:
 *   MPBF background: Short hatch vectors are scanned in quick
 *   succession, so the heat of one vector has no time to flow away
 *   before the next one starts. The local temperature rises (heat
 *   accumulation), the melt pool gets larger and deeper, and defects
 *   such as pores, rough surfaces or warped edges can appear. Lowering
 *   the power on such vectors keeps the melt pool closer to the one of
 *   long vectors. power_model.js computes the powers, this module reads
 *   the vectors from the layer and writes the powers back.
 *   - Layer: one slice of the build; all paths of one height.
 *   - Hatch block: a group of hatch vectors with the same attributes,
 *     for example one vector type (BSID) of one island.
 *   - BSID: build style ID; tells the machine which laser parameter
 *     set (power, speed, focus) to use for a path. With the laser
 *     assignment the BSID also carries the laser (laser bsid, see
 *     lib/multi_laser/laser_bsid.js); the caller then lists the laser
 *     bsids in the settings map, too.
 *   - Laser timeline: the power model needs the vectors in the order in
 *     which ONE laser scans them (return time = time until the laser
 *     comes back next to a point). The vectors of all blocks with the
 *     same laser and the same settings object (= vector type of one
 *     model, see the caller) are therefore put on one timeline, in
 *     processing order. If several models share one settings object
 *     (sort mode 'global', equal settings), their blocks of that vector
 *     type form one timeline per laser, too. Example: the laser assignment cuts
 *     one hatch block into runs on lasers A, B, A; both runs of laser A
 *     form one timeline, so the second run sees the first one as its
 *     neighbor. Without segment splitting the power only depends on the
 *     length of each vector, so the timeline does not change the result.
 *
 * WORKFLOW:
 *   Called in the multi-threaded post-processing step, AFTER the
 *   exposure sorting and the optional laser assignment: the timelines
 *   follow the final processing order, and the vectors are the ones the
 *   lasers really scan.
 *   1. Copy all exposure paths of every model layer into hatches.
 *   2. Take the hatch blocks with an active power optimization in
 *      processing order and group them by (laser, model, vector type).
 *   3. Compute the powers along every group's timeline and give each
 *      block its own vectors back (new per-vector powers, or a new block
 *      of micro vectors if configured). All other blocks are kept.
 *   4. Replace the exposure paths of every changed model layer.
 *
 * USAGE:
 *   var POWER_OPT = require('../power/power_optimization.js');
 *   let l_map = new Map();
 *   l_map.set(500, { power_opt: l_hatch_cfg.power_opt, hatch_distance: 0.1, speed: 1000.0 });
 *   POWER_OPT.optimize_layer(modelData, n, [l_map], l_timing);
 *
 * DEPENDENCIES:
 *   Builtins: bsHatch, bsPolylineIterator
 *   Modules : ./power_model.js, ../util/attribute_names.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Only allowed in the post-processing (layer paths are replaced).
 *   Tip: The power is an EDGE attribute. Point i of a hatch
 *   block carries the power of the vector from point i to i+1, so the
 *   power is written to every even point index (start of a vector).
 *   The block attributes ('_processing_order', 'laser_index', BSID,
 *   preview color, ...) are kept: blocks are changed in place or
 *   replaced by a clone() with new points.
 *   Multi-threading: every worker thread processes different layers.
 *   This module only touches the layer it is called for and keeps no
 *   state between calls, so the threads do not interfere.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HATCH = requireBuiltin('bsHatch');
var POLY_IT = requireBuiltin('bsPolylineIterator');
var POWER_MODEL = require('./power_model.js');
var ATTR = require('../util/attribute_names.js').ATTR;

/**
 * Hatch vectors of a block as segments.
 * In hatch mode the points come in pairs: point 0 -> 1 is the first
 * vector, point 2 -> 3 the second, and so on. Between the pairs the
 * laser jumps (laser off).
 * @param {bsHatchBlock} a_block  Block in hatch mode (point pairs)
 * @return {Array} [{x0, y0, x1, y1}] in mm, in scan order
 */
function read_block_segments(a_block)
{
  let r_segments = [];
  let l_count = a_block.getPointCount();
  // i + 1 < l_count: an odd last point (no partner) is ignored.
  for (let i = 0; i + 1 < l_count; i += 2)
  {
    let l_a = a_block.getPoint(i);
    let l_b = a_block.getPoint(i + 1);
    r_segments.push({ x0: l_a.x, y0: l_a.y, x1: l_b.x, y1: l_b.y });
  }
  return r_segments;
}

/**
 * Write the power of every vector (edge attribute at the vector start).
 * Vector j starts at point 2 * j (see read_block_segments), so the
 * power of piece j is stored there. The block power attribute keeps
 * its original value; the per-vector values are stored in addition.
 * @param {bsHatchBlock} a_block  Block in hatch mode with one point pair per piece
 * @param {Array} a_pieces        [{x0, y0, x1, y1, power}], power in W
 */
function set_vector_powers(a_block, a_pieces)
{
  for (let j = 0; j < a_pieces.length; ++j)
  {
    a_block.setPointAttributeReal(2 * j, ATTR.POWER, a_pieces[j].power, true);
  }
}

/**
 * New block made of the micro vectors of a block.
 * The block keeps the subtype (part or support) and ALL block
 * attributes of the original block (also attributes that this module
 * does not know, e.g. the laser or the processing order); only the
 * geometry (more, shorter vectors) and the per-vector powers are new.
 * HOW: clone() copies the whole block including its attributes, and
 * clear() then removes only the points (and with them the old
 * per-point powers); the block attributes stay. appendPoint accepts an
 * array, so all points are added with a single call.
 * @param {bsHatchBlock} a_src  Original block (attributes, subtype)
 * @param {Array} a_pieces      [{x0, y0, x1, y1, power}]
 * @return {bsHatchBlock} New block
 */
function make_microvector_block(a_src, a_pieces)
{
  // Two points (start and end) per piece, in scan order.
  let l_points = new Array(a_pieces.length * 2);
  for (let i = 0; i < a_pieces.length; ++i)
  {
    l_points[2 * i] = { x: a_pieces[i].x0, y: a_pieces[i].y0 };
    l_points[2 * i + 1] = { x: a_pieces[i].x1, y: a_pieces[i].y1 };
  }

  let r_block = a_src.clone();
  r_block.clear();
  // The source block is a hatch block (checked by the caller); setting
  // the mode again makes the point-pair layout explicit.
  r_block.setPolylineMode(POLY_IT.nPolyHatch);
  r_block.appendPoint(l_points);
  set_vector_powers(r_block, a_pieces);
  return r_block;
}

/**
 * Integer attribute of a block, or a default value if it is missing.
 * @return {number}
 */
function get_int(a_block, a_name, a_default)
{
  let l_v = a_block.getAttributeIntExt(a_name);
  return (typeof l_v === 'number') ? l_v : a_default;
}

/**
 * Copy the paths of all model layers and find the blocks to optimize.
 * @param {bsModelData} a_model_data
 * @param {number} a_layer_nr
 * @param {Array} a_bsid_cfg  Per model index: Map bsid -> {power_opt, hatch_distance, speed}
 * @return {{layers:Array, items:Array}}
 *         layers: [{ model_index, layer, hatch, blocks, result }] (result = blocks
 *         to write back, same index as blocks; hatch kept alive, the blocks belong
 *         to it); items: blocks to optimize, in processing order
 */
function collect_blocks(a_model_data, a_layer_nr, a_bsid_cfg)
{
  let r_res = { layers: [], items: [] };
  for (let m = 0; m < a_model_data.getModelCount(); ++m)
  {
    let l_map = a_bsid_cfg[m];
    // Nothing to optimize for this model: its layer is not touched at all.
    if (!l_map || (l_map.size === 0)) continue;
    // The model may have no layer at this height (above or below the part).
    let l_layer = a_model_data.getModel(m).maybeGetModelLayerByNr(a_layer_nr);
    if (typeof l_layer === 'undefined') continue;

    // Work on a copy of the layer paths; the layer is only replaced at the end.
    let l_src = new HATCH.bsHatch();
    l_layer.addExposurePolylinesToHatch(l_src);
    if (l_src.isEmpty()) continue;
    let l_blocks = l_src.getHatchBlockArray();
    let l_entry = { model_index: m, layer: l_layer, hatch: l_src, blocks: l_blocks,
      result: l_blocks.slice(), changed: false };
    r_res.layers.push(l_entry);

    for (let i = 0; i < l_blocks.length; ++i)
    {
      let l_block = l_blocks[i];
      let l_bsid = l_block.getAttributeIntExt(ATTR.BSID);
      let l_cfg = (typeof l_bsid === 'number') ? l_map.get(l_bsid) : undefined;
      // Not optimized (contours, other vector types): kept unchanged.
      if (!l_cfg || (l_block.getPolylineMode() !== POLY_IT.nPolyHatch)) continue;
      let l_segments = read_block_segments(l_block);
      if (l_segments.length === 0) continue;
      let l_order = l_block.getAttributeIntExt(ATTR.PROCESSING_ORDER);
      r_res.items.push({
        layer_entry: l_entry,
        block_index: i,
        segments: l_segments,
        cfg: l_cfg,
        seq: r_res.items.length,
        order: (typeof l_order === 'number') ? l_order : Number.POSITIVE_INFINITY,
        // Timeline key: same laser and same settings object. All laser
        // bsids of one vector type map to the same settings object (l_cfg),
        // so the settings object identifies the vector type (and the model,
        // unless the caller lets models with equal settings share it).
        laser: get_int(l_block, ATTR.LASER_INDEX, 0)
      });
    }
  }

  // Processing order; blocks without '_processing_order' keep their read order at the end.
  r_res.items.sort(function(a_a, a_b)
  {
    if (a_a.order !== a_b.order) return (a_a.order < a_b.order) ? -1 : 1;
    return a_a.seq - a_b.seq;
  });
  return r_res;
}

/**
 * Group the items into laser timelines (see BACKGROUND).
 * Items of one group keep the processing order.
 * @param {Array} a_items  Items in processing order
 * @return {Array} Array of item arrays
 */
function group_timelines(a_items)
{
  let r_groups = [];
  for (let i = 0; i < a_items.length; ++i)
  {
    let l_item = a_items[i];
    let l_group = undefined;
    for (let g = 0; g < r_groups.length; ++g)
    {
      let l_first = r_groups[g][0];
      if ((l_first.laser === l_item.laser) && (l_first.cfg === l_item.cfg))
      {
        l_group = r_groups[g];
        break;
      }
    }
    if (!l_group)
    {
      l_group = [];
      r_groups.push(l_group);
    }
    l_group.push(l_item);
  }
  return r_groups;
}

/**
 * Compute the powers of one timeline and give every block its pieces back.
 * @param {Array} a_group  Items of one timeline, in processing order
 * @param {Object} a_timing  Timing object (see ../time/scanner_delays.js)
 */
function optimize_timeline(a_group, a_timing)
{
  let l_cfg = a_group[0].cfg;
  let l_segments = [];
  for (let i = 0; i < a_group.length; ++i)
  {
    for (let k = 0; k < a_group[i].segments.length; ++k) l_segments.push(a_group[i].segments[k]);
  }

  // One entry per vector of the timeline, in the same order as l_segments.
  let l_pieces = POWER_MODEL.split_hatch_segments_grouped(l_segments, l_cfg.power_opt,
    l_cfg.speed, l_cfg.hatch_distance, a_timing);

  let l_next = 0;
  for (let i = 0; i < a_group.length; ++i)
  {
    let l_item = a_group[i];
    let l_block_pieces = [];
    for (let k = 0; k < l_item.segments.length; ++k)
    {
      let l_vector_pieces = l_pieces[l_next++];
      for (let j = 0; j < l_vector_pieces.length; ++j) l_block_pieces.push(l_vector_pieces[j]);
    }

    let l_entry = l_item.layer_entry;
    let l_block = l_entry.blocks[l_item.block_index];
    if (l_cfg.power_opt.segment_splitting === true)
    {
      // New geometry (micro vectors): a new block replaces the old one.
      l_entry.result[l_item.block_index] = make_microvector_block(l_block, l_block_pieces);
    }
    else
    {
      // Same geometry: only the powers change.
      set_vector_powers(l_block, l_block_pieces);
    }
    l_entry.changed = true;
  }
}

/**
 * Optimize the hatch powers of one layer (all models).
 * Only hatch blocks whose BSID is in the map of their model are changed.
 * Contours and all other vector types are copied unchanged, because the
 * power model is made for parallel hatch vectors with a fixed hatch
 * distance.
 * Tip: The result is returned as an object {ok, ...} instead
 * of throwing an exception. The caller can decide how to react, and one
 * problematic layer does not abort the whole post-processing.
 * @param {bsModelData} a_model_data  All models
 * @param {number} a_layer_nr         Layer number
 * @param {Array} a_bsid_cfg          Per model index: Map bsid -> {power_opt, hatch_distance, speed};
 *                                    contains only the vector types to optimize
 *                                    (hatch_distance in mm, speed = mark speed in mm/s).
 *                                    All bsids of one vector type (plain and laser bsids)
 *                                    must map to the SAME settings object; different
 *                                    models only share a timeline if their maps hold
 *                                    the same object (see BACKGROUND).
 * @param {Object} a_timing  Timing object (see ../time/scanner_delays.js)
 *        Scanner timing: jump speed in mm/s, delays in microseconds
 * @return {{ok:boolean, changed_blocks:number}} changed_blocks = number of optimized blocks
 */
exports.optimize_layer = function(a_model_data, a_layer_nr, a_bsid_cfg, a_timing)
{
  let l_collected = collect_blocks(a_model_data, a_layer_nr, a_bsid_cfg);
  if (l_collected.items.length === 0) return { ok: true, changed_blocks: 0 };

  let l_groups = group_timelines(l_collected.items);
  for (let g = 0; g < l_groups.length; ++g) optimize_timeline(l_groups[g], a_timing);

  // Replace the exposure paths of every changed model layer, in the
  // original block order (the processing order is a block attribute).
  for (let i = 0; i < l_collected.layers.length; ++i)
  {
    let l_entry = l_collected.layers[i];
    if (!l_entry.changed) continue;
    let l_dst = new HATCH.bsHatch();
    for (let b = 0; b < l_entry.result.length; ++b) l_dst.addHatchBlock(l_entry.result[b]);
    l_entry.layer.deleteExposurePolylines();
    l_entry.layer.createExposurePolylinesFromHatch(l_dst);
  }
  return { ok: true, changed_blocks: l_collected.items.length };
};

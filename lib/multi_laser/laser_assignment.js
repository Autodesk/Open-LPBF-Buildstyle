/************************************************************
 * MODULE NAME: laser_assignment.js
 *
 * PURPOSE:
 *   Assign every exposure path of one layer to a laser of a
 *   multi-laser machine (attribute 'laser_index') and balance the
 *   work between the lasers. Four strategies are available; two of
 *   them split vectors at scan field or swimlane borders.
 *
 * BACKGROUND:
 *   MPBF background: see scanner_array.js (scan fields, overlaps,
 *   swimlanes) and laser_assignment_math.js (candidates, load, greedy
 *   choice, proximity weight).
 *   - Pass: the paths of one sort group (see
 *     exposure_sorter.group_key): all paths with the same scanning
 *     order value inside the same part ('model' mode) or island
 *     ('island' mode), or on the whole platform ('platform' mode).
 *     Every pass starts with an empty load for all lasers, so each
 *     phase of the scanning order (e.g. supports, then hatches, then
 *     borders) is spread over all lasers on its own.
 *   Strategies:
 *   - 'field_split': every hatch vector is cut at the scan field
 *     borders; each piece goes to a laser whose field contains it
 *     (greedy in overlaps). Contours and open paths are not cut; the
 *     whole path goes to one laser.
 *   - 'swimlane': paths are never cut. The paths of a pass are put into
 *     swimlanes by their center and assigned lane by lane, downstream
 *     lane first; the load starts empty in every lane.
 *   - 'swimlane_clip': like 'swimlane', but hatch vectors (and, with
 *     split_polylines, contours and open paths) are first cut at the
 *     lane borders, so no piece lies in two lanes.
 *   - 'swimlane_reassign': like 'swimlane_clip', but hatch vectors are
 *     never cut: each vector goes into the lane of its middle point.
 *
 * WORKFLOW:
 *   Called in the multi-threaded post-processing step for every
 *   layer, AFTER the exposure sorting (the passes follow the sorted
 *   order) and BEFORE the power optimization (which computes the powers
 *   of the new pieces) and the exposure time estimation.
 *   1. Copy the exposure paths of every model layer into hatches and
 *      put them into the sorted order ('_processing_order').
 *   2. Cut the order into passes (consecutive paths with the same
 *      sort group).
 *   3. Run the selected strategy pass by pass. The order of the passes
 *      and of the paths inside a pass is kept; only the swimlane
 *      strategies reorder inside a pass (lane by lane).
 *   4. Write the new '_processing_order', 'laser_index', laser bsid
 *      (see laser_bsid.js) and preview color, and replace the exposure
 *      paths of every model layer.
 *
 * USAGE:
 *   var LASER_ASSIGNMENT = require('../multi_laser/laser_assignment.js');
 *   let l_res = LASER_ASSIGNMENT.assign_layer(modelData, n, {
 *     strategy: 'field_split', scanners: l_scanners, lanes: l_lanes,
 *     gas_dir: l_gas_dir, split_polylines: false,
 *     cost: { use_time: true, jump_speed: 7000, jump_delay_ms: 0.05,
 *             mark_delay_ms: 0.01, proximity_weight: 0 },
 *     sorter: l_sorter_cfg, speed_lookup: l_speed_lookup });
 *
 * DEPENDENCIES:
 *   Builtins: bsHatch, bsPolylineIterator, bsModel, bsColRGBAi
 *   Modules : ./laser_assignment_math.js, ./scanner_array.js, ./laser_bsid.js,
 *             ../sorting/exposure_sorter.js, ../util/attribute_names.js,
 *             ../util/log.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Only allowed in the post-processing (layer paths are replaced).
 *   The vector type of a path is never changed: its bsid becomes the
 *   laser bsid of the same vector type ((laser_index + 1) * 1000 + type,
 *   see laser_bsid.js), and the laser is also written to 'laser_index'
 *   (0-based). The custom table must contain the laser bsids
 *   (main/settings.js, build_custom_table).
 *   Tip: Every new piece is a clone() of its original block,
 *   so it keeps ALL block attributes (BSID, power, speed, island, ...);
 *   only the points are written new.
 *   Per-vector powers: this module does not write any. The power
 *   optimization runs AFTER the laser assignment (main/postprocess.js)
 *   and computes the powers of the pieces from their own vectors, so a
 *   cut piece never keeps the power of the longer original vector.
 *   Multi-threading: only the layer of the call is touched and no state
 *   is kept between calls.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HATCH = requireBuiltin('bsHatch');
var POLY_IT = requireBuiltin('bsPolylineIterator');
var MODEL = requireBuiltin('bsModel');
var RGBA = requireBuiltin('bsColRGBAi');
var LA_MATH = require('./laser_assignment_math.js');
var SCANNER_ARRAY = require('./scanner_array.js');
var LASER_BSID = require('./laser_bsid.js');
var SORTER = require('../sorting/exposure_sorter.js');
var ATTR = require('../util/attribute_names.js').ATTR;
var LOG = require('../util/log.js');

/** Names of the strategies (index = value of the strategy choice parameter). */
exports.STRATEGIES = Object.freeze(['field_split', 'swimlane', 'swimlane_clip', 'swimlane_reassign']);

/** Mark speed (mm/s) used if no speed is known for a path (avoids a division by zero). */
var S_DEFAULT_SPEED = 1000.0;

// -----------------------------------------------------------
// Reading the layer
// -----------------------------------------------------------

/**
 * All points of a block.
 * @param {bsHatchBlock} a_block
 * @return {Array} [{x, y}] in mm
 */
function read_points(a_block)
{
  let l_count = a_block.getPointCount();
  let r_points = new Array(l_count);
  for (let i = 0; i < l_count; ++i)
  {
    let l_p = a_block.getPoint(i);
    r_points[i] = { x: l_p.x, y: l_p.y };
  }
  return r_points;
}

/**
 * Center of the island of a block (same rule as the exposure sorter:
 * island bounds if stored, otherwise the bounds of the points).
 * @param {bsHatchBlock} a_block
 * @param {Array} a_points  Points of the block (may be empty)
 * @return {{x:number, y:number}}
 */
function island_center(a_block, a_points)
{
  let l_min_x = a_block.getAttributeRealExt(ATTR.ISL_MIN_X);
  let l_min_y = a_block.getAttributeRealExt(ATTR.ISL_MIN_Y);
  let l_max_x = a_block.getAttributeRealExt(ATTR.ISL_MAX_X);
  let l_max_y = a_block.getAttributeRealExt(ATTR.ISL_MAX_Y);
  if ((typeof l_min_x === 'number') && (typeof l_min_y === 'number') &&
      (typeof l_max_x === 'number') && (typeof l_max_y === 'number'))
  {
    return { x: 0.5 * (l_min_x + l_max_x), y: 0.5 * (l_min_y + l_max_y) };
  }
  return (a_points.length > 0) ? LA_MATH.points_center(a_points) : { x: 0.0, y: 0.0 };
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
 * Mark speed of a block: block attribute, then lookup table, then default.
 * @param {bsHatchBlock} a_block
 * @param {number} a_model_index
 * @param {number} a_bsid
 * @param {Array} a_speed_lookup  Per model index: { '<bsid>': speed in mm/s }
 * @return {number} mm/s (> 0)
 */
function get_speed(a_block, a_model_index, a_bsid, a_speed_lookup)
{
  let l_v = a_block.getAttributeRealExt(ATTR.SPEED);
  if ((typeof l_v === 'number') && (l_v > 0.0)) return l_v;
  let l_table = a_speed_lookup ? a_speed_lookup[a_model_index] : undefined;
  let l_t = l_table ? l_table[String(a_bsid)] : undefined;
  return ((typeof l_t === 'number') && (l_t > 0.0)) ? l_t : S_DEFAULT_SPEED;
}

/**
 * Copy the exposure paths of all model layers and build one item per path.
 * Why copies (addExposurePolylinesToHatch) instead of the layer paths
 * themselves: the strategies create new blocks, and the layer can only
 * be replaced as a whole (see rebuild_layers). The same pattern is used
 * by the power optimization.
 * @param {bsModelData} a_model_data
 * @param {number} a_layer_nr
 * @param {Object} a_cfg  Settings of assign_layer
 * @return {{layers:Array, hatches:Array, items:Array, missing_order:boolean}}
 *         layers: [{ model_index, layer }]; hatches: the copies (kept
 *         alive until the end, the blocks belong to them); items in
 *         sorted order
 */
function collect_items(a_model_data, a_layer_nr, a_cfg)
{
  let r_res = { layers: [], hatches: [], items: [], missing_order: false };
  for (let m = 0; m < a_model_data.getModelCount(); ++m)
  {
    let l_layer = a_model_data.getModel(m).maybeGetModelLayerByNr(a_layer_nr);
    if (typeof l_layer === 'undefined') continue;
    let l_src = new HATCH.bsHatch();
    l_layer.addExposurePolylinesToHatch(l_src);
    if (l_src.isEmpty()) continue;
    r_res.layers.push({ model_index: m, layer: l_layer });
    r_res.hatches.push(l_src);

    let l_blocks = l_src.getHatchBlockArray();
    for (let i = 0; i < l_blocks.length; ++i)
    {
      let l_block = l_blocks[i];
      let l_points = read_points(l_block);
      let l_is_hatch = (l_block.getPolylineMode() === POLY_IT.nPolyHatch);
      let l_bsid = get_int(l_block, ATTR.BSID, 0);
      let l_order = l_block.getAttributeIntExt(ATTR.PROCESSING_ORDER);
      if (typeof l_order !== 'number') r_res.missing_order = true;
      r_res.items.push({
        block: l_block,
        model_index: m,
        seq: r_res.items.length,
        order: (typeof l_order === 'number') ? l_order : Number.POSITIVE_INFINITY,
        points: l_points,
        is_hatch: l_is_hatch,
        // A hatch path needs one full vector, a contour at least one point.
        has_geometry: l_is_hatch ? (l_points.length >= 2) : (l_points.length >= 1),
        center: (l_points.length > 0) ? LA_MATH.points_center(l_points) : { x: 0.0, y: 0.0 },
        speed: get_speed(l_block, m, l_bsid, a_cfg.speed_lookup),
        group: SORTER.group_key({
          model_index: m,
          bsid: l_bsid,
          islid: get_int(l_block, ATTR.ISLAND_ID, 0),
          center: island_center(l_block, l_points),
          // Own position of the block (used by the sort mode 'global').
          path_center: (l_points.length > 0) ? LA_MATH.points_center(l_points) : undefined,
          is_support: l_block.getModelSubtype() === MODEL.nSubtypeSupport
        }, a_cfg.sorter)
      });
    }
  }

  // Sorted order; paths without '_processing_order' keep their read order at the end.
  r_res.items.sort(function(a_a, a_b)
  {
    if (a_a.order !== a_b.order) return (a_a.order < a_b.order) ? -1 : 1;
    return a_a.seq - a_b.seq;
  });
  return r_res;
}

/**
 * Cut the sorted items into passes (runs with the same sort group).
 * @param {Array} a_items  Sorted items
 * @return {Array} Array of item arrays, in order
 */
function split_into_passes(a_items)
{
  let r_passes = [];
  let l_current = undefined;
  for (let i = 0; i < a_items.length; ++i)
  {
    if (!l_current || (l_current.group !== a_items[i].group))
    {
      l_current = { group: a_items[i].group, items: [] };
      r_passes.push(l_current);
    }
    l_current.items.push(a_items[i]);
  }
  let r_result = [];
  for (let i = 0; i < r_passes.length; ++i) r_result.push(r_passes[i].items);
  return r_result;
}

// -----------------------------------------------------------
// Writing blocks
// -----------------------------------------------------------

/**
 * Empty copy of a block with all its block attributes.
 * @param {bsHatchBlock} a_src  Original block
 * @param {number} a_mode       POLY_IT.nPolyHatch / nPolyOpen / nPolyClosed
 * @return {bsHatchBlock}
 */
function make_piece_block(a_src, a_mode)
{
  let r_block = a_src.clone();
  r_block.clear();
  r_block.setPolylineMode(a_mode);
  return r_block;
}

/**
 * Write the laser, its laser bsid and its preview color to a block.
 * Why the bsid: the host (e.g. the smoke simulation) and multi-laser
 * machines find the laser of a path only through bsid -> custom table
 * 'laserIndex', not through 'laser_index' (see laser_bsid.js).
 * 'laser_index' is written as well, because the exporters of this
 * project read it first.
 * @param {bsHatchBlock} a_block
 * @param {number} a_laser_index  0-based
 * @param {Object} a_ctx          Context of assign_layer (colors)
 */
function tag_block(a_block, a_laser_index, a_ctx)
{
  a_block.setAttributeInt(ATTR.LASER_INDEX, a_laser_index);
  a_block.setAttributeInt(ATTR.DISP_COLOR, a_ctx.colors[a_laser_index]);
  let l_bsid = a_block.getAttributeIntExt(ATTR.BSID);
  // A block without bsid keeps none (the host then uses its defaults).
  if (typeof l_bsid === 'number')
  {
    a_block.setAttributeInt(ATTR.BSID, LASER_BSID.make_laser_bsid(l_bsid, a_laser_index));
  }
}

/**
 * Append one hatch vector to a block.
 * No per-vector power is written: the power optimization computes it
 * afterwards for the new vectors (see the module header).
 * @param {bsHatchBlock} a_block
 * @param {{x:number, y:number}} a_a  Start
 * @param {{x:number, y:number}} a_b  End
 */
function append_vector(a_block, a_a, a_b)
{
  a_block.appendPoint([a_a, a_b]);
}

/**
 * Cost settings for one path (the mark speed differs per path).
 * @param {Object} a_cost  Cost settings of assign_layer
 * @param {number} a_speed Mark speed of the path in mm/s
 * @return {Object} Cost settings for laser_assignment_math.js
 */
function cost_for(a_cost, a_speed)
{
  return {
    use_time: a_cost.use_time,
    jump_speed: a_cost.jump_speed,
    jump_delay_ms: a_cost.jump_delay_ms,
    min_jump_delay_ms: a_cost.min_jump_delay_ms,
    jump_length_limit: a_cost.jump_length_limit,
    mark_delay_ms: a_cost.mark_delay_ms,
    mark_speed: a_speed,
    proximity_weight: a_cost.proximity_weight
  };
}

// -----------------------------------------------------------
// Strategy 'field_split'
// -----------------------------------------------------------

/**
 * Field split strategy for one pass (see BACKGROUND).
 * Consecutive pieces of the SAME original block that go to the same
 * laser are collected into one new block, so a block inside one field
 * stays one block. Pieces of different original blocks are never
 * merged (they may differ in BSID, power, island, ...).
 * @param {Array} a_pass  Items of the pass, in order
 * @param {Object} a_ctx  Context of assign_layer
 * @param {Array} a_out   Output [{ model_index, block }] (appended)
 */
function run_field_split(a_pass, a_ctx, a_out)
{
  let l_states = LA_MATH.create_laser_states(a_ctx.fields.length);
  for (let i = 0; i < a_pass.length; ++i)
  {
    let l_item = a_pass[i];
    if (!l_item.has_geometry)
    {
      // Nothing to assign (e.g. a single point in hatch mode): keep as it is.
      a_out.push({ model_index: l_item.model_index, block: l_item.block });
      continue;
    }
    let l_cost = cost_for(a_ctx.cost, l_item.speed);

    if (!l_item.is_hatch)
    {
      // Contour / open path: the whole path goes to one laser.
      let l_laser = LA_MATH.assign_path_to_laser(l_item.points, false, l_item.center, l_states,
        a_ctx.fields, l_cost);
      tag_block(l_item.block, l_laser, a_ctx);
      a_out.push({ model_index: l_item.model_index, block: l_item.block });
      continue;
    }

    let l_open = undefined;
    let l_open_laser = -1;
    for (let p = 0; p + 1 < l_item.points.length; p += 2)
    {
      let l_a = l_item.points[p];
      let l_b = l_item.points[p + 1];
      let l_parts = LA_MATH.partition_segment_by_fields(l_a, l_b, a_ctx.fields);
      for (let q = 0; q < l_parts.length; ++q)
      {
        let l_sa = LA_MATH.lerp_point(l_a, l_b, l_parts[q].t_start);
        let l_sb = LA_MATH.lerp_point(l_a, l_b, l_parts[q].t_end);
        let l_laser = LA_MATH.choose_laser_for_segment(l_parts[q].candidates, l_states, l_sa, l_sb,
          a_ctx.fields, l_cost);
        LA_MATH.add_segment_load(l_states[l_laser], l_sa, l_sb, l_cost);
        if (l_laser !== l_open_laser)
        {
          if (l_open) a_out.push({ model_index: l_item.model_index, block: l_open });
          l_open = make_piece_block(l_item.block, POLY_IT.nPolyHatch);
          tag_block(l_open, l_laser, a_ctx);
          l_open_laser = l_laser;
        }
        append_vector(l_open, l_sa, l_sb);
      }
    }
    if (l_open) a_out.push({ model_index: l_item.model_index, block: l_open });
  }
}

// -----------------------------------------------------------
// Swimlane strategies
// -----------------------------------------------------------

/**
 * Piece of a path for the swimlane assignment.
 * @return {{block, model_index, points, is_hatch, center, speed}}
 */
function make_piece(a_item, a_block, a_points, a_is_hatch)
{
  return {
    block: a_block,
    model_index: a_item.model_index,
    points: a_points,
    is_hatch: a_is_hatch,
    center: LA_MATH.points_center(a_points),
    speed: a_item.speed
  };
}

/**
 * Split the vectors of a hatch path into one new block per lane.
 * All vectors of the path that lie in the same lane go into the same
 * block (a hatch is a set of independent vectors, so regrouping them
 * is allowed).
 * @param {Object} a_item   Hatch item
 * @param {Object} a_ctx    Context of assign_layer
 * @param {boolean} a_clip  true: cut vectors at the lane borders;
 *                          false: each vector goes into the lane of its middle point
 * @param {Array} a_pieces  Output pieces (appended), downstream lane first
 */
function split_hatch_by_lanes(a_item, a_ctx, a_clip, a_pieces)
{
  let l_by_lane = {};
  let l_lane_ids = [];
  function add(a_lane, a_a, a_b)
  {
    if (!l_by_lane[a_lane])
    {
      l_by_lane[a_lane] = [];
      l_lane_ids.push(a_lane);
    }
    l_by_lane[a_lane].push({ a: a_a, b: a_b });
  }

  for (let p = 0; p + 1 < a_item.points.length; p += 2)
  {
    let l_a = a_item.points[p];
    let l_b = a_item.points[p + 1];
    if (a_clip)
    {
      let l_parts = SCANNER_ARRAY.partition_segment_by_swimlanes(l_a, l_b, a_ctx.lanes, a_ctx.gas_dir);
      for (let q = 0; q < l_parts.length; ++q)
      {
        add(l_parts[q].lane_index, LA_MATH.lerp_point(l_a, l_b, l_parts[q].t_start),
          LA_MATH.lerp_point(l_a, l_b, l_parts[q].t_end));
      }
    }
    else
    {
      let l_key = SCANNER_ARRAY.flow_key(LA_MATH.lerp_point(l_a, l_b, 0.5), a_ctx.gas_dir);
      add(SCANNER_ARRAY.find_swimlane_index(l_key, a_ctx.lanes), l_a, l_b);
    }
  }

  l_lane_ids.sort(function(a_x, a_y) { return a_x - a_y; });
  for (let k = 0; k < l_lane_ids.length; ++k)
  {
    let l_vectors = l_by_lane[l_lane_ids[k]];
    let l_block = make_piece_block(a_item.block, POLY_IT.nPolyHatch);
    let l_points = [];
    for (let s = 0; s < l_vectors.length; ++s)
    {
      append_vector(l_block, l_vectors[s].a, l_vectors[s].b);
      l_points.push(l_vectors[s].a, l_vectors[s].b);
    }
    a_pieces.push(make_piece(a_item, l_block, l_points, true));
  }
}

/**
 * Split a contour or open path at the lane borders.
 * Unlike hatch vectors, the pieces of a path are never merged when the
 * path comes back into a lane later: that would add a jump that is not
 * in the original path. A path that stays in one lane is kept unchanged.
 * A closed contour that is cut becomes several open paths; if it starts
 * and ends in the same lane, its first and last run are joined again
 * (they are connected through the start point).
 * @param {Object} a_item   Contour / open path item
 * @param {Object} a_ctx    Context of assign_layer
 * @param {Array} a_pieces  Output pieces (appended)
 */
function split_path_by_lanes(a_item, a_ctx, a_pieces)
{
  let l_pts = a_item.points;
  let l_closed = (a_item.block.getPolylineMode() === POLY_IT.nPolyClosed);
  if (l_pts.length < 2)
  {
    a_pieces.push(make_piece(a_item, a_item.block, l_pts, false));
    return;
  }

  // Edges of the path; a closed contour also has the edge back to the start.
  let l_edges = [];
  for (let i = 0; i + 1 < l_pts.length; ++i) l_edges.push([l_pts[i], l_pts[i + 1]]);
  let l_last = l_pts[l_pts.length - 1];
  if (l_closed && (LA_MATH.distance(l_last, l_pts[0]) > 1e-9)) l_edges.push([l_last, l_pts[0]]);

  let l_runs = [];
  let l_run = undefined;
  for (let e = 0; e < l_edges.length; ++e)
  {
    let l_a = l_edges[e][0];
    let l_b = l_edges[e][1];
    let l_parts = SCANNER_ARRAY.partition_segment_by_swimlanes(l_a, l_b, a_ctx.lanes, a_ctx.gas_dir);
    for (let q = 0; q < l_parts.length; ++q)
    {
      let l_sa = LA_MATH.lerp_point(l_a, l_b, l_parts[q].t_start);
      let l_sb = LA_MATH.lerp_point(l_a, l_b, l_parts[q].t_end);
      if (!l_run || (l_run.lane !== l_parts[q].lane_index))
      {
        l_run = { lane: l_parts[q].lane_index, points: [l_sa] };
        l_runs.push(l_run);
      }
      l_run.points.push(l_sb);
    }
  }

  if (l_closed && (l_runs.length > 1) && (l_runs[0].lane === l_runs[l_runs.length - 1].lane))
  {
    let l_tail = l_runs.pop();
    l_runs[0].points = l_tail.points.concat(l_runs[0].points.slice(1));
  }
  if (l_runs.length <= 1)
  {
    a_pieces.push(make_piece(a_item, a_item.block, l_pts, false));
    return;
  }

  // Downstream lane first; runs in the same lane keep their path order
  // (Array.sort is stable).
  l_runs.sort(function(a_x, a_y) { return a_x.lane - a_y.lane; });
  for (let r = 0; r < l_runs.length; ++r)
  {
    let l_block = make_piece_block(a_item.block, POLY_IT.nPolyOpen);
    l_block.appendPoint(l_runs[r].points);
    a_pieces.push(make_piece(a_item, l_block, l_runs[r].points, false));
  }
}

/**
 * Assign the pieces of one pass lane by lane (all swimlane strategies).
 * Lane 0 (furthest downstream) first; inside a lane the pieces keep the
 * pass order; the load starts empty in every lane.
 * @param {Array} a_pieces  Pieces of the pass
 * @param {Object} a_ctx    Context of assign_layer
 * @param {Array} a_out     Output [{ model_index, block }] (appended)
 */
function assign_pieces_by_lane(a_pieces, a_ctx, a_out)
{
  let l_buckets = [];
  for (let i = 0; i < a_ctx.lanes.length; ++i) l_buckets.push([]);
  for (let i = 0; i < a_pieces.length; ++i)
  {
    let l_key = SCANNER_ARRAY.flow_key(a_pieces[i].center, a_ctx.gas_dir);
    l_buckets[SCANNER_ARRAY.find_swimlane_index(l_key, a_ctx.lanes)].push(a_pieces[i]);
  }

  for (let lane = 0; lane < l_buckets.length; ++lane)
  {
    let l_states = LA_MATH.create_laser_states(a_ctx.fields.length);
    for (let b = 0; b < l_buckets[lane].length; ++b)
    {
      let l_piece = l_buckets[lane][b];
      let l_laser = LA_MATH.assign_path_to_laser(l_piece.points, l_piece.is_hatch, l_piece.center, l_states,
        a_ctx.fields, cost_for(a_ctx.cost, l_piece.speed));
      tag_block(l_piece.block, l_laser, a_ctx);
      a_out.push({ model_index: l_piece.model_index, block: l_piece.block });
    }
  }
}

/**
 * Swimlane strategies for one pass (see BACKGROUND).
 * @param {Array} a_pass   Items of the pass, in order
 * @param {Object} a_ctx   Context of assign_layer
 * @param {string} a_strategy  'swimlane', 'swimlane_clip' or 'swimlane_reassign'
 * @param {Array} a_out    Output [{ model_index, block }] (appended)
 */
function run_swimlane(a_pass, a_ctx, a_strategy, a_out)
{
  let l_pieces = [];
  for (let i = 0; i < a_pass.length; ++i)
  {
    let l_item = a_pass[i];
    if (!l_item.has_geometry)
    {
      a_out.push({ model_index: l_item.model_index, block: l_item.block });
      continue;
    }
    if (l_item.is_hatch && (a_strategy === 'swimlane_clip'))
    {
      split_hatch_by_lanes(l_item, a_ctx, true, l_pieces);
    }
    else if (l_item.is_hatch && (a_strategy === 'swimlane_reassign'))
    {
      split_hatch_by_lanes(l_item, a_ctx, false, l_pieces);
    }
    else if (!l_item.is_hatch && (a_strategy === 'swimlane_clip') && a_ctx.split_polylines)
    {
      split_path_by_lanes(l_item, a_ctx, l_pieces);
    }
    else
    {
      l_pieces.push(make_piece(l_item, l_item.block, l_item.points, l_item.is_hatch));
    }
  }
  assign_pieces_by_lane(l_pieces, a_ctx, a_out);
}

// -----------------------------------------------------------
// Entry point
// -----------------------------------------------------------

/**
 * Replace the exposure paths of every model layer by the output blocks.
 * '_processing_order' is written here, along the final order and with
 * one counter for all models (like the exposure sorter), BEFORE the
 * blocks are turned into layer paths, so the new paths carry it.
 * @param {Object} a_collected  Result of collect_items
 * @param {Array} a_out         [{ model_index, block }] in final order
 */
function rebuild_layers(a_collected, a_out)
{
  let l_dst = {};
  for (let i = 0; i < a_collected.layers.length; ++i)
  {
    l_dst[a_collected.layers[i].model_index] = new HATCH.bsHatch();
  }
  for (let k = 0; k < a_out.length; ++k)
  {
    a_out[k].block.setAttributeInt(ATTR.PROCESSING_ORDER, k);
    l_dst[a_out[k].model_index].addHatchBlock(a_out[k].block);
  }
  for (let i = 0; i < a_collected.layers.length; ++i)
  {
    let l_entry = a_collected.layers[i];
    l_entry.layer.deleteExposurePolylines();
    l_entry.layer.createExposurePolylinesFromHatch(l_dst[l_entry.model_index]);
  }
}

/**
 * Assign all exposure paths of one layer to the lasers.
 * @param {bsModelData} a_model_data
 * @param {number} a_layer_nr
 * @param {{strategy:string, scanners:Array, lanes:Array, gas_dir:{x:number, y:number},
 *          split_polylines:boolean, cost:Object, sorter:Object, speed_lookup:Array}} a_cfg
 *        strategy: one of STRATEGIES; scanners: SCANNER_ARRAY.build_scanner_array;
 *        lanes: SCANNER_ARRAY.build_swimlanes (only used by the swimlane strategies);
 *        cost: { use_time, jump_speed (mm/s), jump_delay_ms, mark_delay_ms, proximity_weight,
 *                optional min_jump_delay_ms and jump_length_limit (mm), see
 *                ../time/scanner_delays.js };
 *        sorter: settings of SORTER.sort_layer (for the sort groups);
 *        speed_lookup: per model index { '<bsid>': speed } (fallback mark speed)
 * @return {{ok:boolean, message:string, count:number}} count = number of output paths
 */
exports.assign_layer = function(a_model_data, a_layer_nr, a_cfg)
{
  if (!a_cfg.scanners || (a_cfg.scanners.length === 0))
  {
    return { ok: false, message: 'Laser assignment: no scanner defined', count: 0 };
  }
  if (exports.STRATEGIES.indexOf(a_cfg.strategy) < 0)
  {
    return { ok: false, message: 'Laser assignment: unknown strategy ' + a_cfg.strategy, count: 0 };
  }

  // Context shared by all strategy functions: fields and colors per laser.
  let l_ctx = {
    fields: [],
    colors: [],
    lanes: a_cfg.lanes,
    gas_dir: a_cfg.gas_dir,
    split_polylines: a_cfg.split_polylines === true,
    cost: a_cfg.cost
  };
  for (let i = 0; i < a_cfg.scanners.length; ++i)
  {
    let l_s = a_cfg.scanners[i];
    l_ctx.fields.push({ laser_index: l_s.laser_index, min_x: l_s.field.min_x, max_x: l_s.field.max_x,
      min_y: l_s.field.min_y, max_y: l_s.field.max_y });
    l_ctx.colors.push(new RGBA.bsColRGBAi(l_s.color_rgb[0], l_s.color_rgb[1], l_s.color_rgb[2], 255).rgba());
  }

  let l_collected = collect_items(a_model_data, a_layer_nr, a_cfg);
  if (l_collected.items.length === 0) return { ok: true, message: '', count: 0 };
  if (l_collected.missing_order)
  {
    LOG.warning_once('la_missing_order', 'Laser assignment: some paths have no processing order; ' +
      'they are assigned after the sorted paths.');
  }

  let l_passes = split_into_passes(l_collected.items);
  let l_out = [];
  for (let i = 0; i < l_passes.length; ++i)
  {
    if (a_cfg.strategy === 'field_split') run_field_split(l_passes[i], l_ctx, l_out);
    else run_swimlane(l_passes[i], l_ctx, a_cfg.strategy, l_out);
  }

  rebuild_layers(l_collected, l_out);
  return { ok: true, message: '', count: l_out.length };
};

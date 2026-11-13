/************************************************************
 * MODULE NAME: laser_assignment_math.js
 *
 * PURPOSE:
 *   Geometry and cost functions of the laser assignment: clip a
 *   vector at the scan field borders, compute the cost of a vector
 *   or path for one laser and choose the laser with the smallest
 *   resulting load ("greedy load balancing").
 *
 * BACKGROUND:
 *   MPBF background: see scanner_array.js (scan fields, overlaps).
 *   - Candidate lasers: all lasers whose scan field contains a piece of
 *     geometry. 0 candidates = a gap that no field covers (the nearest
 *     laser is used, so nothing is dropped), 1 = no choice, 2 or more
 *     = an overlap region, resolved by load balancing.
 *   - Load: the work a laser already got in the current pass, either
 *     as marked length (metric 'length', mm) or as estimated time
 *     (metric 'time', ms: jump from the last position + marking +
 *     delays).
 *   - Greedy: every piece goes to the candidate whose load AFTER
 *     taking the piece would be smallest. Ties go to the lower laser
 *     index, so the result is reproducible.
 *   - Proximity weight: an optional extra cost = weight * distance from
 *     the piece to the scanner center (in ms via the jump speed for the
 *     'time' metric). 0 = pure load balancing. Above 0, geometry that is
 *     clearly closer to one scanner is pulled towards it; geometry in
 *     the middle of an overlap is about equally far from all candidates,
 *     so there the load still decides. The proximity cost only affects
 *     the choice; it is never added to the load.
 *
 * WORKFLOW:
 *   Used by laser_assignment.js for every vector / path of a layer.
 *
 * USAGE:
 *   var LA_MATH = require('../multi_laser/laser_assignment_math.js');
 *   let l_states = LA_MATH.create_laser_states(4);
 *   let l_parts = LA_MATH.partition_segment_by_fields(l_a, l_b, l_fields);
 *
 * DEPENDENCIES:
 *   Builtins: none (pure module, can be tested with Node.js)
 *   Modules : ../time/scanner_delays.js (pure as well)
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects:
 *   - field:  { laser_index, min_x, max_x, min_y, max_y } (mm)
 *   - state:  { load, last_end } (load in mm or ms, last_end {x, y} or undefined)
 *   - cost:   { use_time: boolean, jump_speed (mm/s), jump_delay_ms,
 *               mark_delay_ms, mark_speed (mm/s), proximity_weight,
 *               min_jump_delay_ms, jump_length_limit (mm) }
 *             The last two are optional (jump delay scaling, see
 *             ../time/scanner_delays.js); without them every jump gets
 *             the full jump delay.
 *   Tip: the functions that only CHOOSE a laser never change
 *   the states; the caller adds the cost with add_load. Only
 *   assign_path_to_laser does both, because it is the complete step.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var DELAYS = require('../time/scanner_delays.js');

/** Tolerance for the segment parameter t (0..1). */
var S_T_EPSILON = 1e-7;

// -----------------------------------------------------------
// Small helpers
// -----------------------------------------------------------

/**
 * Distance between two points.
 * @param {{x:number, y:number}} a_a
 * @param {{x:number, y:number}} a_b
 * @return {number} mm
 */
function distance(a_a, a_b)
{
  let l_dx = a_b.x - a_a.x;
  let l_dy = a_b.y - a_a.y;
  return Math.sqrt(l_dx * l_dx + l_dy * l_dy);
}

/**
 * Point on the segment a_a -> a_b at parameter a_t (0 = a_a, 1 = a_b).
 * @return {{x:number, y:number}}
 */
function lerp_point(a_a, a_b, a_t)
{
  return { x: a_a.x + (a_b.x - a_a.x) * a_t, y: a_a.y + (a_b.y - a_a.y) * a_t };
}

/**
 * Center of the bounding box of some points.
 * @param {Array} a_points  [{x, y}], at least one point
 * @return {{x:number, y:number}}
 */
function points_center(a_points)
{
  let l_min_x = a_points[0].x;
  let l_max_x = a_points[0].x;
  let l_min_y = a_points[0].y;
  let l_max_y = a_points[0].y;
  for (let i = 1; i < a_points.length; ++i)
  {
    l_min_x = Math.min(l_min_x, a_points[i].x);
    l_max_x = Math.max(l_max_x, a_points[i].x);
    l_min_y = Math.min(l_min_y, a_points[i].y);
    l_max_y = Math.max(l_max_y, a_points[i].y);
  }
  return { x: 0.5 * (l_min_x + l_max_x), y: 0.5 * (l_min_y + l_max_y) };
}

/**
 * Fresh load state for every laser (start of a pass or of a swimlane).
 * @param {number} a_count  Number of lasers
 * @return {Array} [{ load: 0, last_end: undefined }]
 */
function create_laser_states(a_count)
{
  let r_states = [];
  for (let i = 0; i < a_count; ++i) r_states.push({ load: 0.0, last_end: undefined });
  return r_states;
}

// -----------------------------------------------------------
// Scan field geometry
// -----------------------------------------------------------

/**
 * Part of the segment a_a -> a_b inside an axis-aligned box.
 * HOW: Liang-Barsky clipping. Each box side is a condition such as
 * x >= min_x; moving along the segment, each side either shrinks the
 * range [t_enter, t_exit] from the front or from the back.
 * @param {{x:number, y:number}} a_a
 * @param {{x:number, y:number}} a_b
 * @param {{min_x:number, max_x:number, min_y:number, max_y:number}} a_box
 * @return {{t_enter:number, t_exit:number}|undefined} undefined = no intersection
 */
function clip_segment_to_box(a_a, a_b, a_box)
{
  let l_dx = a_b.x - a_a.x;
  let l_dy = a_b.y - a_a.y;
  let l_t_enter = 0.0;
  let l_t_exit = 1.0;
  // [p, q] per side: the segment is inside where p * t <= q.
  let l_sides = [
    [-l_dx, a_a.x - a_box.min_x],
    [l_dx, a_box.max_x - a_a.x],
    [-l_dy, a_a.y - a_box.min_y],
    [l_dy, a_box.max_y - a_a.y]
  ];
  for (let i = 0; i < l_sides.length; ++i)
  {
    let l_p = l_sides[i][0];
    let l_q = l_sides[i][1];
    if (Math.abs(l_p) < S_T_EPSILON)
    {
      // Parallel to this side: completely outside or no restriction.
      if (l_q < 0.0) return undefined;
      continue;
    }
    let l_r = l_q / l_p;
    if (l_p < 0.0)
    {
      if (l_r > l_t_exit) return undefined;
      if (l_r > l_t_enter) l_t_enter = l_r;
    }
    else
    {
      if (l_r < l_t_enter) return undefined;
      if (l_r < l_t_exit) l_t_exit = l_r;
    }
  }
  return (l_t_enter > l_t_exit) ? undefined : { t_enter: l_t_enter, t_exit: l_t_exit };
}

/**
 * Same content of two sorted number arrays?
 * @return {boolean}
 */
function same_ids(a_a, a_b)
{
  if (a_a.length !== a_b.length) return false;
  for (let i = 0; i < a_a.length; ++i)
  {
    if (a_a[i] !== a_b[i]) return false;
  }
  return true;
}

/**
 * Split the segment a_a -> a_b into pieces with the same candidate lasers.
 * Example: a vector that starts in field 0 only, runs through the
 * overlap of fields 0 and 1 and ends in field 1 only gives three
 * pieces with the candidates [0], [0, 1] and [1]. Neighboring pieces
 * with the same candidates are merged, so a vector inside one field
 * (the common case) gives one piece.
 * @param {{x:number, y:number}} a_a
 * @param {{x:number, y:number}} a_b
 * @param {Array} a_fields  [{ laser_index, min_x, max_x, min_y, max_y }]
 * @return {Array} [{ t_start, t_end, candidates: number[] }], candidates sorted, possibly empty
 */
function partition_segment_by_fields(a_a, a_b, a_fields)
{
  let l_spans = [];
  for (let i = 0; i < a_fields.length; ++i)
  {
    let l_clip = clip_segment_to_box(a_a, a_b, a_fields[i]);
    if (l_clip && (l_clip.t_exit - l_clip.t_enter > S_T_EPSILON))
    {
      l_spans.push({ laser_index: a_fields[i].laser_index, t_enter: l_clip.t_enter, t_exit: l_clip.t_exit });
    }
  }

  // Break points: both ends and every field entry / exit, sorted, without duplicates.
  let l_breaks = [0.0, 1.0];
  for (let i = 0; i < l_spans.length; ++i) l_breaks.push(l_spans[i].t_enter, l_spans[i].t_exit);
  l_breaks.sort(function(a_x, a_y) { return a_x - a_y; });
  let l_unique = [];
  for (let i = 0; i < l_breaks.length; ++i)
  {
    if ((l_unique.length === 0) || (l_breaks[i] - l_unique[l_unique.length - 1] > S_T_EPSILON))
    {
      l_unique.push(l_breaks[i]);
    }
  }

  let r_pieces = [];
  for (let i = 0; i + 1 < l_unique.length; ++i)
  {
    let l_t0 = l_unique[i];
    let l_t1 = l_unique[i + 1];
    // The candidates of a piece are the fields that contain its middle.
    let l_mid = 0.5 * (l_t0 + l_t1);
    let l_ids = [];
    for (let j = 0; j < l_spans.length; ++j)
    {
      if ((l_spans[j].t_enter - S_T_EPSILON <= l_mid) && (l_mid <= l_spans[j].t_exit + S_T_EPSILON))
      {
        l_ids.push(l_spans[j].laser_index);
      }
    }
    l_ids.sort(function(a_x, a_y) { return a_x - a_y; });

    let l_last = (r_pieces.length > 0) ? r_pieces[r_pieces.length - 1] : undefined;
    if (l_last && same_ids(l_last.candidates, l_ids))
    {
      l_last.t_end = l_t1;
    }
    else
    {
      r_pieces.push({ t_start: l_t0, t_end: l_t1, candidates: l_ids });
    }
  }
  return r_pieces;
}

/**
 * Lasers whose field contains a point.
 * @param {{x:number, y:number}} a_point
 * @param {Array} a_fields
 * @return {number[]} Laser indices, possibly empty
 */
function find_candidates_for_point(a_point, a_fields)
{
  let r_ids = [];
  for (let i = 0; i < a_fields.length; ++i)
  {
    let l_f = a_fields[i];
    if ((a_point.x >= l_f.min_x) && (a_point.x <= l_f.max_x) &&
        (a_point.y >= l_f.min_y) && (a_point.y <= l_f.max_y))
    {
      r_ids.push(l_f.laser_index);
    }
  }
  return r_ids;
}

/**
 * Center of the field of a laser (= position of its scanner).
 * @return {{x:number, y:number}}
 */
function field_center(a_field)
{
  return { x: 0.5 * (a_field.min_x + a_field.max_x), y: 0.5 * (a_field.min_y + a_field.max_y) };
}

/**
 * Laser whose field center is closest to a point. Fallback for
 * geometry that no field covers, so that nothing is dropped.
 * @param {{x:number, y:number}} a_point
 * @param {Array} a_fields  At least one field
 * @return {number} Laser index
 */
function find_nearest_laser(a_point, a_fields)
{
  let r_index = a_fields[0].laser_index;
  let l_best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a_fields.length; ++i)
  {
    let l_d = distance(a_point, field_center(a_fields[i]));
    if (l_d < l_best)
    {
      l_best = l_d;
      r_index = a_fields[i].laser_index;
    }
  }
  return r_index;
}

// -----------------------------------------------------------
// Costs
// -----------------------------------------------------------

/**
 * Cost of a jump (laser off) from a_from to a_to.
 * Metric 'length' counts only the marked length, so jumps cost 0 there.
 * No jump before the first piece of a laser (a_from undefined).
 * @param {{x:number, y:number}|undefined} a_from
 * @param {{x:number, y:number}} a_to
 * @param {Object} a_cost  Cost settings (see REUSE NOTES)
 * @return {number} ms (time metric) or 0
 */
function jump_cost(a_from, a_to, a_cost)
{
  if (!a_cost.use_time || !a_from) return 0.0;
  let l_len = distance(a_from, a_to);
  return l_len / a_cost.jump_speed * 1000.0 +
    DELAYS.scaled_jump_delay(a_cost.jump_delay_ms, a_cost.min_jump_delay_ms, a_cost.jump_length_limit, l_len);
}

/**
 * Cost of marking (laser on) from a_from to a_to.
 * @param {{x:number, y:number}} a_from
 * @param {{x:number, y:number}} a_to
 * @param {Object} a_cost  Cost settings (see REUSE NOTES)
 * @param {boolean} a_with_mark_delay  true: the laser is switched off after
 *        this piece (end of a hatch vector or of a polyline), so the mark
 *        delay is added (time metric only)
 * @return {number} mm (length metric) or ms (time metric)
 */
function mark_cost_ext(a_from, a_to, a_cost, a_with_mark_delay)
{
  let l_len = distance(a_from, a_to);
  if (!a_cost.use_time) return l_len;
  let r_ms = l_len / a_cost.mark_speed * 1000.0;
  if (a_with_mark_delay) r_ms += a_cost.mark_delay_ms;
  return r_ms;
}

/**
 * Cost of marking one separate vector (laser off afterwards).
 * @return {number} mm (length metric) or ms (time metric, incl. mark delay)
 */
function mark_cost(a_from, a_to, a_cost)
{
  return mark_cost_ext(a_from, a_to, a_cost, true);
}

/**
 * Cost of one path for one laser that is currently at a_last_end.
 * Hatch mode: the points are independent vectors (0 -> 1, 2 -> 3, ...)
 * with a jump before and a mark delay after every vector. Contour /
 * open path: one continuous path (0 -> 1 -> 2 ...) with one jump at the
 * start and one mark delay at the end (the corners are marked without
 * switching the laser off).
 * @param {Array} a_points        [{x, y}]
 * @param {boolean} a_is_hatch    true = hatch mode (point pairs)
 * @param {{x:number, y:number}|undefined} a_last_end  Current position of the laser
 * @param {Object} a_cost         Cost settings
 * @return {number} mm or ms
 */
function path_cost(a_points, a_is_hatch, a_last_end, a_cost)
{
  let r_cost = 0.0;
  if (a_points.length === 0) return r_cost;
  if (a_is_hatch)
  {
    let l_pos = a_last_end;
    for (let i = 0; i + 1 < a_points.length; i += 2)
    {
      r_cost += jump_cost(l_pos, a_points[i], a_cost) + mark_cost(a_points[i], a_points[i + 1], a_cost);
      l_pos = a_points[i + 1];
    }
    return r_cost;
  }
  r_cost += jump_cost(a_last_end, a_points[0], a_cost);
  let l_last_edge = a_points.length - 2;
  for (let i = 0; i + 1 < a_points.length; ++i)
  {
    r_cost += mark_cost_ext(a_points[i], a_points[i + 1], a_cost, i === l_last_edge);
  }
  return r_cost;
}

/**
 * Proximity cost of a point for one laser (see BACKGROUND).
 * @param {{x:number, y:number}} a_point
 * @param {number} a_laser_index
 * @param {Array} a_fields
 * @param {Object} a_cost  Cost settings (proximity_weight >= 0)
 * @return {number} mm or ms (same unit as the metric)
 */
function proximity_cost(a_point, a_laser_index, a_fields, a_cost)
{
  if (!(a_cost.proximity_weight > 0.0)) return 0.0;
  let l_field = a_fields[0];
  for (let i = 0; i < a_fields.length; ++i)
  {
    if (a_fields[i].laser_index === a_laser_index) l_field = a_fields[i];
  }
  let l_d = distance(a_point, field_center(l_field));
  if (a_cost.use_time) l_d = l_d / a_cost.jump_speed * 1000.0;
  return a_cost.proximity_weight * l_d;
}

// -----------------------------------------------------------
// Choosing a laser
// -----------------------------------------------------------

/**
 * Choose the laser for one vector piece a_a -> a_b (field split strategy).
 * 0 candidates -> nearest laser, 1 -> that laser, more -> greedy.
 * Does not change a_states (the caller adds the load with add_load).
 * @param {number[]} a_candidates  Result of partition_segment_by_fields
 * @param {Array} a_states         Laser states (read only here)
 * @param {{x:number, y:number}} a_a
 * @param {{x:number, y:number}} a_b
 * @param {Array} a_fields
 * @param {Object} a_cost          Cost settings
 * @return {number} Laser index
 */
function choose_laser_for_segment(a_candidates, a_states, a_a, a_b, a_fields, a_cost)
{
  let l_mid = lerp_point(a_a, a_b, 0.5);
  if (a_candidates.length === 0) return find_nearest_laser(l_mid, a_fields);
  if (a_candidates.length === 1) return a_candidates[0];

  let r_index = a_candidates[0];
  let l_best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a_candidates.length; ++i)
  {
    let l_id = a_candidates[i];
    let l_state = a_states[l_id];
    let l_total = l_state.load + jump_cost(l_state.last_end, a_a, a_cost) + mark_cost(a_a, a_b, a_cost) +
      proximity_cost(l_mid, l_id, a_fields, a_cost);
    // '<' (not '<='): on a tie the lower laser index (earlier candidate) wins.
    if (l_total < l_best)
    {
      l_best = l_total;
      r_index = l_id;
    }
  }
  return r_index;
}

/**
 * Add one vector piece to the load of a laser.
 * @param {Object} a_state  State of the laser (modified)
 * @param {{x:number, y:number}} a_a
 * @param {{x:number, y:number}} a_b
 * @param {Object} a_cost
 */
function add_segment_load(a_state, a_a, a_b, a_cost)
{
  a_state.load += jump_cost(a_state.last_end, a_a, a_cost) + mark_cost(a_a, a_b, a_cost);
  a_state.last_end = a_b;
}

/**
 * Choose the laser for a whole path and add it to that laser's load
 * (swimlane strategies; the path is never split here).
 * The candidates are the fields that contain the path center.
 * @param {Array} a_points        [{x, y}], at least one point
 * @param {boolean} a_is_hatch    true = hatch mode
 * @param {{x:number, y:number}} a_center  Center of the path
 * @param {Array} a_states        Laser states (the chosen one is modified)
 * @param {Array} a_fields
 * @param {Object} a_cost
 * @return {number} Laser index
 */
function assign_path_to_laser(a_points, a_is_hatch, a_center, a_states, a_fields, a_cost)
{
  let l_candidates = find_candidates_for_point(a_center, a_fields);
  let r_index;
  if (l_candidates.length === 0)
  {
    r_index = find_nearest_laser(a_center, a_fields);
  }
  else if (l_candidates.length === 1)
  {
    r_index = l_candidates[0];
  }
  else
  {
    r_index = l_candidates[0];
    let l_best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < l_candidates.length; ++i)
    {
      let l_id = l_candidates[i];
      let l_total = a_states[l_id].load + path_cost(a_points, a_is_hatch, a_states[l_id].last_end, a_cost) +
        proximity_cost(a_center, l_id, a_fields, a_cost);
      if (l_total < l_best)
      {
        l_best = l_total;
        r_index = l_id;
      }
    }
  }
  add_path_load(a_states[r_index], a_points, a_is_hatch, a_cost);
  return r_index;
}

/**
 * Add a whole path to the load of a laser.
 * @param {Object} a_state  State of the laser (modified)
 * @param {Array} a_points
 * @param {boolean} a_is_hatch
 * @param {Object} a_cost
 */
function add_path_load(a_state, a_points, a_is_hatch, a_cost)
{
  if (a_points.length === 0) return;
  a_state.load += path_cost(a_points, a_is_hatch, a_state.last_end, a_cost);
  // A closed contour ends where it starts; the last point is close enough
  // for the cost estimate.
  a_state.last_end = a_points[a_points.length - 1];
}

exports.distance = distance;
exports.lerp_point = lerp_point;
exports.points_center = points_center;
exports.create_laser_states = create_laser_states;
exports.clip_segment_to_box = clip_segment_to_box;
exports.partition_segment_by_fields = partition_segment_by_fields;
exports.find_candidates_for_point = find_candidates_for_point;
exports.find_nearest_laser = find_nearest_laser;
exports.path_cost = path_cost;
exports.choose_laser_for_segment = choose_laser_for_segment;
exports.add_segment_load = add_segment_load;
exports.assign_path_to_laser = assign_path_to_laser;
exports.add_path_load = add_path_load;

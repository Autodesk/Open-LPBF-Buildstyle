/************************************************************
 * MODULE NAME: power_model.js
 *
 * PURPOSE:
 *   Pure calculation of the laser power of hatch vectors from the
 *   "return time": the time between the exposure of a point and the
 *   exposure of the neighboring point on the previous vector.
 *   A short return time means the area is still hot, so less power
 *   is needed. A long return time means the area cooled down, so
 *   more power is needed.
 *
 * BACKGROUND:
 *   MPBF background: The laser melts metal powder along hatch vectors
 *   (parallel fill lines). Each vector also heats its neighbors, because
 *   heat flows sideways into the material that was just melted.
 *   - Long vectors: when the laser comes back next to a point, a lot of
 *     time has passed and the material has cooled down -> full power.
 *   - Short vectors (small islands, narrow features, corners): the laser
 *     returns very quickly, the material is still hot and heat
 *     accumulates. With full power the energy density (energy per
 *     volume, roughly power / (speed * hatch distance * layer thickness))
 *     becomes too high, which can cause overheating, keyhole pores,
 *     swelling edges and spatter.
 *   This model therefore lowers the power for short return times and
 *   keeps the full power for long return times. Speed and hatch
 *   distance stay unchanged, only the power is adapted.
 *
 * WORKFLOW:
 *   Used by power_optimization.js in the post-processing.
 *   1. reference_time_ms: time the laser needs for one vector
 *      including the jump back to the next vector.
 *   2. power_from_time: linear mapping between two reference times
 *      (minimum and maximum vector length) and the power range.
 *   3. split_hatch_segments(_grouped): power per vector, optionally per
 *      micro vector (segment splitting); the grouped variant returns the
 *      pieces per input vector.
 *
 * USAGE:
 *   var POWER_MODEL = require('../power/power_model.js');
 *   let l_pieces = POWER_MODEL.split_hatch_segments(l_segments, l_cfg, 1000.0, 0.1, l_timing);
 *
 * DEPENDENCIES:
 *   Builtins: none (pure JavaScript, can be tested outside the host)
 *   Modules : ../util/math_utils.js, ../time/scanner_delays.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Units: lengths in mm, speeds in mm/s, delays in microseconds,
 *   times in milliseconds, power in W.
 *   Tip: "Pure" means the functions only compute a result
 *   from their arguments. They do not read or change any toolpath
 *   data, so they are easy to test and safe to call from several
 *   threads at the same time.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var MATH = require('../util/math_utils.js');
var DELAYS = require('../time/scanner_delays.js');

/**
 * Maximum number of micro vectors per vector (limits the data size).
 * Example: a 100 mm vector with a micro vector length of 0.05 mm would
 * give 2000 pieces; it is limited to 1000 pieces of 0.1 mm each.
 */
var S_MAX_PIECES = 1000;

/**
 * Neighbor search distance as a multiple of the hatch distance.
 * The previous vector normally lies exactly one hatch distance away.
 * The factor 1.5 tolerates small deviations, but a vector that is
 * further away (for example in another part of the island, after a
 * jump) is not treated as a neighbor.
 */
var S_NEIGHBOUR_FACTOR = 1.5;

/**
 * Power rounding step in W. Rounding keeps the number of different
 * power values small, so neighboring micro vectors with nearly the
 * same power get exactly the same value and can be merged.
 */
var S_POWER_STEP = 0.1;

/**
 * Time for one hatch vector of the given length including the jump to
 * the next vector (one hatch distance) and the delays.
 * This is the time after which the laser is back next to the start
 * point of the vector when it scans a block of equal, parallel vectors
 * back and forth. It is used as "return time" of a vector length.
 * Example: 10 mm at 1000 mm/s = 10 ms marking, plus 0.1 mm jump at
 * 5000 mm/s = 0.02 ms, plus the mark and jump delays.
 * @param {number} a_len        Vector length in mm
 * @param {number} a_speed      Mark speed in mm/s (speed while the laser is on)
 * @param {number} a_hatch_dist Hatch distance in mm (distance between two vectors)
 * @param {Object} a_timing  Scanner timing (see ../time/scanner_delays.js): jump
 *        speed in mm/s (laser off), delays in microseconds, optional jump delay scaling
 * @return {number} Time in ms
 */
exports.reference_time_ms = function(a_len, a_speed, a_hatch_dist, a_timing)
{
  // length / speed gives seconds; * 1000 -> ms. Delays: us / 1000 -> ms.
  return a_len / a_speed * 1000.0 +
    a_timing.mark_delay_us / 1000.0 +
    a_hatch_dist / a_timing.jump_speed * 1000.0 +
    DELAYS.jump_delay_us(a_timing, a_hatch_dist) / 1000.0;
};

/**
 * Power for a return time. Times at or below the reference time of the
 * minimum length give the minimum power, times at or above the reference
 * time of the maximum length give the maximum power.
 * Between the two reference times the power is interpolated linearly:
 *
 *   power
 *   max_power |            ________
 *             |           /
 *             |          /
 *   min_power |_________/
 *             +---------+--+---------> return time
 *                    t_lo  t_hi
 *
 * The user enters vector lengths (min_length, max_length) because they
 * are easier to imagine than times; they are converted to times with
 * reference_time_ms().
 * @param {number} a_t_ms   Return time in ms (Infinity = no neighbor)
 * @param {{min_power:number, max_power:number, min_length:number, max_length:number}} a_cfg
 *        Power range in W and the vector lengths in mm that define t_lo and t_hi
 * @param {number} a_speed       Mark speed in mm/s
 * @param {number} a_hatch_dist  Hatch distance in mm
 * @param {Object} a_timing      Timing object (see ../time/scanner_delays.js)
 * @return {number} Power in W (rounded to 0.1 W)
 */
exports.power_from_time = function(a_t_ms, a_cfg, a_speed, a_hatch_dist, a_timing)
{
  // No heated neighbor: the material is cold, use the full power.
  // Rounded like every other result: merge_equal_pieces compares the
  // powers exactly.
  if (a_t_ms === Infinity) return MATH.round_to(a_cfg.max_power, S_POWER_STEP);

  let l_t_lo = exports.reference_time_ms(a_cfg.min_length, a_speed, a_hatch_dist, a_timing);
  let l_t_hi = exports.reference_time_ms(a_cfg.max_length, a_speed, a_hatch_dist, a_timing);
  // l_f is the position between t_lo (0.0) and t_hi (1.0). If the range
  // is empty or inverted (invalid settings), the full power is used.
  let l_f = 1.0;
  if (l_t_hi > l_t_lo)
  {
    l_f = MATH.clamp((a_t_ms - l_t_lo) / (l_t_hi - l_t_lo), 0.0, 1.0);
  }
  let l_p = a_cfg.min_power + l_f * (a_cfg.max_power - a_cfg.min_power);
  return MATH.round_to(l_p, S_POWER_STEP);
};

/**
 * Start time and length of every vector along the laser timeline.
 * The timeline starts with 0 ms at the start of the first vector and
 * adds, vector by vector, the jump time (plus jump delay) from the end
 * of the previous vector and the marking time (plus mark delay).
 * Knowing when each vector starts allows to compute when any point on
 * it is exposed: t_start + distance_from_start / speed.
 * @param {Array} a_segments  [{x0, y0, x1, y1}] in scan order (mm)
 * @param {number} a_speed    Mark speed in mm/s
 * @param {Object} a_timing   Timing object (see ../time/scanner_delays.js)
 * @return {Array} [{t_start, len}] (t_start in ms, len in mm), one entry per segment
 */
function build_timeline(a_segments, a_speed, a_timing)
{
  let r_info = [];
  let l_t = 0.0;
  let l_prev = undefined;
  for (let k = 0; k < a_segments.length; ++k)
  {
    let l_s = a_segments[k];
    // The first vector has no jump in front of it.
    if (l_prev)
    {
      let l_jump = MATH.dist(l_prev.x1, l_prev.y1, l_s.x0, l_s.y0);
      l_t += l_jump / a_timing.jump_speed * 1000.0 + DELAYS.jump_delay_us(a_timing, l_jump) / 1000.0;
    }
    let l_len = MATH.dist(l_s.x0, l_s.y0, l_s.x1, l_s.y1);
    r_info.push({ t_start: l_t, len: l_len });
    l_t += l_len / a_speed * 1000.0 + a_timing.mark_delay_us / 1000.0;
    l_prev = l_s;
  }
  return r_info;
}

/**
 * Project a point onto a segment.
 * Finds the point on the segment that is closest to (a_px, a_py). The
 * result s tells how far along the segment this closest point lies;
 * it is clamped to [0, a_len], so points beyond the ends map to the
 * nearest end point.
 * @param {number} a_px   X of the point in mm
 * @param {number} a_py   Y of the point in mm
 * @param {{x0:number, y0:number, x1:number, y1:number}} a_seg  Segment in mm
 * @param {number} a_len  Length of the segment in mm (precomputed)
 * @return {{s:number, dist:number}} s = distance from the segment start in mm (clamped),
 *         dist = distance between the point and the segment in mm
 */
function project_on_segment(a_px, a_py, a_seg, a_len)
{
  // Degenerate segment (start = end): the start point is the closest point.
  if (a_len <= 0.0)
  {
    return { s: 0.0, dist: MATH.dist(a_px, a_py, a_seg.x0, a_seg.y0) };
  }
  // (l_dx, l_dy) is the unit direction of the segment. The dot product
  // of (point - start) with it gives the distance along the segment.
  let l_dx = (a_seg.x1 - a_seg.x0) / a_len;
  let l_dy = (a_seg.y1 - a_seg.y0) / a_len;
  let l_s = MATH.clamp((a_px - a_seg.x0) * l_dx + (a_py - a_seg.y0) * l_dy, 0.0, a_len);
  let l_qx = a_seg.x0 + l_dx * l_s;
  let l_qy = a_seg.y0 + l_dy * l_s;
  return { s: l_s, dist: MATH.dist(a_px, a_py, l_qx, l_qy) };
}

/**
 * Merge neighboring pieces of one vector that have the same power.
 * Fewer pieces mean less data and fewer laser on/off transitions
 * in the machine file, without changing the delivered power.
 * @param {Array} a_pieces  Pieces of ONE vector in order
 * @return {Array} New array of pieces [{x0, y0, x1, y1, power}]
 */
function merge_equal_pieces(a_pieces)
{
  let r_merged = [];
  for (let i = 0; i < a_pieces.length; ++i)
  {
    let l_p = a_pieces[i];
    let l_last = (r_merged.length > 0) ? r_merged[r_merged.length - 1] : undefined;
    // Exact comparison is fine here: powers are rounded to S_POWER_STEP.
    if (l_last && (l_last.power === l_p.power))
    {
      // Same power: extend the last piece to the end of this piece.
      l_last.x1 = l_p.x1;
      l_last.y1 = l_p.y1;
    }
    else
    {
      // Copy, so the input pieces are not modified by later merges.
      r_merged.push({ x0: l_p.x0, y0: l_p.y0, x1: l_p.x1, y1: l_p.y1, power: l_p.power });
    }
  }
  return r_merged;
}

/**
 * Split one vector into micro vectors and compute the power of each
 * piece from the return time to the previous vector.
 * Why split? Along one vector the return time is not constant. Example:
 * an island shaped like an "L": where the previous vector is short, the
 * laser comes back quickly (hot); where it is long, the area had time
 * to cool. Micro vectors allow a different power along the vector.
 * For every piece the midpoint is projected onto the previous vector.
 * The return time is "time the midpoint is exposed now" minus "time
 * the closest point of the previous vector was exposed".
 * @param {Array} a_segments  All segments of the block [{x0, y0, x1, y1}] in scan order
 * @param {Array} a_info      Timeline from build_timeline (same index as a_segments)
 * @param {number} a_k        Index of the segment to split
 * @param {Object} a_cfg      Power settings (see split_hatch_segments)
 * @param {number} a_speed       Mark speed in mm/s
 * @param {number} a_hatch_dist  Hatch distance in mm
 * @param {Object} a_timing      Timing object (see ../time/scanner_delays.js)
 * @return {Array} Pieces [{x0, y0, x1, y1, power}] of this vector
 */
function split_one_segment(a_segments, a_info, a_k, a_cfg, a_speed, a_hatch_dist, a_timing)
{
  let l_seg = a_segments[a_k];
  let l_len = a_info[a_k].len;
  // Number of pieces: at least 1, at most S_MAX_PIECES. Math.ceil makes
  // the pieces equal in length and at most microvector_length long.
  let l_n = MATH.clamp(Math.ceil(l_len / a_cfg.microvector_length), 1, S_MAX_PIECES);
  let l_dx = (l_len > 0.0) ? (l_seg.x1 - l_seg.x0) / l_len : 0.0;
  let l_dy = (l_len > 0.0) ? (l_seg.y1 - l_seg.y0) / l_len : 0.0;

  let r_pieces = [];
  for (let j = 0; j < l_n; ++j)
  {
    // Piece j covers [l_s0, l_s1] along the vector; l_s_mid is its center.
    let l_s0 = j / l_n * l_len;
    let l_s1 = (j + 1) / l_n * l_len;
    let l_s_mid = (j + 0.5) / l_n * l_len;
    let l_qx = l_seg.x0 + l_dx * l_s_mid;
    let l_qy = l_seg.y0 + l_dy * l_s_mid;
    // Time (ms) at which the laser passes the center of this piece.
    let l_t_q = a_info[a_k].t_start + l_s_mid / a_speed * 1000.0;

    let l_interval;
    if (a_k > 0)
    {
      // Only the directly preceding vector is checked: it is the most
      // recent heat source next to this piece.
      let l_proj = project_on_segment(l_qx, l_qy, a_segments[a_k - 1], a_info[a_k - 1].len);
      if (l_proj.dist <= S_NEIGHBOUR_FACTOR * a_hatch_dist)
      {
        l_interval = l_t_q - (a_info[a_k - 1].t_start + l_proj.s / a_speed * 1000.0);
      }
      else
      {
        // No neighbor nearby: the area is cold.
        l_interval = Infinity;
      }
    }
    else
    {
      // The first vector has no previous vector: use its own length.
      l_interval = exports.reference_time_ms(l_len, a_speed, a_hatch_dist, a_timing);
    }

    r_pieces.push({
      x0: l_seg.x0 + l_dx * l_s0, y0: l_seg.y0 + l_dy * l_s0,
      x1: l_seg.x0 + l_dx * l_s1, y1: l_seg.y0 + l_dy * l_s1,
      power: exports.power_from_time(l_interval, a_cfg, a_speed, a_hatch_dist, a_timing)
    });
  }

  if (a_cfg.merge_equal_power === true)
  {
    return merge_equal_pieces(r_pieces);
  }
  return r_pieces;
}

/**
 * Power for every hatch vector (or micro vector), grouped per vector.
 * Two modes:
 * - segment_splitting = false: one power per vector, computed from the
 *   vector's own length (short vector -> short return time -> lower
 *   power). Fast, and the geometry is not changed.
 * - segment_splitting = true: every vector is cut into micro vectors
 *   and each piece gets its own power from the real return time to the
 *   previous vector on the laser timeline (see split_one_segment).
 * Why grouped: the caller may pass the vectors of SEVERAL blocks as one
 * timeline (all vectors one laser scans one after the other, see
 * power_optimization.js). With micro vectors (and merge_equal_power) the
 * number of pieces per vector varies, so the pieces are returned per
 * input vector; the caller can then give every block back its own pieces.
 * @param {Array} a_segments  [{x0, y0, x1, y1}] in scan order (mm)
 * @param {{min_power:number, max_power:number, min_length:number, max_length:number,
 *          segment_splitting:boolean, microvector_length:number, merge_equal_power:boolean}} a_cfg
 *        Powers in W, lengths in mm; merge_equal_power joins neighboring
 *        micro vectors with the same power
 * @param {number} a_speed       Mark speed in mm/s
 * @param {number} a_hatch_dist  Hatch distance in mm
 * @param {Object} a_timing      Timing object (see ../time/scanner_delays.js)
 * @return {Array} One array per input vector (same index as a_segments) of
 *         pieces [{x0, y0, x1, y1, power}]; without splitting exactly one piece each
 */
exports.split_hatch_segments_grouped = function(a_segments, a_cfg, a_speed, a_hatch_dist, a_timing)
{
  let l_info = build_timeline(a_segments, a_speed, a_timing);
  let r_out = [];

  if (a_cfg.segment_splitting !== true)
  {
    // One power per vector, from the time the vector itself needs.
    for (let k = 0; k < a_segments.length; ++k)
    {
      let l_s = a_segments[k];
      let l_t = exports.reference_time_ms(l_info[k].len, a_speed, a_hatch_dist, a_timing);
      r_out.push([{
        x0: l_s.x0, y0: l_s.y0, x1: l_s.x1, y1: l_s.y1,
        power: exports.power_from_time(l_t, a_cfg, a_speed, a_hatch_dist, a_timing)
      }]);
    }
    return r_out;
  }

  // Splitting: the pieces of every vector, in scan order.
  for (let k = 0; k < a_segments.length; ++k)
  {
    r_out.push(split_one_segment(a_segments, l_info, k, a_cfg, a_speed, a_hatch_dist, a_timing));
  }
  return r_out;
};

/**
 * Power for every hatch vector (or micro vector) as one flat list.
 * Same calculation as split_hatch_segments_grouped; the pieces of all
 * vectors are returned one after the other in scan order.
 * @param {Array} a_segments     See split_hatch_segments_grouped
 * @param {Object} a_cfg         See split_hatch_segments_grouped
 * @param {number} a_speed       Mark speed in mm/s
 * @param {number} a_hatch_dist  Hatch distance in mm
 * @param {Object} a_timing      Timing object (see ../time/scanner_delays.js)
 * @return {Array} [{x0, y0, x1, y1, power}]; without splitting exactly one entry per input vector
 */
exports.split_hatch_segments = function(a_segments, a_cfg, a_speed, a_hatch_dist, a_timing)
{
  let l_groups = exports.split_hatch_segments_grouped(a_segments, a_cfg, a_speed, a_hatch_dist, a_timing);
  let r_out = [];
  for (let k = 0; k < l_groups.length; ++k)
  {
    for (let i = 0; i < l_groups[k].length; ++i) r_out.push(l_groups[k][i]);
  }
  return r_out;
};

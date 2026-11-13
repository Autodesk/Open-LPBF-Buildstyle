/************************************************************
 * MODULE NAME: exposure_time.js
 *
 * PURPOSE:
 *   Estimate the exposure time of one layer from the paths in their
 *   final processing order (marking, jumps and delays).
 *
 * BACKGROUND:
 *   MPBF background: The laser beam is moved by a scanner (moving
 *   mirrors). Its time is spent on:
 *   - Marking : the laser is on and melts powder at the mark speed
 *               (scan speed of the vector type, typically several
 *               hundred to a few thousand mm/s).
 *   - Jumping : the laser is off and the beam moves to the start of
 *               the next vector at the much higher jump speed.
 *   - Delays  : the mirrors need a short time to settle after a jump
 *               (jump delay, shorter for short jumps if configured) and
 *               at the end of a marked sequence (mark delay: after every
 *               hatch vector, once per contour or open polyline), so the
 *               laser does not switch on or off while the beam is still
 *               accelerating. Delays are given in microseconds and add
 *               up over thousands of vectors. The rules are defined in
 *               ../time/scanner_delays.js.
 *   The exposure order matters for the time: long jumps between far
 *   away islands cost time, therefore the time is estimated AFTER the
 *   sorting, along the final order.
 *   - Several lasers: each laser works through its own paths (attribute
 *     'laser_index') at the same time as the others. The time and the
 *     last position are therefore tracked per laser, and the layer is
 *     finished when the slowest laser is finished (maximum, not sum).
 *
 * WORKFLOW:
 *   - estimate_layer_time_ms: called in the multi-threaded
 *     post-processing step after the exposure sorting. The result is
 *     stored per layer in a tray attribute and summed up for the whole
 *     build at the end.
 *   - estimate_hatch_time_ms: called in makeExposureLayer for the
 *     vectors of one layer of one model, before the sorting. The host
 *     shows this value as layer time in the exposure preview.
 *   Both use the same formula per path (add_path_time).
 *
 * USAGE:
 *   var EXPOSURE_TIME = require('../time/exposure_time.js');
 *   let l_ms = EXPOSURE_TIME.estimate_layer_time_ms(modelData, n, l_timing, l_speed_lookup);
 *   let l_table = EXPOSURE_TIME.build_speed_table(l_part);
 *   let l_ms2 = EXPOSURE_TIME.estimate_hatch_time_ms(hatchResult, l_timing, l_table);
 *
 * DEPENDENCIES:
 *   Builtins: bsPolylineIterator
 *   Modules : ../util/math_utils.js, ../util/attribute_names.js,
 *             ../multi_laser/laser_bsid.js, ../time/scanner_delays.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   This is an estimate: acceleration, recoating and machine
 *   specific waiting times are not included.
 *   Units: lengths in mm, speeds in mm/s, delays in microseconds,
 *   results in milliseconds (length / speed = seconds, * 1000 = ms).
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var POLY_IT = requireBuiltin('bsPolylineIterator');
var MATH = require('../util/math_utils.js');
var ATTR = require('../util/attribute_names.js').ATTR;
var LASER_BSID = require('../multi_laser/laser_bsid.js');
var DELAYS = require('../time/scanner_delays.js');

/**
 * Mark speed (mm/s) used if no speed is known for a path.
 * Only a fallback so that the estimate never divides by zero.
 */
var S_DEFAULT_SPEED = 1000.0;

/**
 * Mark speed of a path: path attribute, then speed table, then default.
 * The path attribute is checked first because it is the value that is
 * really exported. The speed table (speed per BSID from the
 * parameters) covers paths that carry no speed attribute.
 * @param {bsPolylineIterator|bsHatchBlock} a_path
 * @param {Object|undefined} a_table  Speed table of the model of the path: { '<bsid>': speed }
 * @return {number} Speed in mm/s (> 0)
 */
function get_speed(a_path, a_table)
{
  let l_v = a_path.getAttributeRealExt(ATTR.SPEED);
  if ((typeof l_v === 'number') && (l_v > 0.0)) return l_v;

  let l_bsid = a_path.getAttributeIntExt(ATTR.BSID);
  if (a_table && (typeof l_bsid === 'number'))
  {
    let l_s = a_table[String(l_bsid)];
    // Laser bsids (e.g. 2500) use the speed of their vector type (500).
    if (typeof l_s !== 'number') l_s = a_table[String(LASER_BSID.type_bsid(l_bsid))];
    if ((typeof l_s === 'number') && (l_s > 0.0)) return l_s;
  }
  return S_DEFAULT_SPEED;
}

/**
 * Number of mark delays of a path: one per marked sequence, i.e. every
 * time the laser is switched off (see ../time/scanner_delays.js).
 * - Hatch : points come in pairs, one vector (and one mark delay) per pair.
 * - Closed / open polyline: the corners are marked without switching
 *   the laser off, so there is one mark delay at the end of the path
 *   (if it marks anything, i.e. has at least two points).
 * @param {number} a_mode   Polyline mode (POLY_IT.nPolyHatch, nPolyClosed or open)
 * @param {number} a_count  Point count
 * @return {number}
 */
function get_mark_delay_count(a_mode, a_count)
{
  if (a_mode === POLY_IT.nPolyHatch) return Math.floor(a_count / 2);
  return (a_count >= 2) ? 1 : 0;
}

/**
 * Timing settings with the delays converted once: microseconds -> milliseconds.
 * @param {{jump_speed:number, mark_delay_us:number, jump_delay_us:number,
 *          min_jump_delay_us:(number|undefined), jump_length_limit:(number|undefined)}} a_timing
 * @return {{jump_speed:number, jump_delay_ms:number, mark_delay_ms:number,
 *           min_jump_delay_ms:(number|undefined), jump_length_limit:(number|undefined)}}
 */
function to_timing_ms(a_timing)
{
  return {
    jump_speed: a_timing.jump_speed,
    jump_delay_ms: a_timing.jump_delay_us / 1000.0,
    mark_delay_ms: a_timing.mark_delay_us / 1000.0,
    // undefined stays undefined (no scaling, see scanner_delays.js).
    min_jump_delay_ms: (typeof a_timing.min_jump_delay_us === 'number') ? a_timing.min_jump_delay_us / 1000.0 : undefined,
    jump_length_limit: a_timing.jump_length_limit
  };
}

/**
 * Jump delay in ms for a jump of the given length.
 * @param {Object} a_timing_ms  Result of to_timing_ms
 * @param {number} a_length     Jump length in mm
 * @return {number} ms
 */
function jump_delay_ms(a_timing_ms, a_length)
{
  return DELAYS.scaled_jump_delay(a_timing_ms.jump_delay_ms, a_timing_ms.min_jump_delay_ms,
    a_timing_ms.jump_length_limit, a_length);
}

/**
 * State of one laser, created on its first path.
 * @param {Map} a_lasers   laser index -> { t: time in ms, pos: last position }
 * @param {number|undefined} a_laser_v  Value of the 'laser_index' attribute
 * @return {{t:number, pos:({x:number, y:number}|undefined)}}
 */
function get_laser_state(a_lasers, a_laser_v)
{
  // Paths without 'laser_index' count for laser 0.
  let l_index = (typeof a_laser_v === 'number') ? a_laser_v : 0;
  if (!a_lasers.has(l_index))
  {
    // pos is undefined before the first path of a laser (the jump from
    // the scanner rest position to the first path is not counted).
    a_lasers.set(l_index, { t: 0.0, pos: undefined });
  }
  return a_lasers.get(l_index);
}

/**
 * Add the time of one path to the time of its laser: the jump from the
 * last laser position to the start of the path, the marking, the jumps
 * inside the path and the delays. Updates the laser position.
 * Works for polyline iterators and hatch blocks (same length functions).
 * @param {{t:number, pos:Object}} a_laser  State of the laser (modified)
 * @param {bsPolylineIterator|bsHatchBlock} a_path  Path with at least one point
 * @param {{x:number, y:number}} a_first  First point of the path (mm)
 * @param {{x:number, y:number}} a_last   Last point of the path (mm)
 * @param {number} a_speed  Mark speed in mm/s
 * @param {Object} a_timing_ms  Result of to_timing_ms
 * @return {void}
 */
function add_path_time(a_laser, a_path, a_first, a_last, a_speed, a_timing_ms)
{
  let l_t = a_laser.t;
  if (a_laser.pos)
  {
    let l_jump = MATH.dist(a_laser.pos.x, a_laser.pos.y, a_first.x, a_first.y);
    l_t += l_jump / a_timing_ms.jump_speed * 1000.0 + jump_delay_ms(a_timing_ms, l_jump);
  }

  // getExposureLength: total length with laser on (mm).
  // getSkipLength / getSkipCount: total length and number of the
  // jumps between the vectors of a hatch (0 for contours and open
  // polylines, which are marked without interruption).
  let l_mode = a_path.getPolylineMode();
  l_t += a_path.getExposureLength() / a_speed * 1000.0;
  let l_skip_count = a_path.getSkipCount();
  if (l_skip_count > 0)
  {
    let l_skip_len = a_path.getSkipLength();
    l_t += l_skip_len / a_timing_ms.jump_speed * 1000.0;
    // Only the total skip length is known, not every single jump, so
    // the delay is taken for the mean jump length. This is exact while
    // all jumps are shorter than the length limit (the delay is linear
    // there) or the scaling is off; otherwise it is a slight
    // overestimate. Reading every jump would cost far more time.
    l_t += l_skip_count * jump_delay_ms(a_timing_ms, l_skip_len / l_skip_count);
  }
  l_t += get_mark_delay_count(l_mode, a_path.getPointCount()) * a_timing_ms.mark_delay_ms;

  // A closed contour ends where it started.
  a_laser.pos = (l_mode === POLY_IT.nPolyClosed) ? a_first : a_last;
  a_laser.t = l_t;
}

/**
 * Time of the slowest laser.
 * @param {Map} a_lasers  laser index -> { t, pos }
 * @return {number} Time in ms
 */
function max_laser_time(a_lasers)
{
  let r_max = 0.0;
  a_lasers.forEach(function(a_laser) { r_max = Math.max(r_max, a_laser.t); });
  return r_max;
}

/**
 * Mark speed per vector type of one part (fallback for paths without
 * speed attribute).
 * @param {Object} a_part  PartSettings with 'scanning': { '<bsid>': { speed, ... } }
 * @return {Object} { '<bsid>': speed in mm/s }
 */
exports.build_speed_table = function(a_part)
{
  let r_table = {};
  let l_keys = Object.keys(a_part.scanning);
  for (let k = 0; k < l_keys.length; ++k)
  {
    r_table[l_keys[k]] = a_part.scanning[l_keys[k]].speed;
  }
  return r_table;
};

/**
 * Estimated exposure time of one layer.
 * The paths are visited in processing order. For each path the time
 * of the jump from the previous position of ITS laser, the marking
 * time, the jumps inside the path and the delays are added to the time
 * of that laser. Paths without 'laser_index' count for laser 0.
 * @param {bsModelData} a_model_data
 * @param {number} a_layer_nr
 * @param {Object} a_timing  Timing object (see ../time/scanner_delays.js):
 *        jump speed in mm/s, delays in microseconds, optional jump delay scaling
 * @param {Array} a_speed_lookup  Per model index: { '<bsid>': speed in mm/s }
 *                                (fallback for paths without speed attribute)
 * @return {number} Time in ms (of the slowest laser)
 */
exports.estimate_layer_time_ms = function(a_model_data, a_layer_nr, a_timing, a_speed_lookup)
{
  let l_timing_ms = to_timing_ms(a_timing);
  let l_lasers = new Map();

  // nLayerExposureInProcessingOrder: iterate in the order written by
  // the exposure sorter ('_processing_order').
  let l_it = a_model_data.getFirstLayerPolyline(a_layer_nr, POLY_IT.nLayerExposureInProcessingOrder);
  while (l_it.isValid())
  {
    let l_count = l_it.getPointCount();
    if (l_count > 0)
    {
      let l_laser = get_laser_state(l_lasers, l_it.getAttributeIntExt(ATTR.LASER_INDEX));
      let l_table = a_speed_lookup ? a_speed_lookup[l_it.getModelIndex()] : undefined;
      add_path_time(l_laser, l_it, l_it.getXYCoord(0), l_it.getXYCoord(l_count - 1),
        get_speed(l_it, l_table), l_timing_ms);
    }
    l_it.next();
  }
  return max_laser_time(l_lasers);
};

/**
 * Estimated exposure time of the vectors in a hatch (one layer of one
 * model), in the order of its hatch blocks. Same formula as
 * estimate_layer_time_ms; used before the sorting, so it is a rougher
 * estimate (the final order and the jumps between models are unknown).
 * @param {bsHatch} a_hatch
 * @param {Object} a_timing  Timing object (see ../time/scanner_delays.js):
 *        jump speed in mm/s, delays in microseconds, optional jump delay scaling
 * @param {Object} a_speed_table  { '<bsid>': speed in mm/s } (see build_speed_table)
 * @return {number} Time in ms (of the slowest laser)
 */
exports.estimate_hatch_time_ms = function(a_hatch, a_timing, a_speed_table)
{
  let l_timing_ms = to_timing_ms(a_timing);
  let l_lasers = new Map();

  let l_blocks = a_hatch.getHatchBlockArray();
  for (let i = 0; i < l_blocks.length; ++i)
  {
    let l_block = l_blocks[i];
    let l_count = l_block.getPointCount();
    if (l_count > 0)
    {
      let l_laser = get_laser_state(l_lasers, l_block.getAttributeIntExt(ATTR.LASER_INDEX));
      add_path_time(l_laser, l_block, l_block.getPoint(0), l_block.getPoint(l_count - 1),
        get_speed(l_block, a_speed_table), l_timing_ms);
    }
  }
  return max_laser_time(l_lasers);
};

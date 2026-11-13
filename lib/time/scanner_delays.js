/************************************************************
 * MODULE NAME: scanner_delays.js
 *
 * PURPOSE:
 *   One place for the delay rules of the scanner, so that the time
 *   estimate, the power optimization, the laser assignment and the
 *   LSR time column all use the same rules.
 *
 * BACKGROUND:
 *   MPBF background: The laser beam is moved by two small mirrors (the
 *   scanner). After a jump (laser off) the mirrors need a short time
 *   to settle before marking starts: the jump delay. A short jump
 *   moves the mirrors only a little, so they settle faster. Many
 *   scanner controllers therefore scale the jump delay with the jump
 *   length:
 *
 *   delay
 *   jump_delay     |          __________
 *                  |         /
 *                  |        /
 *   min_jump_delay |_______/
 *                  +-------+--------------> jump length
 *                  0     jump_length_limit
 *
 *   - jump length >= jump_length_limit: full jump delay
 *   - shorter jumps: linear between min_jump_delay (length 0) and the
 *     full jump delay (length = jump_length_limit)
 *   - jump_length_limit <= 0 switches the scaling off (full delay for
 *     every jump); this is also the result if the timing object has no
 *     scaling fields at all, so older settings keep their behavior.
 *   - min_jump_delay >= jump_delay: no scaling (full delay)
 *   - Jumps of (almost) zero length are no jumps: no delay.
 *   The mark delay (after a marked vector) is not scaled. It is spent
 *   once per marked sequence: after every hatch vector, and once at the
 *   end of a contour or open polyline (the corners of a polyline are
 *   marked without switching the laser off).
 *
 * WORKFLOW:
 *   Called by lib/time/exposure_time.js, lib/power/power_model.js,
 *   lib/export/lsr_writer.js and lib/multi_laser/laser_assignment_math.js.
 *
 * USAGE:
 *   var DELAYS = require('../time/scanner_delays.js');
 *   let l_us = DELAYS.jump_delay_us(a_timing, l_jump_len);
 *   let l_ms = DELAYS.scaled_jump_delay(0.05, 0.01, 1.0, l_jump_len);
 *
 * DEPENDENCIES:
 *   Builtins: none (pure JavaScript, can be tested outside the host)
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it.
 *   Timing object (all fields except the first three are optional):
 *     { jump_speed (mm/s), mark_delay_us, jump_delay_us,
 *       min_jump_delay_us, jump_length_limit (mm) }
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

/** Jumps shorter than this (mm) are no jumps and get no delay. */
var S_MIN_JUMP = 1e-6;
exports.MIN_JUMP = S_MIN_JUMP;

/**
 * Jump delay for one jump, in the unit of the given delays.
 * Unit independent: pass both delays in microseconds or both in
 * milliseconds, the result has the same unit.
 * @param {number} a_full_delay   Delay of a long jump (>= 0)
 * @param {number|undefined} a_min_delay  Delay of a jump of length 0
 *                                (undefined or invalid = no scaling)
 * @param {number|undefined} a_length_limit  Jump length (mm) from which on
 *                                the full delay applies (<= 0 or undefined = no scaling)
 * @param {number} a_jump_length  Length of the jump in mm
 * @return {number} Delay (0 for jumps shorter than MIN_JUMP)
 */
exports.scaled_jump_delay = function(a_full_delay, a_min_delay, a_length_limit, a_jump_length)
{
  if (!(a_jump_length > S_MIN_JUMP)) return 0.0;
  // The negated comparisons are also true for undefined and NaN, so
  // missing or invalid scaling settings give the full delay.
  if (!(a_length_limit > 0.0) || !(a_min_delay >= 0.0) || !(a_min_delay < a_full_delay) ||
      (a_jump_length >= a_length_limit))
  {
    return a_full_delay;
  }
  return a_min_delay + (a_full_delay - a_min_delay) * (a_jump_length / a_length_limit);
};

/**
 * Jump delay in microseconds for one jump.
 * @param {{jump_delay_us:number, min_jump_delay_us:(number|undefined),
 *          jump_length_limit:(number|undefined)}} a_timing
 * @param {number} a_jump_length  Length of the jump in mm
 * @return {number} Delay in microseconds
 */
exports.jump_delay_us = function(a_timing, a_jump_length)
{
  return exports.scaled_jump_delay(a_timing.jump_delay_us, a_timing.min_jump_delay_us,
    a_timing.jump_length_limit, a_jump_length);
};

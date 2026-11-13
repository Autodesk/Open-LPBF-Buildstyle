/************************************************************
 * MODULE NAME: math_utils.js
 *
 * PURPOSE:
 *   Basic math helpers (angles, clamping, rounding, distances,
 *   number formatting) used by many other modules.
 *
 * WORKFLOW:
 *   Used in all phases. Pure functions without side effects.
 *
 * USAGE:
 *   var MATH = require('../util/math_utils.js');
 *   let l_rad = MATH.deg_to_rad(45.0);
 *   let l_len = MATH.dist(0, 0, 3, 4);   // 5
 *
 * DEPENDENCIES:
 *   Builtins: none (pure module, can be tested with Node.js)
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Tip: A JavaScript module is one file. Everything assigned
 *   to 'exports' (exports.clamp = ...) is visible to the files that
 *   load it with require(); everything else stays private to the file.
 *   "Without side effects" means the functions change nothing outside;
 *   they are therefore safe to use from several threads.
 *   Coordinates and distances are in mm in this project; the helpers
 *   themselves work with any unit.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

/**
 * Convert degrees to radians.
 * The user enters angles in degrees (for example the hatch angle),
 * while Math.sin / Math.cos expect radians (180 degrees = PI radians).
 * @param {number} a_deg  Angle in degrees
 * @return {number} Angle in radians
 */
exports.deg_to_rad = function(a_deg)
{
  return a_deg * Math.PI / 180.0;
};

/**
 * Convert radians to degrees.
 * @param {number} a_rad  Angle in radians
 * @return {number} Angle in degrees
 */
exports.rad_to_deg = function(a_rad)
{
  return a_rad * 180.0 / Math.PI;
};

/**
 * Limit a value to the range [a_lo, a_hi].
 * Example: clamp(1.4, 0.0, 1.0) -> 1.0, clamp(-3, 0, 10) -> 0.
 * @param {number} a_v   Value
 * @param {number} a_lo  Lower limit
 * @param {number} a_hi  Upper limit (must be >= a_lo)
 * @return {number} Clamped value
 */
exports.clamp = function(a_v, a_lo, a_hi)
{
  if (a_v < a_lo) return a_lo;
  if (a_v > a_hi) return a_hi;
  return a_v;
};

/**
 * Mathematical modulo. The result always has the sign of a_b.
 * Tip: In JavaScript, (-1 % 3) is -1. This function returns 2,
 * which is what you usually want for angles and cyclic indices.
 * @param {number} a_a  Dividend
 * @param {number} a_b  Divisor (must not be 0)
 * @return {number} a_a mod a_b
 */
exports.mod = function(a_a, a_b)
{
  // The first % can give a negative result; adding a_b makes it
  // positive, and the second % brings it back into [0, a_b).
  return ((a_a % a_b) + a_b) % a_b;
};

/**
 * Normalize an angle to the range [0, 360).
 * Example: 370 -> 10, -90 -> 270. Used for example for the hatch
 * angle, which grows by a fixed rotation step from layer to layer.
 * @param {number} a_deg  Angle in degrees
 * @return {number} Angle in [0, 360)
 */
exports.normalize_deg_360 = function(a_deg)
{
  let r_deg = exports.mod(a_deg, 360.0);
  // Guard against floating point results like 359.99999999999994 + tiny
  // rounding that ends up at exactly 360.
  if (r_deg >= 360.0) r_deg = 0.0;
  return r_deg;
};

/**
 * Round a value to a multiple of a step (e.g. 0.1).
 * Example: round_to(123.456, 0.1) -> 123.5.
 * @param {number} a_v     Value
 * @param {number} a_step  Step size (> 0); 0, negative or NaN returns a_v unchanged
 * @return {number} Rounded value
 */
exports.round_to = function(a_v, a_step)
{
  // !(a_step > 0) is also true for NaN and undefined, unlike (a_step <= 0).
  if (!(a_step > 0)) return a_v;
  let l_count = Math.round(a_v / a_step);
  // Round again to remove binary representation noise (0.30000000000000004).
  return Number((l_count * a_step).toPrecision(12));
};

/**
 * Euclidean distance between two points.
 * (Pythagoras: sqrt(dx * dx + dy * dy).)
 * @param {number} a_ax  X of point A
 * @param {number} a_ay  Y of point A
 * @param {number} a_bx  X of point B
 * @param {number} a_by  Y of point B
 * @return {number} Distance (same unit as the coordinates, mm here)
 */
exports.dist = function(a_ax, a_ay, a_bx, a_by)
{
  let l_dx = a_bx - a_ax;
  let l_dy = a_by - a_ay;
  return Math.sqrt(l_dx * l_dx + l_dy * l_dy);
};

/**
 * Format an integer with leading zeros.
 * Used for example for time strings (h:mm:ss) and layer numbers in
 * file names.
 * @param {number} a_n      Integer (>= 0); fractions are cut off, a
 *                          negative value gets a '-' in front of the zeros
 * @param {number} a_width  Minimum number of digits
 * @return {string} e.g. pad_int(7, 3) -> '007'
 */
exports.pad_int = function(a_n, a_width)
{
  let r_str = Math.floor(Math.abs(a_n)).toString();
  while (r_str.length < a_width)
  {
    r_str = '0' + r_str;
  }
  if (a_n < 0) r_str = '-' + r_str;
  return r_str;
};

/**
 * Check if a value is a finite number (not NaN, not Infinity, not a string).
 * Tip: The global isFinite('12') is true, because it converts
 * the string to a number first. The typeof check rejects strings.
 * @param {*} a_v  Any value
 * @return {boolean} true if a_v is a finite number
 */
exports.is_finite_number = function(a_v)
{
  return (typeof a_v === 'number') && isFinite(a_v);
};

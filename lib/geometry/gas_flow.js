/************************************************************
 * MODULE NAME: gas_flow.js
 *
 * PURPOSE:
 *   Helpers for the shielding gas flow direction. Used to sort
 *   exposure data so that areas further downstream are exposed
 *   first.
 *
 * WORKFLOW:
 *   - makeExposureLayer: hatch block sort direction
 *   - post-processing: island / model / stripe sorting
 *
 * USAGE:
 *   var GAS_FLOW = require('../geometry/gas_flow.js');
 *   let l_dir = GAS_FLOW.flow_direction(90.0);      // gas flows to +Y
 *   let l_key = GAS_FLOW.downstream_key(x, y, l_dir); // smaller = expose first
 *
 * DEPENDENCIES:
 *   Builtins: none (pure module, can be tested with Node.js)
 *   Modules : ../util/math_utils.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *
 * BACKGROUND:
 *   MPBF background: During exposure the build chamber is flushed
 *   with an inert shielding gas (e.g. argon or nitrogen) that flows
 *   across the build plate from an inlet on one side to an outlet on
 *   the other side. The laser creates spatter (ejected metal droplets)
 *   and fume / soot (condensed metal vapor). The gas flow carries them
 *   "downstream", towards the outlet. Particles that land on powder
 *   which is still to be melted, or that cross the laser beam, cause
 *   defects (lack of fusion, pores, rough surfaces).
 *   "Upstream" = towards the gas inlet, "downstream" = towards the outlet.
 *
 * Why "downstream first"?
 *   Spatter and fume are carried by the gas towards downstream.
 *   If the downstream areas are exposed first, the particles fall
 *   on areas that are already exposed and do not disturb the melt
 *   pool of areas that are still to be exposed.
 *   In other words: the exposure progresses AGAINST the gas flow,
 *   so the laser always works in "clean" gas, and the dirt is blown
 *   onto material that is already finished for this layer.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var MATH = require('../util/math_utils.js');

/**
 * Unit vector of the direction INTO which the gas flows.
 * A unit vector has the length 1, so it only describes a direction.
 * Example: 0 degrees -> {x: 1, y: 0} (gas flows to +X),
 *          90 degrees -> {x: 0, y: 1} (gas flows to +Y).
 * @param {number} a_angle_deg  Angle measured counter-clockwise from +X, in degrees
 * @return {{x:number, y:number}} Unit vector
 */
exports.flow_direction = function(a_angle_deg)
{
  let l_rad = MATH.deg_to_rad(a_angle_deg);
  return { x: Math.cos(l_rad), y: Math.sin(l_rad) };
};

/**
 * Vector pointing against the gas flow (towards the gas inlet).
 * Used as the "progress direction" of the hatch block sort: the
 * exposure front moves along this vector, i.e. upstream.
 * @param {{x:number, y:number}} a_dir  Gas flow direction
 * @return {{x:number, y:number}} Opposite vector
 */
exports.against_flow = function(a_dir)
{
  return { x: -a_dir.x, y: -a_dir.y };
};

/**
 * Sort key of a point with respect to the gas flow.
 * A SMALLER key means the point is further DOWNSTREAM and is exposed first.
 * HOW: the dot product (x * dir.x + y * dir.y) is the position of the
 * point measured along the flow direction (larger = further
 * downstream). It is negated so that a normal ascending sort
 * (smallest key first) gives the "downstream first" order.
 * @param {number} a_x  X coordinate in mm
 * @param {number} a_y  Y coordinate in mm
 * @param {{x:number, y:number}} a_dir  Gas flow direction
 * @return {number} Sort key in mm (negative projection onto the flow direction)
 */
exports.downstream_key = function(a_x, a_y, a_dir)
{
  return -(a_x * a_dir.x + a_y * a_dir.y);
};

/**
 * Position of a point ACROSS the gas flow.
 * Used as second sort key when several paths are equally far
 * downstream (same bucket): they are then exposed in one sweep across
 * the flow instead of in an arbitrary order.
 * HOW: dot product with the flow direction turned by +90 degrees
 * (-dir.y, dir.x). Example: gas flow to +X -> the key is y, so a band of
 * paths at the same X position is exposed from small to large Y.
 * @param {number} a_x  X coordinate in mm
 * @param {number} a_y  Y coordinate in mm
 * @param {{x:number, y:number}} a_dir  Gas flow direction
 * @return {number} Key in mm (projection onto the direction across the flow)
 */
exports.cross_key = function(a_x, a_y, a_dir)
{
  return a_x * (-a_dir.y) + a_y * a_dir.x;
};

/**
 * Put a sort key into a bucket of the given size.
 * Islands whose keys differ by less than the bucket size are treated
 * as "at the same position". This makes the sort order stable against
 * tiny numeric differences between layers.
 * Example with a bucket size of 1 mm: keys 3.2 and 3.9 -> bucket 3
 * (same position, other sort criteria decide); key 4.1 -> bucket 4.
 * Note: keys close to a bucket border (e.g. 3.99 and 4.01) still land
 * in different buckets; the buckets only reduce such flips, they
 * cannot avoid them completely.
 * @param {number} a_key          Sort key from downstream_key()
 * @param {number} a_bucket_size  Bucket size in mm (> 0)
 * @return {number} Integer bucket index (a_key unchanged if the size is not > 0)
 */
exports.bucket = function(a_key, a_bucket_size)
{
  if (!(a_bucket_size > 0)) return a_key;
  return Math.floor(a_key / a_bucket_size);
};

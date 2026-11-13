/************************************************************
 * MODULE NAME: island_ops.js
 *
 * PURPOSE:
 *   Simple, side-effect free wrappers for the most common island
 *   (area) operations: offset, intersection, subtraction, opening.
 *
 * WORKFLOW:
 *   Called from makeExposureLayer to compute contour offsets,
 *   skin areas and hatch areas.
 *
 * USAGE:
 *   var ISL = require('../geometry/island_ops.js');
 *   let l_inner = ISL.offset(a_island, -0.1);      // 0.1 mm inwards
 *   let l_rest = ISL.subtract(l_inner, l_skin);
 *
 * DEPENDENCIES:
 *   Builtins: bsIsland
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   All functions return NEW islands and never modify their inputs.
 *   Tip: Most island builtins work "in place" (they change
 *   the island they are called on). Using these wrappers avoids
 *   accidental changes of islands that are still needed later.
 *
 * BACKGROUND:
 *   - A layer is one horizontal slice of the build (typically 20 to
 *     100 micrometers thick). Each layer of a part consists of one or
 *     more islands.
 *   - An island (bsIsland) is one closed region of a part in one layer:
 *     an outer contour plus optional holes. A bsIsland object can also
 *     hold several such regions at once (e.g. all stripes of an area).
 *   - All coordinates and distances are in mm in the build plane (X/Y).
 *   - Almost every step of the build style is "area math": shrink the
 *     island for the laser spot (offset), cut out the overhang area
 *     (subtract), keep only the common part of two areas (intersect).
 *     These four helpers are the vocabulary used for that.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

// Tip: requireBuiltin() loads a module that is built into the
// host application (here: the island/area geometry). require() loads a
// JavaScript file of this project. Functions assigned to 'exports.xyz'
// are the public interface of this file; everything else stays private.
var ISLAND = requireBuiltin('bsIsland');

/**
 * Create an empty island.
 * Used as the "nothing" result, so callers can always call isEmpty()
 * on the return value instead of checking for null or undefined.
 * @return {bsIsland} New empty island
 */
exports.empty = function()
{
  return new ISLAND.bsIsland();
};

/**
 * Offset an island.
 * Every boundary (outer contour and holes) is moved by the same
 * distance. Shrinking an island moves the outer contour inwards AND
 * makes the holes larger; regions narrower than 2 * |a_dist| vanish.
 * MPBF background: The laser melts a spot with a finite width, so the
 * path of the beam center must lie about half a melt track width inside
 * the part outline ("beam compensation"); otherwise the part grows.
 * @param {bsIsland} a_isl   Input island (not modified)
 * @param {number}   a_dist  Offset in mm. Negative = inwards (shrink), positive = outwards (grow)
 * @return {bsIsland} New island (may be empty if everything vanished)
 */
exports.offset = function(a_isl, a_dist)
{
  if (a_isl.isEmpty()) return exports.empty();
  // A zero offset still returns a copy, so the "never modify the input"
  // promise also holds when the caller changes the result later.
  if (a_dist === 0) return a_isl.clone();
  let r_isl = new ISLAND.bsIsland();
  a_isl.createOffset(r_isl, a_dist);
  return r_isl;
};

/**
 * Intersection (common area) of two islands.
 * Example: intersect(downskin, hatch area) = the part of the hatch area
 * that lies above powder.
 * @param {bsIsland} a_a  Island A (not modified)
 * @param {bsIsland} a_b  Island B (not modified)
 * @return {bsIsland} New island A AND B
 */
exports.intersect = function(a_a, a_b)
{
  if (a_a.isEmpty() || a_b.isEmpty()) return exports.empty();
  // intersectEx works in place, so the operation runs on a clone of A.
  // Non-zero fill rule: a point counts as "inside" if the winding number
  // of the outlines around it is not zero (holes run the other way round).
  let r_isl = a_a.clone();
  r_isl.intersectEx(ISLAND.nFillRuleNonZero, ISLAND.nFillRuleNonZero, a_b);
  return r_isl;
};

/**
 * Subtract island B from island A.
 * Example: subtract(hatch area, downskin) = the part of the hatch area
 * that rests on solid material from the layers below.
 * @param {bsIsland} a_a  Island A (not modified)
 * @param {bsIsland} a_b  Island B (not modified)
 * @return {bsIsland} New island A WITHOUT B
 */
exports.subtract = function(a_a, a_b)
{
  if (a_a.isEmpty()) return exports.empty();
  if (a_b.isEmpty()) return a_a.clone();
  // subtractEx works in place: clone A first (same fill rule as intersect).
  let r_isl = a_a.clone();
  r_isl.subtractEx(ISLAND.nFillRuleNonZero, ISLAND.nFillRuleNonZero, a_b);
  return r_isl;
};

/**
 * Morphological "opening": removes all parts of the island that are
 * narrower than a_width, then clips the result to a_clip.
 * Used to drop tiny skin slivers that would only produce short vectors.
 * HOW: shrink by half the width (thin regions vanish completely), then
 * grow back by the same amount (wide regions get their size back, but
 * sharp corners become slightly rounded). Growing may also push the
 * result outside of the original outline, so it is clipped to a_clip.
 * WHY: skin detection often returns long, very thin strips along
 * sloped walls. Hatching them gives many tiny vectors with their own
 * (e.g. low power) parameters, which costs time and gives no benefit.
 * @param {bsIsland} a_isl    Input island (not modified)
 * @param {number}   a_width  Minimum width in mm (<= 0 = no filtering)
 * @param {bsIsland} a_clip   Island to clip the result to (e.g. the original island)
 * @return {bsIsland} New island
 */
exports.opening = function(a_isl, a_width, a_clip)
{
  if (a_isl.isEmpty()) return exports.empty();
  // Written as !(x > 0) so that NaN or undefined also mean "no filtering".
  if (!(a_width > 0)) return a_isl.clone();
  let l_half = a_width / 2.0;
  let l_shrunk = exports.offset(a_isl, -l_half);
  let l_grown = exports.offset(l_shrunk, l_half);
  return exports.intersect(l_grown, a_clip);
};

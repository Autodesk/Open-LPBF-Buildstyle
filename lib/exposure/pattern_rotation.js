/************************************************************
 * MODULE NAME: pattern_rotation.js
 *
 * PURPOSE:
 *   Compute the hatch line angle of a layer: start angle plus a
 *   rotation increment per layer, optionally mapped into a
 *   limitation window (e.g. "never parallel to the gas flow").
 *
 * WORKFLOW:
 *   Called from makeExposureLayer (main hatch angle) and from the
 *   hatch pattern module (chess / hexagon sub-groups).
 *
 * USAGE:
 *   var ROTATION = require('../exposure/pattern_rotation.js');
 *   let l_angle = ROTATION.get_line_angle(l_hatch_cfg.rotation, l_layer_index, l_gas_angle, 0);
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
 *   MPBF background: If every layer were hatched in the same direction,
 *   the melt tracks of all layers would lie exactly on top of each
 *   other. The part would get direction dependent properties, residual
 *   stress would add up along one axis (risk of warping and cracks),
 *   and small gaps between tracks could line up over many layers to
 *   channels of porosity. Rotating the hatch direction from layer to
 *   layer avoids this.
 *   Why 67 degrees (default increment)? Hatch lines repeat after 180
 *   degrees. 67 has no common divisor with 180, so k * 67 (mod 180)
 *   only returns to the same direction after 180 layers; directions
 *   of nearby layers are always clearly different. A "round" value like
 *   90 degrees would repeat after only 2 layers.
 *   Example (start 0, increment 67, no window): 0, 67, 134, 201, 268 ...
 *
 * Angle conventions (important for the window below):
 *   - The gas flow angle is measured counter-clockwise from the +X axis
 *     (see lib/geometry/gas_flow.js).
 *   - All hatch angles here are hatch ANGLE VALUES, the value that is
 *     passed to hatchExt2 (and to createStripes / createRectangles /
 *     createHexagons): start angle, increment, window direction and the
 *     returned angle. For the value 0 hatchExt2 creates lines parallel to
 *     the Y axis (stripes parallel to X); the geometric line direction is
 *     the angle value + 90 degrees.
 *   Why one convention for all of them: with start angle 0 and window
 *   direction 0, the user expects the hatch in the middle of the window.
 *   (An earlier version gave the window as line direction; then start 0
 *   was perpendicular to window 0 and ended up at the window edge.)
 *
 * Exposure order (against the gas flow):
 *   An angle value a gives the lines AND their order: hatchExt2 creates
 *   lines along (-sin a, cos a) and exposes them one after another in
 *   the direction (cos a, sin a). a and a + 180 give the same lines in
 *   opposite order. The block sort vector (hatch_options.js) does not
 *   change this order, it only decides which side of a hole comes first.
 *   MPBF background: if the lines are exposed in the direction of the gas
 *   flow, spatter and fume are blown onto powder that is still to be
 *   melted in this layer. Exposed against the gas flow, they land on
 *   lines that are already finished (see gas_flow.js).
 *   Therefore:
 *   - window 'relative to gas flow': the window is centered on
 *     gas angle + 180 + window direction, so the lines are always
 *     exposed against the gas flow (the lines themselves are the same
 *     as without the +180),
 *   - a_rot.against_gas_flow (set from 'optimized sorting'): every other
 *     result whose progress direction points downstream is turned by
 *     180 degrees (same lines, reversed order). This covers the case
 *     without window and the absolute window.
 *   Example (gas flow 0, no window, increment 67, against_gas_flow):
 *   raw 0, 67, 134, 201 -> 180, 247, 134, 201 (progress always towards -X).
 *
 * About the limitation window:
 *   'Window direction' = hatch angle value in the middle of the window,
 *   in the same convention as the start angle. In the mode 'relative to
 *   gas flow' it is added to the gas flow angle (plus 180, see above), so
 *   the default 0 means hatch lines perpendicular to the gas flow,
 *   exposed against it. The window limits the angle value to
 *   [center - width/2, center + width/2].
 *   Hatch lines are exposed in alternating directions, so a line
 *   direction is symmetric by 180 degrees; a width of 180 degrees or more
 *   would therefore not limit anything.
 *   The full 180 degree cycle of line directions is compressed linearly
 *   onto the window width (see map_into_window). Two different line
 *   directions therefore always stay two different directions inside
 *   the window: the window never reduces the number of distinct hatch
 *   directions. With the increment 67 there are 180 distinct
 *   directions, with 90 there are 2, no matter how wide the window is.
 *   Important: do not fold the angle back at the window edges (triangle
 *   wave of period 2 * width). Such a fold maps every increment that is
 *   a multiple of the width (e.g. width 45 with increment 90, or width =
 *   increment) onto ONE direction, so all layers would be hatched in
 *   the same direction without any warning.
 *   Why avoid lines parallel to the gas flow? With alternating
 *   directions, every second line would then scan exactly downstream,
 *   i.e. into its own fume and spatter cloud that the gas carries ahead
 *   of the laser.
 *   Example (absolute window, direction 0 degrees, width 120 -> angle
 *   values [-60, 60], i.e. line directions [30, 150]; increment 67,
 *   against_gas_flow off):
 *   raw angle values 0, 67, 134, 201, 268, 335
 *   -> mapped angle values 0, 44.7, 329.3, 14, 58.7, 343.3 (all inside [-60, 60])
 *   -> line directions 90, 134.7, 59.3, 104, 148.7, 73.3.
 *   The same window relative to a gas flow of 0 degrees gives the same
 *   lines with angle values + 180 (180, 224.7, 149.3, ...), exposed
 *   towards -X, i.e. against the gas flow.
 *   Example (start 0, increment 0, absolute window direction 0, width 60):
 *   every layer gets the angle value 0, the middle of the window.
 *
 * Sub-groups (chess fields, hexagon groups):
 *   The chess pattern hatches every second field with +90 degrees, the
 *   hexagon pattern uses three groups with +0 / +60 / +120 degrees, i.e.
 *   the directions are spread evenly over the 180 degrees of possible
 *   line directions. With an active window the extra angle is added
 *   before the mapping, so it is scaled to the window like any other
 *   angle (extra * width / 180, wrapped around inside the window). The
 *   groups then stay spread INSIDE the window: two chess groups always
 *   differ by width / 2, and any two of the three hexagon groups differ
 *   by at least width / 3.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var MATH = require('../util/math_utils.js');

/** All line directions repeat after this angle (a line has two ends). */
var S_LINE_PERIOD = 180.0;

/** Angle offset that reverses the exposure order of the lines (same lines). */
var S_AGAINST_FLOW_OFFSET = 180.0;

/**
 * Tolerance of the "progress points downstream" test (cos of the angle).
 * 1e-9 corresponds to far less than a millionth of a degree away from
 * "exactly across the gas flow".
 */
var S_ACROSS_FLOW_TOL = 1e-9;

/**
 * Map an angle difference into a window.
 * The line directions repeat every 180 degrees, so one cycle of 180
 * degrees is compressed linearly onto the window width:
 *   p     = (d + 90) mod 180          p in [0, 180), p = 90 for d = 0
 *   d_map = p * w / 180 - w / 2       d_map in [-w/2, +w/2)
 * The mapping is one-to-one: line directions that differ (mod 180)
 * also differ after the mapping, see the module header.
 * The direction at the window center (d = 0) stays at the center;
 * the direction perpendicular to it (d = +-90) goes to the window edge.
 * MATH.mod (not %) is used because it also returns a value in
 * [0, 180) for negative inputs.
 * Example: width 120, d = 67 -> p = 157 -> d_map = 157 * 120 / 180 - 60 = 44.7.
 * @param {number} a_d      Distance of the raw angle from the window center (degrees)
 * @param {number} a_width  Window width in degrees (> 0, < 180)
 * @return {number} Mapped distance in [-width/2, +width/2)
 */
function map_into_window(a_d, a_width)
{
  let l_p = MATH.mod(a_d + S_LINE_PERIOD / 2.0, S_LINE_PERIOD);
  return l_p * a_width / S_LINE_PERIOD - a_width / 2.0;
}

/**
 * Final hatch angle value, turned by 180 degrees if needed so that the
 * lines are exposed against the gas flow.
 * hatchExt2 exposes the lines one after another in the direction
 * (cos a, sin a). If this direction points downstream (positive dot
 * product with the gas flow direction), a + 180 gives exactly the same
 * lines in the opposite order, i.e. the exposure moves upstream.
 * A direction exactly across the gas flow (dot product 0) is kept.
 * Only active if a_rot.against_gas_flow is true.
 * Example: gas flow 0 degrees, angle value 30 -> progress (0.87, 0.5)
 * points downstream -> 210; angle value 120 -> progress (-0.5, 0.87) -> kept.
 * @param {Object} a_rot        Rotation settings (uses against_gas_flow)
 * @param {number} a_angle      Hatch angle value in degrees
 * @param {number} a_gas_angle  Gas flow angle in degrees
 * @return {number} Hatch angle value in degrees [0, 360)
 */
function against_gas_flow(a_rot, a_angle, a_gas_angle)
{
  let l_angle = MATH.normalize_deg_360(a_angle);
  if (a_rot.against_gas_flow !== true) return l_angle;
  // cos of the angle between the progress direction and the gas flow.
  // A small tolerance keeps "exactly across" stable against rounding.
  let l_dot = Math.cos(MATH.deg_to_rad(l_angle - a_gas_angle));
  if (l_dot > S_ACROSS_FLOW_TOL) return MATH.normalize_deg_360(l_angle + S_AGAINST_FLOW_OFFSET);
  return l_angle;
}

/**
 * Hatch line angle of a layer.
 * Pure function: the same inputs always give the same angle, so a
 * layer can be recalculated (or calculated in another thread) and
 * still gets exactly the same hatch direction.
 * @param {{start_angle:number, increment:number,
 *          limit:{enabled:boolean, center_mode:string, center_angle:number, width:number},
 *          against_gas_flow:boolean}} a_rot
 *        start_angle / increment in degrees (increment = rotation per layer),
 *        against_gas_flow: true = turn results that are exposed downstream
 *        by 180 degrees (optional, see 'Exposure order' in the header),
 *        limit.center_mode: 'gas_flow' = center relative to the gas flow angle,
 *        otherwise the center is an absolute angle (from +X),
 *        limit.center_angle: hatch angle value in the middle of the window
 *        (degrees, same convention as start_angle),
 *        limit.width: total window width in degrees (1 ... 179)
 * @param {number} a_layer_index   0-based layer index of the model
 * @param {number} a_gas_angle     Gas flow angle in degrees (counter-clockwise from +X)
 * @param {number} [a_extra_angle] Additional angle (0 for the main direction,
 *                                 90 for odd chess fields, 60/120 for hexagon groups)
 * @return {number} Hatch angle VALUE for hatchExt2 in degrees [0, 360)
 */
exports.get_line_angle = function(a_rot, a_layer_index, a_gas_angle, a_extra_angle)
{
  // Tip: [a_extra_angle] in the JSDoc means "optional". If the
  // caller leaves it out, its value is undefined, so 0 is used instead.
  let l_extra = (typeof a_extra_angle === 'number') ? a_extra_angle : 0.0;
  let l_raw = a_rot.start_angle + a_layer_index * a_rot.increment;

  let l_limit = a_rot.limit;
  // A window that is off, has no valid width or is 180 degrees or wider
  // does not limit anything: plain rotation plus extra angle.
  if (!l_limit || !l_limit.enabled || !(l_limit.width > 0.0) || (l_limit.width >= S_LINE_PERIOD))
  {
    return against_gas_flow(a_rot, l_raw + l_extra, a_gas_angle);
  }

  // 'gas_flow' mode: the window turns with the configured gas flow angle,
  // so the same settings work for machines with another gas direction.
  // The +180 degrees keep the same lines but reverse their order: the
  // lines are then exposed AGAINST the gas flow (see 'Exposure order'
  // in the module header).
  let l_center = (l_limit.center_mode === 'gas_flow')
    ? (a_gas_angle + S_AGAINST_FLOW_OFFSET + l_limit.center_angle)
    : l_limit.center_angle;

  // Distance of the raw angle (plus the sub-group angle) from the
  // window center, mapped into the window.
  let l_d_map = map_into_window(l_raw + l_extra - l_center, l_limit.width);
  return against_gas_flow(a_rot, l_center + l_d_map, a_gas_angle);
};

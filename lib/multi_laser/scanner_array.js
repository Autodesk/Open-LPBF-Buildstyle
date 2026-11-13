/************************************************************
 * MODULE NAME: scanner_array.js
 *
 * PURPOSE:
 *   Geometry of a multi-laser machine: the scanner array (a grid of
 *   identical scanners, each with its own scan field) and the
 *   swimlanes (bands across the platform, perpendicular to the gas
 *   flow) used by the swimlane strategies of laser_assignment.js.
 *
 * BACKGROUND:
 *   MPBF background: Large machines have several lasers. Every laser
 *   has its own scanner (moving mirrors) that can only reach a limited
 *   rectangle of the platform, the scan field. The scanners are
 *   mounted on a regular grid, and their fields usually overlap, so
 *   most of the platform can be reached by two or more lasers. In an
 *   overlap the build style may choose the laser; choosing so that all
 *   lasers have about the same amount of work ("load balancing") gives
 *   the shortest layer time, because the layer is only finished when
 *   the slowest laser is finished.
 *   - Scanner grid: count_x * count_y scanners, centred on (center_x,
 *     center_y), spacing_x / spacing_y mm apart. The laser index is
 *     assigned row by row: index = iy * count_x + ix (0-based).
 *   - Scan field: field_width x field_height mm, centred on the
 *     scanner. A spacing smaller than the field size gives overlaps.
 *   - Swimlane: a band of a given width along the gas flow direction
 *     that spans the whole platform across the flow. Lane 0 is the
 *     band furthest DOWNSTREAM (exposed first, so fumes and spatter
 *     are blown away from areas that are still to be exposed).
 *
 * WORKFLOW:
 *   Post-processing (main/postprocess.js) builds the scanner array and
 *   the swimlanes once per call from the platform settings and passes
 *   them to laser_assignment.js.
 *
 * USAGE:
 *   var SCANNER_ARRAY = require('../multi_laser/scanner_array.js');
 *   let l_scanners = SCANNER_ARRAY.build_scanner_array({ center_x: 0, center_y: 0,
 *     count_x: 2, count_y: 2, spacing_x: 150, spacing_y: 150,
 *     field_width: 200, field_height: 200 });
 *   let l_lanes = SCANNER_ARRAY.build_swimlanes(
 *     { min_x: -125, max_x: 125, min_y: -125, max_y: 125 }, l_gas_dir, 50.0);
 *
 * DEPENDENCIES:
 *   Builtins: none (pure module, can be tested with Node.js)
 *   Modules : ../geometry/gas_flow.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Positions along the gas flow use GAS_FLOW.downstream_key (smaller
 *   key = further downstream), the same key as the exposure sorter, so
 *   "downstream first" means the same everywhere in the project.
 *   The gas direction is always the one of GAS_FLOW.flow_direction: the
 *   direction INTO which the gas flows (parameter gas_flow_angle,
 *   0 degrees = towards +X, so +X is downstream). Do not pass a vector
 *   that points upstream (towards the gas inlet); that would reverse
 *   the lane order against the exposure sorter.
 *   Units: mm. Colors: [r, g, b], each 0..255.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var GAS_FLOW = require('../geometry/gas_flow.js');

/** Small value used to compare floating point numbers (mm or parameter t). */
var S_EPSILON = 1e-9;

// -----------------------------------------------------------
// Scanner array
// -----------------------------------------------------------

/**
 * Preview color of one laser.
 * The colors are spread evenly around the color wheel (hue 0, 360/N,
 * 2*360/N, ... degrees) with a fixed, strong saturation, so every
 * scanner count gets N clearly different colors without any color
 * parameter. (A fixed list of color parameters cannot work, because
 * the number of scanners is itself a parameter.)
 * HOW: standard HSV -> RGB conversion with saturation 0.7, value 0.95.
 * @param {number} a_laser_index  0 .. a_laser_count - 1
 * @param {number} a_laser_count  Number of lasers (>= 1)
 * @return {number[]} [r, g, b], each 0..255
 */
function generate_laser_color(a_laser_index, a_laser_count)
{
  let l_saturation = 0.70;
  let l_value = 0.95;
  let l_hue = (a_laser_count > 0) ? (360.0 * a_laser_index / a_laser_count) : 0.0;

  let l_c = l_value * l_saturation;
  let l_h = (l_hue % 360.0) / 60.0;
  let l_x = l_c * (1.0 - Math.abs((l_h % 2.0) - 1.0));
  let l_m = l_value - l_c;

  let l_r = 0.0;
  let l_g = 0.0;
  let l_b = 0.0;
  if (l_h < 1.0)      { l_r = l_c; l_g = l_x; }
  else if (l_h < 2.0) { l_r = l_x; l_g = l_c; }
  else if (l_h < 3.0) { l_g = l_c; l_b = l_x; }
  else if (l_h < 4.0) { l_g = l_x; l_b = l_c; }
  else if (l_h < 5.0) { l_r = l_x; l_b = l_c; }
  else                { l_r = l_c; l_b = l_x; }

  return [
    Math.round((l_r + l_m) * 255.0),
    Math.round((l_g + l_m) * 255.0),
    Math.round((l_b + l_m) * 255.0)
  ];
}

/**
 * Build the scanners of the scanner array.
 * The grid is symmetric around the array center for every count:
 * offset of column ix = (ix - (count_x - 1) / 2) * spacing_x, same for
 * the rows. Example: count_x = 1, count_y = 4 gives one column of four
 * scanners, two below and two above the center.
 * @param {{center_x:number, center_y:number, count_x:number, count_y:number,
 *          spacing_x:number, spacing_y:number, field_width:number, field_height:number}} a_cfg
 *        Lengths in mm; counts >= 1 (rounded)
 * @return {Array} Scanners in laser index order:
 *         [{ laser_index, center: {x, y}, field: {min_x, max_x, min_y, max_y}, color_rgb }]
 */
exports.build_scanner_array = function(a_cfg)
{
  let l_count_x = Math.max(1, Math.round(a_cfg.count_x));
  let l_count_y = Math.max(1, Math.round(a_cfg.count_y));
  let l_count = l_count_x * l_count_y;
  let l_half_w = 0.5 * a_cfg.field_width;
  let l_half_h = 0.5 * a_cfg.field_height;

  let r_scanners = [];
  for (let iy = 0; iy < l_count_y; ++iy)
  {
    let l_y = a_cfg.center_y + (iy - 0.5 * (l_count_y - 1)) * a_cfg.spacing_y;
    for (let ix = 0; ix < l_count_x; ++ix)
    {
      let l_x = a_cfg.center_x + (ix - 0.5 * (l_count_x - 1)) * a_cfg.spacing_x;
      let l_index = iy * l_count_x + ix;
      r_scanners.push({
        laser_index: l_index,
        center: { x: l_x, y: l_y },
        field: { min_x: l_x - l_half_w, max_x: l_x + l_half_w, min_y: l_y - l_half_h, max_y: l_y + l_half_h },
        color_rgb: generate_laser_color(l_index, l_count)
      });
    }
  }
  return r_scanners;
};

// -----------------------------------------------------------
// Swimlanes
// -----------------------------------------------------------

/**
 * Position of a point along the gas flow (see GAS_FLOW.downstream_key).
 * Smaller = further downstream.
 * @param {{x:number, y:number}} a_point  Point in mm
 * @param {{x:number, y:number}} a_gas_dir  Unit vector of the gas flow
 * @return {number} Key in mm
 */
exports.flow_key = function(a_point, a_gas_dir)
{
  return GAS_FLOW.downstream_key(a_point.x, a_point.y, a_gas_dir);
};

/**
 * Cut the platform into swimlanes of a_width mm along the gas flow.
 * Every lane spans the whole platform across the flow, so a lane is
 * fully described by its key range [key_min, key_max) along the flow
 * (a 1D interval; no rotated rectangle is needed).
 * Lane 0 is the most downstream lane. The last lane ends exactly at the
 * platform edge (it may be narrower than a_width), so the lanes cover
 * the platform without gaps.
 * @param {{min_x:number, max_x:number, min_y:number, max_y:number}} a_platform  Platform bounds in mm
 * @param {{x:number, y:number}} a_gas_dir  Unit vector of the gas flow
 * @param {number} a_width  Lane width in mm (> 0, checked by the caller)
 * @return {Array} [{ lane_index, key_min, key_max }], at least one lane, downstream first
 */
exports.build_swimlanes = function(a_platform, a_gas_dir, a_width)
{
  let l_corners = [
    { x: a_platform.min_x, y: a_platform.min_y }, { x: a_platform.max_x, y: a_platform.min_y },
    { x: a_platform.min_x, y: a_platform.max_y }, { x: a_platform.max_x, y: a_platform.max_y }
  ];
  let l_min = Number.POSITIVE_INFINITY;
  let l_max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < l_corners.length; ++i)
  {
    let l_k = exports.flow_key(l_corners[i], a_gas_dir);
    l_min = Math.min(l_min, l_k);
    l_max = Math.max(l_max, l_k);
  }

  let l_count = Math.max(1, Math.ceil((l_max - l_min) / a_width));
  let r_lanes = [];
  for (let i = 0; i < l_count; ++i)
  {
    let l_lo = l_min + i * a_width;
    let l_hi = (i === l_count - 1) ? l_max : (l_lo + a_width);
    r_lanes.push({ lane_index: i, key_min: l_lo, key_max: l_hi });
  }
  return r_lanes;
};

/**
 * Index of the lane that contains a flow key.
 * Keys outside the platform (a part larger than the platform
 * parameters, or rounding) are clamped to the first / last lane, so no
 * geometry is ever dropped.
 * @param {number} a_key    Result of flow_key
 * @param {Array} a_lanes   Result of build_swimlanes
 * @return {number} Lane index
 */
exports.find_swimlane_index = function(a_key, a_lanes)
{
  for (let i = 0; i < a_lanes.length; ++i)
  {
    if (a_key < a_lanes[i].key_max) return i;
  }
  return a_lanes.length - 1;
};

/**
 * Split the segment a_start -> a_end at every lane border it crosses.
 * Lanes are contiguous and do not overlap, so the only borders are the
 * key_min values of lanes 1 .. n-1 (lane 0 starts at the platform edge).
 * Example: a segment from lane 0 into lane 2 returns three pieces
 * (lane 0, lane 1, lane 2).
 * @param {{x:number, y:number}} a_start  Start in mm
 * @param {{x:number, y:number}} a_end    End in mm
 * @param {Array} a_lanes                 Result of build_swimlanes
 * @param {{x:number, y:number}} a_gas_dir  Unit vector of the gas flow
 * @return {Array} [{ lane_index, t_start, t_end }] in segment direction
 *         (t = 0 at a_start, t = 1 at a_end)
 */
exports.partition_segment_by_swimlanes = function(a_start, a_end, a_lanes, a_gas_dir)
{
  let l_k0 = exports.flow_key(a_start, a_gas_dir);
  let l_k1 = exports.flow_key(a_end, a_gas_dir);
  let l_dk = l_k1 - l_k0;

  let l_breaks = [0.0, 1.0];
  // A segment across the flow (l_dk = 0) never crosses a lane border.
  if (Math.abs(l_dk) > S_EPSILON)
  {
    for (let i = 1; i < a_lanes.length; ++i)
    {
      let l_t = (a_lanes[i].key_min - l_k0) / l_dk;
      if ((l_t > 0.0) && (l_t < 1.0)) l_breaks.push(l_t);
    }
    l_breaks.sort(function(a_a, a_b) { return a_a - a_b; });
  }

  let r_pieces = [];
  for (let i = 0; i + 1 < l_breaks.length; ++i)
  {
    let l_t0 = l_breaks[i];
    let l_t1 = l_breaks[i + 1];
    if (l_t1 - l_t0 <= S_EPSILON) continue;
    // The lane of a piece is the lane of its middle (never on a border).
    let l_k_mid = l_k0 + l_dk * 0.5 * (l_t0 + l_t1);
    r_pieces.push({ lane_index: exports.find_swimlane_index(l_k_mid, a_lanes), t_start: l_t0, t_end: l_t1 });
  }
  return r_pieces;
};

exports.generate_laser_color = generate_laser_color;

/************************************************************
 * MODULE NAME: param_groups.js
 *
 * PURPOSE:
 *   Parameter tree of this build style. The tree is built once
 *   when the module is loaded and declared to the host in
 *   declareParameters.
 *
 * WORKFLOW:
 *   - declareParameters: ALL_TOP_LEVEL_GROUPS[i].declare(...)
 *   - main/settings.js: reads the groups into plain settings objects
 *   - every entry point that reads parameters calls
 *     clear_all_cached_values() first
 *
 * BACKGROUND (terms: see the glossary in main/main.js):
 *   - A parameter group is a folder in the parameter tree of the user
 *     interface. Groups can have child groups and parameters.
 *   - Part groups can have other values for every part (e.g. borders,
 *     hatching, laser settings). Platform groups (FLAGS.PLATFORM) exist
 *     once for the whole build plate (laser timing, gas flow, order).
 *   - Optional groups (FLAGS.OPT_ON / OPT_OFF) have a check box; when it
 *     is not checked, the feature is switched off.
 *   - add_real / add_int: (group, text function, id, minimum, maximum,
 *     default, unit key). The user cannot enter values outside the
 *     range. add_bool: (group, text, id, default).
 *   - The default values below are generic starting points for a metal
 *     machine, not tested values for a specific material.
 *
 * USAGE:
 *   var PARAM_GROUPS = require('main/param_groups.js');
 *   let l_enabled = PARAM_GROUPS.hull_core_group.isGrpEnabled();
 *
 * DEPENDENCIES:
 *   Builtins: none
 *   Modules : lib/params/param_factories.js, main/vector_types.js,
 *             localization/localizer.js
 *
 * REUSE NOTES:
 *   Project specific. Group and parameter ids are persistent keys in
 *   saved projects: never rename them. Texts are looked up with the id
 *   (name) and id + '_descr' (description) in localization/lang_*.json.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var FACTORY = require('lib/params/param_factories.js');
var VECTOR_TYPES = require('main/vector_types.js');
var LOCALIZER = require('localization/localizer.js');

// Group flags (DEF, OPT_ON, OPT_OFF, PLATFORM) and the ids of the
// shared child groups (layer skip, stipple, start point, ...).
var FLAGS = FACTORY.FLAGS;
var CHILD_ID = FACTORY.CHILD_ID;

/**
 * Patterns offered for part hatching (order = order in the drop down list).
 * The first entry is the default. The saved value is the INDEX in this
 * list, so only append new patterns at the end.
 * MPBF background:
 *   meander = parallel lines over the whole area;
 *   stripe  = bands of a few mm, lines across each band (short lines);
 *   chess   = square fields, neighbors rotated by 90 degrees;
 *   hexagon = hexagonal cells in three groups (0 / 60 / 120 degrees);
 *   offset  = concentric rings parallel to the outline.
 * Short lines and changing directions spread the heat input more evenly
 * and reduce residual stress and distortion in large areas.
 * Tip: Object.freeze makes the array read-only.
 */
exports.PART_PATTERN_KEYS = Object.freeze([
  'pattern_meander', 'pattern_stripe', 'pattern_chess', 'pattern_hexagon', 'pattern_offset'
]);
/** Patterns offered for solid supports (simple patterns are enough there). */
exports.SUPPORT_PATTERN_KEYS = Object.freeze(['pattern_meander', 'pattern_offset']);

/**
 * Options of the build order choice (index = value).
 * platform = by scanning order over all parts; model = part by part;
 * island = island by island; global = by scanning order over all parts,
 * and inside a vector type every hatch block / contour by its own
 * position from downstream to upstream (see lib/sorting/exposure_sorter.js).
 * main/settings.js maps the index to these modes in the same order.
 * The saved value is the INDEX, so only append new modes at the end.
 */
exports.BUILD_ORDER_KEYS = Object.freeze([
  'build_order_platform', 'build_order_model', 'build_order_island', 'build_order_global'
]);

/**
 * Options of the laser assignment strategy choice (index = value).
 * Same order as LASER_ASSIGNMENT.STRATEGIES (lib/multi_laser/laser_assignment.js),
 * which main/settings.js uses to map the index to the strategy name.
 * Only append new strategies at the end.
 */
exports.LASER_STRATEGY_KEYS = Object.freeze([
  'strategy_field_split', 'strategy_swimlane', 'strategy_swimlane_clip', 'strategy_swimlane_reassign'
]);

/**
 * Options of the load balancing metric choice (index = value).
 * length = marked length per laser; time = estimated time per laser
 * (marking, jumps and delays of grp_laser_timing).
 */
exports.LOAD_METRIC_KEYS = Object.freeze(['metric_length', 'metric_time']);

/**
 * Localization function passed to the factories.
 * Tip: The factories do not know the localizer. They only get
 * this function, which keeps the library independent of the project.
 * @param {string} a_key  Localization key
 * @return {string} Localized text
 */
function text(a_key)
{
  return LOCALIZER.GetMessage(a_key);
}

/**
 * Add the child groups that all contour types share:
 * layer skip, line stipple and start point shift.
 * The empty object {} means "use the library defaults"
 * (FACTORY.TABLE_DEFAULTS). The stipple is off by default (OPT_OFF).
 * @param {Object} a_grp  Contour group
 * @return {void}
 */
function add_contour_children(a_grp)
{
  FACTORY.create_layer_skip_group(a_grp, CHILD_ID.LAYER_SKIP, text, {}, FLAGS.DEF);
  FACTORY.create_stipple_group(a_grp, CHILD_ID.STIPPLE, text, {}, FLAGS.OPT_OFF);
  FACTORY.create_start_point_group(a_grp, CHILD_ID.START_POINT, text, {}, FLAGS.DEF);
}

//////////////////////////////////////////////////////////////
// Part groups
//////////////////////////////////////////////////////////////
// Tip: This code runs once, when the module is loaded (first
// require). It only builds the tree in memory; declareParameters later
// hands it to the host.

// 1. Hull and core
// Off by default. min_hull_thickness (mm): wall thickness of the hull;
// core_every_nth_layer: the core is exposed every n-th layer (1 = every
// layer). MPBF background: a thicker effective layer in the core saves
// time, the hull keeps the fine layers for an accurate surface.
var hull_core_group = FACTORY.create_top_level_group('grp_hull_core', text, FLAGS.OPT_OFF);
FACTORY.add_real(hull_core_group, text, 'min_hull_thickness', 0.05, 100.0, 1.0, 'unit_mm');
FACTORY.add_int(hull_core_group, text, 'core_every_nth_layer', 1, 10, 1, 'unit_layers');

// 2. First border (beam compensation) and blocked paths
// On by default. beam_compensation 0.06 mm = about half the width of a
// melt track, so the melted edge lies on the part outline.
// blocked_path_*: single center lines in regions narrower than the
// compensated border; shorter lines than min_length (mm) are dropped.
// alternate_per_layer: reverse the scan direction on every second layer.
var border_first_group = FACTORY.create_top_level_group('grp_border_first', text, FLAGS.OPT_ON);
FACTORY.add_real(border_first_group, text, 'beam_compensation', 0.0, 2.0, 0.06, 'unit_mm');
FACTORY.add_bool(border_first_group, text, 'blocked_path_enabled', true);
FACTORY.add_real(border_first_group, text, 'blocked_path_min_length', 0.0, 10.0, 0.02, 'unit_mm');
FACTORY.add_bool(border_first_group, text, 'alternate_per_layer', true);
add_contour_children(border_first_group);

// 3. Following borders (2nd .. N-th border)
// Off by default. first_offset: distance from the first border (mm),
// following_offset: distance between two following borders (mm). An
// offset a bit smaller than the track width (0.08 mm here) lets the
// rings overlap, so there is no gap between them.
// alternate_per_contour: reverse the direction from ring to ring.
var border_following_group = FACTORY.create_top_level_group('grp_border_following', text, FLAGS.OPT_OFF);
FACTORY.add_int(border_following_group, text, 'border_count', 1, 20, 1, '');
FACTORY.add_real(border_following_group, text, 'first_offset', 0.0, 5.0, 0.08, 'unit_mm');
FACTORY.add_real(border_following_group, text, 'following_offset', 0.0, 5.0, 0.08, 'unit_mm');
FACTORY.add_bool(border_following_group, text, 'alternate_per_layer', true);
FACTORY.add_bool(border_following_group, text, 'alternate_per_contour', false);
add_contour_children(border_following_group);

// 4. Fill contours
// Off by default. Extra concentric rings inside the borders (default 2,
// 0.1 mm apart), between the borders and the hatch.
var fill_contour_group = FACTORY.create_top_level_group('grp_fill_contour', text, FLAGS.OPT_OFF);
FACTORY.add_int(fill_contour_group, text, 'fill_contour_count', 1, 50, 2, '');
FACTORY.add_real(fill_contour_group, text, 'first_offset', 0.0, 5.0, 0.1, 'unit_mm');
FACTORY.add_real(fill_contour_group, text, 'following_offset', 0.0, 5.0, 0.1, 'unit_mm');
FACTORY.add_bool(fill_contour_group, text, 'alternate_per_layer', true);
FACTORY.add_bool(fill_contour_group, text, 'alternate_per_contour', true);
add_contour_children(fill_contour_group);

// 5. Hatching (volume / hull and core)
// Always active. hatch_offset (mm): distance between the innermost
// contour ring and the hatch area; negative values let the hatch
// overlap the contours.
// create_hatch_group arguments: (parent, id, text, defaults, flags,
// offered patterns, with power optimization). Defaults not given here
// come from FACTORY.TABLE_DEFAULTS (e.g. hatch distance 0.1 mm,
// rotation +67 degrees per layer).
var hatching_group = FACTORY.create_top_level_group('grp_hatching', text, FLAGS.DEF);
FACTORY.add_real(hatching_group, text, 'hatch_offset', -2.0, 5.0, 0.05, 'unit_mm');
FACTORY.create_hatch_group(hatching_group, 'grp_hatch_volume', text, {}, FLAGS.DEF,
  exports.PART_PATTERN_KEYS, true);
// The core uses a larger hatch distance (0.12 mm) by default: the core
// is not visible, so faster settings are acceptable there.
FACTORY.create_hatch_group(hatching_group, 'grp_hatch_core', text,
  { hatch_distance: 0.12, stripe_width: 10.0 }, FLAGS.DEF, exports.PART_PATTERN_KEYS, true);

// 6. Multi-layer overhang (downskin)
// Off by default. surface_angle (degrees): regions whose surface is
// flatter than this angle are downskin (0 = horizontal overhang).
// reference_layers: number of layers below that are compared (max. 20,
// see lower_layers_dependence in main/main.js).
// min_width (mm): narrower downskin slivers are ignored.
// overlap (mm): the downskin hatch reaches this far into the volume.
// *_splitting: contours inside the downskin get the downskin BSIDs.
// MPBF background: downskin hatch uses a smaller hatch distance (0.08 mm)
// and, via its BSID, lower power: above powder the heat cannot flow
// away, so less energy is needed to avoid sagging and rough surfaces.
var overhang_group = FACTORY.create_top_level_group('grp_overhang', text, FLAGS.OPT_OFF);
FACTORY.add_real(overhang_group, text, 'surface_angle', 0.0, 89.0, 45.0, 'unit_deg');
FACTORY.add_int(overhang_group, text, 'reference_layers', 1, 20, 3, 'unit_layers');
FACTORY.add_real(overhang_group, text, 'min_width', 0.0, 10.0, 0.1, 'unit_mm');
FACTORY.add_real(overhang_group, text, 'overlap', 0.0, 5.0, 0.1, 'unit_mm');
FACTORY.add_bool(overhang_group, text, 'border_splitting', true);
FACTORY.add_bool(overhang_group, text, 'fill_contour_splitting', true);
FACTORY.create_hatch_group(overhang_group, 'grp_hatch_downskin', text,
  { hatch_distance: 0.08 }, FLAGS.DEF, exports.PART_PATTERN_KEYS, true);

// 7. Upskin (single layer)
// Off by default. Only the next layer above is compared: an area that
// is not covered there is upskin (top surface). min_width and overlap
// as for the downskin.
var upskin_group = FACTORY.create_top_level_group('grp_upskin', text, FLAGS.OPT_OFF);
FACTORY.add_real(upskin_group, text, 'min_width', 0.0, 10.0, 0.1, 'unit_mm');
FACTORY.add_real(upskin_group, text, 'overlap', 0.0, 5.0, 0.1, 'unit_mm');
FACTORY.create_hatch_group(upskin_group, 'grp_hatch_upskin', text,
  { hatch_distance: 0.08 }, FLAGS.DEF, exports.PART_PATTERN_KEYS, true);

// 8. Wall supports (open polylines)
// On by default. Thin support walls exposed as single lines; only a
// layer skip can be set (laser settings: grp_scanning).
var support_wall_group = FACTORY.create_top_level_group('grp_support_wall', text, FLAGS.OPT_ON);
FACTORY.create_layer_skip_group(support_wall_group, CHILD_ID.LAYER_SKIP, text, {}, FLAGS.DEF);

// 9. Solid supports (areas)
// On by default. support_inset (mm) shrinks the area before hatching.
// Hatch distance 0.2 mm, meander or offset only, no power optimization
// (last argument false).
var support_solid_group = FACTORY.create_top_level_group('grp_support_solid', text, FLAGS.OPT_ON);
FACTORY.add_real(support_solid_group, text, 'support_inset', 0.0, 2.0, 0.0, 'unit_mm');
FACTORY.create_hatch_group(support_solid_group, 'grp_hatch_support', text,
  { hatch_distance: 0.2 }, FLAGS.DEF, exports.SUPPORT_PATTERN_KEYS, false);

// 10. Scanning: laser settings of every vector type (generated from the vector type table)
// One child group per BSID with laser number (1-based), power (W), speed
// (mm/s) and focus offset (mm). These values become the custom table.
// The group id 'grp_scan_<key>' is a persistent key; the visible name
// is the vector type name 'vec_<key>'.
var scanning_group = FACTORY.create_top_level_group('grp_scanning', text, FLAGS.DEF);
for (let i = 0; i < VECTOR_TYPES.VECTOR_TYPES.length; ++i)
{
  let l_vt = VECTOR_TYPES.VECTOR_TYPES[i];
  FACTORY.create_scan_group(scanning_group, 'grp_scan_' + l_vt.key, text,
    l_vt.scan_defaults, FLAGS.DEF, 'vec_' + l_vt.key);
}

//////////////////////////////////////////////////////////////
// Platform groups (shown in the platform settings of the host)
//////////////////////////////////////////////////////////////

// 11. Laser timing
// Used for the power optimization, the exposure time estimate and the
// LSR time column. jump_speed (mm/s): speed of the laser spot while the
// laser is off. mark_delay / jump_delay (microseconds): waiting times of
// the scanner after a marked sequence (every hatch vector, once per
// contour) / after a jump, so the mirrors can settle before the next
// action. min_jump_delay / jump_length_limit: jumps shorter than the
// limit get a delay between min_jump_delay (length 0) and jump_delay
// (lib/time/scanner_delays.js). The limit 0 (default) switches this off,
// so every jump gets the full jump delay.
var laser_timing_group = FACTORY.create_top_level_group('grp_laser_timing', text, FLAGS.PLATFORM);
FACTORY.add_real(laser_timing_group, text, 'jump_speed', 1.0, 100000.0, 7000.0, 'unit_mm_s');
FACTORY.add_real(laser_timing_group, text, 'mark_delay', 0.0, 100000.0, 10.0, 'unit_us');
FACTORY.add_real(laser_timing_group, text, 'jump_delay', 0.0, 100000.0, 50.0, 'unit_us');
FACTORY.add_real(laser_timing_group, text, 'min_jump_delay', 0.0, 100000.0, 0.0, 'unit_us');
FACTORY.add_real(laser_timing_group, text, 'jump_length_limit', 0.0, 1000.0, 0.0, 'unit_mm');

// 12. Gas flow
// Direction INTO which the shielding gas flows, in degrees,
// counter-clockwise from +X (0 = towards +X, 90 = towards +Y).
// MPBF background: the gas carries spatter and fumes away. Exposing the
// downstream areas first keeps these particles away from areas that are
// still to be exposed.
var gas_flow_group = FACTORY.create_top_level_group('grp_gas_flow', text, FLAGS.PLATFORM);
FACTORY.add_real(gas_flow_group, text, 'gas_flow_angle', 0.0, 360.0, 0.0, 'unit_deg');

// 13. Build order
// sort_models: order the parts along the gas flow (downstream first);
// not used by the mode 'global' (there the parts are no sort level).
// build_order_mode: see BUILD_ORDER_KEYS above.
var build_order_group = FACTORY.create_top_level_group('grp_build_order', text, FLAGS.PLATFORM);
FACTORY.add_bool(build_order_group, text, 'sort_models', true);
FACTORY.add_choice(build_order_group, text, 'build_order_mode', exports.BUILD_ORDER_KEYS, 'build_order_platform');

// 14. Scanning order: one number per vector type (smaller = exposed earlier)
// The defaults (main/vector_types.js) expose supports first (10, 20),
// then the hatches (30..50), then fill contours and borders from the
// inside to the outside (60..85) and open part paths last (90).
// Gaps between the numbers leave room for new vector types.
// The parameters are created directly with createParamInt (not with
// FACTORY.add_int), because the name comes from 'vec_<key>' while all
// entries share the description 'order_descr'.
var scanning_order_group = FACTORY.create_top_level_group('grp_scanning_order', text, FLAGS.PLATFORM);
for (let i = 0; i < VECTOR_TYPES.VECTOR_TYPES.length; ++i)
{
  let l_vt = VECTOR_TYPES.VECTOR_TYPES[i];
  // Name = vector type name, one shared description for all entries.
  scanning_order_group.createParamInt('order_' + l_vt.key, text('vec_' + l_vt.key),
    0, 100000, l_vt.scan_order_default, text('order_descr'), '');
}

// 15. Scanner array (multi-laser machines)
// Grid of identical scanners: scanner_count_x * scanner_count_y lasers,
// centred on (scanner_center_x, scanner_center_y) and scanner_spacing_*
// mm apart. Every scanner reaches a scan_field_width x scan_field_height
// rectangle around itself; a spacing smaller than the field size gives
// overlaps, which the laser assignment (group 16) balances.
// platform_*: bounds of the build platform (mm). The swimlanes of the
// laser assignment are cut from these bounds, so the lane borders stay
// at the same place on the machine, wherever the parts are placed.
// The defaults describe a 250 x 250 mm platform with 2 x 2 scanners.
// Only used when the laser assignment is enabled.
var scanner_array_group = FACTORY.create_top_level_group('grp_scanner_array', text, FLAGS.PLATFORM);
FACTORY.add_real(scanner_array_group, text, 'scanner_center_x', -10000.0, 10000.0, 0.0, 'unit_mm');
FACTORY.add_real(scanner_array_group, text, 'scanner_center_y', -10000.0, 10000.0, 0.0, 'unit_mm');
FACTORY.add_int(scanner_array_group, text, 'scanner_count_x', 1, 16, 2, '');
FACTORY.add_int(scanner_array_group, text, 'scanner_count_y', 1, 16, 2, '');
FACTORY.add_real(scanner_array_group, text, 'scanner_spacing_x', 0.0, 10000.0, 125.0, 'unit_mm');
FACTORY.add_real(scanner_array_group, text, 'scanner_spacing_y', 0.0, 10000.0, 125.0, 'unit_mm');
FACTORY.add_real(scanner_array_group, text, 'scan_field_width', 1.0, 10000.0, 175.0, 'unit_mm');
FACTORY.add_real(scanner_array_group, text, 'scan_field_height', 1.0, 10000.0, 175.0, 'unit_mm');
FACTORY.add_real(scanner_array_group, text, 'platform_min_x', -10000.0, 10000.0, -125.0, 'unit_mm');
FACTORY.add_real(scanner_array_group, text, 'platform_max_x', -10000.0, 10000.0, 125.0, 'unit_mm');
FACTORY.add_real(scanner_array_group, text, 'platform_min_y', -10000.0, 10000.0, -125.0, 'unit_mm');
FACTORY.add_real(scanner_array_group, text, 'platform_max_y', -10000.0, 10000.0, 125.0, 'unit_mm');

// 16. Laser assignment (multi-laser load balancing)
// Off by default (laser_assignment_enabled). When enabled, the
// post-processing assigns every path to a laser of the scanner array
// (attribute laser_index) instead of the fixed laser number of its
// vector type (grp_scanning), see lib/multi_laser/laser_assignment.js.
// assignment_strategy: see LASER_STRATEGY_KEYS above.
// load_balance_metric: see LOAD_METRIC_KEYS above.
// proximity_weight: 0 = pure load balancing; larger values pull
// geometry in an overlap towards the closest scanner.
// swimlane_width (mm): band width along the gas flow (swimlane strategies).
// swimlane_split_polylines: also cut contours at the lane borders
// (strategy "swimlane + clipping" only).
// Tip: this is a normal platform group with an "enabled"
// check box parameter, not an optional group: the optional flag is
// only used for part groups in this project.
var laser_assignment_group = FACTORY.create_top_level_group('grp_laser_assignment', text, FLAGS.PLATFORM);
FACTORY.add_bool(laser_assignment_group, text, 'laser_assignment_enabled', false);
FACTORY.add_choice(laser_assignment_group, text, 'assignment_strategy', exports.LASER_STRATEGY_KEYS,
  'strategy_field_split');
FACTORY.add_choice(laser_assignment_group, text, 'load_balance_metric', exports.LOAD_METRIC_KEYS, 'metric_time');
FACTORY.add_real(laser_assignment_group, text, 'proximity_weight', 0.0, 1000.0, 0.0, '');
FACTORY.add_real(laser_assignment_group, text, 'swimlane_width', 0.1, 10000.0, 50.0, 'unit_mm');
FACTORY.add_bool(laser_assignment_group, text, 'swimlane_split_polylines', false);

//////////////////////////////////////////////////////////////
// Exports
//////////////////////////////////////////////////////////////
// main/settings.js reads the values through these group objects.

exports.hull_core_group = hull_core_group;
exports.border_first_group = border_first_group;
exports.border_following_group = border_following_group;
exports.fill_contour_group = fill_contour_group;
exports.hatching_group = hatching_group;
exports.overhang_group = overhang_group;
exports.upskin_group = upskin_group;
exports.support_wall_group = support_wall_group;
exports.support_solid_group = support_solid_group;
exports.scanning_group = scanning_group;
exports.laser_timing_group = laser_timing_group;
exports.gas_flow_group = gas_flow_group;
exports.build_order_group = build_order_group;
exports.scanning_order_group = scanning_order_group;
exports.scanner_array_group = scanner_array_group;
exports.laser_assignment_group = laser_assignment_group;

/** All top-level groups. Declaration order = order in the user interface. */
exports.ALL_TOP_LEVEL_GROUPS = Object.freeze([
  hull_core_group, border_first_group, border_following_group, fill_contour_group,
  hatching_group, overhang_group, upskin_group, support_wall_group, support_solid_group,
  scanning_group,
  laser_timing_group, gas_flow_group, build_order_group, scanning_order_group,
  scanner_array_group, laser_assignment_group
]);

/**
 * Invalidate all cached parameter values.
 * Tip: Parameter values are cached for speed. The user can
 * change them between two calculations, so every entry point that reads
 * parameters must call this function first.
 * Each group also clears its child groups (recursively).
 * Tip: Every thread has its own copy of this module and thus
 * its own cache; clearing it in one thread does not affect the others.
 * @return {void}
 */
exports.clear_all_cached_values = function()
{
  for (let i = 0; i < exports.ALL_TOP_LEVEL_GROUPS.length; ++i)
  {
    exports.ALL_TOP_LEVEL_GROUPS[i].clearCachedValues();
  }
};

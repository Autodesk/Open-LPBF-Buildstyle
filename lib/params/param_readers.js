/************************************************************
 * MODULE NAME: param_readers.js
 *
 * PURPOSE:
 *   Read the parameter groups created by param_factories.js and
 *   convert them into plain JavaScript configuration objects.
 *   The rest of the library only works with these objects and never
 *   reads parameters directly.
 *
 *   Why plain objects? A plain object such as { every_nth: 2, offset: 0 }
 *   can be stored as a model attribute (JSON), passed to worker
 *   threads, logged and unit tested without the host application.
 *   It also decouples the algorithms from parameter ids and the UI
 *   layout: an algorithm module only needs to know the object fields.
 *
 * WORKFLOW:
 *   Called from the project's settings module in the part related
 *   entry points (declareModelFeatures, prepareModelExposure) and,
 *   for platform groups, in any entry point.
 *
 *   Factories and readers always come in pairs (T1 ... T7):
 *     declareParameters -> param_factories.create_xxx_group()  (declare)
 *     later entry point -> param_readers.read_xxx()            (read)
 *   A reader must use the SAME parameter ids and the SAME child group
 *   ids as its factory, otherwise getParamVal() throws "not found".
 *
 * USAGE:
 *   var READ = require('lib/params/param_readers.js');
 *   let l_skip = READ.read_layer_skip(l_grp.getChildGrp('grp_layer_skip'));
 *   // -> { every_nth: 2, offset: 0 }
 *
 *   Add a new parameter to an existing group type:
 *   1. param_factories.js: add a default to TABLE_DEFAULTS and an
 *      add_real/add_int/add_bool/add_choice call in the factory.
 *   2. localization/lang_*.json: add '<id>' and '<id>_descr' texts.
 *   3. This file: read it in the matching read_xxx() function and
 *      add the new field to the returned object (and to the JSDoc).
 *   4. Use the new field in the algorithm module.
 *
 * DEPENDENCIES:
 *   Builtins: none
 *   Modules : ./param_factories.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Choice parameters are always read by INDEX (getValueInt), never by
 *   the displayed text, so the result does not depend on the language.
 *
 * BACKGROUND:
 *   - A "group" is a node of the parameter tree that the user sees in
 *     the UI (a folder with parameters and child groups). An optional
 *     group has a check box; isGrpEnabled() tells if it is checked.
 *   - A child group may be missing (getChildGrp() returns undefined),
 *     e.g. a hatch group created without power optimization. Every
 *     reader therefore checks the group with is_group():
 *     - Optional settings (T1 ... T5) return safe defaults.
 *     - read_hatch (T6) and read_scan (T7) throw an Error that names
 *       the reader: there is no safe default for a hatch pattern or
 *       for laser power and speed, so a missing group is a programming
 *       error (wrong group id) that must be found at once, not a part
 *       built with invented values.
 *   - Units used in the returned objects: lengths in mm, angles in
 *     degrees, power in W (watts), speed in mm/s, layer counts as
 *     plain numbers. They are the same units as shown in the UI.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var FACTORY = require('./param_factories.js');

// Internal mode names, in the SAME order as the option keys in
// FACTORY.START_MODE_KEYS / FACTORY.LIMIT_CENTER_KEYS. The selected
// option index is used to pick the name from these arrays, so the
// order of both lists must always match.
var S_START_MODES = ['off', 'random', 'previous', 'random_previous'];
var S_LIMIT_CENTER_MODES = ['gas_flow', 'absolute'];

/**
 * Default of a factory parameter (see FACTORY.TABLE_DEFAULTS).
 * Used when a group or parameter does not exist, so the result is the
 * same as if the user had kept the default value in the UI.
 * @param {string} a_name  Parameter id, e.g. 'stipple_length'
 * @return {*} Default value (number, boolean or option key string)
 */
function table_default(a_name)
{
  return FACTORY.TABLE_DEFAULTS[a_name];
}

/**
 * true if the group object exists.
 * Tip: getChildGrp() returns undefined for a child group
 * that was never created. Checking both undefined and null is a
 * defensive habit, so the readers never crash on a missing group.
 * @param {Object|undefined|null} a_grp  Group object or nothing
 * @return {boolean} true if a_grp can be used
 */
function is_group(a_grp)
{
  return (typeof a_grp !== 'undefined') && (a_grp !== null);
}

/**
 * Throw a named error if a required group does not exist.
 * Without this check the first getParamVal() call would fail with an
 * unspecific TypeError ("cannot read property of undefined").
 * @param {Object|undefined|null} a_grp  Group object or nothing
 * @param {string} a_reader              Name of the reader, e.g. 'read_hatch'
 * @return {void}  Throws if a_grp is missing
 */
function require_group(a_grp, a_reader)
{
  if (is_group(a_grp)) return;
  throw new Error(a_reader + ': parameter group not found (check the group id passed to getChildGrp)');
}

/**
 * Index of the selected choice option.
 * The index (0 = first option of the drop down list) is the same in
 * every UI language, while the displayed text is translated.
 * @param {Object} a_grp  Group
 * @param {string} a_id   Parameter id
 * @return {number} 0-based index (-1 if invalid)
 */
function read_choice_index(a_grp, a_id)
{
  return a_grp.getParam(a_id).getValueInt();
}

/**
 * Value from a list by index, with fallback for invalid indices.
 * An invalid index can occur e.g. when a saved project contains an
 * option that no longer exists. The fallback keeps the build style
 * working instead of failing.
 * @param {string[]} a_list    Values
 * @param {number} a_index     Index
 * @param {string} a_fallback  Value for invalid indices
 * @return {string} Selected value
 */
function pick(a_list, a_index, a_fallback)
{
  if ((a_index >= 0) && (a_index < a_list.length)) return a_list[a_index];
  return a_fallback;
}

/**
 * T1 layer skip.
 * MPBF background: Some vector types do not need to be exposed in
 * every layer (e.g. a contour or a support wall every second layer).
 * Skipping layers saves build time and reduces heat input. The
 * decision per layer is made by lib/util/layer_skip.js:
 * a layer is exposed if (layer_index - offset) is a multiple of
 * every_nth, i.e. offset is the index of the first exposed layer.
 * @param {Object} a_grp  Layer skip group (or undefined -> every layer)
 * @return {{every_nth:number, offset:number}} Offset is normalized to [0, every_nth)
 */
exports.read_layer_skip = function(a_grp)
{
  if (!is_group(a_grp)) return { every_nth: 1, offset: 0 };
  // Math.max protects against 0 (division by zero in the modulo below).
  let l_every_nth = Math.max(1, a_grp.getParamVal('every_nth_layer'));
  // The UI allows offsets up to 99 for any n. The modulo maps e.g.
  // offset 3 with n = 2 to offset 1, which selects the same layers.
  let l_offset = a_grp.getParamVal('layer_offset') % l_every_nth;
  return { every_nth: l_every_nth, offset: l_offset };
};

/**
 * T2 line stipple.
 * MPBF background: The contour is split into dashes (length in mm)
 * that are exposed in 'count' interleaved passes. Neighboring dashes
 * are not melted directly one after the other, which reduces local
 * heat accumulation. 'overlap' (mm) makes the dashes of different
 * passes overlap a little, so the closed contour has no gaps.
 * @param {Object} a_grp  Stipple group (optional group)
 * @return {{enabled:boolean, length:number, overlap:number, count:number, random_start:boolean}}
 *         enabled is false if the group is missing or its check box is off
 */
exports.read_stipple = function(a_grp)
{
  if (!is_group(a_grp))
  {
    return { enabled: false, length: table_default('stipple_length'), overlap: table_default('stipple_overlap'),
      count: table_default('stipple_count'), random_start: table_default('stipple_random_start') };
  }
  // The values are read even if the group is disabled; the caller
  // checks 'enabled' before it uses them.
  return {
    enabled: a_grp.isGrpEnabled(),
    length: a_grp.getParamVal('stipple_length'),
    overlap: a_grp.getParamVal('stipple_overlap'),
    count: a_grp.getParamVal('stipple_count'),
    random_start: a_grp.getParamVal('stipple_random_start')
  };
};

/**
 * T3 start point.
 * MPBF background: A closed contour starts and ends at the same point.
 * There the melt track overlaps and a small "seam" forms. If the seams
 * of many layers lie on top of each other, a visible line appears on
 * the part surface. Moving the start point from layer to layer
 * distributes the seams. 'history_layers' is the number of previous
 * layers whose start points are avoided, 'min_distance' (mm) is the
 * required distance to them (see lib/sorting/start_point_history.js).
 * @param {Object} a_grp  Start point group
 * @return {{mode:string, history_layers:number, min_distance:number}}
 *         mode is 'off' | 'random' | 'previous' | 'random_previous'
 */
exports.read_start_point = function(a_grp)
{
  // No group -> no start point shift at all.
  if (!is_group(a_grp)) return { mode: 'off', history_layers: 1, min_distance: 0.0 };
  // Invalid option index -> 'random', which is also the factory default.
  return {
    mode: pick(S_START_MODES, read_choice_index(a_grp, 'start_point_mode'), 'random'),
    history_layers: a_grp.getParamVal('history_layer_count'),
    min_distance: a_grp.getParamVal('min_start_distance')
  };
};

/**
 * T4 rotation.
 * MPBF background: The hatch angle of layer i is
 * start_angle + i * increment (degrees). If all layers used the same
 * direction, the shrinkage of the cooling melt tracks would add up in
 * one direction and cause high residual stress and anisotropic
 * properties. Rotating the hatch per layer spreads the stress. The
 * default increment of 67 degrees has no common divisor with 180, so
 * the line direction repeats only after 180 layers.
 * The optional limitation window restricts the hatch directions, e.g.
 * to avoid lines parallel to the gas flow (spatter and fumes are
 * blown along the gas flow). The mapping into the window is done in
 * lib/exposure/pattern_rotation.js.
 * @param {Object} a_grp  Rotation group
 * @return {{start_angle:number, increment:number,
 *           limit:{enabled:boolean, center_mode:string, center_angle:number, width:number}}}
 *         Angles in degrees. center_mode is 'gas_flow' (center_angle is added to the
 *         gas flow angle) or 'absolute' (center_angle is measured from the +X axis).
 */
exports.read_rotation = function(a_grp)
{
  if (!is_group(a_grp))
  {
    return { start_angle: table_default('start_angle'), increment: table_default('angle_increment'),
      limit: { enabled: false, center_mode: 'gas_flow', center_angle: table_default('limit_center_angle'),
        width: table_default('limit_width') } };
  }
  let l_limit_grp = a_grp.getChildGrp(FACTORY.CHILD_ID.ROTATION_LIMIT);
  // Defaults for the case that the rotation group has no limit child group.
  let l_limit = { enabled: false, center_mode: 'gas_flow',
    center_angle: table_default('limit_center_angle'), width: table_default('limit_width') };
  if (is_group(l_limit_grp))
  {
    l_limit = {
      enabled: l_limit_grp.isGrpEnabled(),
      center_mode: pick(S_LIMIT_CENTER_MODES, read_choice_index(l_limit_grp, 'limit_center_mode'), 'gas_flow'),
      center_angle: l_limit_grp.getParamVal('limit_center_angle'),
      width: l_limit_grp.getParamVal('limit_width')
    };
  }
  return {
    start_angle: a_grp.getParamVal('start_angle'),
    increment: a_grp.getParamVal('angle_increment'),
    limit: l_limit
  };
};

/**
 * T5 power optimization.
 * MPBF background: The "return time" is the time until the laser comes
 * back next to a point it has just melted. Short hatch vectors give a
 * short return time: the area is still hot and needs less power.
 * Long vectors give a long return time: the area has cooled down and
 * needs more power. The vector lengths min_length / max_length (mm)
 * are converted to two reference return times. Return times at or
 * below the first one get min_power (W), at or above the second one
 * get max_power (W), values in between are interpolated linearly
 * (see lib/power/power_model.js). With segment_splitting a vector is
 * split into pieces of microvector_length (mm), each with its own
 * power; merge_equal_power joins neighboring pieces of equal power.
 * Note: the result field names min_length / max_length differ from the
 * parameter ids min_vector_length / max_vector_length.
 * @param {Object} a_grp  Power optimization group (may be undefined)
 * @return {{enabled:boolean, min_power?:number, max_power?:number, min_length?:number,
 *           max_length?:number, segment_splitting?:boolean, microvector_length?:number,
 *           merge_equal_power?:boolean}}  { enabled:false } if the group does not exist
 */
exports.read_power_opt = function(a_grp)
{
  // Only 'enabled' is needed when the group is missing: consumers skip
  // the power optimization completely in that case.
  if (!is_group(a_grp)) return { enabled: false };
  return {
    enabled: a_grp.isGrpEnabled(),
    min_power: a_grp.getParamVal('min_power'),
    max_power: a_grp.getParamVal('max_power'),
    min_length: a_grp.getParamVal('min_vector_length'),
    max_length: a_grp.getParamVal('max_vector_length'),
    segment_splitting: a_grp.getParamVal('segment_splitting'),
    microvector_length: a_grp.getParamVal('microvector_length'),
    merge_equal_power: a_grp.getParamVal('merge_equal_power')
  };
};

/**
 * Value of a pattern specific parameter. Returns the table default if the
 * pattern is not offered by the group (parameter was never declared).
 * Example: the support hatch group only offers meander and offset, so
 * 'stripe_width' does not exist there; asking the group for it would
 * throw "Parameter ... not found".
 * @param {Object} a_grp             Hatch group
 * @param {string[]} a_pattern_keys  Pattern keys offered by this group
 * @param {string} a_pattern_key     Pattern the parameter belongs to, e.g. 'pattern_stripe'
 * @param {string} a_id              Parameter id, e.g. 'stripe_width'
 * @return {*} Parameter value or table default
 */
function read_pattern_param(a_grp, a_pattern_keys, a_pattern_key, a_id)
{
  if (a_pattern_keys.indexOf(a_pattern_key) < 0) return table_default(a_id);
  return a_grp.getParamVal(a_id);
}

/**
 * T6 hatching -> HATCH configuration object.
 * MPBF background: Hatching fills the inside of an island with
 * parallel scan lines. 'hatch_distance' (mm) is the distance between
 * neighboring lines; it is normally smaller than the melt track width,
 * so neighboring tracks overlap and no unmelted powder remains.
 * The pattern decides how the area is divided before hatching:
 *   meander - one set of parallel lines over the whole area
 *   stripe  - parallel stripes of 'width' mm, hatched across
 *   chess   - square fields of 'size' mm, neighbors rotated 90 degrees
 *   hexagon - hexagonal cells of 'side' mm in three angle groups
 *   offset  - rings parallel to the outline (concentric)
 * Dividing the area (stripe, chess, hexagon) keeps the scan lines
 * short. This spreads the heat input more evenly and reduces residual
 * stress compared to long lines across a large part.
 * 'sorting' controls the block sort of the hatch lines against the gas
 * flow (0 = keep the host default for that value).
 * The fields of all patterns are always filled, even if another pattern
 * is selected, so the object always has the same structure.
 * @param {Object} a_grp             Hatch group
 * @param {string[]} a_pattern_keys  Same pattern key list as used in create_hatch_group
 * @return {Object} HATCH object:
 *   { pattern ('meander'|'stripe'|'chess'|'hexagon'|'offset'), hatch_distance, min_vector_length,
 *     sorting:{optimized, run_ahead_limit, min_block_segments, max_merge_distance},
 *     stripe:{width, overlap, script_sort, alternate}, chess:{size, overlap},
 *     hexagon:{side, overlap}, offset:{inside_out}, rotation, layer_skip, power_opt }
 *   Throws if the group does not exist (see BACKGROUND).
 */
exports.read_hatch = function(a_grp, a_pattern_keys)
{
  require_group(a_grp, 'read_hatch');
  // The option index selects the key from the SAME list that was used
  // to declare the choice, e.g. index 1 -> 'pattern_stripe'.
  let l_pattern_key = pick(a_pattern_keys, read_choice_index(a_grp, 'pattern'), a_pattern_keys[0]);
  let l_optimized = a_grp.getParamVal('optimized_sorting');
  // Optimized sorting also exposes the lines of every block against the
  // gas flow: the rotation turns angles that would expose downstream by
  // 180 degrees (same lines, see pattern_rotation.js 'Exposure order').
  let l_rotation = exports.read_rotation(a_grp.getChildGrp(FACTORY.CHILD_ID.ROTATION));
  l_rotation.against_gas_flow = (l_optimized === true);
  return {
    // 'pattern_stripe' -> 'stripe' (short name used by hatch_patterns.js)
    pattern: l_pattern_key.replace('pattern_', ''),
    hatch_distance: a_grp.getParamVal('hatch_distance'),
    // Parameter id has the suffix '_hatch' so that it does not collide
    // with 'min_vector_length' of the power optimization (TABLE_DEFAULTS
    // is one flat table for all factories).
    min_vector_length: a_grp.getParamVal('min_vector_length_hatch'),
    sorting: {
      optimized: l_optimized,
      run_ahead_limit: a_grp.getParamVal('blocksort_run_ahead_limit'),
      min_block_segments: a_grp.getParamVal('blocksort_min_block_segments'),
      max_merge_distance: a_grp.getParamVal('blocksort_max_merge_distance')
    },
    stripe: {
      width: read_pattern_param(a_grp, a_pattern_keys, 'pattern_stripe', 'stripe_width'),
      overlap: read_pattern_param(a_grp, a_pattern_keys, 'pattern_stripe', 'stripe_overlap'),
      script_sort: read_pattern_param(a_grp, a_pattern_keys, 'pattern_stripe', 'stripe_script_sort'),
      alternate: read_pattern_param(a_grp, a_pattern_keys, 'pattern_stripe', 'stripe_alternate')
    },
    chess: {
      size: read_pattern_param(a_grp, a_pattern_keys, 'pattern_chess', 'chess_size'),
      overlap: read_pattern_param(a_grp, a_pattern_keys, 'pattern_chess', 'chess_overlap')
    },
    hexagon: {
      side: read_pattern_param(a_grp, a_pattern_keys, 'pattern_hexagon', 'hexagon_side'),
      overlap: read_pattern_param(a_grp, a_pattern_keys, 'pattern_hexagon', 'hexagon_overlap')
    },
    offset: {
      inside_out: read_pattern_param(a_grp, a_pattern_keys, 'pattern_offset', 'offset_inside_out')
    },
    // Child groups created by create_hatch_group. The power optimization
    // group only exists if the factory was called with a_with_power_opt.
    rotation: l_rotation,
    layer_skip: exports.read_layer_skip(a_grp.getChildGrp(FACTORY.CHILD_ID.LAYER_SKIP)),
    power_opt: exports.read_power_opt(a_grp.getChildGrp(FACTORY.CHILD_ID.POWER_OPT))
  };
};

/**
 * T7 scan settings.
 * MPBF background: These are the laser settings of one vector type
 * (one BSID). power (W) and speed (mm/s) together decide how much
 * energy goes into the powder per mm of scan line: more power or a
 * lower speed melts deeper and wider. focus (mm) shifts the focal
 * point of the laser; 0 = in focus, other values enlarge the spot.
 * laser_index selects the laser on machines with several lasers.
 * @param {Object} a_grp  Scan group
 * @return {{laser_index:number, power:number, speed:number, focus:number}} laser_index is 1-based (as in the UI)
 *         Throws if the group does not exist (see BACKGROUND).
 */
exports.read_scan = function(a_grp)
{
  require_group(a_grp, 'read_scan');
  return {
    laser_index: a_grp.getParamVal('laser_index'),
    power: a_grp.getParamVal('power'),
    speed: a_grp.getParamVal('speed'),
    focus: a_grp.getParamVal('focus')
  };
};

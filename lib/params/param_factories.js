/************************************************************
 * MODULE NAME: param_factories.js
 *
 * PURPOSE:
 *   Reusable builders for parameter groups that appear several
 *   times in a build style (layer skip, line stipple, start point,
 *   rotation, power optimization, hatching, scan settings).
 *
 *   A "factory" is a function that creates and returns a new object.
 *   Here every factory creates one child group with its parameters,
 *   so e.g. all five hatch groups of the project (volume, core,
 *   downskin, upskin, support) get exactly the same parameter set
 *   from one place in the code.
 *
 * WORKFLOW:
 *   Called once when the project's parameter tree is built (module
 *   load of main/param_groups.js). The groups are declared to the
 *   host in declareParameters and read with lib/params/param_readers.js.
 *
 *   Declare vs. read:
 *     1. This module only DESCRIBES the parameters (id, text, range,
 *        default, unit). Nothing is shown in the UI yet.
 *     2. declareParameters: group.declare(...) sends the description
 *        to the host, which shows the parameters in the UI.
 *     3. Later entry points: param_readers.js reads the values the
 *        user entered and returns plain configuration objects.
 *   The factories T1 ... T7 here and the readers T1 ... T7 in
 *   param_readers.js belong together and use the same ids.
 *
 * USAGE:
 *   var FACTORY = require('lib/params/param_factories.js');
 *   let l_top = FACTORY.create_top_level_group('grp_x', a_text, FACTORY.FLAGS.DEF);
 *   FACTORY.create_layer_skip_group(l_top, 'grp_layer_skip', a_text, {}, undefined);
 *
 *   a_text is a function key -> localized string (e.g. LOCALIZER.GetMessage).
 *   Name key = group/parameter id, description key = id + '_descr'.
 *
 *   Add a new parameter:
 *   - Project specific parameter: call add_real/add_int/add_bool/
 *     add_choice on the group in main/param_groups.js and read it with
 *     group.getParamVal('<id>') in main/settings.js.
 *   - Parameter of a reusable group type: add the default value to
 *     TABLE_DEFAULTS, add the add_xxx call to the factory below and
 *     read it in the matching function of param_readers.js.
 *   - In both cases add '<id>' and '<id>_descr' to the language files
 *     (lang_en.json first, it is the fallback).
 *
 * DEPENDENCIES:
 *   Builtins: bsBuildParam
 *   Modules : ./atu_param_group_class.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Group and parameter ids are stored in project files. Never rename
 *   them, otherwise saved parameter values of the users are lost.
 *
 * BACKGROUND:
 *   - Parameter tree: the UI shows the build style parameters as a
 *     tree. Top-level groups contain parameters and child groups,
 *     child groups can contain further child groups.
 *   - Part vs. platform groups: part groups can have different values
 *     per part (model). Platform groups (FLAGS.PLATFORM) have one value
 *     for the whole build platform, e.g. the gas flow direction.
 *   - Optional groups show a check box. When it is off, the feature
 *     of the group (e.g. line stipple) is not used.
 *   - Units: lengths in mm, angles in degrees, power in W (watts),
 *     speed in mm/s. The min / max values passed to add_real/add_int
 *     are the limits the UI accepts, not recommended process values.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var BUILD_PARAM = requireBuiltin('bsBuildParam');
var PARAM_GROUP_MOD = require('./atu_param_group_class.js');

/**
 * Group flags used by this module and by the project.
 * The flags are bit masks; '|' (bitwise OR) combines several flags.
 * Object.freeze makes the object read-only, so no module can change
 * the flags by accident.
 */
exports.FLAGS = Object.freeze({
  // Normal group, always active
  DEF: BUILD_PARAM.nGroupDefaultFlags,
  // Optional group (check box in the UI), enabled by default
  OPT_ON: BUILD_PARAM.nGroupOptional | BUILD_PARAM.nGroupEnabled,
  // Optional group, disabled by default
  OPT_OFF: BUILD_PARAM.nGroupOptional,
  // Platform group (shown in the platform settings, not per part).
  // Tip: Only use this flag for top-level groups.
  PLATFORM: BUILD_PARAM.nGroupDefaultFlags | BUILD_PARAM.nGroupPlatform
});

/**
 * Ids of the child groups created by the factories below.
 * The readers use the same constants to find the child groups again,
 * so a typo in a string cannot break the connection between both.
 */
exports.CHILD_ID = Object.freeze({
  LAYER_SKIP: 'grp_layer_skip',
  STIPPLE: 'grp_line_stipple',
  START_POINT: 'grp_start_point',
  ROTATION: 'grp_rotation',
  ROTATION_LIMIT: 'grp_rotation_limit',
  POWER_OPT: 'grp_power_opt'
});

/**
 * Choice option keys. The index of a key is the value read by the readers.
 * Tip: Only append new options at the END of a list. Inserting
 * or reordering options changes the index of existing options, and
 * saved projects would then select a different option.
 */
exports.START_MODE_KEYS = Object.freeze([
  'start_mode_off', 'start_mode_random', 'start_mode_previous_layers', 'start_mode_random_previous_layers'
]);
exports.LIMIT_CENTER_KEYS = Object.freeze(['limit_center_gas_flow', 'limit_center_absolute']);

/**
 * Default values of all parameters created by the factories.
 * The readers use the same values for parameters that are not declared
 * (e.g. stripe settings of a support hatch that only offers meander).
 * Callers can override single values per group with the a_defaults
 * argument of a factory (see get_default). The table is flat, so every
 * parameter id must be unique across all factories.
 * Units: lengths in mm, angles in degrees, power in W.
 */
exports.TABLE_DEFAULTS = Object.freeze({
  // T1 layer skip
  // 1 = expose every layer; offset shifts which layers are exposed.
  every_nth_layer: 1, layer_offset: 0,
  // T2 line stipple
  // 1 mm dashes, no overlap, closed in 2 interleaved passes.
  stipple_length: 1.0, stipple_overlap: 0.0, stipple_count: 2, stipple_random_start: true,
  // T3 start point
  // Option KEY (not index) of the default mode; avoid the start points
  // of the last 3 layers by at least 1 mm.
  start_point_mode: 'start_mode_random', history_layer_count: 3, min_start_distance: 1.0,
  // T4 rotation
  // MPBF background: 67 degrees has no common divisor with 180, so the
  // hatch direction repeats only after 180 layers. Default window
  // (off by default): hatch LINES perpendicular to the gas flow (gas flow
  // angle + 90 degrees), 120 degrees wide -> the lines are never closer
  // than 30 degrees to the gas flow direction (see pattern_rotation.js).
  start_angle: 0.0, angle_increment: 67.0,
  // limit_center_angle 0 relative to the gas flow = hatch lines perpendicular
  // to the gas flow (hatch angle value convention, see pattern_rotation.js).
  limit_center_mode: 'limit_center_gas_flow', limit_center_angle: 0.0, limit_width: 120.0,
  // T5 power optimization
  // Power range in W; vector lengths in mm that are converted to the
  // return times for minimum and maximum power.
  min_power: 150.0, max_power: 280.0, min_vector_length: 0.5, max_vector_length: 10.0,
  segment_splitting: false, microvector_length: 0.5, merge_equal_power: true,
  // T6 hatching
  // 0.1 mm = 100 micrometers between hatch lines. The block sort
  // values 0 mean "use the default of the host".
  hatch_distance: 0.1, min_vector_length_hatch: 0.05, optimized_sorting: true,
  blocksort_run_ahead_limit: 0.0, blocksort_min_block_segments: 0, blocksort_max_merge_distance: 0.0,
  stripe_width: 10.0, stripe_overlap: 0.05, stripe_script_sort: true, stripe_alternate: false,
  chess_size: 5.0, chess_overlap: 0.05,
  hexagon_side: 3.0, hexagon_overlap: 0.05,
  offset_inside_out: false
});

//////////////////////////////////////////////////////////////
// Small helpers (exported, so projects can use them for their own parameters)
//////////////////////////////////////////////////////////////

/**
 * Value of a_defaults[a_name] if defined, otherwise a_fallback.
 * Order of precedence: caller defaults -> a_fallback -> TABLE_DEFAULTS.
 * Example: get_default({ hatch_distance: 0.08 }, 'hatch_distance') -> 0.08,
 *          get_default({}, 'hatch_distance') -> 0.1 (table default).
 * @param {Object|undefined} a_defaults  Caller defaults
 * @param {string} a_name                Field name
 * @param {*} a_fallback                 Value if the field is missing
 * @return {*} Default value
 */
function get_default(a_defaults, a_name, a_fallback)
{
  if (a_defaults && (a_defaults[a_name] !== undefined))
  {
    return a_defaults[a_name];
  }
  if (a_fallback !== undefined)
  {
    return a_fallback;
  }
  return exports.TABLE_DEFAULTS[a_name];
}
exports.get_default = get_default;

/**
 * Localized unit text. An empty key means "no unit".
 * @param {function(string):string} a_text  Localization function
 * @param {string} a_unit_key               e.g. 'unit_mm' or ''
 * @return {string} Unit text
 */
function unit_text(a_text, a_unit_key)
{
  if (!a_unit_key) return '';
  return a_text(a_unit_key);
}

/**
 * Flags given by the caller, or the default flags of the group type.
 * Tip: The type check (instead of 'a_flags || default') is
 * used because a flag value of 0 (no flag bit set) counts as "false"
 * in JavaScript and would be replaced by the default.
 * @param {number|undefined} a_flags  Caller flags
 * @param {number} a_default_flags    Default flags
 * @return {number} Flags
 */
function choose_flags(a_flags, a_default_flags)
{
  return (typeof a_flags === 'number') ? a_flags : a_default_flags;
}

/**
 * Create a real (floating point) parameter. Name key = a_id, description key = a_id + '_descr'.
 * @param {Object} a_grp                    Group that receives the parameter
 * @param {function(string):string} a_text  Localization function
 * @param {string} a_id                     Parameter id (persistent, never rename)
 * @param {number} a_min                    Smallest value the UI accepts
 * @param {number} a_max                    Largest value the UI accepts
 * @param {number} a_def                    Default value
 * @param {string} a_unit_key               Unit key, e.g. 'unit_mm' ('' = no unit)
 * @return {Object} Parameter object
 */
exports.add_real = function(a_grp, a_text, a_id, a_min, a_max, a_def, a_unit_key)
{
  return a_grp.createParamReal(a_id, a_text(a_id), a_min, a_max, a_def,
    a_text(a_id + '_descr'), unit_text(a_text, a_unit_key));
};

/**
 * Create an integer parameter. Name key = a_id, description key = a_id + '_descr'.
 * Arguments as in add_real, but a_min, a_max and a_def are whole numbers.
 * @return {Object} Parameter object
 */
exports.add_int = function(a_grp, a_text, a_id, a_min, a_max, a_def, a_unit_key)
{
  return a_grp.createParamInt(a_id, a_text(a_id), a_min, a_max, a_def,
    a_text(a_id + '_descr'), unit_text(a_text, a_unit_key));
};

/**
 * Create a boolean parameter (check box).
 * @param {Object} a_grp                    Group that receives the parameter
 * @param {function(string):string} a_text  Localization function
 * @param {string} a_id                     Parameter id (persistent, never rename)
 * @param {boolean} a_def                   Default state (true = checked)
 * @return {Object} Parameter object
 */
exports.add_bool = function(a_grp, a_text, a_id, a_def)
{
  return a_grp.createParamBool(a_id, a_text(a_id), a_def, a_text(a_id + '_descr'));
};

/**
 * Create a choice parameter (drop down list).
 * The options are localized strings. The readers always use the INDEX of
 * the selected option, so saved projects work in every language.
 * @param {Object} a_grp                    Group that receives the parameter
 * @param {function(string):string} a_text  Localization function
 * @param {string} a_id                     Parameter id (persistent, never rename)
 * @param {string[]} a_option_keys  Localization keys of the options
 * @param {string} a_default_key    Key of the default option (must be in a_option_keys)
 * @return {Object} Parameter object
 */
exports.add_choice = function(a_grp, a_text, a_id, a_option_keys, a_default_key)
{
  let l_options = [];
  for (let i = 0; i < a_option_keys.length; ++i)
  {
    l_options.push(a_text(a_option_keys[i]));
  }
  // An unknown default key would select no option at all; the first
  // option is used instead.
  let l_default_key = a_default_key;
  if (a_option_keys.indexOf(l_default_key) < 0)
  {
    l_default_key = a_option_keys[0];
  }
  // The host expects the default as displayed (localized) text.
  return a_grp.createParamChoice(a_id, a_text(a_id), l_options, a_text(l_default_key),
    a_text(a_id + '_descr'), '');
};

/**
 * Create a top-level parameter group.
 * Top-level groups are the roots of the parameter tree. Every one of
 * them must be declared in declareParameters (group.declare(...)).
 * @param {string} a_group_id                Group id (name key = id, description key = id + '_descr')
 * @param {function(string):string} a_text   Localization function
 * @param {number} a_flags                   Group flags (see FLAGS)
 * @return {Object} Group object (ClassAtuParamGroup)
 */
exports.create_top_level_group = function(a_group_id, a_text, a_flags)
{
  return new PARAM_GROUP_MOD.AtuParamGroup(a_group_id, a_text(a_group_id),
    a_text(a_group_id + '_descr'), a_flags, true);
};

/**
 * Create a child group.
 * a_name_key allows several groups with different ids to share one
 * text, e.g. the scan groups use the vector type name 'vec_<key>'.
 * @param {Object} a_parent_grp   Parent group
 * @param {string} a_group_id     Child group id
 * @param {function(string):string} a_text  Localization function
 * @param {number} a_flags        Group flags
 * @param {string} [a_name_key]   Name key (default: a_group_id). Description key = name key + '_descr'.
 * @return {Object} Child group
 */
function create_child(a_parent_grp, a_group_id, a_text, a_flags, a_name_key)
{
  let l_name_key = a_name_key ? a_name_key : a_group_id;
  return a_parent_grp.createChildGrp(a_group_id, a_text(l_name_key),
    a_text(l_name_key + '_descr'), a_flags);
}
exports.create_child = create_child;

//////////////////////////////////////////////////////////////
// Group factories
// Every factory has the same argument order:
//   (parent group, group id, localization function, defaults, flags, ...)
// a_defaults may be {} or undefined; then TABLE_DEFAULTS are used.
// a_flags may be undefined; then the default flags of the factory are used.
//////////////////////////////////////////////////////////////

/**
 * T1: Layer skip ("expose every n-th layer").
 * MPBF background: A layer is one slice of the build (typically some
 * tens of micrometers thick). Some vector types do not need to be
 * exposed in every layer; skipping saves time and heat input.
 * Parameters: every_nth_layer (1 ... 100, 1 = every layer),
 * layer_offset (0 ... 99 layers, shifts which layers are exposed).
 * @param {Object} a_parent_grp  Parent group
 * @param {string} a_group_id    Group id (usually CHILD_ID.LAYER_SKIP)
 * @param {function(string):string} a_text  Localization function
 * @param {Object} [a_defaults]  Optional defaults { every_nth_layer, layer_offset }
 * @param {number} [a_flags]     Default FLAGS.DEF
 * @return {Object} New child group
 */
exports.create_layer_skip_group = function(a_parent_grp, a_group_id, a_text, a_defaults, a_flags)
{
  let l_grp = create_child(a_parent_grp, a_group_id, a_text, choose_flags(a_flags, exports.FLAGS.DEF));
  exports.add_int(l_grp, a_text, 'every_nth_layer', 1, 100,
    get_default(a_defaults, 'every_nth_layer'), 'unit_layers');
  // The reader takes the offset modulo every_nth_layer, so values >= n are valid.
  exports.add_int(l_grp, a_text, 'layer_offset', 0, 99,
    get_default(a_defaults, 'layer_offset'), 'unit_layers');
  return l_grp;
};

/**
 * T2: Line stipple (dashed contours that are closed in several passes).
 * MPBF background: Instead of one continuous contour, the laser
 * exposes dashes with gaps; the gaps are closed by the following
 * passes. This reduces local heat accumulation along the contour.
 * Parameters: stipple_length (dash length, 0.01 ... 100 mm),
 * stipple_overlap (overlap of dashes of different passes, 0 ... 10 mm),
 * stipple_count (number of passes, 2 ... 100; at least 2 passes are
 * needed to close the gaps between the dashes of the first pass),
 * stipple_random_start (start the dash pattern at a random
 * position, so the dash ends do not line up from layer to layer).
 * @param {Object} a_parent_grp  Parent group
 * @param {string} a_group_id    Group id (usually CHILD_ID.STIPPLE)
 * @param {function(string):string} a_text  Localization function
 * @param {Object} [a_defaults]  Optional defaults { stipple_length, stipple_overlap, stipple_count, stipple_random_start }
 * @param {number} [a_flags]     Default FLAGS.OPT_OFF
 * @return {Object} New child group
 */
exports.create_stipple_group = function(a_parent_grp, a_group_id, a_text, a_defaults, a_flags)
{
  let l_grp = create_child(a_parent_grp, a_group_id, a_text, choose_flags(a_flags, exports.FLAGS.OPT_OFF));
  exports.add_real(l_grp, a_text, 'stipple_length', 0.01, 100.0,
    get_default(a_defaults, 'stipple_length'), 'unit_mm');
  exports.add_real(l_grp, a_text, 'stipple_overlap', 0.0, 10.0,
    get_default(a_defaults, 'stipple_overlap'), 'unit_mm');
  exports.add_int(l_grp, a_text, 'stipple_count', 2, 100,
    get_default(a_defaults, 'stipple_count'), '');
  exports.add_bool(l_grp, a_text, 'stipple_random_start',
    get_default(a_defaults, 'stipple_random_start'));
  return l_grp;
};

/**
 * T3: Start point shift of closed contours.
 * MPBF background: Where a closed contour starts and ends, a small
 * seam forms. Seams on top of each other in many layers create a
 * visible line on the part surface, so the start point is moved.
 * Parameters: start_point_mode (off / random / far from previous
 * layers / random among the points far enough away),
 * history_layer_count (1 ... 50 previous layers that are compared),
 * min_start_distance (0 ... 100 mm to the previous start points).
 * @param {Object} a_parent_grp  Parent group
 * @param {string} a_group_id    Group id (usually CHILD_ID.START_POINT)
 * @param {function(string):string} a_text  Localization function
 * @param {Object} [a_defaults]  Optional defaults { start_point_mode (option key), history_layer_count, min_start_distance }
 * @param {number} [a_flags]     Default FLAGS.DEF
 * @return {Object} New child group
 */
exports.create_start_point_group = function(a_parent_grp, a_group_id, a_text, a_defaults, a_flags)
{
  let l_grp = create_child(a_parent_grp, a_group_id, a_text, choose_flags(a_flags, exports.FLAGS.DEF));
  exports.add_choice(l_grp, a_text, 'start_point_mode', exports.START_MODE_KEYS,
    get_default(a_defaults, 'start_point_mode'));
  exports.add_int(l_grp, a_text, 'history_layer_count', 1, 50,
    get_default(a_defaults, 'history_layer_count'), 'unit_layers');
  exports.add_real(l_grp, a_text, 'min_start_distance', 0.0, 100.0,
    get_default(a_defaults, 'min_start_distance'), 'unit_mm');
  return l_grp;
};

/**
 * T4: Hatch rotation per layer with an optional limitation window.
 * MPBF background: Rotating the hatch direction from layer to layer
 * avoids that the shrinkage stresses of all layers add up in one
 * direction (lower residual stress, more uniform properties).
 * The limitation window keeps the hatch lines within a range of
 * directions, e.g. away from the gas flow direction, because the gas
 * flow blows spatter and fumes across the build area.
 * Parameters (degrees): start_angle and angle_increment (-360 ... 360),
 * window: limit_center_mode (relative to gas flow or absolute),
 * limit_center_angle (-360 ... 360; hatch angle value in the middle of
 * the window, same convention as start_angle: 0 = lines parallel to Y),
 * limit_width (1 ... 179; a line direction repeats every 180 degrees,
 * so 180 or more would not limit).
 * @param {Object} a_parent_grp  Parent group
 * @param {string} a_group_id    Group id (usually CHILD_ID.ROTATION)
 * @param {function(string):string} a_text  Localization function
 * @param {Object} [a_defaults]  Optional defaults { start_angle, angle_increment, limit_center_mode, limit_center_angle, limit_width }
 * @param {number} [a_flags]     Default FLAGS.DEF
 * @return {Object} New child group
 */
exports.create_rotation_group = function(a_parent_grp, a_group_id, a_text, a_defaults, a_flags)
{
  let l_grp = create_child(a_parent_grp, a_group_id, a_text, choose_flags(a_flags, exports.FLAGS.DEF));
  exports.add_real(l_grp, a_text, 'start_angle', -360.0, 360.0,
    get_default(a_defaults, 'start_angle'), 'unit_deg');
  exports.add_real(l_grp, a_text, 'angle_increment', -360.0, 360.0,
    get_default(a_defaults, 'angle_increment'), 'unit_deg');

  // The window is a nested optional group (check box), off by default.
  let l_limit = create_child(l_grp, exports.CHILD_ID.ROTATION_LIMIT, a_text, exports.FLAGS.OPT_OFF);
  exports.add_choice(l_limit, a_text, 'limit_center_mode', exports.LIMIT_CENTER_KEYS,
    get_default(a_defaults, 'limit_center_mode'));
  exports.add_real(l_limit, a_text, 'limit_center_angle', -360.0, 360.0,
    get_default(a_defaults, 'limit_center_angle'), 'unit_deg');
  exports.add_real(l_limit, a_text, 'limit_width', 1.0, 179.0,
    get_default(a_defaults, 'limit_width'), 'unit_deg');
  return l_grp;
};

/**
 * T5: Power optimization (power depending on the return time of the laser).
 * MPBF background: Short hatch vectors bring the laser back to its
 * last line quickly, while the material there is still hot; less
 * power is needed to avoid overheating. Long vectors give the material
 * time to cool; more power is needed for a full melt.
 * Parameters: min_power / max_power (0 ... 2000 W), min_vector_length /
 * max_vector_length (0.01 ... 1000 mm, converted to return times; the
 * validation in main/settings.js requires min < max for both pairs),
 * segment_splitting (one power per short segment instead of per vector),
 * microvector_length (segment length, 0.05 ... 10 mm),
 * merge_equal_power (join neighboring segments with equal power).
 * @param {Object} a_parent_grp  Parent group
 * @param {string} a_group_id    Group id (usually CHILD_ID.POWER_OPT)
 * @param {function(string):string} a_text  Localization function
 * @param {Object} [a_defaults]  Optional defaults (see TABLE_DEFAULTS, section T5)
 * @param {number} [a_flags]     Default FLAGS.OPT_OFF
 * @return {Object} New child group
 */
exports.create_power_opt_group = function(a_parent_grp, a_group_id, a_text, a_defaults, a_flags)
{
  let l_grp = create_child(a_parent_grp, a_group_id, a_text, choose_flags(a_flags, exports.FLAGS.OPT_OFF));
  exports.add_real(l_grp, a_text, 'min_power', 0.0, 2000.0, get_default(a_defaults, 'min_power'), 'unit_w');
  exports.add_real(l_grp, a_text, 'max_power', 0.0, 2000.0, get_default(a_defaults, 'max_power'), 'unit_w');
  exports.add_real(l_grp, a_text, 'min_vector_length', 0.01, 1000.0,
    get_default(a_defaults, 'min_vector_length'), 'unit_mm');
  exports.add_real(l_grp, a_text, 'max_vector_length', 0.01, 1000.0,
    get_default(a_defaults, 'max_vector_length'), 'unit_mm');
  exports.add_bool(l_grp, a_text, 'segment_splitting', get_default(a_defaults, 'segment_splitting'));
  exports.add_real(l_grp, a_text, 'microvector_length', 0.05, 10.0,
    get_default(a_defaults, 'microvector_length'), 'unit_mm');
  exports.add_bool(l_grp, a_text, 'merge_equal_power', get_default(a_defaults, 'merge_equal_power'));
  return l_grp;
};

/**
 * T6: Hatching (pattern, distance, sorting, pattern settings, rotation,
 * layer skip and optionally power optimization).
 * MPBF background: Hatching fills the inside of an island (one closed
 * region of a part in a layer) with parallel scan lines.
 * Parameters (lengths in mm):
 *   pattern                - meander / stripe / chess / hexagon / offset
 *   hatch_distance         - distance between neighboring lines (0.01 ... 10);
 *                            smaller than the melt track width, so the
 *                            tracks overlap and no powder stays unmelted
 *   min_vector_length_hatch - shorter hatch vectors are removed (0 = keep all)
 *   optimized_sorting      - block sort of the lines against the gas flow
 *   blocksort_*            - fine tuning of the block sort (0 = host default)
 *   stripe_* / chess_* / hexagon_* - size and overlap of the pattern cells;
 *                            a positive overlap makes neighboring cells
 *                            overlap, so no gap remains at the cell borders
 *   offset_inside_out      - expose the concentric rings from inside out
 * The overlap ranges also allow negative values (-5 ... 5 mm).
 * @param {Object} a_parent_grp       Parent group
 * @param {string} a_group_id         Group id
 * @param {function(string):string} a_text  Localization function
 * @param {Object} [a_defaults]       Optional defaults (any field of TABLE_DEFAULTS, plus 'pattern' as option key)
 * @param {number} [a_flags]          Default FLAGS.DEF
 * @param {string[]} a_pattern_keys   Offered patterns, e.g. ['pattern_meander', 'pattern_offset']
 * @param {boolean} a_with_power_opt  true = add the power optimization child group
 * @return {Object} New child group
 */
exports.create_hatch_group = function(a_parent_grp, a_group_id, a_text, a_defaults, a_flags,
  a_pattern_keys, a_with_power_opt)
{
  let l_grp = create_child(a_parent_grp, a_group_id, a_text, choose_flags(a_flags, exports.FLAGS.DEF));

  // TABLE_DEFAULTS has no 'pattern' entry: the first offered pattern is the fallback.
  exports.add_choice(l_grp, a_text, 'pattern', a_pattern_keys,
    get_default(a_defaults, 'pattern', a_pattern_keys[0]));
  exports.add_real(l_grp, a_text, 'hatch_distance', 0.01, 10.0,
    get_default(a_defaults, 'hatch_distance'), 'unit_mm');
  exports.add_real(l_grp, a_text, 'min_vector_length_hatch', 0.0, 10.0,
    get_default(a_defaults, 'min_vector_length_hatch'), 'unit_mm');
  exports.add_bool(l_grp, a_text, 'optimized_sorting', get_default(a_defaults, 'optimized_sorting'));
  exports.add_real(l_grp, a_text, 'blocksort_run_ahead_limit', 0.0, 1000.0,
    get_default(a_defaults, 'blocksort_run_ahead_limit'), 'unit_mm');
  exports.add_int(l_grp, a_text, 'blocksort_min_block_segments', 0, 1000,
    get_default(a_defaults, 'blocksort_min_block_segments'), '');
  exports.add_real(l_grp, a_text, 'blocksort_max_merge_distance', 0.0, 100.0,
    get_default(a_defaults, 'blocksort_max_merge_distance'), 'unit_mm');

  // Pattern specific parameters: only declared if the pattern is offered.
  // This keeps the UI short (e.g. supports show no stripe settings).
  // read_hatch() in param_readers.js uses TABLE_DEFAULTS for the others.
  if (a_pattern_keys.indexOf('pattern_stripe') >= 0)
  {
    // Stripes: width of one stripe, overlap to the neighbor stripe,
    // script based stripe sorting against the gas flow, and reversing
    // the scan direction for every second stripe.
    exports.add_real(l_grp, a_text, 'stripe_width', 0.5, 100.0, get_default(a_defaults, 'stripe_width'), 'unit_mm');
    exports.add_real(l_grp, a_text, 'stripe_overlap', -5.0, 5.0, get_default(a_defaults, 'stripe_overlap'), 'unit_mm');
    exports.add_bool(l_grp, a_text, 'stripe_script_sort', get_default(a_defaults, 'stripe_script_sort'));
    exports.add_bool(l_grp, a_text, 'stripe_alternate', get_default(a_defaults, 'stripe_alternate'));
  }
  if (a_pattern_keys.indexOf('pattern_chess') >= 0)
  {
    // Chessboard: edge length of one square field and field overlap.
    exports.add_real(l_grp, a_text, 'chess_size', 0.5, 100.0, get_default(a_defaults, 'chess_size'), 'unit_mm');
    exports.add_real(l_grp, a_text, 'chess_overlap', -5.0, 5.0, get_default(a_defaults, 'chess_overlap'), 'unit_mm');
  }
  if (a_pattern_keys.indexOf('pattern_hexagon') >= 0)
  {
    // Hexagons: side length of one cell and cell overlap.
    exports.add_real(l_grp, a_text, 'hexagon_side', 0.5, 100.0, get_default(a_defaults, 'hexagon_side'), 'unit_mm');
    exports.add_real(l_grp, a_text, 'hexagon_overlap', -5.0, 5.0, get_default(a_defaults, 'hexagon_overlap'), 'unit_mm');
  }
  if (a_pattern_keys.indexOf('pattern_offset') >= 0)
  {
    exports.add_bool(l_grp, a_text, 'offset_inside_out', get_default(a_defaults, 'offset_inside_out'));
  }

  // Child groups. a_defaults is passed on, so a caller can also
  // override e.g. 'angle_increment' or 'min_power' for this hatch group.
  exports.create_rotation_group(l_grp, exports.CHILD_ID.ROTATION, a_text, a_defaults);
  exports.create_layer_skip_group(l_grp, exports.CHILD_ID.LAYER_SKIP, a_text, a_defaults);
  if (a_with_power_opt === true)
  {
    exports.create_power_opt_group(l_grp, exports.CHILD_ID.POWER_OPT, a_text, a_defaults);
  }
  return l_grp;
};

/**
 * T7: Scan settings of one vector type (laser, power, speed, focus).
 * MPBF background: Every vector type has its own BSID (build style ID).
 * The BSID tells the machine which laser parameter set to use for a
 * vector. This group holds that parameter set:
 *   laser_index - laser that exposes the vectors (1 ... 16, 1 = first laser)
 *   power       - laser power (0 ... 2000 W)
 *   speed       - scan speed of the laser spot (1 ... 20000 mm/s)
 *   focus       - focus offset (-50 ... 50 mm, 0 = in focus)
 * More power or a lower speed puts more energy into the powder per mm.
 * The fallback values (laser 1, 100 W, 1000 mm/s, focus 0) are only
 * used if a_defaults does not contain the field.
 * @param {Object} a_parent_grp   Parent group
 * @param {string} a_group_id     Group id, e.g. 'grp_scan_hatch_volume'
 * @param {function(string):string} a_text  Localization function
 * @param {{laser_index:number, power:number, speed:number, focus:number}} a_defaults  Defaults (laser_index 1-based)
 * @param {number} [a_flags]      Default FLAGS.DEF
 * @param {string} [a_name_key]   Name key of the group (default: a_group_id)
 * @return {Object} New child group
 */
exports.create_scan_group = function(a_parent_grp, a_group_id, a_text, a_defaults, a_flags, a_name_key)
{
  let l_grp = create_child(a_parent_grp, a_group_id, a_text,
    choose_flags(a_flags, exports.FLAGS.DEF), a_name_key);
  exports.add_int(l_grp, a_text, 'laser_index', 1, 16, get_default(a_defaults, 'laser_index', 1), '');
  exports.add_real(l_grp, a_text, 'power', 0.0, 2000.0, get_default(a_defaults, 'power', 100.0), 'unit_w');
  exports.add_real(l_grp, a_text, 'speed', 1.0, 20000.0, get_default(a_defaults, 'speed', 1000.0), 'unit_mm_s');
  exports.add_real(l_grp, a_text, 'focus', -50.0, 50.0, get_default(a_defaults, 'focus', 0.0), 'unit_mm');
  return l_grp;
};

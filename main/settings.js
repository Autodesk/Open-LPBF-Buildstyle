/************************************************************
 * MODULE NAME: settings.js
 *
 * PURPOSE:
 *   Convert the parameter tree into plain settings objects
 *   (PartSettings, PlatformSettings), validate them and build the
 *   custom table. Also defines the names of all model and tray
 *   attributes used by this project.
 *
 * WORKFLOW:
 *   - declareModelFeatures / prepareModelExposure: read_part_settings()
 *   - prepareModelExposure: settings are stored at the model
 *   - makeExposureLayer, post-processing, export: settings are read back
 *     from the model attributes (read_model_object)
 *   - read_platform_settings() may be called in every entry point
 *
 * BACKGROUND (terms: see the glossary in main/main.js):
 *   - Why plain settings objects? Reading a parameter needs the host
 *     and is only allowed in certain entry points. A plain object
 *     (numbers, strings, booleans, nested objects) can be stored at the
 *     model, read in any thread and printed as JSON for the export.
 *   - PartSettings: everything that can differ per part (contours,
 *     hatching, skins, supports, laser settings per BSID).
 *   - PlatformSettings: everything for the whole build plate (laser
 *     timing, gas flow, build order, scanning order per BSID, scanner
 *     array and laser assignment of multi-laser machines).
 *   - Model attributes are named values stored at a model; tray
 *     attributes are named text values stored once for the build plate.
 *   - Units in the settings objects: mm, W, mm/s, degrees, layers;
 *     delays in microseconds (fields ending in _us).
 *
 * USAGE:
 *   var SETTINGS = require('main/settings.js');
 *   let l_part = SETTINGS.read_part_settings();
 *   let l_errors = SETTINGS.validate_part_settings(l_part);
 *
 * DEPENDENCIES:
 *   Builtins: none
 *   Modules : main/param_groups.js, main/vector_types.js,
 *             lib/params/param_readers.js, lib/params/param_factories.js,
 *             lib/multi_laser/laser_assignment.js (strategy names),
 *             lib/multi_laser/laser_bsid.js (laser bsids of the custom table)
 *
 * REUSE NOTES:
 *   Project specific. Tip: Post-processing and export
 *   functions are platform related. Reading part parameters there only
 *   produces warnings. Therefore part settings are stored as model
 *   attributes in prepareModelExposure and read back from there.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var PARAM_GROUPS = require('main/param_groups.js');
var VECTOR_TYPES = require('main/vector_types.js');
var READ = require('lib/params/param_readers.js');
var FACTORY = require('lib/params/param_factories.js');
var LASER_ASSIGNMENT = require('lib/multi_laser/laser_assignment.js');
var LASER_BSID = require('lib/multi_laser/laser_bsid.js');

var CHILD_ID = FACTORY.CHILD_ID;

/**
 * Version of the settings objects. Increase it when the structure changes.
 * It is stored in every settings object and therefore also appears in
 * the parameter JSON files of the export.
 * 2: PlatformSettings got scanner_array and laser_assignment.
 * 3: PlatformSettings.laser_timing got min_jump_delay_us and jump_length_limit.
 */
var S_SETTINGS_VERSION = 3;

/**
 * Project name and version of this build style. Defined once here and
 * used by about() (main/main.js) and by export_info.json
 * (main/export_main.js), so the two can never differ.
 */
exports.PROJECT_NAME = 'OSS_MPBF_01';
exports.PROJECT_VERSION = '1.0.0';

/** Name of the hull/core parameter set (declareModelFeatures and exposure must use the same name). */
exports.HULL_CORE_PARAM_SET = 'oss_hull_core';

/**
 * Names of the model attributes written in prepareModelExposure.
 * The prefix 'oss_' avoids name clashes with attributes of the host or
 * of other build styles.
 *   PART_SETTINGS / PLATFORM_SETTINGS: settings objects of this file
 *   PART_PARAMS_JSON / PLATFORM_PARAMS_JSON: full parameter copies (JSON text)
 *   MODEL_INFO: first / last layer number, bounds (mm), material, layer thickness
 *   CUSTOM_TABLE: laser settings per BSID ('customTable'); the name is
 *     read by the host applications and the exporters, never rename it.
 *     Post-processing reduces it to the BSIDs that are really used.
 *   FULL_CUSTOM_TABLE: complete custom table of prepareModelExposure;
 *     post-processing always reduces from this copy, so a repeated
 *     post-processing never misses a BSID that an earlier run removed.
 *   COLOR_TABLE: color legend ('toolpathColorTable'), read by the host.
 */
exports.MODEL_ATTR = Object.freeze({
  PART_SETTINGS: 'oss_part_settings',
  PLATFORM_SETTINGS: 'oss_platform_settings',
  PART_PARAMS_JSON: 'oss_part_params_json',
  PLATFORM_PARAMS_JSON: 'oss_platform_params_json',
  MODEL_INFO: 'oss_model_info',
  CUSTOM_TABLE: 'customTable',
  FULL_CUSTOM_TABLE: 'oss_custom_table_full',
  COLOR_TABLE: 'toolpathColorTable'
});

/**
 * Names of the tray attributes written in post-processing.
 * LAYER_TIME_PREFIX + layer number = estimated time of one layer in whole ms;
 * BUILD_TIME = sum of all layers in whole ms.
 * Both names are read by the host applications (same names as in the
 * other build styles, BUILD_TIME = BS_STACK_EXPOSURE_TIME of the host),
 * so they must not be renamed.
 * LAYER_USAGE_PREFIX + layer number = preview colors and BSIDs used in
 * the layer (temporary, passed from step 2 to step 3 and deleted there).
 * COLOR_TABLE = color legend of all models ('toolpathColorTable'), read
 * by the host.
 */
exports.TRAY_ATTR = Object.freeze({
  LAYER_TIME_PREFIX: 'layer_built_time_estimation_ms_',
  BUILD_TIME: 'built_time_estimation_ms',
  LAYER_USAGE_PREFIX: 'oss_layer_usage_',
  COLOR_TABLE: 'toolpathColorTable'
});

// Internal names of the build order modes. Same order as the options in
// PARAM_GROUPS.BUILD_ORDER_KEYS: the saved index selects the entry.
var S_BUILD_ORDER_MODES = ['platform', 'model', 'island', 'global'];

// Internal names of the load balancing metrics (same order as
// PARAM_GROUPS.LOAD_METRIC_KEYS). The strategy names come from
// LASER_ASSIGNMENT.STRATEGIES (same order as PARAM_GROUPS.LASER_STRATEGY_KEYS).
var S_LOAD_METRICS = ['length', 'time'];

/**
 * Largest number of lasers (scanner_count_x * scanner_count_y).
 * Same limit as the laser number of the scan groups (1 ... 16), so the
 * exported laser numbers stay in the range machines expect.
 */
var S_MAX_LASER_COUNT = 16;

/**
 * Internal name of a choice parameter value.
 * @param {Object} a_grp      Group of the parameter
 * @param {string} a_id       Parameter id
 * @param {string[]} a_names  Internal names in option order
 * @return {string} Name of the selected option (the first one for invalid indices)
 */
function read_choice_name(a_grp, a_id, a_names)
{
  let l_index = a_grp.getParam(a_id).getValueInt();
  if ((l_index >= 0) && (l_index < a_names.length)) return a_names[l_index];
  return a_names[0];
}

//////////////////////////////////////////////////////////////
// Reading
//////////////////////////////////////////////////////////////

/**
 * Read the settings shared by all contour groups (border first,
 * following borders, fill contours).
 * layer_skip: { every_nth, offset }; stipple: { enabled, length (mm),
 * overlap (mm), count, random_start }; start_point: { mode,
 * history_layers, min_distance (mm) } (see lib/params/param_readers.js).
 * @param {Object} a_grp  Contour group
 * @return {{layer_skip:Object, stipple:Object, start_point:Object}}
 */
function read_contour_children(a_grp)
{
  return {
    layer_skip: READ.read_layer_skip(a_grp.getChildGrp(CHILD_ID.LAYER_SKIP)),
    stipple: READ.read_stipple(a_grp.getChildGrp(CHILD_ID.STIPPLE)),
    start_point: READ.read_start_point(a_grp.getChildGrp(CHILD_ID.START_POINT))
  };
}

/**
 * Read all part parameters.
 * Only call this in part related entry points (declareModelFeatures,
 * prepareModelExposure).
 * The values belong to the part that is active in that entry point.
 * Tip: getParamVal(id) returns the current value of a
 * parameter (number or boolean); isGrpEnabled() returns the check box
 * state of an optional group.
 * @return {Object} PartSettings (see project plan, section 6.2)
 */
exports.read_part_settings = function()
{
  // Short alias to keep the long object below readable.
  let G = PARAM_GROUPS;

  let l_bf = G.border_first_group;
  let l_bf_children = read_contour_children(l_bf);
  let l_bo = G.border_following_group;
  let l_bo_children = read_contour_children(l_bo);
  let l_fc = G.fill_contour_group;
  let l_fc_children = read_contour_children(l_fc);

  // The structure mirrors the parameter tree: one field per top-level
  // group. Optional groups get 'enabled'; lengths are in mm.
  let r_part = {
    version: S_SETTINGS_VERSION,
    hull_core: {
      enabled: G.hull_core_group.isGrpEnabled(),
      min_thickness: G.hull_core_group.getParamVal('min_hull_thickness'),
      core_every_nth: G.hull_core_group.getParamVal('core_every_nth_layer')
    },
    border_first: {
      enabled: l_bf.isGrpEnabled(),
      beam_comp: l_bf.getParamVal('beam_compensation'),
      blocked_path: {
        enabled: l_bf.getParamVal('blocked_path_enabled'),
        min_length: l_bf.getParamVal('blocked_path_min_length')
      },
      alternate_per_layer: l_bf.getParamVal('alternate_per_layer'),
      layer_skip: l_bf_children.layer_skip,
      stipple: l_bf_children.stipple,
      start_point: l_bf_children.start_point
    },
    border_following: {
      enabled: l_bo.isGrpEnabled(),
      count: l_bo.getParamVal('border_count'),
      first_offset: l_bo.getParamVal('first_offset'),
      following_offset: l_bo.getParamVal('following_offset'),
      alternate_per_layer: l_bo.getParamVal('alternate_per_layer'),
      alternate_per_contour: l_bo.getParamVal('alternate_per_contour'),
      layer_skip: l_bo_children.layer_skip,
      stipple: l_bo_children.stipple,
      start_point: l_bo_children.start_point
    },
    fill_contour: {
      enabled: l_fc.isGrpEnabled(),
      count: l_fc.getParamVal('fill_contour_count'),
      first_offset: l_fc.getParamVal('first_offset'),
      following_offset: l_fc.getParamVal('following_offset'),
      alternate_per_layer: l_fc.getParamVal('alternate_per_layer'),
      alternate_per_contour: l_fc.getParamVal('alternate_per_contour'),
      layer_skip: l_fc_children.layer_skip,
      stipple: l_fc_children.stipple,
      start_point: l_fc_children.start_point
    },
    // READ.read_hatch returns a HATCH object: pattern, hatch_distance,
    // min_vector_length, sorting, pattern sizes, rotation, layer_skip and
    // power_opt (see lib/params/param_readers.js).
    hatching: {
      hatch_offset: G.hatching_group.getParamVal('hatch_offset'),
      volume: READ.read_hatch(G.hatching_group.getChildGrp('grp_hatch_volume'), G.PART_PATTERN_KEYS),
      core: READ.read_hatch(G.hatching_group.getChildGrp('grp_hatch_core'), G.PART_PATTERN_KEYS)
    },
    overhang: {
      enabled: G.overhang_group.isGrpEnabled(),
      surface_angle: G.overhang_group.getParamVal('surface_angle'),
      reference_layers: G.overhang_group.getParamVal('reference_layers'),
      min_width: G.overhang_group.getParamVal('min_width'),
      overlap: G.overhang_group.getParamVal('overlap'),
      border_splitting: G.overhang_group.getParamVal('border_splitting'),
      fill_contour_splitting: G.overhang_group.getParamVal('fill_contour_splitting'),
      hatch: READ.read_hatch(G.overhang_group.getChildGrp('grp_hatch_downskin'), G.PART_PATTERN_KEYS)
    },
    upskin: {
      enabled: G.upskin_group.isGrpEnabled(),
      min_width: G.upskin_group.getParamVal('min_width'),
      overlap: G.upskin_group.getParamVal('overlap'),
      hatch: READ.read_hatch(G.upskin_group.getChildGrp('grp_hatch_upskin'), G.PART_PATTERN_KEYS)
    },
    support_wall: {
      enabled: G.support_wall_group.isGrpEnabled(),
      layer_skip: READ.read_layer_skip(G.support_wall_group.getChildGrp(CHILD_ID.LAYER_SKIP))
    },
    support_solid: {
      enabled: G.support_solid_group.isGrpEnabled(),
      inset: G.support_solid_group.getParamVal('support_inset'),
      hatch: READ.read_hatch(G.support_solid_group.getChildGrp('grp_hatch_support'), G.SUPPORT_PATTERN_KEYS)
    },
    scanning: {}
  };

  // One entry per vector type. Keys are bsids as strings (JSON compatible).
  // Example: r_part.scanning['500'] = { laser_index: 1, power: 280,
  // speed: 1200, focus: 0 } (laser_index 1-based as in the UI).
  for (let i = 0; i < VECTOR_TYPES.VECTOR_TYPES.length; ++i)
  {
    let l_vt = VECTOR_TYPES.VECTOR_TYPES[i];
    r_part.scanning[String(l_vt.bsid)] =
      READ.read_scan(G.scanning_group.getChildGrp('grp_scan_' + l_vt.key));
  }
  return r_part;
};

/**
 * Read all platform parameters. Allowed in every entry point.
 * @return {Object} PlatformSettings (see project plan, section 6.4)
 */
exports.read_platform_settings = function()
{
  let G = PARAM_GROUPS;
  // Choice parameters are read by INDEX of the selected option (not by
  // the displayed, translated text), so the result does not depend on
  // the user interface language. Invalid indices fall back to 'platform'.
  let l_mode_index = G.build_order_group.getParam('build_order_mode').getValueInt();
  let l_mode = 'platform';
  if ((l_mode_index >= 0) && (l_mode_index < S_BUILD_ORDER_MODES.length))
  {
    l_mode = S_BUILD_ORDER_MODES[l_mode_index];
  }

  let r_platform = {
    version: S_SETTINGS_VERSION,
    // Timing object of lib/time/scanner_delays.js.
    laser_timing: {
      jump_speed: G.laser_timing_group.getParamVal('jump_speed'),
      mark_delay_us: G.laser_timing_group.getParamVal('mark_delay'),
      jump_delay_us: G.laser_timing_group.getParamVal('jump_delay'),
      min_jump_delay_us: G.laser_timing_group.getParamVal('min_jump_delay'),
      jump_length_limit: G.laser_timing_group.getParamVal('jump_length_limit')
    },
    gas_flow: { angle: G.gas_flow_group.getParamVal('gas_flow_angle') },
    build_order: {
      sort_models: G.build_order_group.getParamVal('sort_models'),
      mode: l_mode
    },
    scanning_order: {},
    // Scanner grid and platform bounds in mm (see lib/multi_laser/scanner_array.js).
    scanner_array: {
      center_x: G.scanner_array_group.getParamVal('scanner_center_x'),
      center_y: G.scanner_array_group.getParamVal('scanner_center_y'),
      count_x: G.scanner_array_group.getParamVal('scanner_count_x'),
      count_y: G.scanner_array_group.getParamVal('scanner_count_y'),
      spacing_x: G.scanner_array_group.getParamVal('scanner_spacing_x'),
      spacing_y: G.scanner_array_group.getParamVal('scanner_spacing_y'),
      field_width: G.scanner_array_group.getParamVal('scan_field_width'),
      field_height: G.scanner_array_group.getParamVal('scan_field_height'),
      platform: {
        min_x: G.scanner_array_group.getParamVal('platform_min_x'),
        max_x: G.scanner_array_group.getParamVal('platform_max_x'),
        min_y: G.scanner_array_group.getParamVal('platform_min_y'),
        max_y: G.scanner_array_group.getParamVal('platform_max_y')
      }
    },
    // strategy: one of LASER_ASSIGNMENT.STRATEGIES; metric: 'length' or 'time'.
    laser_assignment: {
      enabled: G.laser_assignment_group.getParamVal('laser_assignment_enabled') === true,
      strategy: read_choice_name(G.laser_assignment_group, 'assignment_strategy', LASER_ASSIGNMENT.STRATEGIES),
      metric: read_choice_name(G.laser_assignment_group, 'load_balance_metric', S_LOAD_METRICS),
      proximity_weight: G.laser_assignment_group.getParamVal('proximity_weight'),
      swimlane_width: G.laser_assignment_group.getParamVal('swimlane_width'),
      split_polylines: G.laser_assignment_group.getParamVal('swimlane_split_polylines') === true
    }
  };

  // Scanning order per BSID, e.g. { '100': 80, '500': 40, ... };
  // smaller numbers are exposed earlier.
  for (let i = 0; i < VECTOR_TYPES.VECTOR_TYPES.length; ++i)
  {
    let l_vt = VECTOR_TYPES.VECTOR_TYPES[i];
    r_platform.scanning_order[String(l_vt.bsid)] =
      G.scanning_order_group.getParamVal('order_' + l_vt.key);
  }
  return r_platform;
};

/**
 * Read a settings object that was stored with setAttribEx.
 * Robust against hosts that return the stored value as JSON string.
 * @param {bsModel} a_model  Model
 * @param {string} a_name    Attribute name
 * @return {Object|undefined} Stored object or undefined
 */
exports.read_model_object = function(a_model, a_name)
{
  let l_value = a_model.getAttribEx(a_name);
  // Not stored (prepareModelExposure did not run for this model).
  if ((typeof l_value === 'undefined') || (l_value === null)) return undefined;
  if (typeof l_value === 'string')
  {
    // Tip: JSON.parse throws on invalid text. The exception is
    // caught here and turned into "undefined", so the callers only have
    // to check one case ("no settings").
    try
    {
      return JSON.parse(l_value);
    }
    catch (e)
    {
      return undefined;
    }
  }
  // The host returned the object itself.
  return l_value;
};

//////////////////////////////////////////////////////////////
// Validation
//////////////////////////////////////////////////////////////

/**
 * Check one HATCH configuration and append error messages.
 * @param {Object} a_hatch    HATCH object
 * @param {string} a_name     Name used in the messages
 * @param {string[]} a_errors Error list (modified)
 */
function validate_hatch(a_hatch, a_name, a_errors)
{
  // Tip: the checks use !(a < b) instead of (a >= b). This is
  // also true if a value is not a number (NaN), so missing values are
  // reported as errors, too.
  let l_po = a_hatch.power_opt;
  // Power optimization: the power is interpolated between min_power
  // (short vectors) and max_power (long vectors), so both ranges must
  // be in ascending order, and micro vectors need a length > 0.
  if (l_po && l_po.enabled)
  {
    if (!(l_po.min_power < l_po.max_power))
      a_errors.push(a_name + ': minimum power must be smaller than maximum power');
    if (!(l_po.min_length < l_po.max_length))
      a_errors.push(a_name + ': vector length for minimum power must be smaller than for maximum power');
    if (!(l_po.microvector_length > 0))
      a_errors.push(a_name + ': segment length must be greater than 0');
  }
  // Pattern sizes are only checked for the selected pattern.
  // A stripe or chess field must hold more than two hatch lines, and a
  // hexagon side must be longer than one hatch distance, otherwise the
  // cells would contain (almost) no hatch lines.
  if ((a_hatch.pattern === 'stripe') && !(a_hatch.stripe.width > 2.0 * a_hatch.hatch_distance))
    a_errors.push(a_name + ': stripe width must be greater than two hatch distances');
  if ((a_hatch.pattern === 'chess') && !(a_hatch.chess.size > 2.0 * a_hatch.hatch_distance))
    a_errors.push(a_name + ': field size must be greater than two hatch distances');
  if ((a_hatch.pattern === 'hexagon') && !(a_hatch.hexagon.side > a_hatch.hatch_distance))
    a_errors.push(a_name + ': hexagon side length must be greater than the hatch distance');
}

/**
 * Validate the part settings.
 * All errors are collected (not only the first one), so the user can
 * fix everything at once. Only active features are checked: the volume
 * hatch is always used, the others only if their group is enabled.
 * @param {Object} a_part  PartSettings
 * @return {string[]} English error messages (empty = valid)
 */
exports.validate_part_settings = function(a_part)
{
  let r_errors = [];
  validate_hatch(a_part.hatching.volume, 'Volume hatching', r_errors);
  if (a_part.hull_core.enabled) validate_hatch(a_part.hatching.core, 'Core hatching', r_errors);
  if (a_part.overhang.enabled) validate_hatch(a_part.overhang.hatch, 'Downskin hatching', r_errors);
  if (a_part.upskin.enabled) validate_hatch(a_part.upskin.hatch, 'Upskin hatching', r_errors);
  if (a_part.support_solid.enabled) validate_hatch(a_part.support_solid.hatch, 'Support hatching', r_errors);
  if (!(a_part.overhang.reference_layers >= 1))
    r_errors.push('Overhang: at least one reference layer is required');
  return r_errors;
};

/**
 * Validate the platform settings.
 * @param {Object} a_platform  PlatformSettings
 * @return {string[]} English error messages (empty = valid)
 */
exports.validate_platform_settings = function(a_platform)
{
  let r_errors = [];
  // The time calculations divide by the jump speed.
  if (!(a_platform.laser_timing.jump_speed > 0))
    r_errors.push('Laser timing: jump speed must be greater than 0');
  // A minimum above the full delay would make short jumps slower than
  // long ones; only checked when the scaling is switched on.
  if ((a_platform.laser_timing.jump_length_limit > 0) &&
      (a_platform.laser_timing.min_jump_delay_us > a_platform.laser_timing.jump_delay_us))
    r_errors.push('Laser timing: minimum jump delay must not be greater than the jump delay');
  // The scanner array is only checked when it is used.
  if (a_platform.laser_assignment.enabled)
  {
    let l_sa = a_platform.scanner_array;
    if (!(l_sa.count_x * l_sa.count_y <= S_MAX_LASER_COUNT))
      r_errors.push('Scanner array: at most ' + S_MAX_LASER_COUNT + ' scanners are allowed');
    if (!(l_sa.platform.min_x < l_sa.platform.max_x) || !(l_sa.platform.min_y < l_sa.platform.max_y))
      r_errors.push('Scanner array: platform minimum must be smaller than platform maximum');
    if (!(a_platform.laser_assignment.swimlane_width > 0))
      r_errors.push('Laser assignment: swimlane width must be greater than 0');
    // Laser bsids are (laser + 1) * 1000 + vector type (lib/multi_laser/laser_bsid.js),
    // so every vector type bsid must stay below 1000.
    for (let i = 0; i < VECTOR_TYPES.VECTOR_TYPES.length; ++i)
    {
      if (!(VECTOR_TYPES.VECTOR_TYPES[i].bsid < LASER_BSID.STRIDE))
        r_errors.push('Laser assignment: vector type bsid ' + VECTOR_TYPES.VECTOR_TYPES[i].bsid +
          ' must be smaller than ' + LASER_BSID.STRIDE);
    }
  }
  return r_errors;
};

//////////////////////////////////////////////////////////////
// Custom table
//////////////////////////////////////////////////////////////

/**
 * Build the custom table (one entry per vector type). The custom table
 * is stored at the model and describes the laser settings of each bsid
 * for exporters.
 * Tip: The UI shows laser numbers starting at 1, the custom
 * table and the toolpath attribute use 0-based laser indices.
 * Both are stored (laserIndex 0-based, laserNumber 1-based), so every
 * exporter can use the form its file format needs.
 * MPBF background: a machine can have several lasers; laserIndex tells
 * which laser exposes the vectors of this BSID.
 * Laser assignment: when it is enabled, the post-processing moves every
 * path to the laser bsid of its vector type (lib/multi_laser/laser_bsid.js,
 * e.g. 500 on laser 1 -> 2500). The host (smoke simulation) and the
 * exporters find the laser ONLY through this table, so one extra entry
 * per vector type and laser is added: same power, speed and focus as the
 * vector type, laserIndex = the assigned laser. The plain entries stay
 * for paths that keep their vector type bsid.
 * @param {Object} a_part      PartSettings
 * @param {Object} a_platform  PlatformSettings (laser assignment, scanner array)
 * @return {Object[]} Custom table entries
 *         { bsid, name, laserIndex, laserNumber, power (W), speed (mm/s), focus (mm) }
 */
exports.build_custom_table = function(a_part, a_platform)
{
  let r_table = [];
  for (let i = 0; i < VECTOR_TYPES.VECTOR_TYPES.length; ++i)
  {
    let l_vt = VECTOR_TYPES.VECTOR_TYPES[i];
    let l_scan = a_part.scanning[String(l_vt.bsid)];
    r_table.push({
      bsid: l_vt.bsid,
      name: l_vt.key,
      laserIndex: l_scan.laser_index - 1,
      laserNumber: l_scan.laser_index,
      power: l_scan.power,
      speed: l_scan.speed,
      focus: l_scan.focus
    });
  }

  if (!a_platform.laser_assignment.enabled) return r_table;
  // Laser count of the scanner array (rounded like in build_scanner_array).
  let l_lasers = Math.max(1, Math.round(a_platform.scanner_array.count_x)) *
    Math.max(1, Math.round(a_platform.scanner_array.count_y));
  for (let l = 0; l < l_lasers; ++l)
  {
    for (let i = 0; i < VECTOR_TYPES.VECTOR_TYPES.length; ++i)
    {
      let l_vt = VECTOR_TYPES.VECTOR_TYPES[i];
      let l_scan = a_part.scanning[String(l_vt.bsid)];
      r_table.push({
        bsid: LASER_BSID.make_laser_bsid(l_vt.bsid, l),
        // e.g. 'hatch_volume_laser2' (laser number 1-based, as in the UI)
        name: l_vt.key + '_laser' + (l + 1),
        laserIndex: l,
        laserNumber: l + 1,
        power: l_scan.power,
        speed: l_scan.speed,
        focus: l_scan.focus
      });
    }
  }
  return r_table;
};

/**
 * Custom table with only the entries of the given BSIDs, in the order
 * of the full table. With the laser assignment the full table has one
 * entry per vector type and laser; most of them are never used, and
 * the host and the exporters only need the used ones.
 * Entries without a numeric bsid are kept (not created by this build
 * style, so they are not touched).
 * @param {Object[]} a_full_table  Result of build_custom_table
 * @param {Set} a_used_bsids       BSIDs (numbers) of all paths of the model
 * @return {Object[]} New array; the entries are shared with a_full_table
 */
exports.reduce_custom_table = function(a_full_table, a_used_bsids)
{
  let r_table = [];
  for (let i = 0; i < a_full_table.length; ++i)
  {
    let l_entry = a_full_table[i];
    if (!l_entry) continue;
    if ((typeof l_entry.bsid !== 'number') || a_used_bsids.has(l_entry.bsid)) r_table.push(l_entry);
  }
  return r_table;
};

/************************************************************
 * MODULE NAME: postprocess.js
 *
 * PURPOSE:
 *   Post-processing of the whole layer stack after all layers were
 *   exposed:
 *   1. step_start_points_st: contour start points that avoid the
 *      start points of previous layers (single-threaded).
 *   2. step_layers_mt: exposure order, laser assignment (multi-laser
 *      machines, optional), power optimization and time estimation per
 *      layer (multi-threaded).
 *   3. step_finish_st: total exposure time, color legend and custom
 *      table reduced to the used BSIDs (single-threaded).
 *   Attributes read by the host applications (names in
 *   SETTINGS.TRAY_ATTR / SETTINGS.MODEL_ATTR):
 *   'layer_built_time_estimation_ms_<n>' and 'built_time_estimation_ms'
 *   at the tray, 'toolpathColorTable' at the tray and at every model,
 *   'customTable' at every model.
 *
 * WORKFLOW:
 *   Why this order:
 *   1. Start points first: they need the layers in strictly ascending
 *      order, which only a single-threaded step guarantees.
 *   2. Sorting first in step 2: it fixes the sequence of the paths
 *      ('_processing_order'). Every later step works along it.
 *   3. Laser assignment (if enabled) next: it balances the lasers pass
 *      by pass along the sorted order (one pass per scanning order value
 *      inside each part / island, see lib/multi_laser/laser_assignment.js).
 *      It cuts and regroups hatch vectors and writes the final
 *      processing order itself.
 *   4. Power optimization after that: the power of a vector depends on
 *      the time until its laser comes back next to it, so it is computed
 *      along the vectors each laser really scans, in the final order
 *      (one timeline per laser, model and vector type, see
 *      lib/power/power_optimization.js). Cut pieces get the power of
 *      their own length, not of the original longer vector. The rebuild
 *      keeps the processing order and the laser of every path.
 *   5. Time estimation last, in the final order and per laser.
 *
 * BACKGROUND (terms: see the glossary in main/main.js):
 *   - Start points: a closed contour starts and ends at the same point,
 *     where a small seam remains. If the seams of many layers lie on
 *     top of each other, they form a visible line on the part surface.
 *     The modes 'previous' / 'random_previous' choose a start point far
 *     enough away from the start points of the last N layers.
 *   - Power optimization: on short hatch lines the laser comes back
 *     quickly to the neighboring line while it is still hot, so less
 *     power is needed; long lines had time to cool down and get more
 *     power (lib/power/power_model.js).
 *   - Exposure order: written as '_processing_order' at every path.
 *   - Laser assignment: on machines with several scanners, every path
 *     is given to one laser (attribute 'laser_index'), so that all
 *     lasers have about the same work; vectors may be cut at scan field
 *     or swimlane borders. Off by default (grp_laser_assignment).
 *   - Exposure time: estimated from marking length / speed, jumps and
 *     delays; with several lasers the slowest laser decides. Recoating
 *     time is not included.
 *   Every step function gets (modelData, progress, layer_start_nr,
 *   layer_end_nr, input_results) from the host; input_results is not
 *   used by this project.
 *
 * USAGE:
 *   var POSTPROCESS = require('main/postprocess.js');
 *   a_config.addPostProcessingStep(POSTPROCESS.step_start_points_st, { bMultithread: false, nProgressWeight: 1 });
 *
 * DEPENDENCIES:
 *   Builtins: bsPolylineIterator
 *   Modules : main/settings.js, main/vector_types.js, main/param_groups.js,
 *             main/color_table.js, main/layer_usage.js,
 *             lib/sorting/..., lib/power/..., lib/time/..., lib/geometry/gas_flow.js,
 *             lib/multi_laser/..., lib/util/...
 *
 * NOTES:
 *   Tip: Post-processing and export functions are platform
 *   related. Reading part parameters there only produces warnings.
 *   Therefore part settings are stored as model attributes in
 *   prepareModelExposure and read back from there.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var POLY_IT = requireBuiltin('bsPolylineIterator');
var SETTINGS = require('main/settings.js');
var VECTOR_TYPES = require('main/vector_types.js');
var PARAM_GROUPS = require('main/param_groups.js');
var START_HIST = require('lib/sorting/start_point_history.js');
var SORTER = require('lib/sorting/exposure_sorter.js');
var POWER_OPT = require('lib/power/power_optimization.js');
var EXPOSURE_TIME = require('lib/time/exposure_time.js');
var COLOR_TABLE = require('main/color_table.js');
var LAYER_USAGE = require('main/layer_usage.js');
var GAS_FLOW = require('lib/geometry/gas_flow.js');
var SCANNER_ARRAY = require('lib/multi_laser/scanner_array.js');
var LASER_ASSIGNMENT = require('lib/multi_laser/laser_assignment.js');
var LASER_BSID = require('lib/multi_laser/laser_bsid.js');
var RANDOM = require('lib/util/random.js');
var MATH = require('lib/util/math_utils.js');
var ATTR = require('lib/util/attribute_names.js').ATTR;
var LOG = require('lib/util/log.js');

var BSID = VECTOR_TYPES.BSID;
var MODEL_ATTR = SETTINGS.MODEL_ATTR;
// Tip: The "tray" is the whole build plate. Tray attributes
// are text values stored once for the build (not per model); they are
// used here to pass the layer times from step 2 to step 3 and to the
// export.
var TRAY_ATTR = SETTINGS.TRAY_ATTR;

/**
 * Start point modes that need the previous layers.
 * 'off' and 'random' are handled completely in makeExposureLayer.
 */
var S_HISTORY_MODES = ['previous', 'random_previous'];

/**
 * Free memory every N layers in the multi-threaded step.
 * The power optimization creates many temporary objects. global.gc is
 * only called if the host makes it available (see step_layers_mt).
 */
var S_GC_INTERVAL = 10;

// -----------------------------------------------------------
// Helpers
// -----------------------------------------------------------

/**
 * Settings stored at every model in prepareModelExposure.
 * A model without settings (e.g. not calculated) is skipped with a
 * single warning instead of aborting the post-processing of all others.
 * @param {bsModelData} a_model_data  All models of the build
 * @return {Array} Per model index: { part, info } or undefined if missing
 *         (the array index is the model index, so it is never compacted)
 */
function load_model_context(a_model_data)
{
  let r_models = [];
  for (let i = 0; i < a_model_data.getModelCount(); ++i)
  {
    let l_model = a_model_data.getModel(i);
    let l_part = SETTINGS.read_model_object(l_model, MODEL_ATTR.PART_SETTINGS);
    let l_info = SETTINGS.read_model_object(l_model, MODEL_ATTR.MODEL_INFO);
    if (!l_part || !l_info)
    {
      LOG.warning_once('pp_model_' + i, 'Settings of model ' + (i + 1) + ' are missing; it is not post-processed.');
      r_models.push(undefined);
      continue;
    }
    r_models.push({ part: l_part, info: l_info });
  }
  return r_models;
}

/**
 * Advance the progress by one step.
 * step() returning false means "stop". Some host versions offer an
 * additional cancelled() function; it is only called if it exists.
 * @param {Object} a_progress  Progress object of the step
 * @return {boolean} true if the user cancelled
 */
function step_and_check_cancel(a_progress)
{
  if (a_progress.step(1) === false) return true;
  return (typeof a_progress.cancelled === 'function') && (a_progress.cancelled() === true);
}

/**
 * Read the platform settings (fresh values in every step).
 * Platform parameters may be read in post-processing (unlike part
 * parameters, see NOTES above), so they are not taken from the model.
 * @return {Object} PlatformSettings (see main/settings.js)
 */
function read_platform()
{
  PARAM_GROUPS.clear_all_cached_values();
  return SETTINGS.read_platform_settings();
}

/**
 * Contour settings of a start point family ('border_first', ...).
 * The family of a BSID is defined in main/vector_types.js; a contour and
 * its downskin variant belong to the same family and share the settings.
 * @param {Object} a_part    PartSettings
 * @param {string} a_family  'border_first', 'border_following' or 'fill_contour'
 * @return {Object|undefined} Contour settings, undefined for other families
 */
function get_family_settings(a_part, a_family)
{
  if (a_family === 'border_first') return a_part.border_first;
  if (a_family === 'border_following') return a_part.border_following;
  if (a_family === 'fill_contour') return a_part.fill_contour;
  return undefined;
}

/**
 * Does the contour setting use a start point mode with history?
 * Tip: '!!' converts any value to true / false.
 * @param {Object|undefined} a_contour_cfg  Contour settings
 * @return {boolean}
 */
function uses_history(a_contour_cfg)
{
  return !!(a_contour_cfg && a_contour_cfg.enabled && a_contour_cfg.start_point &&
    (S_HISTORY_MODES.indexOf(a_contour_cfg.start_point.mode) >= 0));
}

/**
 * Does any model use a start point mode with history?
 * Used to skip step 1 completely (it is single-threaded and therefore
 * slow) when no contour needs it.
 * @param {Array} a_models  Result of load_model_context
 * @return {boolean}
 */
function any_model_uses_history(a_models)
{
  for (let i = 0; i < a_models.length; ++i)
  {
    let l_m = a_models[i];
    if (!l_m) continue;
    if (uses_history(l_m.part.border_first) || uses_history(l_m.part.border_following) ||
        uses_history(l_m.part.fill_contour))
    {
      return true;
    }
  }
  return false;
}

/**
 * Vector types with power optimization of one model.
 * Only the four part hatch types offer a power optimization; contours
 * and supports always keep their constant power.
 * The power model needs the hatch distance (mm) and the mark speed
 * (mm/s) to compute how long the laser needs to return to a point.
 * Tip: a Map is a key -> value table; here the key is the
 * BSID as number.
 * @param {Object} a_part  PartSettings
 * @return {Map} bsid -> { power_opt, hatch_distance, speed }
 *         (empty Map = nothing to optimize for this model)
 */
function build_power_opt_map(a_part)
{
  let r_map = new Map();
  let l_list = [
    { bsid: BSID.hatch_volume, hatch: a_part.hatching.volume },
    { bsid: BSID.hatch_core, hatch: a_part.hatching.core },
    { bsid: BSID.hatch_downskin, hatch: a_part.overhang.hatch },
    { bsid: BSID.hatch_upskin, hatch: a_part.upskin.hatch }
  ];
  for (let i = 0; i < l_list.length; ++i)
  {
    let l_h = l_list[i].hatch;
    if (!l_h || !l_h.power_opt || !l_h.power_opt.enabled) continue;
    let l_scan = a_part.scanning[String(l_list[i].bsid)];
    r_map.set(l_list[i].bsid, {
      power_opt: l_h.power_opt,
      hatch_distance: l_h.hatch_distance,
      speed: l_scan.speed
    });
  }
  return r_map;
}

/**
 * Power optimization map of one model including the laser bsids.
 * With the laser assignment, the paths carry laser bsids (e.g. 2500 =
 * volume hatch on laser 1, see lib/multi_laser/laser_bsid.js). Every
 * laser bsid gets the SAME settings object as its vector type, so it
 * uses the original hatch distance, speed and power settings, and the
 * power optimization recognizes all bsids of one vector type as one
 * vector type (one timeline per laser).
 * @param {Object} a_part         PartSettings
 * @param {number} a_laser_count  Number of lasers (0 = no laser assignment)
 * @return {Map} bsid -> { power_opt, hatch_distance, speed }
 */
function build_laser_power_opt_map(a_part, a_laser_count)
{
  let r_map = build_power_opt_map(a_part);
  // Copy of the keys first: the map is extended inside the loop.
  let l_type_bsids = Array.from(r_map.keys());
  for (let l = 0; l < a_laser_count; ++l)
  {
    for (let i = 0; i < l_type_bsids.length; ++i)
    {
      r_map.set(LASER_BSID.make_laser_bsid(l_type_bsids[i], l), r_map.get(l_type_bsids[i]));
    }
  }
  return r_map;
}

/**
 * Let models with equal power settings share one settings object.
 * Used in the sort mode 'global', where all models are treated as one:
 * a laser then scans blocks of different parts one after the other, and
 * the power optimization puts all blocks with the same settings object
 * on one timeline per laser (lib/power/power_optimization.js). Models
 * whose settings for a vector type differ (hatch distance, speed, power
 * range, ...) keep their own object, i.e. their own timeline, because
 * the power model needs one speed and hatch distance per timeline.
 * @param {Array} a_maps  Per model index: Map bsid -> settings object (modified)
 * @return {void}
 */
function share_equal_power_settings(a_maps)
{
  // Key: vector type + settings as JSON text -> shared settings object.
  // The vector type is part of the key, so two vector types with equal
  // settings still get separate timelines.
  let l_shared = new Map();
  for (let m = 0; m < a_maps.length; ++m)
  {
    a_maps[m].forEach(function(a_cfg, a_bsid)
    {
      let l_key = LASER_BSID.type_bsid(a_bsid) + '|' + JSON.stringify(a_cfg);
      if (!l_shared.has(l_key)) l_shared.set(l_key, a_cfg);
      a_maps[m].set(a_bsid, l_shared.get(l_key));
    });
  }
}

/**
 * Mark speed per vector type of every model (fallback for the time estimate).
 * Normally every path carries its speed as attribute; this table is
 * used for paths without it.
 * @param {Array} a_models  Result of load_model_context
 * @return {Array} Per model index: { '<bsid>': speed in mm/s } (empty for missing models)
 */
function build_speed_lookup(a_models)
{
  let r_lookup = [];
  for (let i = 0; i < a_models.length; ++i)
  {
    r_lookup.push(a_models[i] ? EXPOSURE_TIME.build_speed_table(a_models[i].part) : {});
  }
  return r_lookup;
}

/**
 * Sorter settings for all layers.
 * The model ranks (order of the parts along the gas flow) are computed
 * once from the model bounds, so the part order is the same in every
 * layer.
 * @param {Array} a_models     Result of load_model_context
 * @param {Object} a_platform  PlatformSettings
 * @return {Object} Settings for SORTER.sort_layer
 */
function build_sorter_config(a_models, a_platform)
{
  let l_gas_dir = GAS_FLOW.flow_direction(a_platform.gas_flow.angle);
  let l_bounds = [];
  for (let i = 0; i < a_models.length; ++i)
  {
    l_bounds.push(a_models[i] ? a_models[i].info.bounds : undefined);
  }
  return {
    mode: a_platform.build_order.mode,
    sort_models: a_platform.build_order.sort_models === true,
    gas_dir: l_gas_dir,
    scan_order: a_platform.scanning_order,
    model_rank: SORTER.compute_model_ranks(l_bounds, a_platform.build_order.sort_models === true, l_gas_dir)
  };
}

/**
 * Settings of the laser assignment for all layers.
 * The scanner array and the swimlanes depend only on the platform
 * settings, so they are built once per call, not once per layer.
 * Timing: the delays of grp_laser_timing are converted from
 * microseconds to milliseconds (the unit of the time metric).
 * @param {Object} a_platform      PlatformSettings
 * @param {Object} a_sorter_cfg    Result of build_sorter_config (defines the passes)
 * @param {Array} a_speed_lookup   Result of build_speed_lookup
 * @return {Object|undefined} Settings for LASER_ASSIGNMENT.assign_layer,
 *         undefined if the laser assignment is disabled
 */
function build_laser_assignment_config(a_platform, a_sorter_cfg, a_speed_lookup)
{
  let l_la = a_platform.laser_assignment;
  if (!l_la.enabled) return undefined;
  let l_sa = a_platform.scanner_array;
  let l_timing = a_platform.laser_timing;
  return {
    strategy: l_la.strategy,
    scanners: SCANNER_ARRAY.build_scanner_array(l_sa),
    lanes: SCANNER_ARRAY.build_swimlanes(l_sa.platform, a_sorter_cfg.gas_dir, l_la.swimlane_width),
    gas_dir: a_sorter_cfg.gas_dir,
    split_polylines: l_la.split_polylines,
    cost: {
      use_time: l_la.metric === 'time',
      jump_speed: l_timing.jump_speed,
      jump_delay_ms: l_timing.jump_delay_us / 1000.0,
      min_jump_delay_ms: l_timing.min_jump_delay_us / 1000.0,
      jump_length_limit: l_timing.jump_length_limit,
      mark_delay_ms: l_timing.mark_delay_us / 1000.0,
      proximity_weight: l_la.proximity_weight
    },
    sorter: a_sorter_cfg,
    speed_lookup: a_speed_lookup
  };
}

/**
 * Milliseconds as h:mm:ss (e.g. 5025000 -> '1:23:45').
 * @param {number} a_ms  Time in ms
 * @return {string}
 */
function format_hms(a_ms)
{
  let l_s = Math.round(a_ms / 1000.0);
  let l_h = Math.floor(l_s / 3600);
  let l_m = Math.floor((l_s % 3600) / 60);
  return l_h + ':' + MATH.pad_int(l_m, 2) + ':' + MATH.pad_int(l_s % 60, 2);
}

// -----------------------------------------------------------
// Step 1: start points (single-threaded)
// -----------------------------------------------------------

/**
 * Apply the start point history to all closed contours of one layer.
 * @param {bsModelData} a_model_data  All models
 * @param {Array} a_models   Result of load_model_context
 * @param {number} a_layer_nr  Layer number
 * @param {Object} a_store   History store (START_HIST.create_store)
 * @return {void}
 */
function process_start_points_layer(a_model_data, a_models, a_layer_nr, a_store)
{
  // All exposure paths of the layer (all models), writable ('rw'),
  // because the start point of a contour is changed in place.
  let l_polys = a_model_data.getLayerPolylineArray(a_layer_nr, POLY_IT.nLayerExposure, 'rw');
  if (!l_polys) return;
  for (let i = 0; i < l_polys.length; ++i)
  {
    let l_poly = l_polys[i];
    // Only closed contours have a start point that can be moved; hatch
    // lines and open paths (e.g. stippled contours) are skipped.
    if (l_poly.getPolylineMode() !== POLY_IT.nPolyClosed) continue;
    // getAttributeIntExt returns undefined if the attribute is missing.
    let l_bsid = l_poly.getAttributeIntExt(ATTR.BSID);
    if (typeof l_bsid !== 'number') continue;
    let l_vt = VECTOR_TYPES.get_vector_type_by_bsid(l_bsid);
    if (!l_vt || (l_vt.family === 'none')) continue;

    let l_model_index = l_poly.getModelIndex();
    let l_m = a_models[l_model_index];
    if (!l_m) continue;
    let l_cfg = get_family_settings(l_m.part, l_vt.family);
    if (!uses_history(l_cfg)) continue;

    // One history per model and contour family.
    // Example key: '0_border_first'. Different parts and contour types
    // do not push each other's start points around.
    // The seed uses the path index i, so every contour of the layer gets
    // its own (but reproducible) random candidate order.
    let l_hist = START_HIST.get_history(a_store, l_model_index + '_' + l_vt.family, l_cfg.start_point.history_layers);
    START_HIST.apply(l_poly, l_hist, l_cfg.start_point, RANDOM.make_seed(a_layer_nr, i, l_bsid));
  }
}

/**
 * Step 1 (single-threaded): contour start points with layer history.
 * Single-threaded on purpose: the choice in layer n depends on the
 * start points chosen in the layers below, so the layers must be
 * visited one after the other from bottom to top.
 * @param {bsModelData} modelData  All models
 * @param {Object} progress        Progress object of the step
 * @param {number} layer_start_nr  First layer number
 * @param {number} layer_end_nr    Last layer number (inclusive)
 * @param {*} input_results        Not used
 * @return {void}
 */
function step_start_points_st(modelData, progress, layer_start_nr, layer_end_nr, input_results)
{
  let l_models = load_model_context(modelData);
  if (!any_model_uses_history(l_models)) return;

  // One progress step per layer.
  progress.initSteps(layer_end_nr - layer_start_nr + 1);
  let l_store = START_HIST.create_store();
  for (let n = layer_start_nr; n <= layer_end_nr; ++n)
  {
    process_start_points_layer(modelData, l_models, n, l_store);
    // The start points of this layer become history for the next layers.
    START_HIST.commit_layer(l_store);
    if (step_and_check_cancel(progress)) break;
  }
}

// -----------------------------------------------------------
// Step 2: sorting, laser assignment, power optimization, time (multi-threaded)
// -----------------------------------------------------------

/**
 * Step 2 (multi-threaded): exposure order, laser assignment, power
 * optimization and time estimation of every layer (why this order: see
 * WORKFLOW in the file header).
 * Every layer is independent of the others here, so the host can give
 * each thread its own range of layers [layer_start_nr, layer_end_nr].
 * Tip: the settings below are built once per call (per
 * thread and range), not once per layer, to save time.
 * @param {bsModelData} modelData  All models
 * @param {Object} progress        Progress object of the step
 * @param {number} layer_start_nr  First layer number of this range
 * @param {number} layer_end_nr    Last layer number (inclusive)
 * @param {*} input_results        Not used
 * @return {void}
 */
function step_layers_mt(modelData, progress, layer_start_nr, layer_end_nr, input_results)
{
  let l_models = load_model_context(modelData);
  let l_platform = read_platform();
  let l_timing = l_platform.laser_timing;
  let l_sorter_cfg = build_sorter_config(l_models, l_platform);
  let l_speed_lookup = build_speed_lookup(l_models);
  let l_assign_cfg = build_laser_assignment_config(l_platform, l_sorter_cfg, l_speed_lookup);

  // One power map per model (parts can have different settings);
  // missing models get an empty map and are skipped. With the laser
  // assignment the maps also contain the laser bsids.
  let l_laser_count = l_assign_cfg ? l_assign_cfg.scanners.length : 0;
  let l_power_maps = [];
  for (let i = 0; i < l_models.length; ++i)
  {
    l_power_maps.push(l_models[i] ? build_laser_power_opt_map(l_models[i].part, l_laser_count) : new Map());
  }
  // Sort mode 'global' treats all models as one: models with equal power
  // settings share one timeline per laser and vector type.
  if (l_sorter_cfg.mode === 'global') share_equal_power_settings(l_power_maps);

  progress.initSteps(layer_end_nr - layer_start_nr + 1);
  let l_done = 0;
  for (let n = layer_start_nr; n <= layer_end_nr; ++n)
  {
    // a) Exposure order of all paths of the layer (all models).
    SORTER.sort_layer(modelData, n, l_sorter_cfg);

    // b) Laser of every path (multi-laser machines, if enabled). A
    //    problem in one layer is reported and the layer keeps the
    //    lasers of its vector types; the other layers go on.
    if (l_assign_cfg)
    {
      let l_res = LASER_ASSIGNMENT.assign_layer(modelData, n, l_assign_cfg);
      if (!l_res.ok) LOG.warning_once('pp_laser_assignment', l_res.message + ' (layer ' + n + ')');
    }

    // c) Power per hatch vector along the timeline of every laser
    //    (rebuilds the paths of the changed model layers).
    POWER_OPT.optimize_layer(modelData, n, l_power_maps, l_timing);

    // d) Time of the layer in the final order. Tray attributes store
    //    text, so the number is converted to a string; one attribute per
    //    layer in whole ms, e.g. 'layer_built_time_estimation_ms_12'
    //    (name read by the host applications).
    let l_ms = EXPOSURE_TIME.estimate_layer_time_ms(modelData, n, l_timing, l_speed_lookup);
    modelData.setTrayAttrib(TRAY_ATTR.LAYER_TIME_PREFIX + n, Math.round(l_ms).toString());

    // e) Preview colors and BSIDs of the layer (final values, after the
    //    laser assignment) for the color legend and the reduced custom
    //    table of step 3.
    modelData.setTrayAttrib(TRAY_ATTR.LAYER_USAGE_PREFIX + n,
      LAYER_USAGE.to_json(LAYER_USAGE.collect_layer_usage(modelData, n)));

    if (step_and_check_cancel(progress)) break;
    ++l_done;
    // Run the garbage collector from time to time, if the host offers
    // it, to limit the memory used by temporary objects.
    if (((l_done % S_GC_INTERVAL) === 0) && (typeof global !== 'undefined') && (typeof global.gc === 'function'))
    {
      global.gc();
    }
  }
}

// -----------------------------------------------------------
// Step 3: total time, color legend, custom table (single-threaded)
// -----------------------------------------------------------

/**
 * Merge the per layer usage of step 2 (colors and BSIDs per model) and
 * delete the temporary tray attributes.
 * @param {bsModelData} a_model_data  All models
 * @param {number} a_layer_start_nr   First layer number
 * @param {number} a_layer_end_nr     Last layer number (inclusive)
 * @return {{usage:Array, complete:boolean}} usage: see LAYER_USAGE.create_usage;
 *         complete: false if a layer has no valid usage (e.g. step 2
 *         was cancelled), then the BSID sets may miss entries
 */
function merge_layer_usage(a_model_data, a_layer_start_nr, a_layer_end_nr)
{
  let r_usage = LAYER_USAGE.create_usage(a_model_data.getModelCount());
  let r_complete = true;
  for (let n = a_layer_start_nr; n <= a_layer_end_nr; ++n)
  {
    let l_layer = LAYER_USAGE.parse_json(a_model_data.getTrayAttrib(TRAY_ATTR.LAYER_USAGE_PREFIX + n));
    if (!l_layer)
    {
      r_complete = false;
      continue;
    }
    LAYER_USAGE.merge_usage(r_usage, l_layer);
  }
  a_model_data.delTrayAttribsStartingWith(TRAY_ATTR.LAYER_USAGE_PREFIX);
  return { usage: r_usage, complete: r_complete };
}

/**
 * Store the color legend ('toolpathColorTable') at every model and at
 * the tray (all models together).
 * @param {bsModelData} a_model_data  All models
 * @param {Array} a_usage             Merged usage (see merge_layer_usage)
 * @param {Object} a_platform         PlatformSettings
 * @return {void}
 */
function store_color_tables(a_model_data, a_usage, a_platform)
{
  let l_info_map = COLOR_TABLE.build_color_info_map(a_platform);
  let l_all = [];
  for (let i = 0; i < a_usage.length; ++i)
  {
    let l_colors = a_usage[i].colors;
    if (l_colors.length === 0) continue;
    let l_table = COLOR_TABLE.build_color_table(l_colors, l_info_map);
    a_model_data.getModel(i).setAttrib(MODEL_ATTR.COLOR_TABLE, JSON.stringify(l_table));
    // Duplicates are removed by build_color_table.
    for (let k = 0; k < l_colors.length; ++k) l_all.push(l_colors[k]);
  }
  if (l_all.length > 0)
  {
    a_model_data.setTrayAttrib(TRAY_ATTR.COLOR_TABLE,
      JSON.stringify(COLOR_TABLE.build_color_table(l_all, l_info_map)));
  }
}

/**
 * Reduce the custom table of every model to the BSIDs its paths use.
 * Always starts from the full table of prepareModelExposure, so a
 * repeated post-processing (e.g. with other platform settings) gets
 * every BSID it needs. If the usage is incomplete or a model has no
 * paths, the full table is kept: a missing entry would lose the laser
 * settings of a BSID in the export, an extra entry costs nothing.
 * @param {bsModelData} a_model_data  All models
 * @param {Array} a_usage             Merged usage (see merge_layer_usage)
 * @param {boolean} a_complete        true if every layer has a usage
 * @return {void}
 */
function store_reduced_custom_tables(a_model_data, a_usage, a_complete)
{
  if (!a_complete)
  {
    LOG.info('Post-processing is incomplete: the custom tables keep all entries.');
  }
  for (let i = 0; i < a_usage.length; ++i)
  {
    let l_model = a_model_data.getModel(i);
    let l_full = SETTINGS.read_model_object(l_model, MODEL_ATTR.FULL_CUSTOM_TABLE);
    // Model without settings of this build style (warned in step 2).
    if (!Array.isArray(l_full)) continue;
    let l_table = l_full;
    if (a_complete && (a_usage[i].bsids.size > 0))
    {
      l_table = SETTINGS.reduce_custom_table(l_full, a_usage[i].bsids);
    }
    l_model.setAttribEx(MODEL_ATTR.CUSTOM_TABLE, l_table);
  }
}

/**
 * Step 3 (single-threaded): sum of the layer times of step 2, the color
 * legend and the custom tables reduced to the used BSIDs.
 * A separate single-threaded step is needed because in step 2 every
 * thread only sees its own layers; module variables are not shared
 * between threads, so the layer results are passed via tray attributes.
 * @param {bsModelData} modelData  All models
 * @param {Object} progress        Progress object of the step (not used)
 * @param {number} layer_start_nr  First layer number
 * @param {number} layer_end_nr    Last layer number (inclusive)
 * @param {*} input_results        Not used
 * @return {void}
 */
function step_finish_st(modelData, progress, layer_start_nr, layer_end_nr, input_results)
{
  let l_sum = 0.0;
  for (let n = layer_start_nr; n <= layer_end_nr; ++n)
  {
    // Layers without a stored time (e.g. step 2 was cancelled) give NaN
    // and are not added.
    let l_v = parseFloat(modelData.getTrayAttrib(TRAY_ATTR.LAYER_TIME_PREFIX + n));
    if (MATH.is_finite_number(l_v)) l_sum += l_v;
  }
  // Total in whole ms ('built_time_estimation_ms', read by the host
  // applications); export_main.js writes it to export_info.json.
  modelData.setTrayAttrib(TRAY_ATTR.BUILD_TIME, Math.round(l_sum).toString());

  let l_merged = merge_layer_usage(modelData, layer_start_nr, layer_end_nr);
  store_color_tables(modelData, l_merged.usage, read_platform());
  store_reduced_custom_tables(modelData, l_merged.usage, l_merged.complete);
}

// The suffixes _st / _mt mark single-threaded / multi-threaded steps.
exports.step_start_points_st = step_start_points_st;
exports.step_layers_mt = step_layers_mt;
exports.step_finish_st = step_finish_st;

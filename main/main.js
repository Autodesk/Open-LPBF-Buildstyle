/************************************************************
 * MODULE NAME: main.js
 *
 * PURPOSE:
 *   Entry points of the OSS MPBF 01 build style: a generic metal
 *   powder bed fusion build style with contours, hatching, skin
 *   handling, supports, power optimization, exposure sorting and
 *   LSR / CLI+ / 3MF toolpath export.
 *
 * MPBF BASICS (glossary; the other files refer to it):
 *   Powder bed     : A thin layer of metal powder is spread over the build
 *                    plate. A laser melts the powder where the part is; the
 *                    melt solidifies and fuses with the material below. Then
 *                    the plate is lowered and the next powder layer is spread.
 *   Layer          : One horizontal slice of the build. The thickness is given
 *                    in micrometers (30 = 0.03 mm). Layer numbers (nLayerNr)
 *                    count upwards from the build plate.
 *   Island         : One closed region of a part in one layer: an outer
 *                    contour plus its holes. A layer can contain many islands.
 *   Vector         : A path the laser scans while it is switched on (also
 *                    called exposure polyline). Moving with the laser switched
 *                    off is a "jump".
 *   Contour        : Border path along the outline of an island. It gives a
 *                    smooth, dense side wall. The first border is shifted
 *                    inwards by the "beam compensation" (about the melt pool
 *                    radius), so the part does not come out too large.
 *   Hatch          : Parallel fill lines that melt the inside of an island.
 *                    Hatch distance = spacing between neighboring lines (mm).
 *                    The hatch angle is rotated from layer to layer (default
 *                    +67 degrees): lines of different layers do not lie on top
 *                    of each other, which gives a more uniform material and
 *                    spreads the residual stress in all directions.
 *   Stripe         : The hatch area is cut into bands of a few mm; the hatch
 *                    lines run across each band. Short lines keep the heat
 *                    input more even than lines across the whole part.
 *   BSID           : Build style ID: an integer at every vector that tells the
 *                    machine which laser parameter set (power, speed, focus)
 *                    to use, e.g. 100 = first border, 500 = volume hatch.
 *                    All BSIDs of this project: main/vector_types.js.
 *                    With the laser assignment, the BSID also carries the
 *                    laser: (laser index + 1) * 1000 + vector type, e.g.
 *                    2500 = volume hatch on laser 1 (lib/multi_laser/laser_bsid.js).
 *   Custom table   : One entry per BSID with laser number, power (W), speed
 *                    (mm/s) and focus offset (mm). Stored at the model; the
 *                    exporters read it.
 *   Downskin       : Overhang area with loose powder below instead of solid
 *                    metal. Powder conducts heat poorly, so with normal power
 *                    the melt pool gets too large and sags into the powder.
 *                    Downskin areas therefore get lower power (own BSIDs).
 *   Upskin         : Top surface area (nothing is built above it). It can get
 *                    own settings for a smoother top surface.
 *   Hull / core    : Hull = outer shell of the part, core = inner volume. The
 *                    core can use other settings and may be exposed only every
 *                    n-th layer (n times thicker) to save build time.
 *   Supports       : Helper structures that hold overhangs and lead heat into
 *                    the plate; removed after the build. Wall supports are
 *                    open lines, solid supports are areas.
 *   Scanner / laser: The scanner (moving mirrors) steers the laser beam over
 *                    the powder. Large machines have several lasers, each with
 *                    its own scanner; laser_index (0-based) at every path tells
 *                    which laser exposes it.
 *   Scan field     : Rectangle of the platform that one scanner can reach.
 *                    Neighboring fields usually overlap; there, either laser
 *                    can expose the vectors.
 *   Laser assignment / load balancing:
 *                    Optional post-processing step that gives every path (or
 *                    piece of a hatch vector) to one laser, so that all lasers
 *                    have about the same work: the layer is only finished when
 *                    the slowest laser is finished. Settings: grp_scanner_array,
 *                    grp_laser_assignment; code: lib/multi_laser/.
 *   Swimlane       : Band across the platform, perpendicular to the gas flow.
 *                    The swimlane strategies of the laser assignment work lane
 *                    by lane, downstream lane first.
 *   Exposure order : Order in which the vectors of a layer are scanned. The
 *                    defaults expose supports first, then hatches, then the
 *                    contours from the inside to the outside: the borders
 *                    re-melt the ends of the hatch lines and give a clean
 *                    side wall. Islands are ordered along the shielding gas
 *                    flow (downstream first). Build order 'global' treats all
 *                    parts as one and sorts every hatch block (stripe, chess
 *                    field, ...) by its own position instead of its island.
 *                    Defaults: main/vector_types.js,
 *                    sorting: lib/sorting/exposure_sorter.js.
 *   Post-processing: Steps that run after all layers were created and may use
 *                    several layers (start points, order, laser
 *                    assignment, power, time).
 *   Export         : Writing the final vectors to a file for the machine or
 *                    other tools: LSR, CLI+ or 3MF toolpath package.
 *   Units          : lengths in mm, power in W, speed in mm/s, angles in
 *                    degrees, layer thickness in micrometers, delays in
 *                    microseconds (us).
 *
 * HOW TO READ THIS PROJECT:
 *   main/          Project specific wiring. Start with this file, then
 *                  vector_types.js (BSID table), param_groups.js (parameter
 *                  tree), settings.js (parameters -> plain objects),
 *                  exposure_layer.js (vectors of one layer), postprocess.js
 *                  (whole build; uses layer_usage.js and color_table.js for
 *                  the color legend and the reduced custom table) and
 *                  export_main.js (export filters).
 *   lib/params/    Parameter group class, group factories and readers.
 *   lib/exposure/  Contours, hatch patterns, hatch rotation, skin areas,
 *                  hull / core, supports, narrow paths, vector attributes.
 *   lib/geometry/  Island operations (offset, intersect, ...) and gas flow.
 *   lib/sorting/   Exposure order and contour start point history.
 *   lib/power/     Power model and power optimization of hatch vectors.
 *   lib/multi_laser/ Scanner array, swimlanes and laser assignment (load
 *                  balancing between the lasers of a multi-laser machine).
 *   lib/time/      Exposure time estimation and scanner delay rules.
 *   lib/export/    Toolpath reader and writers (LSR, CLI+, 3MF, ZIP), parameter
 *                  JSON and build job image.
 *   lib/util/      Small helpers: attribute names, log, math, random numbers,
 *                  layer skip, version check.
 *   localization/  localizer.js and lang_<language>.json with all texts that
 *                  the user sees (parameter names, descriptions, filter names).
 *   The lib/ modules do not know this project: they get plain settings
 *   objects and can be copied into other build styles.
 *
 * WORKFLOW:
 *   The host application calls the entry points in this order:
 *    1. about                        -> version info
 *    2. declareParameters            -> parameter tree
 *    3. declareMachine               -> machine, materials, layer thicknesses
 *    4. declareBuildAttributes       -> attributes stored at the vectors
 *    5. declareExportFilter          -> export formats
 *    6. declareModelFeatures         -> shadow box, hull / core
 *    7. prepareModelExposure         -> read parameters ONCE per model,
 *                                       store them as model attributes
 *    8. makeExposureLayer            -> vectors of one layer (multi-threaded)
 *    9. configurePostProcessingSteps -> start points, order, laser
 *                                       assignment, power, time
 *   10. exportToFile                 -> write the export package
 *
 * USAGE:
 *   Loaded by the host application as main module of the project.
 *
 * DEPENDENCIES:
 *   Builtins: bsParam, bsBuildParam, bsModel, bsModelFeatures, bsHatchInfo
 *   Modules : localization/localizer.js, main/*.js, lib/util/*.js,
 *             lib/time/exposure_time.js, lib/export/parameter_json.js
 *
 * NOTES:
 *   Only this file throws exceptions (the host shows them as error).
 *   All other modules return { ok, message } results.
 *   Why: a thrown exception stops the whole calculation. With result
 *   objects every caller sees in the code which calls can fail, and it
 *   can decide itself: abort (here, by throwing), print a warning and go
 *   on (e.g. one island that cannot be hatched), or ignore the problem.
 *
 *   Tip: makeExposureLayer runs in several threads at the
 *   same time. Each thread has its own script context, so module
 *   variables are NOT shared between threads. Never keep layer
 *   results in module variables.
 *
 *   Tip: Every .js file is a "module" with its own variables.
 *   A module makes functions visible to other files by adding them to
 *   'exports' (exports.name = ...). require('main/settings.js') loads a
 *   module once and returns its 'exports' object. requireBuiltin('bsXxx')
 *   returns an object with functions and constants of the host
 *   application (for example islands, hatches, parameters). The host
 *   calls the entry points of this file through its 'exports' object.
 *
 * EXTENSION NOTES:
 *   - New vector type: add an entry to VECTOR_TYPES in
 *     main/vector_types.js -> scan and scan order parameters are
 *     created automatically; add the text 'vec_<key>' to the language
 *     files; create the vectors in main/exposure_layer.js.
 *   - New hatch pattern: key in PART_PATTERN_KEYS (main/param_groups.js),
 *     parameters in create_hatch_group (lib/params/param_factories.js),
 *     reader in read_hatch (lib/params/param_readers.js), 'case' in
 *     create_pattern_hatch (lib/exposure/hatch_patterns.js).
 *   - New exporter: use the path records of
 *     toolpath_reader.read_layer_paths and add the attachments via
 *     add_common_attachments (main/export_main.js).
 *   - Reuse: copy the whole 'lib/' folder and write a project specific
 *     'main/' wiring in the target project.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
// Tip: 'use strict' makes the script engine report common
// mistakes (e.g. assigning to an undeclared variable) as errors instead
// of silently creating global variables.
'use strict';

// Builtins of the host (UPPER_CASE alias by convention).
var PARAM = requireBuiltin('bsParam');
var BUILD_PARAM = requireBuiltin('bsBuildParam');
var MODEL = requireBuiltin('bsModel');
var MODEL_FEATURES = requireBuiltin('bsModelFeatures');
var HATCH_INFO = requireBuiltin('bsHatchInfo');
// Project modules. The paths are relative to the project folder.
var LOCALIZER = require('localization/localizer.js');
var PARAM_GROUPS = require('main/param_groups.js');
var SETTINGS = require('main/settings.js');
var VECTOR_TYPES = require('main/vector_types.js');
var EXPOSURE_LAYER = require('main/exposure_layer.js');
var POSTPROCESS = require('main/postprocess.js');
var EXPORT_MAIN = require('main/export_main.js');
var PARAMETER_JSON = require('lib/export/parameter_json.js');
var EXPOSURE_TIME = require('lib/time/exposure_time.js');
var LOG = require('lib/util/log.js');
var VERSION_CHECK = require('lib/util/version_check.js');
var ATTR = require('lib/util/attribute_names.js').ATTR;

// Names of the model attributes in which prepareModelExposure stores
// the settings (see main/settings.js).
var MODEL_ATTR = SETTINGS.MODEL_ATTR;

/** Version of this build style (shown in about(), defined in main/settings.js). */
var S_project_version = SETTINGS.PROJECT_VERSION;

/** Name of the hull / core parameter set (must match SETTINGS.HULL_CORE_PARAM_SET). */
var S_hull_core_param_set = SETTINGS.HULL_CORE_PARAM_SET;

/**
 * Oldest processor version that supports all functions used here.
 * declareMachine only prints a warning if the host is older; it does
 * not stop the calculation.
 */
var S_min_processor_version = '1.25.12';

// Every log message of this project starts with this prefix, so it is
// easy to find in the host log. This line runs once per script context
// (i.e. once per thread), when the module is loaded.
LOG.set_prefix('[OSS_MPBF_01] ');

// -----------------------------------------------------------
// Helpers
// -----------------------------------------------------------

/**
 * Forget all cached parameter values.
 * Tip: Parameter values can change between two calls (the user
 * edits them). Call this at the start of every entry point that reads
 * parameters, so that no old value is used.
 * Why a cache at all: a parameter value is read many times (for every
 * model, for every group); asking the host each time would be slow.
 * @return {void}
 */
function clear_cached_parameter_values()
{
  PARAM_GROUPS.clear_all_cached_values();
}

/**
 * Read a settings object of a model or throw if it is missing.
 * A missing object means that prepareModelExposure did not run for this
 * model; without the settings no meaningful vectors can be created, so
 * the calculation is stopped with a clear message.
 * @param {bsModel} a_model  Model whose attributes are read
 * @param {string} a_name    Attribute name (one of MODEL_ATTR)
 * @return {Object} Stored settings object
 */
function require_model_object(a_model, a_name)
{
  let r_obj = SETTINGS.read_model_object(a_model, a_name);
  if (!r_obj)
  {
    throw new Error('Model attributes missing. prepareModelExposure was not executed.');
  }
  return r_obj;
}

// -----------------------------------------------------------
// Entry points
// -----------------------------------------------------------
// Tip: The host calls these functions by their exact names
// (about, declareParameters, ...). The argument names in camelCase
// (aboutInfo, modelData, nLayerNr, ...) follow the host documentation;
// the helpers of this project use the a_ / l_ / r_ prefixes instead.

/**
 * Text shown in the "about" information of the build style.
 * @param {Object} aboutInfo  Host object; addCommentLine adds one text line
 * @return {void}
 */
exports.about = function(aboutInfo)
{
  aboutInfo.addCommentLine('OSS MPBF 01 - generic metal powder bed fusion build style');
  aboutInfo.addCommentLine('Version ' + S_project_version);
  aboutInfo.addCommentLine('Copyright (c) 2026, Autodesk Inc. (Original Author)');
};

/**
 * Declare the parameter tree (all groups and parameters the user can
 * edit). The tree itself is built when main/param_groups.js is loaded;
 * here every top-level group only registers itself with the host.
 * @param {Object} parameter  Host object that receives the declarations
 * @return {void}
 */
exports.declareParameters = function(parameter)
{
  clear_cached_parameter_values();
  // Order of ALL_TOP_LEVEL_GROUPS = order in the user interface.
  for (let i = 0; i < PARAM_GROUPS.ALL_TOP_LEVEL_GROUPS.length; ++i)
  {
    PARAM_GROUPS.ALL_TOP_LEVEL_GROUPS[i].declare(parameter);
  }
};

/**
 * Describe the machine: build style name, machine name, the materials
 * and the layer thicknesses the user can choose.
 * @param {Object} machineConfig  Host object that receives the machine data
 * @return {void}
 */
exports.declareMachine = function(machineConfig)
{
  VERSION_CHECK.warn_if_older(S_min_processor_version);
  machineConfig.setBuildstyleName('OSS MPBF 01');
  machineConfig.setBuildstyleDescription(LOCALIZER.GetMessage('bs_description'));
  machineConfig.setMachineName('Generic MPBF Machine');

  // Material names offered in the host. This build style uses the same
  // default parameters for all of them; the user adapts the laser
  // settings (grp_scanning) to the material.
  let l_materials = ['Generic Metal', 'Ti6Al4V', 'AlSi10Mg', 'IN718', 'SS316L'];
  for (let i = 0; i < l_materials.length; ++i)
  {
    machineConfig.addMaterialName(l_materials[i]);
  }
  // Layer thicknesses in micrometers (20 = 0.02 mm). Thin layers give
  // finer details and smoother surfaces, thick layers build faster.
  // Other values are possible as well (custom_thickness_allowed in
  // declareBuildstyleProperties).
  let l_thicknesses = [20, 30, 40, 50, 60, 80, 100];
  for (let k = 0; k < l_thicknesses.length; ++k)
  {
    machineConfig.addLayerThickness(l_thicknesses[k]);
  }
};

/**
 * Declare the attributes (named values) stored at every vector.
 * The exposure step writes them, post-processing and export read them.
 * @param {Object} buildAttrib  Host object that receives the declarations
 * @return {void}
 */
exports.declareBuildAttributes = function(buildAttrib)
{
  // Tip: Attributes that are not declared here are silently
  // ignored by the host. Add every new attribute name to this list.
  // Names starting with '_' are predefined and must NOT be declared.
  // Int attributes: vector type, laser (0-based) and island number.
  buildAttrib.declareAttributeInt(ATTR.BSID);
  buildAttrib.declareAttributeInt(ATTR.LASER_INDEX);
  buildAttrib.declareAttributeInt(ATTR.ISLAND_ID);

  // Real attributes: laser settings (W, mm/s, mm) and the island
  // bounding box in mm (used to sort islands along the gas flow).
  buildAttrib.declareAttributeReal(ATTR.POWER);
  buildAttrib.declareAttributeReal(ATTR.SPEED);
  buildAttrib.declareAttributeReal(ATTR.FOCUS);
  buildAttrib.declareAttributeReal(ATTR.ISL_MIN_X);
  buildAttrib.declareAttributeReal(ATTR.ISL_MIN_Y);
  buildAttrib.declareAttributeReal(ATTR.ISL_MAX_X);
  buildAttrib.declareAttributeReal(ATTR.ISL_MAX_Y);
};

/**
 * Declare the export formats (filters) the user can choose.
 * @param {Object} exportFilter  Host object that receives the filters
 * @return {void}
 */
exports.declareExportFilter = function(exportFilter)
{
  EXPORT_MAIN.declare_export_filters(exportFilter);
};

/**
 * Tell the host which model features (extra data computed by the host
 * before the exposure) this build style needs.
 * This is a part related entry point, so part parameters may be read.
 * @param {Object} modelFeatures  Host object that receives the features
 * @return {void}
 */
exports.declareModelFeatures = function(modelFeatures)
{
  clear_cached_parameter_values();
  // The shadow box gives the model bounds used for sorting and the build job image.
  modelFeatures.enableFeature(MODEL_FEATURES.nFeatureShadowBox, true);

  let l_part = SETTINGS.read_part_settings();
  // Hull / core: the host prepares the data that lets the exposure step
  // split every volume area into an outer shell and an inner core. The
  // parameter set name connects this declaration with the split call in
  // main/exposure_layer.js (lib/exposure/hull_core.js).
  // MPBF background: the core is only exposed every n-th layer (with n
  // times the layer thickness), which saves build time inside the part
  // while the hull keeps the fine layers for an accurate surface.
  if (l_part.hull_core.enabled)
  {
    modelFeatures.declareSingleHullCore(S_hull_core_param_set, {
      // coreSkip: expose the core every n-th layer (1 = every layer);
      // minThickness: minimum hull wall thickness in mm.
      coreSkip: l_part.hull_core.core_every_nth,
      minThickness: l_part.hull_core.min_thickness
    });
  }
};

/**
 * Prepare one model (part) for the exposure. Called once per model,
 * before makeExposureLayer, while the parameters of THIS part are
 * active (every part can have its own part parameters).
 * All parameters are read here ONCE, checked and stored at the model.
 * Why: makeExposureLayer runs very often and in several threads;
 * reading the stored plain objects there is fast, and every layer is
 * guaranteed to use the same values.
 * @param {bsModel} model  Model to prepare (attributes are written to it)
 * @return {void}  Throws if the parameters are invalid
 */
exports.prepareModelExposure = function(model)
{
  clear_cached_parameter_values();
  let l_part = SETTINGS.read_part_settings();
  let l_platform = SETTINGS.read_platform_settings();

  // Invalid combinations (e.g. minimum power >= maximum power) would
  // give wrong toolpaths, so they stop the calculation right here, with
  // all problems listed in one message.
  let l_errors = SETTINGS.validate_part_settings(l_part).concat(SETTINGS.validate_platform_settings(l_platform));
  if (l_errors.length > 0)
  {
    throw new Error('Invalid parameters: ' + l_errors.join('; '));
  }

  // Store the settings at the model: makeExposureLayer, post-processing
  // and export read them from there instead of reading parameters again.
  model.setAttribEx(MODEL_ATTR.PART_SETTINGS, l_part);
  model.setAttribEx(MODEL_ATTR.PLATFORM_SETTINGS, l_platform);
  // The custom table (laser settings per BSID, see the glossary above)
  // is stored under the name 'customTable', which the export modules
  // (lib/export/toolpath_reader.js) and the host (e.g. the smoke
  // simulation) read. With the laser assignment it also contains the
  // laser bsids (one entry per vector type and laser). Post-processing
  // reduces it to the used BSIDs, always starting from the full copy.
  let l_custom_table = SETTINGS.build_custom_table(l_part, l_platform);
  model.setAttribEx(MODEL_ATTR.CUSTOM_TABLE, l_custom_table);
  model.setAttribEx(MODEL_ATTR.FULL_CUSTOM_TABLE, l_custom_table);

  // Full parameter copies for the JSON files of the export package.
  PARAMETER_JSON.capture_part_parameters(model, MODEL_ATTR.PART_PARAMS_JSON);
  PARAMETER_JSON.capture_platform_parameters(model, MODEL_ATTR.PLATFORM_PARAMS_JSON);

  // General model data used later:
  // - min_layer_nr: first layer of the model. exposure_layer.js counts
  //   the layer index from here (layer skip, hatch rotation), so every
  //   part starts with the same pattern, no matter at which height.
  // - bounds: XY bounding box in mm (shadow box of islands and open
  //   polylines), used for the model order and the build job image.
  // - material and layer thickness (micrometers) for the export files.
  // Tip: getMinMaxLayerNr fills the given object (out-parameter).
  let l_mm = {};
  model.getMinMaxLayerNr(l_mm);
  let l_box = model.createShadowBox({ bIslands: true, bOpenPolylines: true, bExposurePolylines: false });
  model.setAttribEx(MODEL_ATTR.MODEL_INFO, {
    min_layer_nr: l_mm.min_layer_nr,
    max_layer_nr: l_mm.max_layer_nr,
    bounds: { min_x: l_box.m_min.x, min_y: l_box.m_min.y, max_x: l_box.m_max.x, max_y: l_box.m_max.y },
    material: model.getMaterialID(),
    layer_thickness: model.getLayerThickness()
  });
};

/**
 * Create all exposure vectors of one layer of one model.
 * Runs in several threads at the same time (one layer per call), see
 * the NOTES in the file header.
 * @param {bsModelData} modelData  Input data of this call (one model)
 * @param {bsHatch} hatchResult    Receives all vectors of the layer
 * @param {number} nLayerNr        Layer number (counted from the build plate)
 * @return {void}  Throws if the layer cannot be created
 */
exports.makeExposureLayer = function(modelData, hatchResult, nLayerNr)
{
  // No parameters are read here: everything comes from the model attributes.
  // The host calls this entry point per model, so exactly one model is
  // expected; anything else means the call is not what this code expects.
  if (modelData.getModelCount() !== 1)
  {
    throw new Error('Exactly one model expected per exposure call');
  }
  let l_model = modelData.getModel(0);
  let l_part = require_model_object(l_model, MODEL_ATTR.PART_SETTINGS);
  let l_platform = require_model_object(l_model, MODEL_ATTR.PLATFORM_SETTINGS);
  let l_info = require_model_object(l_model, MODEL_ATTR.MODEL_INFO);

  let l_res = EXPOSURE_LAYER.make_layer({
    model_data: modelData,
    model: l_model,
    layer_nr: nLayerNr,
    part: l_part,
    platform: l_platform,
    info: l_info
  }, hatchResult);
  if (!l_res.ok)
  {
    throw new Error(l_res.message);
  }

  // Report the time of this layer to the host (model attribute
  // '_bs_exposure_time': layer time of the exposure preview and build
  // time estimate of the host). Only allowed inside makeExposureLayer.
  // It is estimated before the sorting, per model; the time of the
  // final order is stored in post-processing (main/postprocess.js).
  let l_ms = EXPOSURE_TIME.estimate_hatch_time_ms(
    hatchResult, l_platform.laser_timing, EXPOSURE_TIME.build_speed_table(l_part));
  HATCH_INFO.addExposureTimeSeconds(l_ms / 1000.0);
};

/**
 * Register the post-processing steps. They run after all layers of all
 * models were created, in the order they are added here.
 * The optional laser assignment (multi-laser machines) runs inside
 * step_layers_mt, after the sorting and before the power optimization
 * and the time estimate (see the file header of main/postprocess.js).
 * bMultithread: false = one thread visits the layers in ascending order;
 * true = layers are processed in parallel by several threads.
 * nProgressWeight: share of the step in the progress bar (1 : 10 : 1).
 * @param {Object} a_config  Host object that receives the steps
 * @return {void}
 */
exports.configurePostProcessingSteps = function(a_config)
{
  // Why this order: see the file header of main/postprocess.js.
  a_config.addPostProcessingStep(POSTPROCESS.step_start_points_st, { bMultithread: false, nProgressWeight: 1 });
  a_config.addPostProcessingStep(POSTPROCESS.step_layers_mt, { bMultithread: true, nProgressWeight: 10 });
  a_config.addPostProcessingStep(POSTPROCESS.step_finish_st, { bMultithread: false, nProgressWeight: 1 });
};

/**
 * Write the export file for the selected filter.
 * @param {bsFile} exportFile      Target file, already opened by the host
 * @param {string} sFilter         Id of the selected export filter
 * @param {bsModelData} modelData  All models with their final toolpaths
 * @param {Object} progress        Progress bar / cancel button of the host
 * @return {void}  Throws on failure or if the user cancelled
 */
exports.exportToFile = function(exportFile, sFilter, modelData, progress)
{
  // The export reads the platform parameters again (fresh values).
  clear_cached_parameter_values();
  let l_res = EXPORT_MAIN.export_to_file(exportFile, sFilter, modelData, progress);
  if (!l_res.ok)
  {
    throw new Error(l_res.message);
  }
};

/**
 * Export into a directory (several files). Not used by this project.
 * @param {string} sFilter         Id of the selected export filter
 * @param {bsModelData} modelData  All models with their final toolpaths
 * @param {Object} progress        Progress object of the host
 * @return {void}  Always throws
 */
exports.exportToDirectory = function(sFilter, modelData, progress)
{
  // All filters write one file (isMultifile: false).
  // The "one file per layer" variants put the layer files into a ZIP.
  throw new Error('Unsupported export filter');
};

/**
 * Properties of the build style for a material and layer thickness.
 * @param {string} sMaterial   Selected material name
 * @param {number} nThickness  Selected layer thickness in micrometers
 * @param {Object} properties  Host object; the values are set on it
 * @return {void}
 */
exports.declareBuildstyleProperties = function(sMaterial, nThickness, properties)
{
  // The user may also enter layer thicknesses that are not in the list
  // of declareMachine.
  properties.adsk_main.custom_thickness_allowed = true;
  // 20 = maximum of the overhang 'reference layers' parameter. The single
  // layer preview then gets enough layers below to compute the downskin.
  properties.adsk_main.lower_layers_dependence = 20;
  // One layer above is needed for the upskin.
  // Tip: If a new feature looks at more layers below or above,
  // increase these numbers, otherwise the single layer preview differs
  // from the full calculation.
  properties.adsk_main.upper_layers_dependence = 1;
};

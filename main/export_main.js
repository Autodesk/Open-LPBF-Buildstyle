/************************************************************
 * MODULE NAME: export_main.js
 *
 * PURPOSE:
 *   Declaration of the export filters and the export of the
 *   toolpaths as LSR (ZIP), CLI+ (ZIP) or 3MF toolpath package.
 *
 * WORKFLOW:
 *   1. declare_export_filters: called from declareExportFilter.
 *   2. export_to_file: called from exportToFile.
 *      - build_export_context collects everything all formats need
 *      - the format writer writes the layers
 *      - every package also gets the common attachments:
 *        build job image, parameter JSON files, export_info.json
 *
 * BACKGROUND (terms: see the glossary in main/main.js):
 *   - An export filter is one entry in the export dialog of the host
 *     (name, file extension, id).
 *   - LSR: plain text, one line per laser vector with power, start and
 *     end point, focus, speed and start time; easy to read for
 *     simulation and analysis tools (lib/export/lsr_writer.js).
 *   - CLI+: the common layer based CLI text format plus parameter lines
 *     per path (BSID, laser, power, speed, focus) (cli_plus_writer.js).
 *   - 3MF toolpath: a ZIP package with one XML file per layer and the
 *     laser settings as profiles (tp3mf_writer.js).
 *   - "single" = one toolpath file for the whole build; "layers" = one
 *     file per layer inside the ZIP.
 *   - All formats read the paths in the final exposure order (set in
 *     post-processing) through lib/export/toolpath_reader.js.
 *   - The export only reads platform parameters; the part settings
 *     come from the model attributes written in prepareModelExposure.
 *
 * USAGE:
 *   var EXPORT_MAIN = require('main/export_main.js');
 *   EXPORT_MAIN.declare_export_filters(exportFilter);
 *   let l_res = EXPORT_MAIN.export_to_file(exportFile, sFilter, modelData, progress);
 *
 * DEPENDENCIES:
 *   Builtins: bsFile
 *   Modules : main/settings.js, localization/localizer.js, lib/export/...,
 *             lib/util/...
 *
 * EXTENSION NOTES:
 *   New export format: add an entry to S_FILTERS (new unique id!),
 *   add the name key to the language files and a branch in
 *   export_to_file that calls the new writer.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var FILE = requireBuiltin('bsFile');
var SETTINGS = require('main/settings.js');
var LOCALIZER = require('localization/localizer.js');
var ZIP = require('lib/export/zip_package.js');
var TOOLPATH_READER = require('lib/export/toolpath_reader.js');
var LSR = require('lib/export/lsr_writer.js');
var CLI_PLUS = require('lib/export/cli_plus_writer.js');
var TP3MF = require('lib/export/tp3mf_writer.js');
var PARAM_JSON = require('lib/export/parameter_json.js');
var BUILD_JOB_IMAGE = require('lib/export/build_job_image.js');
var MATH = require('lib/util/math_utils.js');
var LOG = require('lib/util/log.js');

var MODEL_ATTR = SETTINGS.MODEL_ATTR;
var TRAY_ATTR = SETTINGS.TRAY_ATTR;

/** Project name and version written to export_info.json (defined in main/settings.js). */
var S_PROJECT_NAME = SETTINGS.PROJECT_NAME;
var S_PROJECT_VERSION = SETTINGS.PROJECT_VERSION;

/**
 * ZIP compression level (0 = none, 9 = best).
 * 6 is a usual compromise: toolpath text compresses well, and higher
 * levels cost much more time for little gain.
 */
var S_ZIP_LEVEL = 6;

/** Maximum length of a model name in attachment file names. */
var S_MAX_NAME_LENGTH = 60;

// Filter ids are stored in user projects: NEVER change an existing id.
// The random looking suffix makes every id globally unique, so it can
// not collide with a filter of another build style.
var S_filter_lsr_single = 'OSS-MPBF-01-LSR-ZIP-SINGLE-8E2F4A10-5C1B-4D7E-9A63-1F0B2C3D4E01';
var S_filter_lsr_layers = 'OSS-MPBF-01-LSR-ZIP-LAYERS-8E2F4A10-5C1B-4D7E-9A63-1F0B2C3D4E02';
var S_filter_cli_single = 'OSS-MPBF-01-CLIPLUS-ZIP-SINGLE-8E2F4A10-5C1B-4D7E-9A63-1F0B2C3D4E03';
var S_filter_cli_layers = 'OSS-MPBF-01-CLIPLUS-ZIP-LAYERS-8E2F4A10-5C1B-4D7E-9A63-1F0B2C3D4E04';
var S_filter_3mf_ramps = 'OSS-MPBF-01-3MF-TP-RAMPS-8E2F4A10-5C1B-4D7E-9A63-1F0B2C3D4E05';
var S_filter_3mf_edges = 'OSS-MPBF-01-3MF-TP-EDGES-8E2F4A10-5C1B-4D7E-9A63-1F0B2C3D4E06';

/**
 * Filter table: id, localization key of the name, file extension,
 * format and options.
 * per_layer: true = one file per layer inside the ZIP (handy for
 *   machines or tools that load the job layer by layer).
 * with_ramps: 3MF only. true = the power of a hatch line may change
 *   linearly from its start to its end (f1 / f2 between touching micro
 *   vectors); false = one constant power per line ("edges"). Polylines
 *   and loops always get one power per line. This only matters with
 *   power optimization.
 * The order of the entries is the order in the export dialog.
 */
var S_FILTERS = Object.freeze([
  { id: S_filter_lsr_single, name_key: 'filter_lsr_single', ext: 'zip', format: 'lsr', per_layer: false, with_ramps: false },
  { id: S_filter_lsr_layers, name_key: 'filter_lsr_layers', ext: 'zip', format: 'lsr', per_layer: true, with_ramps: false },
  { id: S_filter_cli_single, name_key: 'filter_cli_single', ext: 'zip', format: 'cli', per_layer: false, with_ramps: false },
  { id: S_filter_cli_layers, name_key: 'filter_cli_layers', ext: 'zip', format: 'cli', per_layer: true, with_ramps: false },
  { id: S_filter_3mf_ramps, name_key: 'filter_3mf_ramps', ext: '3mf', format: '3mf', per_layer: false, with_ramps: true },
  { id: S_filter_3mf_edges, name_key: 'filter_3mf_edges', ext: '3mf', format: '3mf', per_layer: false, with_ramps: false }
]);

// -----------------------------------------------------------
// Helpers
// -----------------------------------------------------------

/**
 * Find a filter table entry by id (undefined if unknown).
 * @param {string} a_filter_id  Filter id selected by the user
 * @return {Object|undefined} Entry of S_FILTERS
 */
function find_filter(a_filter_id)
{
  for (let i = 0; i < S_FILTERS.length; ++i)
  {
    if (S_FILTERS[i].id === a_filter_id) return S_FILTERS[i];
  }
  return undefined;
}

/**
 * Advance the progress by one step.
 * Same logic as in main/postprocess.js: step() returning false means
 * "stop"; cancelled() is only used if the host provides it.
 * @param {Object} a_progress  Progress object of the export
 * @return {boolean} true if the user cancelled
 */
function step_and_check_cancel(a_progress)
{
  if (a_progress.step(1) === false) return true;
  return (typeof a_progress.cancelled === 'function') && (a_progress.cancelled() === true);
}

/**
 * Check that there is something to export.
 * Why: if the export is started without the exposure calculation
 * (e.g. from an automation script that skips the calculation steps),
 * the host still provides the layers, but they are empty. Writing
 * a package with an empty toolpath and reporting success would
 * hide this mistake, so the export is refused instead.
 * Tip: prepareModelExposure stores the part settings on
 * every model, so a missing attribute means "not calculated".
 * @param {bsModelData} a_model_data
 * @return {{ok:boolean, message:string}}
 */
function check_toolpaths_calculated(a_model_data)
{
  if (a_model_data.getModelCount() === 0)
  {
    return { ok: false, message: 'Nothing to export: the build contains no models.' };
  }
  for (let i = 0; i < a_model_data.getModelCount(); ++i)
  {
    let l_model = a_model_data.getModel(i);
    if (!SETTINGS.read_model_object(l_model, MODEL_ATTR.PART_SETTINGS))
    {
      return {
        ok: false,
        message: 'No calculated toolpaths for model "' + PARAM_JSON.get_model_name(l_model, i) +
          '". Run the exposure calculation before exporting.'
      };
    }
  }
  return { ok: true, message: '' };
}

/**
 * Result object for a cancelled export (closes the archive).
 * The archive is closed in every exit path, so the export file is not
 * left open. A cancel is reported as ok:false, so exportToFile tells
 * the user that the file is incomplete.
 * @param {bsFileArchiveWriter} a_archive  Open archive
 * @return {{ok:boolean, message:string}}
 */
function cancel_export(a_archive)
{
  ZIP.close_zip(a_archive);
  return { ok: false, message: 'Export cancelled' };
}

/**
 * Model name usable in file names: only [A-Za-z0-9_-], max. 60 characters.
 * Every other character (space, accented letter, '/', ':' ...) becomes '_', so
 * the name works as entry name on every operating system.
 * Example: 'Bracket v2 (left)' -> 'Bracket_v2__left_'.
 * @param {*} a_name  Model name
 * @return {string}
 */
function sanitize_name(a_name)
{
  return String(a_name).replace(/[^A-Za-z0-9_-]/g, '_').substring(0, S_MAX_NAME_LENGTH);
}

/**
 * Today as ddmmyy (CLI date format), e.g. 27 Oct 2026 -> '271026'.
 * Tip: getMonth() counts from 0 (January = 0), hence the + 1.
 * @return {string}
 */
function get_date_ddmmyy()
{
  let l_now = new Date();
  return MATH.pad_int(l_now.getDate(), 2) + MATH.pad_int(l_now.getMonth() + 1, 2) +
    MATH.pad_int(l_now.getFullYear() % 100, 2);
}

/**
 * Highest power of all active power optimizations per model.
 * The 3MF export needs it as upper limit of the power factors.
 * (3MF stores the power as factor = power / maximum power.)
 * @param {bsModelData} a_model_data  All models
 * @return {number[]} Per model index (0 = no power optimization)
 */
function compute_max_power_by_model(a_model_data)
{
  let r_max = [];
  for (let i = 0; i < a_model_data.getModelCount(); ++i)
  {
    let l_part = SETTINGS.read_model_object(a_model_data.getModel(i), MODEL_ATTR.PART_SETTINGS);
    let l_max = 0.0;
    if (l_part)
    {
      // The same four hatch types that offer a power optimization
      // (see build_power_opt_map in main/postprocess.js).
      let l_hatches = [l_part.hatching.volume, l_part.hatching.core, l_part.overhang.hatch, l_part.upskin.hatch];
      for (let k = 0; k < l_hatches.length; ++k)
      {
        let l_po = l_hatches[k] ? l_hatches[k].power_opt : undefined;
        if (l_po && l_po.enabled) l_max = Math.max(l_max, l_po.max_power);
      }
    }
    r_max.push(l_max);
  }
  return r_max;
}

/**
 * Context shared by all export formats.
 * lookup = custom table of every model ({ '<bsid>': entry } per model
 * index); it supplies laser settings for paths that do not carry them.
 * @param {bsModelData} a_model_data  All models
 * @param {Object} a_platform         PlatformSettings
 * @param {string} a_filter_id        Selected filter id
 * @param {Object} a_progress         Progress object of the export
 * @return {Object} { model_data, platform, filter_id, layer_count, lookup, progress, max_power_by_model }
 */
function build_export_context(a_model_data, a_platform, a_filter_id, a_progress)
{
  return {
    model_data: a_model_data,
    platform: a_platform,
    filter_id: a_filter_id,
    layer_count: a_model_data.getLayerCount(),
    lookup: TOOLPATH_READER.build_scan_lookup(a_model_data),
    progress: a_progress,
    max_power_by_model: compute_max_power_by_model(a_model_data)
  };
}

/**
 * Content of export_info.json (meta data of the export).
 * @param {Object} a_ctx  Export context
 * @return {Object} Plain object, written with JSON.stringify
 */
function build_export_info(a_ctx)
{
  let l_md = a_ctx.model_data;
  // Total exposure time of post-processing step 3 (text in ms). It is
  // missing if post-processing did not run; then null is written.
  let l_time = parseFloat(l_md.getTrayAttrib(TRAY_ATTR.BUILD_TIME));
  // Tip: 'process' is not available in every script engine, so check it first.
  let l_engine = ((typeof process !== 'undefined') && process.version) ? process.version : 'unknown';
  return {
    project: S_PROJECT_NAME,
    project_version: S_PROJECT_VERSION,
    processor_version: l_engine,
    filter_id: a_ctx.filter_id,
    export_date: new Date().toISOString(),
    layer_count: a_ctx.layer_count,
    // getLayerThickness() is given in Z units, getZUnit() = Z units per
    // mm, so the quotient is the layer thickness in mm.
    layer_thickness_mm: l_md.getLayerThickness() / l_md.getZUnit(),
    estimated_exposure_time_ms: MATH.is_finite_number(l_time) ? l_time : null,
    model_count: l_md.getModelCount()
  };
}

/**
 * Collect the common attachments: build job image and JSON texts.
 * Tip: The image is created first because the 3MF package
 * refers to it as thumbnail.
 * The JSON files document the exact parameters the job was made with,
 * so an exported job can be traced back later.
 * @param {Object} a_ctx  Export context
 * @return {{image:Object, texts:Array<{name:string, text:string}>}}
 */
function build_attachments(a_ctx)
{
  let l_md = a_ctx.model_data;
  // Top view of the build plate as PNG: at most 1024 pixels, 5 mm margin
  // around the model bounds. A missing image is only a warning: the
  // toolpath itself is still complete.
  let l_image = BUILD_JOB_IMAGE.create_png_temp_file(l_md, {
    max_pixels: 1024,
    margin_mm: 5,
    model_info_attr: MODEL_ATTR.MODEL_INFO
  });
  if (!l_image.ok) LOG.warning('Build job image: ' + l_image.message);

  // JSON.stringify(value, null, 2) writes indented, human readable JSON.
  // One file for the platform, one per model, e.g.
  // 'parameters/model_001_Bracket.json'.
  let l_texts = [];
  l_texts.push({
    name: 'parameters/platform_parameters.json',
    text: JSON.stringify(PARAM_JSON.collect_platform(l_md, MODEL_ATTR.PLATFORM_PARAMS_JSON), null, 2)
  });
  for (let i = 0; i < l_md.getModelCount(); ++i)
  {
    let l_model = l_md.getModel(i);
    let l_name = sanitize_name(PARAM_JSON.get_model_name(l_model, i));
    l_texts.push({
      name: 'parameters/model_' + MATH.pad_int(i + 1, 3) + '_' + l_name + '.json',
      text: JSON.stringify(PARAM_JSON.collect_model(l_model, i, MODEL_ATTR.PART_PARAMS_JSON, MODEL_ATTR.PART_SETTINGS), null, 2)
    });
  }
  l_texts.push({ name: 'export_info.json', text: JSON.stringify(build_export_info(a_ctx), null, 2) });
  return { image: l_image, texts: l_texts };
}

/**
 * Add the common attachments to an archive.
 * Attachments are "nice to have": if one cannot be written, a warning
 * is printed, but the export still succeeds.
 * @param {bsFileArchiveWriter} a_archive  Open archive
 * @param {Object} a_ctx      Export context
 * @param {string} a_prefix  '' for ZIP packages, 'Metadata/' for 3MF
 * @return {void}
 */
function add_common_attachments(a_archive, a_ctx, a_prefix)
{
  let l_attach = build_attachments(a_ctx);
  ZIP.add_image_attachment(a_archive, a_prefix + 'build_job_image.png', l_attach.image);
  if (!ZIP.add_text_attachments(a_archive, a_prefix, l_attach.texts))
  {
    LOG.warning('Some attachments could not be written.');
  }
}

/**
 * Close the ZIP after the attachments and return the result.
 * @param {bsFileArchiveWriter} a_archive  Open archive
 * @param {Object} a_ctx  Export context
 * @return {{ok:boolean, message:string}} Always ok
 */
function finish_zip(a_archive, a_ctx)
{
  add_common_attachments(a_archive, a_ctx, '');
  ZIP.close_zip(a_archive);
  return { ok: true, message: '' };
}

/**
 * Temporary file for a text format (one byte per character).
 * LSR and CLI+ are plain 8-bit text formats, so the ANSI encoding is
 * used instead of UTF-8 (which can use several bytes per character).
 * Every archive entry is first written to a temporary file and then
 * copied into the ZIP (see lib/export/zip_package.js).
 * @return {bsFile|undefined} Open temporary file or undefined on failure
 */
function create_text_temp_file()
{
  return ZIP.create_temp_file(FILE.nEncodingAnsi);
}

/**
 * Archive entry name of one layer file, e.g. 'layers/layer_00012.lsr'.
 * The layer number is padded to 5 digits, so the files sort correctly
 * by name (layer_00002 before layer_00010).
 * @param {number} a_layer_nr  Layer number
 * @param {string} a_ext       File extension without dot
 * @return {string}
 */
function layer_entry_name(a_layer_nr, a_ext)
{
  return 'layers/layer_' + MATH.pad_int(a_layer_nr, 5) + '.' + a_ext;
}

// -----------------------------------------------------------
// LSR
// -----------------------------------------------------------

/**
 * LSR export as ZIP.
 * Package content: 'toolpath.lsr' (single) or 'layers/layer_NNNNN.lsr'
 * (per layer), plus the common attachments.
 * @param {Object} a_ctx         Export context
 * @param {bsFile} a_file        Export file (opened by the host)
 * @param {boolean} a_per_layer  true: one file per layer; false: one file
 * @return {{ok:boolean, message:string}}
 */
function export_lsr_zip(a_ctx, a_file, a_per_layer)
{
  let l_zip = ZIP.open_zip(a_file, S_ZIP_LEVEL);
  if (!l_zip.ok) return { ok: false, message: l_zip.message };
  let l_archive = l_zip.archive;
  let l_md = a_ctx.model_data;
  // The writer state holds the laser time (s) and position; the laser
  // timing (jump speed, delays) is needed for the time column.
  let l_state = LSR.create_state(a_ctx.platform.laser_timing);

  // In single file mode the time runs on over all layers.
  let l_single = a_per_layer ? undefined : create_text_temp_file();
  if (!a_per_layer && !l_single)
  {
    ZIP.close_zip(l_archive);
    return { ok: false, message: 'Failed to create temporary file' };
  }

  // One progress step per layer. Layer numbers run from 1 to layer_count.
  a_ctx.progress.initSteps(a_ctx.layer_count);
  for (let n = 1; n <= a_ctx.layer_count; ++n)
  {
    // All paths of the layer (all models) in exposure order.
    let l_records = TOOLPATH_READER.read_layer_paths(l_md, n, a_ctx.lookup);
    if (!a_per_layer)
    {
      // getLayerZ(n): height of the layer in mm.
      LSR.write_layer(l_single, l_records, l_md.getLayerZ(n), l_state);
    }
    else if (l_records.length > 0)
    {
      // Empty layers get no file in the per layer mode.
      // Every layer file starts at time 0.
      LSR.reset_time(l_state);
      let l_tmp = create_text_temp_file();
      if (!l_tmp)
      {
        ZIP.close_zip(l_archive);
        return { ok: false, message: 'Failed to create temporary file' };
      }
      LSR.write_layer(l_tmp, l_records, l_md.getLayerZ(n), l_state);
      // add_temp_file copies the temporary file into the ZIP and closes it.
      if (!ZIP.add_temp_file(l_archive, layer_entry_name(n, 'lsr'), l_tmp))
      {
        ZIP.close_zip(l_archive);
        return { ok: false, message: 'Failed to write layer ' + n };
      }
    }
    if (step_and_check_cancel(a_ctx.progress))
    {
      // Close the unfinished temporary file before the archive.
      if (l_single) l_single.close();
      return cancel_export(l_archive);
    }
  }

  // Single file mode: the complete toolpath becomes one archive entry.
  if (l_single && !ZIP.add_temp_file(l_archive, 'toolpath.lsr', l_single))
  {
    ZIP.close_zip(l_archive);
    return { ok: false, message: 'Failed to write toolpath.lsr' };
  }
  return finish_zip(l_archive, a_ctx);
}

// -----------------------------------------------------------
// CLI+
// -----------------------------------------------------------

/**
 * One CLI label per model (id = model index + 1).
 * In CLI files every geometry record refers to a label id; this is how
 * a reader knows which part a path belongs to.
 * @param {bsModelData} a_model_data  All models
 * @return {Array<{id:number, text:string}>}
 */
function build_cli_labels(a_model_data)
{
  let r_labels = [];
  for (let i = 0; i < a_model_data.getModelCount(); ++i)
  {
    r_labels.push({ id: i + 1, text: PARAM_JSON.get_model_name(a_model_data.getModel(i), i) });
  }
  return r_labels;
}

/**
 * CLI+ export as ZIP.
 * Package content: 'toolpath.cli' (single) or 'layers/layer_NNNNN.cli'
 * (per layer), plus the common attachments.
 * A CLI file has a header (units, date, labels, layer count), the
 * geometry of all layers and a footer.
 * @param {Object} a_ctx         Export context
 * @param {bsFile} a_file        Export file (opened by the host)
 * @param {boolean} a_per_layer  true: one complete CLI file per layer; false: one file
 * @return {{ok:boolean, message:string}}
 */
function export_cli_zip(a_ctx, a_file, a_per_layer)
{
  let l_zip = ZIP.open_zip(a_file, S_ZIP_LEVEL);
  if (!l_zip.ok) return { ok: false, message: l_zip.message };
  let l_archive = l_zip.archive;
  let l_md = a_ctx.model_data;
  let l_labels = build_cli_labels(l_md);
  let l_date = get_date_ddmmyy();

  // Single file mode: write the header once, before the first layer.
  let l_single = undefined;
  if (!a_per_layer)
  {
    l_single = create_text_temp_file();
    if (!l_single)
    {
      ZIP.close_zip(l_archive);
      return { ok: false, message: 'Failed to create temporary file' };
    }
    CLI_PLUS.write_header(l_single, { layer_count: a_ctx.layer_count, labels: l_labels, date_str: l_date });
  }

  a_ctx.progress.initSteps(a_ctx.layer_count);
  for (let n = 1; n <= a_ctx.layer_count; ++n)
  {
    let l_records = TOOLPATH_READER.read_layer_paths(l_md, n, a_ctx.lookup);
    if (!a_per_layer)
    {
      CLI_PLUS.write_layer(l_single, l_md.getLayerZ(n), l_records);
    }
    else if (l_records.length > 0)
    {
      // Every layer file is a complete CLI file with header and footer.
      let l_tmp = create_text_temp_file();
      if (!l_tmp)
      {
        ZIP.close_zip(l_archive);
        return { ok: false, message: 'Failed to create temporary file' };
      }
      CLI_PLUS.write_header(l_tmp, { layer_count: 1, labels: l_labels, date_str: l_date });
      CLI_PLUS.write_layer(l_tmp, l_md.getLayerZ(n), l_records);
      CLI_PLUS.write_footer(l_tmp);
      if (!ZIP.add_temp_file(l_archive, layer_entry_name(n, 'cli'), l_tmp))
      {
        ZIP.close_zip(l_archive);
        return { ok: false, message: 'Failed to write layer ' + n };
      }
    }
    if (step_and_check_cancel(a_ctx.progress))
    {
      if (l_single) l_single.close();
      return cancel_export(l_archive);
    }
  }

  // Single file mode: close the geometry block and add the file.
  if (l_single)
  {
    CLI_PLUS.write_footer(l_single);
    if (!ZIP.add_temp_file(l_archive, 'toolpath.cli', l_single))
    {
      ZIP.close_zip(l_archive);
      return { ok: false, message: 'Failed to write toolpath.cli' };
    }
  }
  return finish_zip(l_archive, a_ctx);
}

// -----------------------------------------------------------
// Public functions
// -----------------------------------------------------------

/**
 * Declare all export filters.
 * Tip: declareFilterEx accepts only the keys used here;
 * any other key causes an "Illegal member" error.
 * The displayed name is localized, the id is not (it must stay the
 * same in every language). isMultifile: false = the host opens one
 * export file and passes it to exportToFile.
 * @param {Object} a_ef  Export filter object of the entry point
 * @return {void}
 */
exports.declare_export_filters = function(a_ef)
{
  for (let i = 0; i < S_FILTERS.length; ++i)
  {
    let l_f = S_FILTERS[i];
    a_ef.declareFilterEx({
      sFilterId: l_f.id,
      sFilterName: LOCALIZER.GetMessage(l_f.name_key),
      sFilterExtension: l_f.ext,
      nVersionMajor: 1,
      nVersionMinor: 0,
      isMultifile: false
    });
  }
};

/**
 * Export the toolpaths into one file.
 * @param {bsFile} a_file          Export file (opened by the host)
 * @param {string} a_filter_id     Selected filter id
 * @param {bsModelData} a_model_data
 * @param {Object} a_progress      Progress object of the entry point
 * @return {{ok:boolean, message:string}}  Never throws; main.js turns
 *         ok:false into an exception for the host
 */
exports.export_to_file = function(a_file, a_filter_id, a_model_data, a_progress)
{
  let l_filter = find_filter(a_filter_id);
  if (!l_filter) return { ok: false, message: 'Unsupported export filter ' + a_filter_id };

  // Refuse to write a package without calculated toolpaths.
  let l_check = check_toolpaths_calculated(a_model_data);
  if (!l_check.ok) return l_check;

  // Platform parameters may be read in the export (laser timing for the
  // LSR time column); part settings come from the model attributes.
  let l_platform = SETTINGS.read_platform_settings();
  let l_ctx = build_export_context(a_model_data, l_platform, a_filter_id, a_progress);

  if (l_filter.format === 'lsr') return export_lsr_zip(l_ctx, a_file, l_filter.per_layer);
  if (l_filter.format === 'cli') return export_cli_zip(l_ctx, a_file, l_filter.per_layer);
  if (l_filter.format === '3mf')
  {
    // The 3MF writer needs the attachments BEFORE it writes the package
    // (the image is referenced as thumbnail), so they are built here.
    // The ZIP formats add them at the end (finish_zip).
    l_ctx.attachments = build_attachments(l_ctx);
    return TP3MF.export_3mf(l_ctx, a_file, l_filter.with_ramps);
  }
  // Only reached if S_FILTERS contains a format without a branch above.
  return { ok: false, message: 'Unsupported export filter ' + a_filter_id };
};

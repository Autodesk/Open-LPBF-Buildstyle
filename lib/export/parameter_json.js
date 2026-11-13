/************************************************************
 * MODULE NAME: parameter_json.js
 *
 * PURPOSE:
 *   Capture the build style parameters as JSON and collect them for
 *   the export, so every exported job documents the settings it was
 *   made with.
 *
 * WORKFLOW:
 *   1. prepareModelExposure: capture_part_parameters /
 *      capture_platform_parameters store the parameters as model
 *      attributes (part parameters can differ per part).
 *   2. Export: collect_platform / collect_model read them back and
 *      return plain objects that are written as JSON files.
 *   Why two steps: the export runs later, in a separate entry point.
 *   At that time the parameters of one particular part are not
 *   necessarily "active" any more, so they are stored on the model
 *   while they are known for sure.
 *
 * USAGE:
 *   var PARAM_JSON = require('../export/parameter_json.js');
 *   PARAM_JSON.capture_part_parameters(model, 'my_part_params_json');
 *   let l_obj = PARAM_JSON.collect_model(model, 0, 'my_part_params_json', 'my_part_settings');
 *
 * DEPENDENCIES:
 *   Builtins: bsParam
 *   Modules : ../util/log.js
 *
 * BACKGROUND:
 *   Traceability: in metal printing a part may have to be certified
 *   (for example for medical or aerospace use). Then it must be
 *   possible to prove later which laser powers, speeds, layer
 *   thickness and so on were used. Writing a snapshot of all
 *   parameters into the export package makes every job
 *   self-documenting, even if the build style is changed later.
 *   Platform parameters are valid for the whole build plate (for
 *   example laser timing); part parameters can be different for
 *   every part (for example hatch distance or contour power).
 *   JSON is a text format for objects: JSON.stringify turns an
 *   object into text, JSON.parse turns the text back into an object.
 *   Model attributes store values on a model, so later entry points
 *   can read them again.
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Attribute names are passed by the caller.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var PARAM = requireBuiltin('bsParam');
var LOG = require('../util/log.js');

/** Is the value a non-empty string? */
function is_text(a_v)
{
  return (typeof a_v === 'string') && (a_v.length > 0);
}

/**
 * Parse a JSON string; undefined if it is empty or invalid.
 * Tip: JSON.parse throws an exception for invalid text. The
 * try/catch turns this into a simple 'undefined' result, so callers
 * only need one 'if' check instead of their own try/catch.
 * @param {*} a_text
 * @return {Object|undefined}
 */
function parse_json_or_undefined(a_text)
{
  if (!is_text(a_text)) return undefined;
  try
  {
    return JSON.parse(a_text);
  }
  catch (e)
  {
    return undefined;
  }
}

/**
 * Store the part parameters of a model as JSON text attribute.
 * Call in prepareModelExposure (the parameters of the part are active there).
 * bFullDetail: true requests the most detailed export data, so the
 * snapshot is as complete as possible.
 * The data is stored as text (JSON.stringify), because a text
 * attribute can be read back in any later entry point.
 * @param {bsModel} a_model
 * @param {string} a_attr  Attribute name
 */
exports.capture_part_parameters = function(a_model, a_attr)
{
  let l_data = PARAM.getParametersExportData({
    bIncludePlatformParameters: false,
    bIncludePartParameters: true,
    bFullDetail: true
  });
  a_model.setAttrib(a_attr, JSON.stringify(l_data));
};

/**
 * Store the platform parameters as JSON text attribute of a model.
 * Platform parameters are the same for all models; storing them on
 * every model is a fallback copy for collect_platform.
 * @param {bsModel} a_model
 * @param {string} a_attr  Attribute name
 */
exports.capture_platform_parameters = function(a_model, a_attr)
{
  let l_data = PARAM.getParametersExportData({
    bIncludePlatformParameters: true,
    bIncludePartParameters: false,
    bFullDetail: true
  });
  a_model.setAttrib(a_attr, JSON.stringify(l_data));
};

/**
 * Platform parameters for the export: live query first, then the copy
 * stored on the first model, otherwise an empty object.
 * Why this order: the live values are the current ones; the stored
 * copy is used if the live query is not possible in the export
 * context. An empty object (plus a warning) is better than a failed
 * export, because the toolpath itself is still valid.
 * @param {bsModelData} a_model_data
 * @param {string} a_attr  Attribute name used by capture_platform_parameters
 * @return {Object}
 */
exports.collect_platform = function(a_model_data, a_attr)
{
  try
  {
    let l_live = PARAM.getParametersExportData({
      bIncludePlatformParameters: true,
      bIncludePartParameters: false,
      bFullDetail: true
    });
    if (l_live && (typeof l_live === 'object')) return l_live;
  }
  catch (e)
  {
    // Not available in this context: use the stored copy below.
  }

  if (a_model_data.getModelCount() > 0)
  {
    let l_stored = parse_json_or_undefined(a_model_data.getModel(0).getAttrib(a_attr));
    if (l_stored) return l_stored;
  }
  LOG.warning('Platform parameters are not available for the export.');
  return {};
};

/**
 * Display name of a model (several attribute names are tried).
 * The name may be stored under one of several attribute names; the
 * known names are tried in this order and the first non-empty text wins.
 * @param {bsModel} a_model
 * @param {number} a_index  Model index, 0-based (for the fallback name)
 * @return {string} For example 'bracket' or 'model_3' (1-based) if no
 *         name is found
 */
exports.get_model_name = function(a_model, a_index)
{
  let l_names = ['ModelName', 'modelName', 'nf_model_name'];
  for (let i = 0; i < l_names.length; ++i)
  {
    let l_v = a_model.getAttrib(l_names[i]);
    if (is_text(l_v)) return l_v;
  }
  return 'model_' + (a_index + 1);
};

/**
 * Read an object attribute (object or JSON text).
 * getAttribEx may return a real object or a JSON string, depending on
 * how the value was stored; both cases are accepted.
 * @param {bsModel} a_model
 * @param {string} a_name  Attribute name
 * @return {Object|undefined}
 */
function read_object_attrib(a_model, a_name)
{
  let l_v = a_model.getAttribEx(a_name);
  if (typeof l_v === 'string') return parse_json_or_undefined(l_v);
  if (l_v && (typeof l_v === 'object')) return l_v;
  return undefined;
}

/**
 * Parameters and resolved settings of one model for the export.
 * 'parameters' are the raw values as the user entered them;
 * 'resolved_settings' is the settings object that the build style
 * computed from them and used for the calculation. Both are written,
 * so a reader can see the input and the effective values.
 * @param {bsModel} a_model
 * @param {number} a_index          Model index
 * @param {string} a_params_attr    Attribute with the captured part parameters (JSON text)
 * @param {string} a_settings_attr  Attribute with the resolved settings object
 * @return {Object} { model_index, model_name, material, layer_thickness
 *         (as returned by getLayerThickness), parameters, resolved_settings }
 */
exports.collect_model = function(a_model, a_index, a_params_attr, a_settings_attr)
{
  let l_params = parse_json_or_undefined(a_model.getAttrib(a_params_attr));
  if (!l_params)
  {
    LOG.warning('Part parameters of model ' + (a_index + 1) + ' are not available for the export.');
  }
  return {
    model_index: a_index,
    model_name: exports.get_model_name(a_model, a_index),
    material: a_model.getMaterialID(),
    layer_thickness: a_model.getLayerThickness(),
    parameters: l_params ? l_params : {},
    resolved_settings: read_object_attrib(a_model, a_settings_attr)
  };
};

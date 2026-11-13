/************************************************************
 * MODULE NAME: layer_usage.js
 *
 * PURPOSE:
 *   Record which preview colors and which BSIDs the paths of every
 *   model really use, so that post-processing can build the color
 *   legend ('toolpathColorTable') and reduce the custom table to the
 *   used BSIDs.
 *
 * BACKGROUND:
 *   Post-processing step 2 runs in several threads; every thread sees
 *   only its own layers, and module variables are not shared between
 *   threads. Therefore every layer stores its usage as JSON text in a
 *   tray attribute, and the single-threaded step 3 merges all layers.
 *   The usage is read AFTER the laser assignment, so it contains the
 *   final colors and the laser BSIDs.
 *
 * WORKFLOW:
 *   1. Step 2, per layer: to_json(collect_layer_usage(modelData, n))
 *      -> tray attribute.
 *   2. Step 3: create_usage(model count), then for every layer
 *      merge_usage(usage, parse_json(text)); a layer without valid text
 *      makes the result incomplete (see parse_json).
 *
 * USAGE:
 *   var LAYER_USAGE = require('main/layer_usage.js');
 *   let l_text = LAYER_USAGE.to_json(LAYER_USAGE.collect_layer_usage(modelData, n));
 *   let l_usage = LAYER_USAGE.create_usage(modelData.getModelCount());
 *   let l_layer = LAYER_USAGE.parse_json(l_text);   // undefined if invalid
 *   if (l_layer) LAYER_USAGE.merge_usage(l_usage, l_layer);
 *
 * DEPENDENCIES:
 *   Builtins: bsPolylineIterator
 *   Modules : main/color_table.js, lib/util/attribute_names.js
 *
 * NOTES:
 *   Data format of one layer (plain object, also the JSON text):
 *     { '<model index>': { colors: [unsigned color, ...], bsids: [bsid, ...] } }
 *   Models without paths in the layer have no entry.
 *   Merged result: array per model index { colors: [...], bsids: Set }.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var POLY_IT = requireBuiltin('bsPolylineIterator');
var COLOR_TABLE = require('main/color_table.js');
var ATTR = require('lib/util/attribute_names.js').ATTR;

/**
 * Add a value to a list if it is not in the list yet.
 * The lists stay short (a few dozen values), so indexOf is fast enough.
 * @param {Array} a_list  Values (modified)
 * @param {number} a_value
 * @return {void}
 */
function add_unique(a_list, a_value)
{
  if (a_list.indexOf(a_value) < 0) a_list.push(a_value);
}

/**
 * Colors and BSIDs used by the exposure paths of one layer, per model.
 * One pass over all paths of the layer.
 * @param {bsModelData} a_model_data  All models
 * @param {number} a_layer_nr
 * @return {Object} { '<model index>': { colors: [...], bsids: [...] } }
 */
exports.collect_layer_usage = function(a_model_data, a_layer_nr)
{
  let r_usage = {};
  let l_it = a_model_data.getFirstLayerPolyline(a_layer_nr, POLY_IT.nLayerExposure);
  while (l_it.isValid())
  {
    let l_key = String(l_it.getModelIndex());
    let l_entry = r_usage[l_key];
    if (!l_entry)
    {
      l_entry = { colors: [], bsids: [] };
      r_usage[l_key] = l_entry;
    }
    let l_color = l_it.getAttributeIntExt(ATTR.DISP_COLOR);
    if (typeof l_color === 'number') add_unique(l_entry.colors, COLOR_TABLE.to_uint32(l_color));
    let l_bsid = l_it.getAttributeIntExt(ATTR.BSID);
    if (typeof l_bsid === 'number') add_unique(l_entry.bsids, l_bsid);
    l_it.next();
  }
  return r_usage;
};

/**
 * Text form of a layer usage (for a tray attribute).
 * @param {Object} a_layer_usage  Result of collect_layer_usage
 * @return {string}
 */
exports.to_json = function(a_layer_usage)
{
  return JSON.stringify(a_layer_usage);
};

/**
 * Parse the text of one layer.
 * @param {*} a_text  Value of the tray attribute (undefined if missing)
 * @return {Object|undefined} Layer usage, undefined if missing or invalid
 */
exports.parse_json = function(a_text)
{
  if ((typeof a_text !== 'string') || (a_text === '')) return undefined;
  let l_obj;
  try
  {
    l_obj = JSON.parse(a_text);
  }
  catch (e)
  {
    return undefined;
  }
  if (!l_obj || (typeof l_obj !== 'object') || Array.isArray(l_obj)) return undefined;
  return l_obj;
};

/**
 * Empty merged usage for all models.
 * @param {number} a_model_count
 * @return {Array} Per model index: { colors: [], bsids: Set }
 */
exports.create_usage = function(a_model_count)
{
  let r_usage = [];
  for (let i = 0; i < a_model_count; ++i) r_usage.push({ colors: [], bsids: new Set() });
  return r_usage;
};

/**
 * Merge the usage of one layer. Invalid entries (wrong model index,
 * non-numeric values) are ignored.
 * @param {Array} a_usage        Result of create_usage (modified)
 * @param {Object} a_layer_usage Result of parse_json
 * @return {void}
 */
exports.merge_usage = function(a_usage, a_layer_usage)
{
  let l_keys = Object.keys(a_layer_usage);
  for (let k = 0; k < l_keys.length; ++k)
  {
    let l_index = parseInt(l_keys[k], 10);
    if (!(l_index >= 0) || (l_index >= a_usage.length)) continue;
    let l_src = a_layer_usage[l_keys[k]];
    if (!l_src) continue;
    let l_dst = a_usage[l_index];
    if (Array.isArray(l_src.colors))
    {
      for (let i = 0; i < l_src.colors.length; ++i)
      {
        if (typeof l_src.colors[i] === 'number') add_unique(l_dst.colors, COLOR_TABLE.to_uint32(l_src.colors[i]));
      }
    }
    if (Array.isArray(l_src.bsids))
    {
      for (let i = 0; i < l_src.bsids.length; ++i)
      {
        if (typeof l_src.bsids[i] === 'number') l_dst.bsids.add(l_src.bsids[i]);
      }
    }
  }
};

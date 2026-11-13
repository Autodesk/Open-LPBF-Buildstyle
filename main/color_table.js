/************************************************************
 * MODULE NAME: color_table.js
 *
 * PURPOSE:
 *   Build the color legend ('toolpathColorTable') of the toolpath
 *   preview: one entry per preview color that is really used, with a
 *   name and a description.
 *
 * BACKGROUND:
 *   Every path carries its preview color in the attribute '_disp_color'
 *   (one color per vector type, see main/vector_types.js; one color per
 *   laser when the laser assignment is enabled). The host applications
 *   read the legend as JSON text from the model attribute and from the
 *   tray attribute 'toolpathColorTable':
 *     [{ "_disp_color": <int>, "name": "<text>", "description": "<text>" }, ...]
 *   Colors without an entry are shown without a name.
 *
 * WORKFLOW:
 *   Post-processing step 3 (single-threaded): the colors used per model
 *   come from main/layer_usage.js; build_color_info_map names them,
 *   build_color_table creates the sorted legend.
 *
 * USAGE:
 *   var COLOR_TABLE = require('main/color_table.js');
 *   let l_map = COLOR_TABLE.build_color_info_map(l_platform);
 *   let l_json = JSON.stringify(COLOR_TABLE.build_color_table(l_colors, l_map));
 *
 * DEPENDENCIES:
 *   Builtins: bsColRGBAi
 *   Modules : main/vector_types.js, localization/localizer.js,
 *             lib/multi_laser/scanner_array.js
 *
 * NOTES:
 *   Colors are compared as unsigned 32 bit integers ('>>> 0'): the
 *   integer attribute may return the same RGBA value as a negative
 *   number, and the host reads the value as unsigned integer.
 *   Order of the legend: vector types in the order of the vector type
 *   table (the same order as in the parameter tree), then the lasers.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var RGBA = requireBuiltin('bsColRGBAi');
var VECTOR_TYPES = require('main/vector_types.js');
var LOCALIZER = require('localization/localizer.js');
var SCANNER_ARRAY = require('lib/multi_laser/scanner_array.js');

/**
 * Color as unsigned 32 bit integer (see NOTES).
 * @param {number} a_color
 * @return {number}
 */
exports.to_uint32 = function(a_color)
{
  return a_color >>> 0;
};

/**
 * Name and description of every preview color this build style uses:
 * - every vector type ('vec_<key>' / 'vec_<key>_descr'),
 * - every laser of the scanner array if the laser assignment is
 *   enabled (the preview then shows one color per laser).
 * 'rank' is the position in the legend (see NOTES).
 * @param {Object} a_platform  PlatformSettings (see main/settings.js)
 * @return {Map} unsigned color -> { name, description, rank }
 */
exports.build_color_info_map = function(a_platform)
{
  let r_map = new Map();
  let l_types = VECTOR_TYPES.VECTOR_TYPES;
  for (let i = 0; i < l_types.length; ++i)
  {
    let l_color = exports.to_uint32(VECTOR_TYPES.get_display_color_int(l_types[i].bsid));
    // Two vector types with the same color: the first one names it.
    if (r_map.has(l_color)) continue;
    r_map.set(l_color, {
      name: LOCALIZER.GetMessage('vec_' + l_types[i].key),
      description: LOCALIZER.GetMessage('vec_' + l_types[i].key + '_descr'),
      rank: i
    });
  }

  if (a_platform.laser_assignment.enabled)
  {
    let l_scanners = SCANNER_ARRAY.build_scanner_array(a_platform.scanner_array);
    for (let i = 0; i < l_scanners.length; ++i)
    {
      let l_rgb = l_scanners[i].color_rgb;
      let l_color = exports.to_uint32(new RGBA.bsColRGBAi(l_rgb[0], l_rgb[1], l_rgb[2], 255).rgba());
      // The paths of an assigned laser carry the laser color, so the
      // laser name replaces a vector type with the same color.
      // The user interface counts the lasers from 1.
      r_map.set(l_color, {
        name: LOCALIZER.GetMessage('legend_laser') + ' ' + (l_scanners[i].laser_index + 1),
        description: LOCALIZER.GetMessage('legend_laser_descr'),
        rank: l_types.length + l_scanners[i].laser_index
      });
    }
  }
  return r_map;
};

/**
 * Compare two legend entries by their rank (helper for Array.sort).
 * @param {{rank:number}} a_one
 * @param {{rank:number}} a_two
 * @return {number}
 */
function compare_rank(a_one, a_two)
{
  return a_one.rank - a_two.rank;
}

/**
 * Legend entries for the given colors, sorted (see NOTES). Colors
 * without name are skipped.
 * @param {Array} a_colors  [unsigned color, ...] (duplicates allowed)
 * @param {Map} a_info_map  Result of build_color_info_map
 * @return {Array} [{ _disp_color, name, description }]
 */
exports.build_color_table = function(a_colors, a_info_map)
{
  let l_found = [];
  let l_seen = new Set();
  for (let i = 0; i < a_colors.length; ++i)
  {
    let l_color = exports.to_uint32(a_colors[i]);
    if (l_seen.has(l_color)) continue;
    l_seen.add(l_color);
    let l_info = a_info_map.get(l_color);
    if (!l_info) continue;
    l_found.push({ color: l_color, info: l_info, rank: l_info.rank });
  }
  // Ranks are unique per color, so the order is the same everywhere.
  l_found.sort(compare_rank);

  let r_table = [];
  for (let i = 0; i < l_found.length; ++i)
  {
    r_table.push({
      _disp_color: l_found[i].color,
      name: l_found[i].info.name,
      description: l_found[i].info.description
    });
  }
  return r_table;
};

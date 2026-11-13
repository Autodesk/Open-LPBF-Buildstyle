/************************************************************
 * MODULE NAME: vector_types.js
 *
 * PURPOSE:
 *   Table of all vector types (BSIDs) of this build style with
 *   their default laser settings, default scan order and preview
 *   color. The parameter tree, the custom table, the sorting and the
 *   export are all generated from this table.
 *
 * WORKFLOW:
 *   - declareParameters: one scan group and one scan order value per entry
 *   - prepareModelExposure: custom table
 *   - makeExposureLayer: preview color (_disp_color)
 *   - post-processing: start point family, scan order
 *
 * BACKGROUND (terms: see the glossary in main/main.js):
 *   - A vector type is one kind of laser path (first border, volume
 *     hatch, wall support, ...). Its number, the BSID, is written to
 *     every vector, and the machine selects the laser parameter set
 *     (power W, speed mm/s, focus mm) by this number.
 *   - Number ranges: 1xx first border, 2xx following borders, 3xx fill
 *     contours, 5xx hatches, 6xx open part paths, 7xx supports.
 *   - Why own types for downskin: above loose powder the heat cannot
 *     flow away into solid metal, so less energy per mm is used there
 *     (lower power and/or higher speed; compare 150 W / 600 mm/s with
 *     100 W / 900 mm/s for the first border).
 *   - Why different settings for core and hull: the core is hidden
 *     inside the part, so higher power and speed (faster build) are
 *     acceptable there.
 *   - All default values are generic starting points, not qualified
 *     parameters for a specific material or machine.
 *
 * USAGE:
 *   var VECTOR_TYPES = require('main/vector_types.js');
 *   let l_bsid = VECTOR_TYPES.BSID.hatch_volume;              // 500
 *   let l_color = VECTOR_TYPES.get_display_color_int(l_bsid);
 *
 * DEPENDENCIES:
 *   Builtins: bsColRGBAi
 *   Modules : lib/multi_laser/laser_bsid.js
 *
 * REUSE NOTES:
 *   Project specific. To add a new vector type: add an entry here,
 *   add the texts 'vec_<key>' and 'vec_<key>_descr' to the language
 *   files and create the vectors in main/exposure_layer.js. The scan
 *   parameters and the scan order parameter are created automatically.
 *   Convention: downskin variant = normal BSID + 1.
 *   All BSIDs must stay below 1000: the laser assignment uses
 *   (laser index + 1) * 1000 + BSID for the laser bsids
 *   (lib/multi_laser/laser_bsid.js; checked in main/settings.js).
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

// Builtin for RGBA colors; used to turn [r, g, b] into the integer the
// '_disp_color' attribute expects.
var RGBA = requireBuiltin('bsColRGBAi');
var LASER_BSID = require('lib/multi_laser/laser_bsid.js');

/**
 * Create one table entry (keeps the table below short and readable).
 * @param {string} a_key        Unique key (used in parameter ids, never rename)
 * @param {number} a_bsid       Vector type id
 * @param {string} a_family     Start point family ('border_first', 'border_following', 'fill_contour' or 'none')
 *                              Contours of one family share the start point settings and
 *                              history; 'none' = no start point handling (hatches, supports, ...)
 * @param {boolean} a_is_ds     true for downskin variants
 * @param {number} a_power      Default power in W
 * @param {number} a_speed      Default speed in mm/s
 * @param {number} a_order      Default scan order (smaller = earlier)
 * @param {number[]} a_rgb      Preview color [r, g, b], each 0..255
 * @return {Object} Table entry
 *         { key, bsid, family, is_downskin, scan_defaults, scan_order_default, color_rgb }
 */
function make_entry(a_key, a_bsid, a_family, a_is_ds, a_power, a_speed, a_order, a_rgb)
{
  return {
    key: a_key,
    bsid: a_bsid,
    family: a_family,
    is_downskin: a_is_ds,
    // laser_index is 1-based like in the user interface
    // focus 0.0 mm = beam focused on the powder surface (no offset).
    scan_defaults: { laser_index: 1, power: a_power, speed: a_speed, focus: 0.0 },
    scan_order_default: a_order,
    color_rgb: a_rgb
  };
}

// Order of this array = order of the parameter groups in the UI.
// Reading the columns:
// - P[W] / v[mm/s]: default laser power and scan speed. More power or
//   less speed puts more energy into the powder.
// - order: default scanning order. Supports (10, 20) first, so the part
//   above has a base; then the hatches (30..50); then fill contours and
//   borders from the inside to the outside (60..85), so the borders
//   re-melt the ends of the hatch lines; open part paths last (90).
//   Downskin contours directly follow their normal type (80 -> 81); the
//   downskin hatch (30) is exposed before the volume hatch (40).
// - color: preview color only (no influence on the toolpath).
// The downskin variants are bsid + 1 (101, 201, 301, 501).
exports.VECTOR_TYPES = Object.freeze([
  //          key                    bsid family               ds     P[W] v[mm/s] order color
  make_entry('border_first',        100, 'border_first',     false, 150,  600, 80, [220,  50,  80]),
  make_entry('border_first_ds',     101, 'border_first',     true,  100,  900, 81, [240, 120,  60]),
  make_entry('blocked_path',        110, 'none',             false, 150,  600, 85, [200,   0, 200]),
  make_entry('border_following',    200, 'border_following', false, 180,  800, 70, [220,  20,  40]),
  make_entry('border_following_ds', 201, 'border_following', true,  100,  900, 71, [240, 150,  90]),
  make_entry('fill_contour',        300, 'fill_contour',     false, 200, 1000, 60, [255, 140,   0]),
  make_entry('fill_contour_ds',     301, 'fill_contour',     true,  110, 1000, 61, [255, 190, 100]),
  make_entry('hatch_volume',        500, 'none',             false, 280, 1200, 40, [ 25, 250,  45]),
  make_entry('hatch_downskin',      501, 'none',             true,  120, 1000, 30, [  0, 120, 255]),
  make_entry('hatch_core',          510, 'none',             false, 350, 1300, 45, [  0, 170,  70]),
  make_entry('hatch_upskin',        520, 'none',             false, 220,  900, 50, [255, 230,   0]),
  make_entry('part_open_path',      600, 'none',             false, 150,  600, 90, [150,   0,   0]),
  make_entry('support_wall',        700, 'none',             false, 180, 1000, 10, [128, 128, 128]),
  make_entry('support_solid',       710, 'none',             false, 200, 1200, 20, [ 90,  90,  90])
]);

/**
 * Map key -> bsid, e.g. BSID.hatch_volume === 500.
 * Built from the table so that both can never be out of sync.
 * Tip: other modules write BSID.border_first instead of the
 * number 100; a typo in the name then gives 'undefined' at one place
 * instead of a silently wrong number.
 * @return {Object} Frozen map { key: bsid }
 */
function build_bsid_map()
{
  let r_map = {};
  for (let i = 0; i < exports.VECTOR_TYPES.length; ++i)
  {
    let l_entry = exports.VECTOR_TYPES[i];
    r_map[l_entry.key] = l_entry.bsid;
  }
  return Object.freeze(r_map);
}
exports.BSID = build_bsid_map();

/**
 * Find the table entry of a vector type id.
 * A simple linear search is fast enough for a dozen entries.
 * Laser bsids (e.g. 2500, see lib/multi_laser/laser_bsid.js) give the
 * entry of their vector type (500).
 * @param {number} a_bsid  Vector type id or laser bsid
 * @return {Object|undefined} Table entry or undefined if unknown
 */
exports.get_vector_type_by_bsid = function(a_bsid)
{
  let l_type = LASER_BSID.type_bsid(a_bsid);
  for (let i = 0; i < exports.VECTOR_TYPES.length; ++i)
  {
    if (exports.VECTOR_TYPES[i].bsid === l_type)
    {
      return exports.VECTOR_TYPES[i];
    }
  }
  return undefined;
};

// Cache bsid -> color integer (the color object is created only once per bsid).
// The function is called for every hatch of every layer. The cache is
// per script context (thread), which is fine: the values never change.
var S_color_cache = new Map();

/**
 * Preview color of a vector type as integer for the '_disp_color' attribute.
 * @param {number} a_bsid  Vector type id
 * @return {number} RGBA color integer (gray for unknown ids)
 */
exports.get_display_color_int = function(a_bsid)
{
  if (S_color_cache.has(a_bsid))
  {
    return S_color_cache.get(a_bsid);
  }
  let l_entry = exports.get_vector_type_by_bsid(a_bsid);
  // Unknown BSIDs are shown in light gray instead of causing an error.
  let l_rgb = l_entry ? l_entry.color_rgb : [160, 160, 160];
  // Alpha 255 = fully opaque.
  let r_color = new RGBA.bsColRGBAi(l_rgb[0], l_rgb[1], l_rgb[2], 255).rgba();
  S_color_cache.set(a_bsid, r_color);
  return r_color;
};

/************************************************************
 * MODULE NAME: toolpath_reader.js
 *
 * PURPOSE:
 *   Read the final toolpaths of one layer into simple, format
 *   independent records ("PathRecord"). All export writers (LSR,
 *   CLI+, 3MF) use these records, so the reading logic exists only
 *   once.
 *
 * WORKFLOW:
 *   1. build_scan_lookup: once per export, the scanning parameters
 *      (custom table) of every model.
 *   2. read_layer_paths: per layer, all exposure paths in their
 *      processing order.
 *   Why per layer: a build can have thousands of layers with millions
 *   of vectors. Reading one layer, writing it and then forgetting it
 *   keeps the memory use small (streaming).
 *
 *   PathRecord:
 *   { model_index, subtype, bsid, laser_index (0-based), speed, focus,
 *     nominal_power, kind: 'hatch'|'open'|'closed', is_inloop,
 *     coords: [x0, y0, x1, y1, ...] (mm),
 *     edges: [{ a, b, power }] (point indices into coords / 2),
 *     has_power_variation }
 *   Edges: hatch -> (2i, 2i+1); open -> (i, i+1); closed -> (i, i+1)
 *   plus the closing edge (n-1, 0) if the last point is not the first.
 *   Units: coordinates in mm in the build plate coordinate system,
 *   power in W, speed in mm/s, focus (offset) in mm.
 *
 * USAGE:
 *   var TOOLPATH_READER = require('../export/toolpath_reader.js');
 *   let l_lookup = TOOLPATH_READER.build_scan_lookup(modelData);
 *   let l_records = TOOLPATH_READER.read_layer_paths(modelData, n, l_lookup);
 *
 * DEPENDENCIES:
 *   Builtins: bsPolylineIterator
 *   Modules : ../util/math_utils.js, ../util/attribute_names.js
 *
 * BACKGROUND:
 *   Layer: one slice of the build; the laser exposes one layer, then
 *   new powder is spread and the next layer follows.
 *   Exposure path: a line or polyline the laser scans with the laser
 *   on. Between two paths the laser is off and "jumps".
 *   Hatch: many parallel, independent lines that fill an area. In a
 *   hatch path every pair of points is one line (point 0 -> 1,
 *   2 -> 3, ...); the laser is off between the lines.
 *   Contour: a border path along the outline; it is a closed
 *   polyline (loop). An open polyline does not return to its start.
 *   Inner loop: a closed contour around a hole of an island.
 *   BSID (build style ID): a number on every path that tells the
 *   machine which laser parameter set (power, speed, focus) to use.
 *   Custom table: the list of these parameter sets, one per BSID.
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. The custom table is read from the model
 *   attribute 'customTable' (array of {bsid, power, speed, focus,
 *   laserIndex, ...}).
 *   New export format: do not read the toolpath again; use the
 *   PathRecords of read_layer_paths and only write a new formatter.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var POLY_IT = requireBuiltin('bsPolylineIterator');
var MATH = require('../util/math_utils.js');
var ATTR = require('../util/attribute_names.js').ATTR;

/**
 * Edges shorter than this (mm) are skipped.
 * 1e-6 mm = 1 nanometer: far below anything a laser can resolve, so
 * such an edge is only numerical noise (or a duplicated point).
 */
var S_MIN_EDGE_LENGTH = 1e-6;

/**
 * Two powers are equal if they differ less than this (W).
 * Small differences from floating point rounding must not count as
 * a "power variation" (which would make the CLI+ file larger).
 */
var S_POWER_TOL = 0.05;

/**
 * Scanning parameters of every model.
 * The custom table may be stored as an array or as JSON text; both
 * are accepted. An invalid or missing table gives an empty map, so the
 * reader then uses the attributes of each path or the defaults.
 * @param {bsModelData} a_model_data
 * @return {Array} Per model index: { '<bsid>': custom table entry }
 *         The keys are strings, because JavaScript object keys are
 *         always strings (String(bsid) is used for writing and reading).
 */
exports.build_scan_lookup = function(a_model_data)
{
  let r_lookup = [];
  for (let i = 0; i < a_model_data.getModelCount(); ++i)
  {
    let l_table = a_model_data.getModel(i).getAttribEx('customTable');
    if (typeof l_table === 'string')
    {
      try { l_table = JSON.parse(l_table); } catch (e) { l_table = undefined; }
    }
    let l_map = {};
    if (Array.isArray(l_table))
    {
      for (let k = 0; k < l_table.length; ++k)
      {
        l_map[String(l_table[k].bsid)] = l_table[k];
      }
    }
    r_lookup.push(l_map);
  }
  return r_lookup;
};

/**
 * Point coordinates of a path as flat array [x0, y0, x1, y1, ...].
 * Uses the fast array access if available, otherwise point by point.
 * Why a flat array: one array of numbers needs much less memory and
 * time than one {x, y} object per point.
 * The fast result is only used if its length matches the point count;
 * otherwise the slow but safe path below is taken.
 * @param {bsPolylineIterator} a_poly
 * @param {number} a_count  Point count
 * @return {Array|Float64Array} Coordinates in mm
 */
function read_coords(a_poly, a_count)
{
  if (typeof a_poly.getPointCoordFloat64Array === 'function')
  {
    try
    {
      // The argument object is required (it may contain a start/end index).
      let l_arr = a_poly.getPointCoordFloat64Array({});
      if (l_arr && (l_arr.length === 2 * a_count)) return l_arr;
    }
    catch (e)
    {
      // Fall back to the point by point access below.
    }
  }
  let r_coords = [];
  for (let i = 0; i < a_count; ++i)
  {
    let l_p = a_poly.getXYCoord(i);
    r_coords.push(l_p.x, l_p.y);
  }
  return r_coords;
}

/**
 * Real attribute of the path, otherwise the custom table value, otherwise the default.
 * Why this order: a path attribute is the most specific value (it
 * may have been changed for this path only, for example by a power
 * optimization); the custom table holds the value of the whole BSID.
 * @param {bsPolylineIterator} a_poly
 * @param {string} a_name       Path attribute name (for example ATTR.SPEED)
 * @param {Object|undefined} a_entry  Custom table entry of the BSID
 * @param {string} a_entry_key  Key in the entry (for example 'speed')
 * @param {number} a_default    Value if neither source has a number
 * @return {number}
 */
function get_real_value(a_poly, a_name, a_entry, a_entry_key, a_default)
{
  let l_v = a_poly.getAttributeRealExt(a_name);
  if (typeof l_v === 'number') return l_v;
  if (a_entry && (typeof a_entry[a_entry_key] === 'number')) return a_entry[a_entry_key];
  return a_default;
}

/**
 * Kind of a path from its polyline mode.
 * Every mode that is neither hatch nor closed is treated as an open polyline.
 * @param {number} a_mode  Result of getPolylineMode()
 * @return {string} 'hatch', 'closed' or 'open'
 */
function get_kind(a_mode)
{
  if (a_mode === POLY_IT.nPolyHatch) return 'hatch';
  if (a_mode === POLY_IT.nPolyClosed) return 'closed';
  return 'open';
}

/** Length of the edge between point a and point b (mm). */
function edge_length(a_coords, a_a, a_b)
{
  return MATH.dist(a_coords[2 * a_a], a_coords[2 * a_a + 1], a_coords[2 * a_b], a_coords[2 * a_b + 1]);
}

/**
 * Power of the edge starting at point a_a.
 * Order: point (edge) attribute, path attribute, nominal power.
 * A point attribute exists if the power changes along the path (for
 * example the power optimization lowers the power of short hatch
 * vectors against heat accumulation); otherwise every edge gets the nominal
 * power (which already contains the path attribute, see read_record).
 * @param {bsPolylineIterator} a_poly
 * @param {number} a_a        Index of the start point of the edge
 * @param {number} a_nominal  Nominal power of the path (W)
 * @return {number} Power in W
 */
function get_edge_power(a_poly, a_a, a_nominal)
{
  let l_v = a_poly.getPointAttributeRealExt(a_a, ATTR.POWER);
  if (typeof l_v === 'number') return l_v;
  return a_nominal;
}

/**
 * Point index pairs of all edges of a path.
 * A closed path gets the closing edge from the last point back to the
 * first one, unless the path already ends at its start point (then
 * this edge would have length 0). At least 3 points are needed for a
 * closed shape.
 * @param {string} a_kind   'hatch', 'open' or 'closed'
 * @param {Array} a_coords  Flat coordinate array (mm)
 * @param {number} a_count  Point count
 * @return {Array} [[a, b], ...]
 */
function make_edge_pairs(a_kind, a_coords, a_count)
{
  let r_pairs = [];
  if (a_kind === 'hatch')
  {
    // Hatch: points 0-1, 2-3, ... are separate lines. A single
    // left-over point (odd count) is ignored.
    for (let i = 0; i + 1 < a_count; i += 2) r_pairs.push([i, i + 1]);
    return r_pairs;
  }
  for (let i = 0; i + 1 < a_count; ++i) r_pairs.push([i, i + 1]);
  if ((a_kind === 'closed') && (a_count >= 3) && (edge_length(a_coords, a_count - 1, 0) >= S_MIN_EDGE_LENGTH))
  {
    r_pairs.push([a_count - 1, 0]);
  }
  return r_pairs;
}

/**
 * Read one path into a PathRecord.
 * Missing values are filled from the custom table (see get_real_value).
 * Note: speed and focus default to 0.0 if neither the path nor the
 * custom table has a value; the writers handle this case themselves.
 * @param {bsPolylineIterator} a_poly  Iterator positioned on the path
 * @param {Array} a_lookup  Result of build_scan_lookup
 * @return {Object|undefined} undefined if the path has no usable edge
 */
function read_record(a_poly, a_lookup)
{
  let l_count = a_poly.getPointCount();
  if (l_count < 2) return undefined;

  let l_model_index = a_poly.getModelIndex();
  let l_bsid_v = a_poly.getAttributeIntExt(ATTR.BSID);
  // A path without BSID gets 0, which normally has no custom table entry.
  let l_bsid = (typeof l_bsid_v === 'number') ? l_bsid_v : 0;
  let l_table = a_lookup[l_model_index];
  let l_entry = l_table ? l_table[String(l_bsid)] : undefined;

  // Machines with several lasers: the index selects the laser
  // (0 = first laser). Negative values are clamped to 0.
  let l_laser_v = a_poly.getAttributeIntExt(ATTR.LASER_INDEX);
  let l_laser_index = 0;
  if (typeof l_laser_v === 'number') l_laser_index = Math.max(0, l_laser_v);
  else if (l_entry && (typeof l_entry.laserIndex === 'number')) l_laser_index = l_entry.laserIndex;

  let l_nominal = get_real_value(a_poly, ATTR.POWER, l_entry, 'power', 0.0);
  let l_mode = a_poly.getPolylineMode();
  let l_kind = get_kind(l_mode);
  let l_coords = read_coords(a_poly, l_count);

  let l_edges = [];
  let l_variation = false;
  let l_pairs = make_edge_pairs(l_kind, l_coords, l_count);
  for (let k = 0; k < l_pairs.length; ++k)
  {
    let l_a = l_pairs[k][0];
    let l_b = l_pairs[k][1];
    if (edge_length(l_coords, l_a, l_b) < S_MIN_EDGE_LENGTH) continue;
    let l_p = get_edge_power(a_poly, l_a, l_nominal);
    // Remember if any edge differs from the nominal power, so the
    // writers can use the short "constant power" form otherwise.
    if (Math.abs(l_p - l_nominal) > S_POWER_TOL) l_variation = true;
    l_edges.push({ a: l_a, b: l_b, power: l_p });
  }
  if (l_edges.length === 0) return undefined;

  return {
    model_index: l_model_index,
    subtype: a_poly.getModelSubtype(),
    bsid: l_bsid,
    laser_index: l_laser_index,
    speed: get_real_value(a_poly, ATTR.SPEED, l_entry, 'speed', 0.0),
    focus: get_real_value(a_poly, ATTR.FOCUS, l_entry, 'focus', 0.0),
    nominal_power: l_nominal,
    kind: l_kind,
    // Only closed paths can be inner loops (contours around holes).
    is_inloop: (l_kind === 'closed') ? (a_poly.isInloop() === true) : false,
    coords: l_coords,
    edges: l_edges,
    has_power_variation: l_variation
  };
}

/**
 * All exposure paths of one layer in processing order.
 * Processing order is the order in which the machine exposes the
 * paths. The build style decided it earlier (for example contours
 * before or after hatches, or sorting against the gas flow so that
 * spatter and fumes are blown away from areas that are not exposed
 * yet). The writers keep this order exactly.
 * @param {bsModelData} a_model_data
 * @param {number} a_layer_nr  Layer number, 1-based
 * @param {Array} a_lookup  Result of build_scan_lookup
 * @return {Array} PathRecords (empty if the layer has no exposure)
 */
exports.read_layer_paths = function(a_model_data, a_layer_nr, a_lookup)
{
  let r_records = [];
  let l_it = a_model_data.getFirstLayerPolyline(a_layer_nr, POLY_IT.nLayerExposureInProcessingOrder);
  while (l_it.isValid())
  {
    let l_rec = read_record(l_it, a_lookup);
    if (l_rec) r_records.push(l_rec);
    l_it.next();
  }
  return r_records;
};

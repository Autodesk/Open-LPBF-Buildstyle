/************************************************************
 * MODULE NAME: tp3mf_writer.js
 *
 * PURPOSE:
 *   Write a 3MF package with the laser toolpath extension
 *   (namespace .../toolpath/2026/03): one XML file per layer with
 *   hatches, polylines and loops, plus profiles with the scanning
 *   parameters of every vector type.
 *
 * WORKFLOW (order of the entries in the package):
 *   1. _rels/.rels (start part and thumbnail)
 *   2. [Content_Types].xml
 *   3. Metadata/build_job_image.png (if available)
 *   4. Toolpath/layer<ztop>.xml for every layer with data
 *   5. 3D/3dmodel.model (profiles, layer list, empty part objects)
 *   6. 3D/_rels/3dmodel.model.rels (one relationship per layer)
 *   7. Metadata/... text attachments (JSON files)
 *   Why this order: the two package files come first, as in the other
 *   3MF toolpath exporters of the scripts tree; they do not depend on
 *   the toolpath. Every layer file is written into the package as soon
 *   as it is ready and then forgotten (low memory use). The model file
 *   lists only the layers that were really written, so it and its
 *   relationships can only be written afterwards.
 *
 *   Laser power: every profile has a linear modifier for the laser
 *   power (0 .. max_power). The factor f = P / max is written on the
 *   child elements of a segment, as the toolpath specification
 *   requires (a <segment> has no factor attributes):
 *   - <hatch>: one constant factor 'f', or (filter with ramps, where the
 *     power changes along touching micro vectors) start and end factor
 *     'f1' / 'f2'; the power changes linearly along the hatch line,
 *   - filter with support points: every chain of touching micro vectors
 *     is ONE <hatch> with 'f1' / 'f2' and <sub t f/> children at the
 *     centers of the micro vectors (t = position along the line, 0..1);
 *     the reader interpolates linearly between them. The profiles then
 *     get a 'nonlinear' modifier. About half the size of one <hatch> per
 *     micro vector (one <sub> is about half as long as one <hatch>),
 *   - <point>: the factor 'f' of the line that the point closes (the
 *     line arriving from the previous point; for a loop the first point
 *     closes the line from the last point back to the first one).
 *   Every path becomes exactly one segment.
 *   Example: max power 400 W, a hatch at 200 W -> <hatch ... f="0.5"/>.
 *
 * USAGE:
 *   var TP3MF = require('../export/tp3mf_writer.js');
 *   let l_res = TP3MF.export_3mf(l_ctx, exportFile, 'sub'); // or 'edges' / 'ramps'
 *   // l_ctx: { model_data, layer_count, lookup, progress,
 *   //          max_power_by_model: number[], attachments: { image, texts: [{name, text}] } }
 *
 * DEPENDENCIES:
 *   Builtins: StringUtil
 *   Modules : ./zip_package.js, ./xml_text.js, ./toolpath_reader.js,
 *             ./parameter_json.js, ../util/math_utils.js, ../util/log.js
 *
 * BACKGROUND:
 *   3MF is an open file format for 3D printing. A 3MF file is a ZIP
 *   archive with XML files inside. Fixed "relationship" files
 *   (_rels/...) tell a reader where to start (3D/3dmodel.model) and
 *   which other files belong to it; [Content_Types].xml tells the
 *   reader the type of every file extension.
 *   The toolpath extension adds the laser data: one XML file per
 *   layer with the vectors, and "profiles" (one per vector type =
 *   per BSID and model) with laser power, speed, focus and laser
 *   index. Each segment (a group of vectors) refers to its profile,
 *   so the parameters are stored once instead of on every vector.
 *   Segment types: 'hatch' = independent lines, 'polyline' = open
 *   chain of points, 'loop' = closed chain (contour).
 *   Namespaces (the long 'http://...' texts) are only unique names
 *   that identify the XML vocabulary; nothing is downloaded.
 *   UUID: a random, globally unique id text, used to link the layer
 *   files to parts and profiles of the model file.
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it.
 *   This writer runs single-threaded. Extension: a multi-threaded
 *   variant could write the layer files in export processing steps
 *   (configureExportProcessingSteps).
 *   Coordinates are written as integers in micrometers
 *   (unitfactor 0.001).
 *   Why integers: they are shorter than decimal numbers and have no
 *   rounding differences between readers; 1 micrometer is far finer
 *   than the laser spot. A reader multiplies the integer by 0.001 to
 *   get millimeters (model unit), e.g. x="12345" -> 12.345 mm.
 *   Speed, focus and laser index are taken from the path first and from
 *   the custom table second (same rule as LSR and CLI+). Paths with own
 *   values, or with a BSID without table entry, get an extra profile.
 *
 * NEW EXPORT FORMAT:
 *   Use this file or lsr_writer.js as template: read each layer with
 *   toolpath_reader.read_layer_paths, turn the PathRecords into the
 *   text of the new format, and add it to a ZIP with zip_package.js.
 *   Then register the new filter and call the writer in
 *   main/export_main.js (see EXTENSION NOTES there).
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var STRING_UTIL = requireBuiltin('StringUtil');
var ZIP = require('./zip_package.js');
var XML = require('./xml_text.js');
var TOOLPATH_READER = require('./toolpath_reader.js');
var PARAM_JSON = require('./parameter_json.js');
var MATH = require('../util/math_utils.js');
var LOG = require('../util/log.js');

// XML namespaces and relationship types defined by the 3MF and the
// package specifications. They must be written exactly as they are;
// a reader compares them as text.
var S_NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
var S_NS_PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
var S_NS_TOOLPATH = 'http://schemas.3mf.io/3dmanufacturing/toolpath/2026/03';
var S_REL_3DMODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
var S_REL_LAYER = 'http://schemas.3mf.io/3dmanufacturing/toolpath/2026/03/layer';
var S_REL_THUMBNAIL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail';
var S_NS_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
var S_NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';

var S_IMAGE_ENTRY = 'Metadata/build_job_image.png';

/**
 * Decimals of the power factors.
 * 6 decimals of a factor give a power resolution of 0.001 W at 1000 W
 * maximum power, far finer than a laser can be controlled.
 */
var S_FACTOR_DIGITS = 6;

/**
 * Geometric tolerance (mm) of the micro vector tests: two points closer
 * than this are the same point, and a point closer than this to a line
 * lies on it (edges_touch, edges_collinear, chain_end).
 * Why 0.1 micrometer: the host stores toolpath points in single
 * precision (about 7 digits), so the split points of a micro vector
 * chain lie a few nanometers off the ideal line (at 250 mm one float
 * step is 0.03 micrometer). The coordinates are written in whole
 * micrometers, so 0.1 micrometer is still far below what the file can
 * show.
 */
var S_SAME_POINT_TOL = 1e-4;

/**
 * Power modes of the 3MF export (how a changing power along a hatch line
 * is written, only matters with power optimization):
 * - 'edges': every micro vector is its own <hatch> with a constant f,
 * - 'ramps': every micro vector is its own <hatch>; where two touching
 *   micro vectors meet, both ramp to their mean power (f1 / f2),
 * - 'sub'  : every chain of touching micro vectors is ONE <hatch> with
 *   support points <sub t f/> at the centers of the micro vectors
 *   (profiles get a 'nonlinear' modifier, required for <sub>).
 */
var S_POWER_MODES = Object.freeze(['edges', 'ramps', 'sub']);

/**
 * Allowed shift (micrometers) of a support point caused by the rounding
 * of its t value. Far below the 1 micrometer resolution of the coordinates.
 */
var S_SUB_POSITION_TOL_UM = 0.05;

/** Fewest / most decimals of a t value (see sub_t_digits). */
var S_SUB_T_MIN_DIGITS = 3;
var S_SUB_T_MAX_DIGITS = 12;

/**
 * Speeds (mm/s) and focus offsets (mm) closer than this are equal when a
 * path is compared with its profile (far below any meaningful change).
 */
var S_PROFILE_VALUE_TOL = 1e-6;

/**
 * Smallest maximum power of a profile (avoids a division by 0).
 * Without it a profile with 0 W (for example an unused vector type)
 * would give factor = P / 0.
 */
var S_MIN_MAX_POWER = 1.0;

// -----------------------------------------------------------
// Small helpers
// -----------------------------------------------------------

/**
 * Millimeter to integer micrometer.
 * Example: 12.3456 mm -> 12346 (rounded to the nearest micrometer).
 * @param {number} a_mm
 * @return {number} Integer value in micrometers
 */
function to_um(a_mm)
{
  return Math.round(a_mm * 1000.0);
}

/**
 * Power factor in [0, 1], rounded to 6 decimals.
 * The factor is clamped: a power above a_max_power is written as 1.0
 * (that is, as a_max_power), a negative power as 0.
 * Rounding here (not only when writing) makes sure that two powers
 * that give the same text also compare as equal (f1 === f2 -> one 'f').
 * @param {number} a_power      Power in W
 * @param {number} a_max_power  Maximum power of the profile in W (> 0)
 * @return {number}
 */
function make_factor(a_power, a_max_power)
{
  let l_f = MATH.clamp(a_power / a_max_power, 0.0, 1.0);
  return Number(l_f.toFixed(S_FACTOR_DIGITS));
}

/**
 * Number as text for profile attributes (no exponent for normal values).
 * 12 significant digits remove binary noise such as 0.30000000000000004.
 */
function num_text(a_v)
{
  return Number(a_v.toPrecision(12)).toString();
}

/**
 * Advance the progress by one step.
 * The progress object is optional (undefined = no progress display).
 * step() returning false or cancelled() returning true both mean that
 * the user pressed "Cancel".
 * @param {Object|undefined} a_progress  Progress object of the entry point
 * @return {boolean} true if the user cancelled
 */
function step_and_check_cancel(a_progress)
{
  if (!a_progress) return false;
  if (a_progress.step(1) === false) return true;
  return (typeof a_progress.cancelled === 'function') && (a_progress.cancelled() === true);
}

/** x/y of point a_i of a record (mm); coords is the flat array [x0, y0, x1, y1, ...]. */
function px(a_rec, a_i) { return a_rec.coords[2 * a_i]; }
function py(a_rec, a_i) { return a_rec.coords[2 * a_i + 1]; }

/** Does edge k start where edge j ends (no gap, within S_SAME_POINT_TOL)? */
function edges_touch(a_rec, a_j, a_k)
{
  let l_ej = a_rec.edges[a_j];
  let l_ek = a_rec.edges[a_k];
  return MATH.dist(px(a_rec, l_ej.b), py(a_rec, l_ej.b), px(a_rec, l_ek.a), py(a_rec, l_ek.a)) < S_SAME_POINT_TOL;
}

/**
 * Distance (mm) of point (a_qx, a_qy) from the infinite line through
 * (a_x0, a_y0) and (a_x1, a_y1).
 * HOW: |cross product| of (line direction, point - line start) divided
 * by the line length = height of the parallelogram = distance.
 * A line of length 0 gives the distance to its start point.
 */
function point_line_dist(a_qx, a_qy, a_x0, a_y0, a_x1, a_y1)
{
  let l_dx = a_x1 - a_x0;
  let l_dy = a_y1 - a_y0;
  let l_len = Math.sqrt(l_dx * l_dx + l_dy * l_dy);
  if (!(l_len > 0.0)) return MATH.dist(a_qx, a_qy, a_x0, a_y0);
  return Math.abs(l_dx * (a_qy - a_y0) - l_dy * (a_qx - a_x0)) / l_len;
}

/**
 * Does edge k continue edge j in the same direction (edge k starts where
 * edge j ends, see edges_touch)?
 * Two tests: the shared point lies on the line from the start of edge j
 * to the end of edge k (within S_SAME_POINT_TOL, a distance in mm, so
 * float noise of the stored points does not matter; using the two
 * outer points keeps the test stable if one edge is very short), and
 * the dot product of both directions is > 0 (same way, not back).
 * Only then can the power run smoothly through
 * the shared point; at a corner the laser changes direction and the
 * powers are kept separate.
 * Why a distance and not an angle: the split points of micro vectors
 * are stored in single precision; on a 0.5 mm piece a few nanometers
 * of noise already change the direction by ~1e-5 rad.
 */
function edges_collinear(a_rec, a_j, a_k)
{
  let l_ej = a_rec.edges[a_j];
  let l_ek = a_rec.edges[a_k];
  let l_ax = px(a_rec, l_ej.b) - px(a_rec, l_ej.a);
  let l_ay = py(a_rec, l_ej.b) - py(a_rec, l_ej.a);
  let l_bx = px(a_rec, l_ek.b) - px(a_rec, l_ek.a);
  let l_by = py(a_rec, l_ek.b) - py(a_rec, l_ek.a);
  if ((l_ax * l_bx + l_ay * l_by) <= 0.0) return false;
  return point_line_dist(px(a_rec, l_ej.b), py(a_rec, l_ej.b),
    px(a_rec, l_ej.a), py(a_rec, l_ej.a), px(a_rec, l_ek.b), py(a_rec, l_ek.b)) < S_SAME_POINT_TOL;
}

// -----------------------------------------------------------
// Profiles and model identifiers
// -----------------------------------------------------------

/**
 * Profiles (one per model and vector type) and part identifiers.
 * A profile is created for every custom table entry of every model,
 * even if a vector type is not used in any layer; the model file then
 * lists all parameter sets of the job.
 * Maximum power of a profile = the largest of: S_MIN_MAX_POWER, the
 * nominal power of the entry, and the highest power that the power
 * optimization of this model may use. So every power that occurs fits
 * into the factor range 0..1.
 * These table profiles are the normal case. A path whose speed, focus
 * or laser index differs from its table entry, or whose BSID has no
 * table entry at all, gets an additional profile while the layers are
 * written (see get_record_profile), so 3MF writes the same values as
 * LSR and CLI+ (path attribute first, then table).
 * @param {Object} a_ctx  Export context (model_data, lookup, max_power_by_model)
 * @return {{profiles:Array, by_key:Map, model_uuids:string[], model_names:string[],
 *          model_max_power:number[]}}
 *         by_key: '<model index>_<bsid>' -> table profile,
 *         'v:<model index>_<bsid>_<laser>_<speed>_<focus>' -> extra profile,
 *         model_max_power: highest power of the power optimization per model (W)
 */
function build_profiles(a_ctx)
{
  let r_ids = { profiles: [], by_key: new Map(), model_uuids: [], model_names: [], model_max_power: [] };
  let l_md = a_ctx.model_data;
  for (let i = 0; i < l_md.getModelCount(); ++i)
  {
    r_ids.model_uuids.push(STRING_UTIL.getUuidString());
    r_ids.model_names.push(PARAM_JSON.get_model_name(l_md.getModel(i), i));

    let l_model_max = a_ctx.max_power_by_model ? a_ctx.max_power_by_model[i] : undefined;
    r_ids.model_max_power.push((typeof l_model_max === 'number') ? l_model_max : 0.0);
    let l_table = a_ctx.lookup[i] || {};
    let l_keys = Object.keys(l_table);
    for (let k = 0; k < l_keys.length; ++k)
    {
      let l_entry = l_table[l_keys[k]];
      let l_max = Math.max(S_MIN_MAX_POWER, l_entry.power, (typeof l_model_max === 'number') ? l_model_max : 0.0);
      // Profile name: 'm' + model number (1-based) + '_' + vector type key
      // (the 'name' of the custom table entry), readable for humans.
      let l_profile = {
        uuid: STRING_UTIL.getUuidString(),
        name: 'm' + (i + 1) + '_' + l_entry.name,
        power: l_entry.power,
        speed: l_entry.speed,
        focus: l_entry.focus,
        laser_index: l_entry.laserIndex,
        max_power: l_max
      };
      r_ids.profiles.push(l_profile);
      r_ids.by_key.set(i + '_' + l_entry.bsid, l_profile);
    }
  }
  return r_ids;
}

/**
 * true if the scanning parameters of a path match a profile.
 * Speed and focus are compared with a small tolerance, because the
 * values went through floating point calculations.
 * @param {Object} a_profile  Profile (speed, focus, laser_index)
 * @param {Object} a_rec      PathRecord (speed, focus, laser_index)
 * @return {boolean}
 */
function profile_matches_record(a_profile, a_rec)
{
  return (a_profile.laser_index === a_rec.laser_index) &&
    (Math.abs(a_profile.speed - a_rec.speed) <= S_PROFILE_VALUE_TOL) &&
    (Math.abs(a_profile.focus - a_rec.focus) <= S_PROFILE_VALUE_TOL);
}

/**
 * Highest power of a path (nominal power and all edge powers), in W.
 * @param {Object} a_rec  PathRecord
 * @return {number}
 */
function get_record_max_power(a_rec)
{
  let r_max = a_rec.nominal_power;
  for (let k = 0; k < a_rec.edges.length; ++k)
  {
    if (a_rec.edges[k].power > r_max) r_max = a_rec.edges[k].power;
  }
  return r_max;
}

/**
 * Profile of a path.
 * Normal case: the table profile of the BSID. If the path has its own
 * speed, focus or laser index (path attributes), or if its BSID has no
 * table entry, an extra profile with the values of the path is created
 * once and reused for all paths with the same values.
 * Why: a 3MF segment has no own speed or focus; they are only stored
 * in the profile. Without extra profiles such paths would be written
 * with the wrong values or not at all.
 * The model file is written after all layers, so profiles created here
 * still end up in it.
 * @param {Object} a_ids  Result of build_profiles (extended here)
 * @param {Object} a_rec  PathRecord
 * @return {Object} Profile
 */
function get_record_profile(a_ids, a_rec)
{
  let l_base_key = a_rec.model_index + '_' + a_rec.bsid;
  let l_base = a_ids.by_key.get(l_base_key);
  if (l_base && profile_matches_record(l_base, a_rec)) return l_base;

  // num_text gives a stable text for equal numbers, so equal values
  // always produce the same key.
  let l_key = 'v:' + l_base_key + '_' + a_rec.laser_index + '_' +
    num_text(a_rec.speed) + '_' + num_text(a_rec.focus);
  let r_profile = a_ids.by_key.get(l_key);
  if (r_profile) return r_profile;

  // Base name: the table profile name, or model number + BSID if the
  // BSID has no table entry. The suffix keeps profile names unique.
  let l_name = l_base ? l_base.name : ('m' + (a_rec.model_index + 1) + '_bsid' + a_rec.bsid);
  let l_power = l_base ? l_base.power : a_rec.nominal_power;
  let l_model_max = a_ids.model_max_power[a_rec.model_index] || 0.0;
  r_profile = {
    uuid: STRING_UTIL.getUuidString(),
    name: l_name + '_v' + (a_ids.profiles.length + 1),
    power: l_power,
    speed: a_rec.speed,
    focus: a_rec.focus,
    laser_index: a_rec.laser_index,
    // Covers all powers that can occur for this model; a later path with
    // an even higher power is clamped to this maximum (see make_factor).
    max_power: Math.max(S_MIN_MAX_POWER, l_power, l_model_max, get_record_max_power(a_rec),
      l_base ? l_base.max_power : 0.0)
  };
  a_ids.profiles.push(r_profile);
  a_ids.by_key.set(l_key, r_profile);
  return r_profile;
}

// -----------------------------------------------------------
// Segments of one record
// One PathRecord becomes exactly one segment:
//   <segment type="hatch|polyline|loop" profileid=".." partid="..">
//     <hatch .../> ... or <point .../> ...
//   </segment>
// The power factors are written on the child elements, as the 3MF
// toolpath specification requires (<segment> has no factor attributes):
// - <hatch>: 'f' (constant) or 'f1' / 'f2' (power at the start / end
//   point of the hatch line, linear in between); in power mode 'sub'
//   also <sub t f/> support points between them (piecewise linear),
// - <point>: 'f' of the line that the point CLOSES, i.e. the line
//   arriving from the previous point. The first point of a polyline
//   closes no line; the spec ignores its factor, it gets the factor of
//   the first line (keeps every point complete for readers that need a
//   value on every point). The first point of a loop closes the
//   implied closing line (last point -> first point).
// A child never carries 'f' and 'f1' / 'f2' at the same time.
// -----------------------------------------------------------

/**
 * Factor attribute text of one element: ' f="0.5"' or ' f1=".." f2=".."'.
 * Equal start and end factors are written as one constant 'f' (shorter).
 * @param {number} a_f1  Factor at the start (0..1, see make_factor)
 * @param {number} a_f2  Factor at the end (0..1)
 * @return {string}
 */
function factor_attrs(a_f1, a_f2)
{
  if (a_f1 === a_f2) return XML.attr('f', XML.num(a_f1, S_FACTOR_DIGITS));
  return XML.attr('f1', XML.num(a_f1, S_FACTOR_DIGITS)) + XML.attr('f2', XML.num(a_f2, S_FACTOR_DIGITS));
}

/**
 * XML element of hatch line k with its factors.
 * @param {Object} a_rec  PathRecord
 * @param {number} a_k    Edge index
 * @param {number} a_f1   Factor at the start point (x1, y1)
 * @param {number} a_f2   Factor at the end point (x2, y2)
 * @return {string}
 */
function hatch_element(a_rec, a_k, a_f1, a_f2)
{
  let l_e = a_rec.edges[a_k];
  return '<hatch' + XML.attr('x1', to_um(px(a_rec, l_e.a))) + XML.attr('y1', to_um(py(a_rec, l_e.a))) +
    XML.attr('x2', to_um(px(a_rec, l_e.b))) + XML.attr('y2', to_um(py(a_rec, l_e.b))) +
    factor_attrs(a_f1, a_f2) + '/>';
}

/**
 * XML element of one polyline / loop point with the factor of the line it closes.
 * @param {number} a_x  X in mm (written in micrometers)
 * @param {number} a_y  Y in mm
 * @param {number} a_f  Factor of the line that ends at this point (0..1)
 * @return {string}
 */
function point_element(a_x, a_y, a_f)
{
  return '<point' + XML.attr('x', to_um(a_x)) + XML.attr('y', to_um(a_y)) + factor_attrs(a_f, a_f) + '/>';
}

/**
 * Power at the start and at the end of every hatch line (filter with ramps).
 * Where two hatch lines meet without gap and in the same direction, both
 * get the mean power at this point, so the power changes smoothly.
 * Example: line 0 has 200 W, line 1 has 220 W and both lie on one
 * straight line -> line 0 ramps 200 -> 210 W, line 1 ramps 210 -> 220 W.
 * This happens when one hatch line was split into touching "micro
 * vectors" (power optimization); separate parallel hatch lines do not
 * touch and keep their own constant power.
 * @param {Object} a_rec  PathRecord of kind 'hatch'
 * @return {{p_start:number[], p_end:number[]}} Powers in W, per edge
 */
function compute_hatch_ramp_powers(a_rec)
{
  let l_n = a_rec.edges.length;
  let r_pp = { p_start: [], p_end: [] };
  for (let k = 0; k < l_n; ++k)
  {
    r_pp.p_start.push(a_rec.edges[k].power);
    r_pp.p_end.push(a_rec.edges[k].power);
  }
  for (let k = 1; k < l_n; ++k)
  {
    if (!edges_touch(a_rec, k - 1, k) || !edges_collinear(a_rec, k - 1, k)) continue;
    let l_mean = 0.5 * (a_rec.edges[k - 1].power + a_rec.edges[k].power);
    r_pp.p_end[k - 1] = l_mean;
    r_pp.p_start[k] = l_mean;
  }
  return r_pp;
}

/**
 * Last edge of the chain of micro vectors that starts at edge a_k.
 * A chain is a run of consecutive edges where each edge starts exactly
 * where the previous one ends and points in the same direction, i.e.
 * one hatch line that the power optimization split into pieces.
 * The chain is written as ONE straight line, so a new edge must also
 * end on the line from the chain start to the current chain end
 * (within S_SAME_POINT_TOL). Without this test, many tiny bends (each
 * below the tolerance) could add up to a curved path.
 * Example: edges 0-1-2 touch and are collinear, edge 3 is the next
 * parallel line -> chain_end(rec, 0) = 2, chain_end(rec, 3) = 3.
 * @param {Object} a_rec  PathRecord of kind 'hatch'
 * @param {number} a_k    First edge of the chain
 * @return {number} Index of the last edge of the chain (a_k for a single line)
 */
function chain_end(a_rec, a_k)
{
  let l_start = a_rec.edges[a_k].a;
  let r_j = a_k;
  while ((r_j + 1 < a_rec.edges.length) && edges_touch(a_rec, r_j, r_j + 1) && edges_collinear(a_rec, r_j, r_j + 1))
  {
    let l_end = a_rec.edges[r_j].b;
    let l_next = a_rec.edges[r_j + 1].b;
    if (point_line_dist(px(a_rec, l_next), py(a_rec, l_next), px(a_rec, l_start), py(a_rec, l_start),
      px(a_rec, l_end), py(a_rec, l_end)) >= S_SAME_POINT_TOL)
    {
      break;
    }
    ++r_j;
  }
  return r_j;
}

/**
 * Support points of one chain of micro vectors (filter with support points).
 * One point per micro vector, at its center (t = position along the
 * whole chain, 0 = start, 1 = end, proportional to the length), with the
 * factor of its power. The reader interpolates linearly between the
 * points, so every micro vector gets exactly its power at its middle;
 * f1 / f2 (start / end of the chain) repeat the factor of the first /
 * last micro vector, so the first and the last half piece keep their
 * power constant.
 * A point inside a run of equal factors (same factor as both neighbors)
 * lies on the flat line between them and is left out (smaller file).
 * Example: pieces of 1 mm with 200, 200, 200, 240 W (max 400 W) ->
 * centers 0.125, 0.375, 0.625, 0.875 with factors 0.5, 0.5, 0.5, 0.6;
 * f1 0.5, f2 0.6. The points at 0.125 and 0.375 lie between equal
 * factors and are left out -> written: (0.625, 0.5) (0.875, 0.6).
 * The power is 200 W up to 2.5 mm, ramps to 240 W at 3.5 mm and stays there.
 * @param {Object} a_rec  PathRecord of kind 'hatch'
 * @param {number} a_k0   First edge of the chain
 * @param {number} a_k1   Last edge of the chain (> a_k0)
 * @param {number} a_max  Maximum power of the profile (W)
 * @return {{f1:number, f2:number, length:number, points:Array<{t:number, f:number}>}}
 *         length = chain length in mm (0 if the chain has no length)
 */
function compute_sub_points(a_rec, a_k0, a_k1, a_max)
{
  let l_len = [];
  let l_total = 0.0;
  for (let k = a_k0; k <= a_k1; ++k)
  {
    let l_e = a_rec.edges[k];
    let l_l = MATH.dist(px(a_rec, l_e.a), py(a_rec, l_e.a), px(a_rec, l_e.b), py(a_rec, l_e.b));
    l_len.push(l_l);
    l_total += l_l;
  }
  let l_all = [];
  let l_pos = 0.0;
  for (let i = 0; i < l_len.length; ++i)
  {
    let l_t = (l_total > 0.0) ? (l_pos + 0.5 * l_len[i]) / l_total : 0.0;
    l_all.push({ t: l_t, f: make_factor(a_rec.edges[a_k0 + i].power, a_max) });
    l_pos += l_len[i];
  }
  let r_sub = { f1: l_all[0].f, f2: l_all[l_all.length - 1].f, length: l_total, points: [] };
  for (let i = 0; i < l_all.length; ++i)
  {
    // Neighbor factors: the previous / next point, at the ends f1 / f2.
    let l_prev = (i > 0) ? l_all[i - 1].f : r_sub.f1;
    let l_next = (i + 1 < l_all.length) ? l_all[i + 1].f : r_sub.f2;
    if ((l_all[i].f === l_prev) && (l_all[i].f === l_next)) continue;
    r_sub.points.push(l_all[i]);
  }
  return r_sub;
}

/**
 * Decimals of the t values of one chain.
 * t is a fraction of the chain length, so a longer chain needs more
 * decimals for the same position accuracy: the rounding of t must move
 * a point by less than S_SUB_POSITION_TOL_UM.
 * HOW: rounding to d decimals moves t by at most 0.5 * 10^-d, i.e. the
 * point by 0.5 * 10^-d * length; d = ceil(log10(0.5 * length / tol)).
 * Example: 10 mm = 10000 um, tolerance 0.05 um -> 10^5 -> 5 decimals;
 * 200 mm -> 7 decimals.
 * @param {number} a_length_mm  Chain length in mm (> 0)
 * @return {number} Decimals (S_SUB_T_MIN_DIGITS .. S_SUB_T_MAX_DIGITS)
 */
function sub_t_digits(a_length_mm)
{
  let l_d = Math.ceil(Math.log10(0.5 * a_length_mm * 1000.0 / S_SUB_POSITION_TOL_UM));
  return MATH.clamp(l_d, S_SUB_T_MIN_DIGITS, S_SUB_T_MAX_DIGITS);
}

/**
 * t values of the support points as text.
 * The spec requires 0 < t < 1 and strictly increasing t values. Rounding
 * could break this for points that lie extremely close together or very
 * close to an end, so the decimals are increased until the rounded
 * values are valid. A point that is still invalid at the maximum number
 * of decimals (only possible for pieces far below a micrometer) is left
 * out: the curve then runs straight past it.
 * @param {Array<{t:number, f:number}>} a_points  Support points (increasing t)
 * @param {number} a_length_mm  Chain length in mm (> 0)
 * @return {Array<{t:string, f:number}>} Points with t as text, valid for the spec
 */
function format_sub_points(a_points, a_length_mm)
{
  for (let d = sub_t_digits(a_length_mm); d <= S_SUB_T_MAX_DIGITS; ++d)
  {
    let l_ok = true;
    let l_last = 0.0;
    for (let i = 0; i < a_points.length; ++i)
    {
      let l_t = Number(a_points[i].t.toFixed(d));
      if ((l_t <= l_last) || (l_t >= 1.0))
      {
        l_ok = false;
        break;
      }
      l_last = l_t;
    }
    if (l_ok || (d === S_SUB_T_MAX_DIGITS))
    {
      let r_points = [];
      let l_prev = 0.0;
      for (let i = 0; i < a_points.length; ++i)
      {
        let l_t = Number(a_points[i].t.toFixed(d));
        if ((l_t <= l_prev) || (l_t >= 1.0)) continue;
        r_points.push({ t: XML.num(l_t, d), f: a_points[i].f });
        l_prev = l_t;
      }
      return r_points;
    }
  }
  return [];
}

/**
 * XML element of one chain of micro vectors as ONE hatch line with
 * support points (filter with support points):
 *   <hatch x1 y1 x2 y2 f1 f2><sub t f/>...</hatch>
 * The <sub> children need f1 / f2 on the hatch (spec), so f1 / f2 are
 * written even if they are equal. Without support points (all micro
 * vectors have the same factor) the line gets one constant 'f'.
 * @param {Object} a_rec  PathRecord of kind 'hatch'
 * @param {number} a_k0   First edge of the chain
 * @param {number} a_k1   Last edge of the chain (> a_k0)
 * @param {number} a_max  Maximum power of the profile (W)
 * @return {string}
 */
function sub_hatch_element(a_rec, a_k0, a_k1, a_max)
{
  let l_sub = compute_sub_points(a_rec, a_k0, a_k1, a_max);
  let l_points = (l_sub.length > 0.0) ? format_sub_points(l_sub.points, l_sub.length) : [];
  let l_a = a_rec.edges[a_k0].a;
  let l_b = a_rec.edges[a_k1].b;
  let l_xml = '<hatch' + XML.attr('x1', to_um(px(a_rec, l_a))) + XML.attr('y1', to_um(py(a_rec, l_a))) +
    XML.attr('x2', to_um(px(a_rec, l_b))) + XML.attr('y2', to_um(py(a_rec, l_b)));
  if (l_points.length === 0) return l_xml + factor_attrs(l_sub.f1, l_sub.f2) + '/>';

  l_xml += XML.attr('f1', XML.num(l_sub.f1, S_FACTOR_DIGITS)) + XML.attr('f2', XML.num(l_sub.f2, S_FACTOR_DIGITS)) + '>';
  for (let i = 0; i < l_points.length; ++i)
  {
    l_xml += '<sub' + XML.attr('t', l_points[i].t) + XML.attr('f', XML.num(l_points[i].f, S_FACTOR_DIGITS)) + '/>';
  }
  return l_xml + '</hatch>';
}

/**
 * Child elements of a hatch record.
 * Power modes (see S_POWER_MODES):
 * - 'edges': one constant f per line (every micro vector is a line),
 * - 'ramps': f1 / f2 where touching micro vectors meet (mean power),
 * - 'sub'  : every chain of micro vectors becomes one line with support
 *            points at the centers of the micro vectors.
 * @param {Object} a_rec         PathRecord of kind 'hatch'
 * @param {number} a_max         Maximum power of the profile (W)
 * @param {string} a_power_mode  'edges' | 'ramps' | 'sub'
 * @return {string[]}
 */
function hatch_body(a_rec, a_max, a_power_mode)
{
  let r_body = [];
  if (a_power_mode === 'sub')
  {
    let k = 0;
    while (k < a_rec.edges.length)
    {
      let l_j = chain_end(a_rec, k);
      let l_f = make_factor(a_rec.edges[k].power, a_max);
      r_body.push((l_j > k) ? sub_hatch_element(a_rec, k, l_j, a_max) : hatch_element(a_rec, k, l_f, l_f));
      k = l_j + 1;
    }
    return r_body;
  }
  let l_pp = (a_power_mode === 'ramps') ? compute_hatch_ramp_powers(a_rec) : undefined;
  for (let k = 0; k < a_rec.edges.length; ++k)
  {
    let l_p0 = l_pp ? l_pp.p_start[k] : a_rec.edges[k].power;
    let l_p1 = l_pp ? l_pp.p_end[k] : a_rec.edges[k].power;
    r_body.push(hatch_element(a_rec, k, make_factor(l_p0, a_max), make_factor(l_p1, a_max)));
  }
  return r_body;
}

/**
 * Child elements of a polyline: start point of the first line, then the
 * end point of every line, each with the factor of the line it closes.
 * The start point gets the factor of the first line (see the section
 * comment above).
 * @param {Object} a_rec  PathRecord of kind 'open' (or a short 'closed' one)
 * @param {number} a_max  Maximum power of the profile (W)
 * @return {string[]}
 */
function polyline_body(a_rec, a_max)
{
  let l_first = a_rec.edges[0];
  let r_body = [point_element(px(a_rec, l_first.a), py(a_rec, l_first.a), make_factor(l_first.power, a_max))];
  for (let k = 0; k < a_rec.edges.length; ++k)
  {
    let l_e = a_rec.edges[k];
    r_body.push(point_element(px(a_rec, l_e.b), py(a_rec, l_e.b), make_factor(l_e.power, a_max)));
  }
  return r_body;
}

/**
 * Child elements of a loop: the start point of every line, in order.
 * The closing line (last point -> first point) is implied by the loop,
 * so no point is repeated. Point j closes line j - 1; the first point
 * closes the last line, which is the closing line.
 * Works for both forms of closed records (see toolpath_reader.js): with
 * an explicit closing edge, or ending on the start point.
 * @param {Object} a_rec  PathRecord of kind 'closed' with at least 3 edges
 * @param {number} a_max  Maximum power of the profile (W)
 * @return {string[]}
 */
function loop_body(a_rec, a_max)
{
  let l_n = a_rec.edges.length;
  let r_body = [];
  for (let j = 0; j < l_n; ++j)
  {
    let l_closed_line = a_rec.edges[(j + l_n - 1) % l_n];
    let l_e = a_rec.edges[j];
    r_body.push(point_element(px(a_rec, l_e.a), py(a_rec, l_e.a), make_factor(l_closed_line.power, a_max)));
  }
  return r_body;
}

/**
 * The segment of one record.
 * The power mode (ramps, support points) only changes hatches: it
 * describes the power along touching micro vectors. Polylines and loops
 * get one constant factor per line, which is exactly the power stored
 * at the path (one power per edge).
 * @param {Object} a_rec          PathRecord
 * @param {number} a_max          Maximum power of the profile (W)
 * @param {string} a_power_mode  See hatch_body
 * @return {{type:string, body:string[]}}
 */
function make_segment(a_rec, a_max, a_power_mode)
{
  if (a_rec.kind === 'hatch') return { type: 'hatch', body: hatch_body(a_rec, a_max, a_power_mode) };
  // A loop needs at least 3 points; a shorter closed path is written as polyline.
  if ((a_rec.kind === 'closed') && (a_rec.edges.length >= 3)) return { type: 'loop', body: loop_body(a_rec, a_max) };
  return { type: 'polyline', body: polyline_body(a_rec, a_max) };
}

/**
 * XML text of one segment. The segment itself carries no factors.
 * Example: <segment type="hatch" profileid="1" partid="1"><hatch ... f="0.5"/></segment>
 * @param {Object} a_seg         Segment ({type, body})
 * @param {number} a_part_id     Layer-local part id
 * @param {number} a_profile_id  Layer-local profile id
 * @return {string} One line of XML text
 */
function segment_xml(a_seg, a_part_id, a_profile_id)
{
  return '   <segment' + XML.attr('type', a_seg.type) + XML.attr('profileid', a_profile_id) +
    XML.attr('partid', a_part_id) + '>' + a_seg.body.join('') + '</segment>\n';
}

// -----------------------------------------------------------
// Layer files
// -----------------------------------------------------------

/**
 * XML text of one layer. Part and profile ids are local to the layer
 * and numbered in the order of first use.
 * Why local ids: segments refer to parts and profiles by small
 * numbers (1, 2, ...) instead of long UUIDs, which keeps the layer
 * file small. The <parts> and <profiles> lists at the top of the
 * layer map these numbers to the UUIDs of the model file.
 * The segments keep the processing order of the records, which is
 * the exposure order on the machine.
 * Layer file structure:
 *   <layer> <parts/> <profiles/> <data/> <segments> ... </segments> </layer>
 * @param {Array} a_records       PathRecords of the layer
 * @param {Object} a_ids          Result of build_profiles
 * @param {string} a_power_mode  See make_segment
 * @return {string|undefined} undefined if the layer has no usable path
 */
function build_layer_xml(a_records, a_ids, a_power_mode)
{
  let l_part_ids = new Map();     // model index -> local part id
  let l_profile_ids = new Map();  // profile uuid -> { id, profile }
  let l_segments = [];

  for (let i = 0; i < a_records.length; ++i)
  {
    let l_rec = a_records[i];
    let l_profile = get_record_profile(a_ids, l_rec);
    let l_key = l_profile.uuid;
    // First use of a part / profile in this layer: give it the next local id.
    if (!l_part_ids.has(l_rec.model_index)) l_part_ids.set(l_rec.model_index, l_part_ids.size + 1);
    if (!l_profile_ids.has(l_key)) l_profile_ids.set(l_key, { id: l_profile_ids.size + 1, profile: l_profile });

    let l_part_id = l_part_ids.get(l_rec.model_index);
    let l_profile_id = l_profile_ids.get(l_key).id;
    l_segments.push(segment_xml(make_segment(l_rec, l_profile.max_power, a_power_mode), l_part_id, l_profile_id));
  }
  if (l_segments.length === 0) return undefined;

  // Tip: collecting the pieces in an array and calling join('')
  // once is much faster than adding long strings with '+' in a loop.
  let l_xml = ['<?xml version="1.0" encoding="UTF-8"?>\n', '<layer' + XML.attr('xmlns', S_NS_TOOLPATH) + '>\n', ' <parts>\n'];
  let l_models = Array.from(l_part_ids.keys());
  for (let i = 0; i < l_models.length; ++i)
  {
    l_xml.push('  <part' + XML.attr('id', l_part_ids.get(l_models[i])) + XML.attr('uuid', a_ids.model_uuids[l_models[i]]) + '/>\n');
  }
  l_xml.push(' </parts>\n', ' <profiles>\n');
  let l_profiles = Array.from(l_profile_ids.values());
  for (let i = 0; i < l_profiles.length; ++i)
  {
    l_xml.push('  <profile' + XML.attr('id', l_profiles[i].id) + XML.attr('uuid', l_profiles[i].profile.uuid) + '/>\n');
  }
  l_xml.push(' </profiles>\n', ' <data/>\n', ' <segments>\n');
  l_xml.push(l_segments.join(''));
  l_xml.push(' </segments>\n', '</layer>\n');
  return l_xml.join('');
}

/**
 * Write all layer files.
 * Streaming: each layer is read, converted and written into the
 * package before the next layer is read, so only one layer is in
 * memory at a time.
 * A layer file is named after its top Z in micrometers (for example
 * 'Toolpath/layer60.xml' for z = 0.06 mm). Layers without exposure are
 * skipped. The Z values must strictly increase; a layer with the same
 * or a lower Z (for example two layer numbers that round to the same
 * micrometer) is skipped with a warning, because two files with the
 * same name are not possible.
 * @param {bsFileArchiveWriter} a_archive
 * @param {Object} a_ctx          Export context
 * @param {Object} a_ids          Result of build_profiles
 * @param {string} a_power_mode  See make_segment
 * @return {{ok:boolean, message:string, layers:number[]}} layers: written ztop values (micrometer)
 */
function write_layers(a_archive, a_ctx, a_ids, a_power_mode)
{
  let l_md = a_ctx.model_data;
  let r_layers = [];
  let l_last_ztop = -Infinity;
  if (a_ctx.progress) a_ctx.progress.initSteps(a_ctx.layer_count);

  // Layer numbers start at 1.
  for (let n = 1; n <= a_ctx.layer_count; ++n)
  {
    let l_records = TOOLPATH_READER.read_layer_paths(l_md, n, a_ctx.lookup);
    let l_ztop = to_um(l_md.getLayerZ(n));
    if ((l_records.length > 0) && (l_ztop <= l_last_ztop))
    {
      LOG.warning_once('3mf_ztop', 'Layer heights are not strictly increasing; some layers are not exported to 3MF.');
    }
    else if (l_records.length > 0)
    {
      let l_text = build_layer_xml(l_records, a_ids, a_power_mode);
      if (typeof l_text === 'string')
      {
        if (!ZIP.add_text(a_archive, 'Toolpath/layer' + l_ztop + '.xml', l_text))
        {
          return { ok: false, message: 'Failed to write layer ' + n, layers: r_layers };
        }
        r_layers.push(l_ztop);
        l_last_ztop = l_ztop;
      }
    }
    // Checked once per layer, so "Cancel" reacts quickly even for large builds.
    if (step_and_check_cancel(a_ctx.progress))
    {
      return { ok: false, message: 'Export cancelled', layers: r_layers };
    }
  }
  return { ok: true, message: '', layers: r_layers };
}

// -----------------------------------------------------------
// Package files
// -----------------------------------------------------------

/**
 * Text of 3D/3dmodel.model.
 * Content: the toolpath resource (all profiles and the list of layer
 * files with their top Z), one empty mesh object per part and the
 * build items. The parts need no triangles here: the package carries
 * the toolpath, not the geometry; the objects only give every part a
 * name and a UUID that the layer files refer to.
 * zbottom is the bottom of the first layer: Z of layer 1 minus one
 * layer thickness (usually 0 = top of the build plate).
 * @param {Object} a_ctx     Export context
 * @param {Object} a_ids     Result of build_profiles
 * @param {number[]} a_layers  Written ztop values (micrometers)
 * @param {string} a_power_mode  See hatch_body ('sub' -> nonlinear modifier)
 * @return {string}
 */
function build_model_xml(a_ctx, a_ids, a_layers, a_power_mode)
{
  let l_md = a_ctx.model_data;
  // getLayerThickness() is in Z units; dividing by getZUnit() gives mm.
  let l_thickness_mm = l_md.getLayerThickness() / l_md.getZUnit();
  let l_zbottom = to_um(l_md.getLayerZ(1) - l_thickness_mm);

  let l_x = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
  l_x.push('<model' + XML.attr('unit', 'millimeter') + XML.attr('xml:lang', 'en-US') +
    XML.attr('xmlns', S_NS_CORE) + XML.attr('xmlns:p', S_NS_PRODUCTION) + XML.attr('xmlns:t', S_NS_TOOLPATH) +
    // A reader that does not support these extensions must not load the
    // file (it could not interpret the toolpath).
    XML.attr('requiredextensions', 'p t') + '>\n');
  l_x.push(' <resources>\n');
  // unitfactor 0.001: toolpath coordinates are integers in micrometers.
  // 'planar' = all paths of one layer lie in one plane (flat layers).
  l_x.push('  <t:toolpathresource' + XML.attr('id', 1) + XML.attr('uuid', STRING_UTIL.getUuidString()) +
    XML.attr('unitfactor', '0.001') + XML.attr('toolpathtype', 'planar') + '>\n');

  // One profile per model and BSID: laser focus (mm), laser index
  // (0-based), nominal power (W) and speed (mm/s).
  let l_modifier_type = (a_power_mode === 'sub') ? 'nonlinear' : 'linear';
  l_x.push('   <t:toolpathprofiles>\n');
  for (let i = 0; i < a_ids.profiles.length; ++i)
  {
    let l_p = a_ids.profiles[i];
    l_x.push('    <t:toolpathprofile' + XML.attr('uuid', l_p.uuid) + XML.attr('name', l_p.name) +
      XML.attr('laserfocus', num_text(l_p.focus)) + XML.attr('laserindex', l_p.laser_index) +
      XML.attr('laserpower', num_text(l_p.power)) + XML.attr('laserspeed', num_text(l_p.speed)) + '>');
    // laser power = minvalue + factor * (maxvalue - minvalue); minvalue < maxvalue is required.
    // 'nonlinear' allows <sub> support points (required by the spec for
    // them); a constant f or f1 / f2 stay valid under it.
    l_x.push('<t:modifier' + XML.attr('attribute', 'laserpower') + XML.attr('type', l_modifier_type) +
      XML.attr('minvalue', '0') + XML.attr('maxvalue', num_text(l_p.max_power)) + XML.attr('factor', 'f') + '/>');
    l_x.push('</t:toolpathprofile>\n');
  }
  l_x.push('   </t:toolpathprofiles>\n');

  // Layer list: every entry points to one layer file inside the package.
  l_x.push('   <t:toolpathlayers' + XML.attr('zbottom', l_zbottom) + '>\n');
  for (let i = 0; i < a_layers.length; ++i)
  {
    l_x.push('    <t:toolpathlayer' + XML.attr('ztop', a_layers[i]) +
      XML.attr('path', '/Toolpath/layer' + a_layers[i] + '.xml') + '/>\n');
  }
  l_x.push('   </t:toolpathlayers>\n');
  l_x.push('  </t:toolpathresource>\n');

  // One empty mesh object per part: the toolpath references the parts by UUID.
  // The build item (not the object) carries the part UUID used in the
  // layer files.
  let l_items = [];
  for (let i = 0; i < a_ids.model_uuids.length; ++i)
  {
    // Resource id 1 is the toolpath resource, so objects start at 2.
    let l_object_id = i + 2;
    let l_object_uuid = STRING_UTIL.getUuidString();
    l_x.push('  <object' + XML.attr('id', l_object_id) + XML.attr('type', 'model') + XML.attr('name', a_ids.model_names[i]) +
      XML.attr('partnumber', l_object_uuid) + XML.attr('p:UUID', l_object_uuid) +
      '><mesh><vertices/><triangles/></mesh></object>\n');
    l_items.push('  <item' + XML.attr('objectid', l_object_id) + XML.attr('p:UUID', a_ids.model_uuids[i]) +
      XML.attr('partnumber', a_ids.model_names[i]) + '/>\n');
  }
  l_x.push(' </resources>\n');
  l_x.push(' <build' + XML.attr('p:UUID', STRING_UTIL.getUuidString()) + '>\n');
  l_x.push(l_items.join(''));
  l_x.push(' </build>\n', '</model>\n');
  return l_x.join('');
}

/**
 * Text of 3D/_rels/3dmodel.model.rels.
 * Relationships of the model file: one per layer file, so a reader
 * knows that these files belong to the model. Every relationship
 * needs an Id that is unique in this file; a UUID is used for it.
 * @param {number[]} a_layers  Written ztop values (micrometers)
 * @return {string}
 */
function build_model_rels(a_layers)
{
  let l_x = ['<?xml version="1.0" encoding="UTF-8"?>\n', '<Relationships' + XML.attr('xmlns', S_NS_RELS) + '>\n'];
  for (let i = 0; i < a_layers.length; ++i)
  {
    l_x.push(' <Relationship' + XML.attr('Type', S_REL_LAYER) + XML.attr('Target', '/Toolpath/layer' + a_layers[i] + '.xml') +
      XML.attr('Id', 'attachment' + STRING_UTIL.getUuidString()) + '/>\n');
  }
  l_x.push('</Relationships>\n');
  return l_x.join('');
}

/**
 * Text of _rels/.rels.
 * The package root relationships: the start part (3D/3dmodel.model)
 * and, if the image was added, the thumbnail (preview image).
 * @param {boolean} a_has_thumbnail  true if the image entry was written
 * @return {string}
 */
function build_root_rels(a_has_thumbnail)
{
  let l_x = ['<?xml version="1.0" encoding="UTF-8"?>\n', '<Relationships' + XML.attr('xmlns', S_NS_RELS) + '>\n'];
  l_x.push(' <Relationship' + XML.attr('Type', S_REL_3DMODEL) + XML.attr('Target', '/3D/3dmodel.model') + XML.attr('Id', 'rel0') + '/>\n');
  if (a_has_thumbnail)
  {
    l_x.push(' <Relationship' + XML.attr('Type', S_REL_THUMBNAIL) + XML.attr('Target', '/' + S_IMAGE_ENTRY) + XML.attr('Id', 'rel1') + '/>\n');
  }
  l_x.push('</Relationships>\n');
  return l_x.join('');
}

/**
 * Text of [Content_Types].xml.
 * Maps every file extension used in the package to its type (MIME
 * type). A file with an extension that is not listed here makes the
 * package invalid, so a new attachment type (for example '.csv')
 * needs a new entry in this list.
 * @return {string}
 */
function build_content_types()
{
  let l_types = [
    ['jpeg', 'image/jpeg'],
    ['jpg', 'image/jpeg'],
    ['model', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'],
    ['png', 'image/png'],
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
    ['texture', 'application/vnd.ms-package.3dmanufacturing-3dmodeltexture'],
    ['xml', 'application/xml'],
    ['json', 'application/json']
  ];
  let l_x = ['<?xml version="1.0" encoding="UTF-8"?>\n', '<Types' + XML.attr('xmlns', S_NS_CONTENT_TYPES) + '>\n'];
  for (let i = 0; i < l_types.length; ++i)
  {
    l_x.push(' <Default' + XML.attr('Extension', l_types[i][0]) + XML.attr('ContentType', l_types[i][1]) + '/>\n');
  }
  l_x.push('</Types>\n');
  return l_x.join('');
}

/**
 * Write one package text file; false on failure.
 * The name of a failed entry is added to a_errors, so all failures
 * can be reported together at the end.
 */
function add_package_text(a_archive, a_name, a_text, a_errors)
{
  if (ZIP.add_text(a_archive, a_name, a_text)) return true;
  a_errors.push(a_name);
  return false;
}

// -----------------------------------------------------------
// Entry point
// -----------------------------------------------------------

/**
 * Write all entries of the 3MF package into an open archive (see the
 * entry order in the module header). May throw (builtins, XML text);
 * export_3mf catches it and closes the archive.
 * @param {bsFileArchiveWriter} a_archive  Open archive
 * @param {Object} a_ctx          Export context (see export_3mf)
 * @param {{image:Object, texts:Array}} a_attach  Attachments
 * @param {string} a_power_mode  See make_segment
 * @param {{image_open:boolean}} a_state  image_open is set to false as soon
 *        as add_image_attachment has closed the image file
 * @return {{ok:boolean, message:string}}
 */
function write_package(a_archive, a_ctx, a_attach, a_power_mode, a_state)
{
  let l_errors = [];
  // _rels/.rels is written before the image, so it is decided here if
  // the thumbnail relationship exists. If the image entry then cannot be
  // written, the relationship points to a missing part, which makes the
  // package invalid: this is reported as an error below.
  let l_has_thumbnail = (a_attach.image !== undefined) && (a_attach.image !== null) && (a_attach.image.ok === true);
  add_package_text(a_archive, '_rels/.rels', build_root_rels(l_has_thumbnail), l_errors);
  add_package_text(a_archive, '[Content_Types].xml', build_content_types(), l_errors);
  if (l_has_thumbnail)
  {
    if (!ZIP.add_image_attachment(a_archive, S_IMAGE_ENTRY, a_attach.image)) l_errors.push(S_IMAGE_ENTRY);
    a_state.image_open = false;
  }

  let l_ids = build_profiles(a_ctx);
  let l_res = write_layers(a_archive, a_ctx, l_ids, a_power_mode);
  if (!l_res.ok)
  {
    return { ok: false, message: l_res.message };
  }
  // An empty toolpath is still written as a valid package, but the
  // user is warned.
  if (l_res.layers.length === 0)
  {
    LOG.warning('3MF export: no layer with toolpath data.');
  }

  add_package_text(a_archive, '3D/3dmodel.model', build_model_xml(a_ctx, l_ids, l_res.layers, a_power_mode), l_errors);
  add_package_text(a_archive, '3D/_rels/3dmodel.model.rels', build_model_rels(l_res.layers), l_errors);
  // Missing JSON attachments are only a warning: the toolpath itself is complete.
  if (!ZIP.add_text_attachments(a_archive, 'Metadata/', a_attach.texts || []))
  {
    LOG.warning('3MF export: some attachments could not be written.');
  }

  if (l_errors.length > 0)
  {
    return { ok: false, message: 'Failed to write ' + l_errors.join(', ') };
  }
  return { ok: true, message: '' };
}

/**
 * Text of a caught exception.
 * @param {*} a_e  Caught value (Error or anything else that was thrown)
 * @return {string}
 */
function exception_text(a_e)
{
  return (a_e && a_e.message) ? a_e.message : String(a_e);
}

/**
 * Export the toolpaths as 3MF package.
 * Errors are returned as {ok: false, message} instead of thrown, so the
 * entry point can pass the message on to the user unchanged. Every
 * return path closes the image file and the archive, also when a
 * builtin throws while the package is written.
 * a_ctx.max_power_by_model: per model the highest power of an active
 * power optimization (0 = none), see build_profiles.
 * @param {Object} a_ctx  { model_data, layer_count, lookup, progress, max_power_by_model, attachments:{image, texts} }
 * @param {bsFile} a_file Export file
 * @param {string|boolean} a_power_mode  Power mode of the hatch lines, see S_POWER_MODES:
 *        'edges' (constant f per line), 'ramps' (f1/f2 between touching micro
 *        vectors) or 'sub' (one line per chain of micro vectors with support
 *        points). true / false are read as 'ramps' / 'edges' (earlier
 *        signature). Points of polylines / loops always get a constant f.
 * @return {{ok:boolean, message:string}}
 */
exports.export_3mf = function(a_ctx, a_file, a_power_mode)
{
  let l_attach = a_ctx.attachments || { image: undefined, texts: [] };
  let l_mode = (a_power_mode === true) ? 'ramps' : ((a_power_mode === false) ? 'edges' : a_power_mode);
  if (S_POWER_MODES.indexOf(l_mode) < 0)
  {
    ZIP.release_image_attachment(l_attach.image);
    return { ok: false, message: '3MF export: unknown power mode ' + String(a_power_mode) };
  }
  // Compression level 6: the usual compromise between size and speed.
  let l_zip = ZIP.open_zip(a_file, 6);
  if (!l_zip.ok)
  {
    ZIP.release_image_attachment(l_attach.image);
    return { ok: false, message: l_zip.message };
  }

  // The image file must be closed exactly once: by add_image_attachment
  // or, if that was not reached, by release_image_attachment below.
  let l_state = { image_open: true };
  let r_res;
  try
  {
    r_res = write_package(l_zip.archive, a_ctx, l_attach, l_mode, l_state);
  }
  catch (e)
  {
    r_res = { ok: false, message: '3MF export failed: ' + exception_text(e) };
  }

  if (l_state.image_open) ZIP.release_image_attachment(l_attach.image);
  try
  {
    ZIP.close_zip(l_zip.archive);
  }
  catch (e)
  {
    if (r_res.ok) r_res = { ok: false, message: 'Could not close the 3MF package: ' + exception_text(e) };
  }
  return r_res;
};

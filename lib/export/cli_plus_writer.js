/************************************************************
 * MODULE NAME: cli_plus_writer.js
 *
 * PURPOSE:
 *   Write toolpaths as ASCII CLI file with extensions ("CLI+").
 *
 * WORKFLOW:
 *   write_header -> write_layer (per layer) -> write_footer
 *
 *   CLI+ extensions compared to the plain CLI format:
 *   - Before every $$HATCHES / $$POLYLINE record parameter lines:
 *       $$PARAM/bsid,int,<vector type id>
 *       $$PARAM/laser_index,int,<laser number, 1-based>
 *       $$POWER/<W>   $$SPEED/<mm/s>   $$FOCUS/<mm>
 *   - Only if the power changes along the record:
 *       $$POWERS/<edge index>,<W>,<edge index>,<W>,...
 *     Each pair means "from this edge on, use this power". Edge
 *     index = hatch number for $$HATCHES, segment number for
 *     $$POLYLINE (both start at 0).
 *   Readers that do not know the extensions can skip all lines
 *   they do not understand.
 *
 *   Example of one layer (z = 0.06 mm, label 1, two hatch lines):
 *     $$LAYER/0.06000
 *     $$PARAM/bsid,int,500
 *     $$PARAM/laser_index,int,1
 *     $$POWER/200.000
 *     $$SPEED/800.000
 *     $$FOCUS/0.000
 *     $$HATCHES/1,2,0.00000,0.00000,10.00000,0.00000,10.00000,0.10000,0.00000,0.10000
 *
 * USAGE:
 *   var CLI_PLUS = require('../export/cli_plus_writer.js');
 *   CLI_PLUS.write_header(l_file, { layer_count: 100, labels: [{ id: 1, text: 'part' }], date_str: '271026' });
 *   CLI_PLUS.write_layer(l_file, modelData.getLayerZ(n), l_records);
 *   CLI_PLUS.write_footer(l_file);
 *
 * DEPENDENCIES:
 *   Builtins: none
 *   Modules : ../util/math_utils.js
 *
 * BACKGROUND:
 *   CLI ("Common Layer Interface") is an old, widely used text format
 *   for layer data in additive manufacturing. Every line is one
 *   command that starts with '$$'. The header describes the file
 *   (units, version, labels), then the geometry block lists the
 *   layers from bottom to top. Inside a layer, $$HATCHES holds
 *   independent lines (start x, start y, end x, end y each) and
 *   $$POLYLINE holds a chain of points (contours).
 *   A label groups geometry: here one label per model, so a reader
 *   knows which part each path belongs to.
 *   Plain CLI has no laser parameters. CLI+ adds them as extra
 *   lines, so the file alone describes how every path is exposed.
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Input are PathRecords of toolpath_reader.js.
 *   Label id = model index + 1. Units: 1 = mm.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var MATH = require('../util/math_utils.js');

/**
 * Coordinate decimals.
 * 5 decimals of a mm = 0.01 micrometers: much finer than the laser
 * spot (typically 50 to 100 micrometers), so no visible rounding.
 */
var S_COORD_DIGITS = 5;

/** Points closer than this (mm) are the same point. */
var S_SAME_POINT_TOL = 1e-6;

/** Coordinate as text (mm with S_COORD_DIGITS decimals). */
function c(a_v)
{
  return a_v.toFixed(S_COORD_DIGITS);
}

/**
 * Write the file header.
 * $$UNITS/1.000000 means: one coordinate unit = 1 mm.
 * The header also opens the geometry block ($$GEOMETRYSTART), so
 * write_layer can be called right after it.
 * @param {bsFile} a_file
 * @param {{layer_count:number, labels:Array, date_str:string}} a_info
 *        labels: [{id, text}], date_str: ddmmyy
 *        layer_count: number of $$LAYER lines that will follow
 */
exports.write_header = function(a_file, a_info)
{
  let l_lines = [
    '$$HEADERSTART\n',
    '$$ASCII\n',
    '$$UNITS/1.000000\n',
    '$$VERSION/200\n',
    '$$DATE/' + a_info.date_str + '\n'
  ];
  for (let i = 0; i < a_info.labels.length; ++i)
  {
    // Commas would break the record; they are replaced.
    // Line breaks are replaced as well, they would end the command early.
    l_lines.push('$$LABEL/' + a_info.labels[i].id + ',' + String(a_info.labels[i].text).replace(/[,\r\n]/g, '_') + '\n');
  }
  l_lines.push('$$LAYERS/' + a_info.layer_count + '\n');
  l_lines.push('$$HEADEREND\n');
  l_lines.push('$$GEOMETRYSTART\n');
  a_file.writeString(l_lines.join(''));
};

/**
 * $$POWERS line: one pair whenever the power (rounded to 0.1 W) changes.
 * Rounding to 0.1 W avoids a new pair for tiny differences that no
 * laser can reproduce, which keeps the line short.
 * For a polyline, the start point index of the edge is used as the
 * segment number (segment i goes from point i to point i+1).
 * @param {Object} a_rec  PathRecord
 * @return {string} Line or '' if the power is constant
 */
function make_powers_line(a_rec)
{
  if (!a_rec.has_power_variation) return '';
  let l_parts = [];
  let l_last = undefined;
  for (let k = 0; k < a_rec.edges.length; ++k)
  {
    let l_p = MATH.round_to(a_rec.edges[k].power, 0.1);
    if (l_p === l_last) continue;
    let l_index = (a_rec.kind === 'hatch') ? k : a_rec.edges[k].a;
    l_parts.push(l_index + ',' + l_p.toFixed(1));
    l_last = l_p;
  }
  return '$$POWERS/' + l_parts.join(',') + '\n';
}

/**
 * Parameter lines written before every record.
 * They are repeated for every record (not only when they change), so
 * every record can be read on its own.
 * The laser number is written 1-based, as users count lasers.
 * @param {Object} a_rec  PathRecord
 * @return {string} 5 or 6 lines of text
 */
function make_param_lines(a_rec)
{
  return '$$PARAM/bsid,int,' + a_rec.bsid + '\n' +
    '$$PARAM/laser_index,int,' + (a_rec.laser_index + 1) + '\n' +
    '$$POWER/' + a_rec.nominal_power.toFixed(3) + '\n' +
    '$$SPEED/' + a_rec.speed.toFixed(3) + '\n' +
    '$$FOCUS/' + a_rec.focus.toFixed(3) + '\n' +
    make_powers_line(a_rec);
}

/**
 * Geometry line of a hatch record (one hatch per edge).
 * Format: $$HATCHES/<label>,<count>,x1,y1,x2,y2,x1,y1,x2,y2,...
 * Edges that toolpath_reader skipped (too short) are not written, so
 * the count always matches the coordinates.
 * @param {Object} a_rec    PathRecord of kind 'hatch'
 * @param {number} a_label  CLI label id (model index + 1)
 * @return {string}
 */
function make_hatches_line(a_rec, a_label)
{
  let l_c = a_rec.coords;
  let l_v = [];
  for (let k = 0; k < a_rec.edges.length; ++k)
  {
    let l_e = a_rec.edges[k];
    l_v.push(c(l_c[2 * l_e.a]), c(l_c[2 * l_e.a + 1]), c(l_c[2 * l_e.b]), c(l_c[2 * l_e.b + 1]));
  }
  return '$$HATCHES/' + a_label + ',' + a_rec.edges.length + ',' + l_v.join(',') + '\n';
}

/**
 * Geometry line of a polyline record.
 * Direction: 0 = clockwise (inner loop), 1 = counter-clockwise
 * (outer loop), 2 = open polyline. Closed polylines repeat the first
 * point at the end, as required by the CLI format.
 * Format: $$POLYLINE/<label>,<direction>,<point count>,x,y,x,y,...
 * The direction value is taken from the inner loop flag of the
 * record; the point order itself is written unchanged.
 * @param {Object} a_rec    PathRecord of kind 'open' or 'closed'
 * @param {number} a_label  CLI label id (model index + 1)
 * @return {string}
 */
function make_polyline_line(a_rec, a_label)
{
  let l_c = a_rec.coords;
  let l_n = l_c.length / 2;
  let l_v = [];
  for (let i = 0; i < l_n; ++i) l_v.push(c(l_c[2 * i]), c(l_c[2 * i + 1]));

  if (a_rec.kind !== 'closed')
  {
    return '$$POLYLINE/' + a_label + ',2,' + l_n + ',' + l_v.join(',') + '\n';
  }
  let l_dir = a_rec.is_inloop ? 0 : 1;
  let l_already_closed = MATH.dist(l_c[0], l_c[1], l_c[2 * (l_n - 1)], l_c[2 * (l_n - 1) + 1]) < S_SAME_POINT_TOL;
  if (l_already_closed)
  {
    return '$$POLYLINE/' + a_label + ',' + l_dir + ',' + l_n + ',' + l_v.join(',') + '\n';
  }
  // Append the first point again and count it.
  l_v.push(c(l_c[0]), c(l_c[1]));
  return '$$POLYLINE/' + a_label + ',' + l_dir + ',' + (l_n + 1) + ',' + l_v.join(',') + '\n';
}

/**
 * Write one layer.
 * $$LAYER/<z> starts the layer; z is the top of the layer in mm.
 * The $$LAYER line is written even if the layer has no records, so
 * the number of $$LAYER lines matches $$LAYERS in the header.
 * The records keep their processing order: the machine exposes them
 * in the order in which they appear in the file.
 * @param {bsFile} a_file
 * @param {number} a_z_mm     Z position in mm
 * @param {Array} a_records   PathRecords in processing order
 */
exports.write_layer = function(a_file, a_z_mm, a_records)
{
  a_file.writeString('$$LAYER/' + a_z_mm.toFixed(5) + '\n');
  for (let i = 0; i < a_records.length; ++i)
  {
    let l_rec = a_records[i];
    let l_label = l_rec.model_index + 1;
    let l_geom = (l_rec.kind === 'hatch') ? make_hatches_line(l_rec, l_label) : make_polyline_line(l_rec, l_label);
    a_file.writeString(make_param_lines(l_rec) + l_geom);
  }
};

/**
 * Write the end of the geometry block.
 * Call it once after the last layer; a CLI reader may treat a file
 * without $$GEOMETRYEND as incomplete.
 * @param {bsFile} a_file
 */
exports.write_footer = function(a_file)
{
  a_file.writeString('$$GEOMETRYEND\n');
};

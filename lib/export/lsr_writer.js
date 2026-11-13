/************************************************************
 * MODULE NAME: lsr_writer.js
 *
 * PURPOSE:
 *   Write toolpaths as LSR text: one line per exposed vector with
 *   power, position, focus, speed and start time. This simple
 *   column format is easy to read for simulation and analysis tools.
 *
 * WORKFLOW:
 *   state = create_state(timing);
 *   for every layer: write_layer(file, records, z, state);
 *   reset_time(state) starts the time again at 0 (one file per layer).
 *
 *   Line format (13 columns, separated by one space):
 *     power 0 0 -1 x0 y0 z x1 y1 z focus speed t_start
 *   Units: W, mm, mm/s, s. The columns 2..4 are reserved (always
 *   '0 0 -1'). There are no comment or header lines; the meta data
 *   is written to export_info.json.
 *   Example line (200 W, 1 mm long vector at z = 0.03 mm, focus 0,
 *   800 mm/s, starting 12.5 ms after the start of the file):
 *     200 0 0 -1 10 5 0.03 11 5 0.03 0 800 0.0125
 *
 * USAGE:
 *   var LSR = require('../export/lsr_writer.js');
 *   let l_state = LSR.create_state({ jump_speed: 7000, mark_delay_us: 10, jump_delay_us: 50 });
 *   LSR.write_layer(l_tmp_file, l_records, modelData.getLayerZ(n), l_state);
 *
 * DEPENDENCIES:
 *   Builtins: none
 *   Modules : ../util/math_utils.js, ../time/scanner_delays.js
 *
 * BACKGROUND:
 *   Vector: one straight line the laser scans with the laser on.
 *   Jump: the move to the start of the next vector with the laser
 *   off. Jumps are much faster than marking, but they still take time.
 *   The laser beam is moved by two small mirrors (scanner). Mirrors
 *   need time to settle: after a jump the scanner waits a "jump delay"
 *   before marking starts, and after a vector it waits a "mark delay"
 *   before the next move. Both are given in microseconds (us). Short
 *   jumps may get a shorter jump delay (rules: ../time/scanner_delays.js).
 *   The start time column lets a simulation tool know when every
 *   vector is exposed, which matters for heat: a spot that is exposed
 *   again shortly after its neighbor is still hot.
 *   The time is an estimate from these simple rules; it does not
 *   include acceleration or the time to spread new powder.
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Input are PathRecords of toolpath_reader.js.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var MATH = require('../util/math_utils.js');
var DELAYS = require('../time/scanner_delays.js');

/**
 * Speed used if a record has no valid speed (mm/s).
 * It avoids a division by 0 in the time calculation; the fallback is
 * also written into the speed column of the line.
 */
var S_FALLBACK_SPEED = 1000.0;

/**
 * Number with 9 significant digits and without trailing zeros.
 * 9 digits keep sub-micrometer resolution even for coordinates of
 * several hundred mm (for example 123.456789 mm), and the text stays
 * short because trailing zeros are dropped.
 * @param {number} a_v
 * @return {string}
 */
function fmt(a_v)
{
  return Number(a_v.toPrecision(9)).toString();
}

/**
 * Create the writer state (laser time and position).
 * The state is an object that the caller keeps and passes to every
 * write_layer call, so the time can continue from layer to layer.
 * @param {Object} a_timing  Timing object (see ../time/scanner_delays.js):
 *        jump_speed in mm/s (must be > 0), delays in microseconds,
 *        optional jump delay scaling
 * @return {{t_s:number, pos:({x:number, y:number}|undefined), timing:Object}}
 *         t_s: current time in seconds; pos: last laser position in
 *         mm (undefined = no position yet, so no first jump is counted)
 */
exports.create_state = function(a_timing)
{
  return { t_s: 0.0, pos: undefined, timing: a_timing };
};

/**
 * Start the time again at 0 (for example for a new file).
 * The position is forgotten as well, so the first vector of the new
 * file starts at t = 0 without a jump time.
 * @param {Object} a_state
 */
exports.reset_time = function(a_state)
{
  a_state.t_s = 0.0;
  a_state.pos = undefined;
};

/**
 * Add the jump time from the current laser position to a point.
 * Jump time = distance / jump speed, plus the jump delay for real jumps.
 * Example: the next edge of a polyline starts exactly where the last
 * one ended; the scanner does not jump there, so no delay is added.
 * @param {Object} a_state  Writer state (t_s is updated)
 * @param {number} a_x      Target x (mm)
 * @param {number} a_y      Target y (mm)
 */
function add_jump(a_state, a_x, a_y)
{
  if (!a_state.pos) return;
  let l_jump = MATH.dist(a_state.pos.x, a_state.pos.y, a_x, a_y);
  a_state.t_s += l_jump / a_state.timing.jump_speed;
  a_state.t_s += DELAYS.jump_delay_us(a_state.timing, l_jump) * 1e-6;
}

/**
 * Lines of one record.
 * Every edge becomes one line. The time advances by:
 * jump (to the edge start) -> marking (length / speed) -> mark delay
 * (after each hatch line, or after the last edge of a polyline).
 * @param {Object} a_rec    PathRecord
 * @param {number} a_z_mm   Layer Z (mm), written for start and end point
 * @param {Object} a_state  Writer state (updated)
 * @return {string[]}
 */
function make_record_lines(a_rec, a_z_mm, a_state)
{
  let r_lines = [];
  let l_speed = (a_rec.speed > 0.0) ? a_rec.speed : S_FALLBACK_SPEED;
  let l_c = a_rec.coords;
  // Values that are the same for every line of the record are formatted once.
  let l_z = fmt(a_z_mm);
  let l_tail = ' ' + fmt(a_rec.focus) + ' ' + fmt(l_speed) + ' ';
  let l_mark_delay_s = a_state.timing.mark_delay_us * 1e-6;

  for (let k = 0; k < a_rec.edges.length; ++k)
  {
    let l_e = a_rec.edges[k];
    let l_x0 = l_c[2 * l_e.a];
    let l_y0 = l_c[2 * l_e.a + 1];
    let l_x1 = l_c[2 * l_e.b];
    let l_y1 = l_c[2 * l_e.b + 1];

    // The start time of this vector includes the jump to its start point.
    add_jump(a_state, l_x0, l_y0);
    r_lines.push(fmt(l_e.power) + ' 0 0 -1 ' +
      fmt(l_x0) + ' ' + fmt(l_y0) + ' ' + l_z + ' ' +
      fmt(l_x1) + ' ' + fmt(l_y1) + ' ' + l_z +
      l_tail + fmt(a_state.t_s) + '\n');
    a_state.t_s += MATH.dist(l_x0, l_y0, l_x1, l_y1) / l_speed;

    // A hatch line is a vector of its own; a polyline is one vector.
    if ((a_rec.kind === 'hatch') || (k === a_rec.edges.length - 1))
    {
      a_state.t_s += l_mark_delay_s;
    }
    a_state.pos = { x: l_x1, y: l_y1 };
  }
  return r_lines;
}

/**
 * Write all records of one layer.
 * The text goes directly into the (temporary) file, so only the lines
 * of one path are in memory at a time.
 * @param {bsFile} a_file      Open text file
 * @param {Array} a_records    PathRecords in processing order
 * @param {number} a_z_mm      Z position of the layer in mm
 * @param {Object} a_state     Writer state (updated)
 * @return {number} Number of written lines
 */
exports.write_layer = function(a_file, a_records, a_z_mm, a_state)
{
  let r_count = 0;
  for (let i = 0; i < a_records.length; ++i)
  {
    let l_lines = make_record_lines(a_records[i], a_z_mm, a_state);
    if (l_lines.length === 0) continue;
    // One write call per path is much faster than one per line.
    a_file.writeString(l_lines.join(''));
    r_count += l_lines.length;
  }
  return r_count;
};

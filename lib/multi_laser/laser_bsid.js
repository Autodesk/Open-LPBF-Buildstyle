/************************************************************
 * MODULE NAME: laser_bsid.js
 *
 * PURPOSE:
 *   BSIDs that carry the laser: when the laser assignment gives a
 *   path to a laser, the BSID of the path is changed so that it tells
 *   both the vector type and the laser.
 *
 * BACKGROUND:
 *   - The host (e.g. the smoke simulation of ATU) and multi-laser
 *     machines find the laser of a path ONLY through its BSID: they
 *     look up the BSID in the custom table of the model and use the
 *     'laserIndex' of that entry. A separate laser attribute at the
 *     path is not read there. A vector type that is exposed by several
 *     lasers therefore needs one BSID (and one custom table entry) per
 *     laser. Same convention as the ATU demo project
 *     ATU_Small_Demo_Projects/Multi_Laser_Smoke_Sim_Demo
 *     (bsid = 10 * laser + type there).
 *   - Encoding (laser-major, like the demo):
 *       laser bsid = (laser_index + 1) * 1000 + vector type bsid
 *     Example: volume hatch 500 on laser 0 -> 1500, on laser 1 -> 2500;
 *     its downskin variant 501 -> 1501 / 2501 (downskin = normal + 1
 *     stays valid). laser_index is 0-based, like 'laserIndex' in the
 *     custom table. Paths without an assigned laser keep the plain
 *     vector type bsid (< 1000), so both can be told apart.
 *   - Requirement: every vector type bsid is smaller than 1000
 *     (S_STRIDE); main/vector_types.js checks this.
 *
 * WORKFLOW:
 *   - prepareModelExposure: custom table entries for every vector type
 *     and laser (main/settings.js, build_custom_table)
 *   - post-processing: laser_assignment.js writes the laser bsid
 *   - everywhere the vector type is needed: type_bsid(bsid)
 *
 * USAGE:
 *   var LASER_BSID = require('../multi_laser/laser_bsid.js');
 *   let l_bsid = LASER_BSID.make_laser_bsid(500, 1);    // 2500
 *   let l_type = LASER_BSID.type_bsid(2500);            // 500
 *   let l_laser = LASER_BSID.laser_index_of(2500);      // 1
 *
 * DEPENDENCIES:
 *   Builtins: none (pure module, can be tested with Node.js)
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

/** Distance between the BSID ranges of two lasers (vector type bsids are < S_STRIDE). */
var S_STRIDE = 1000;
exports.STRIDE = S_STRIDE;

/**
 * BSID of a vector type on one laser.
 * @param {number} a_type_bsid    Vector type bsid (0 .. 999)
 * @param {number} a_laser_index  Laser, 0-based
 * @return {number} Laser bsid, e.g. (500, 1) -> 2500
 */
exports.make_laser_bsid = function(a_type_bsid, a_laser_index)
{
  return (a_laser_index + 1) * S_STRIDE + exports.type_bsid(a_type_bsid);
};

/**
 * Vector type of a bsid (plain or laser bsid).
 * @param {number} a_bsid  e.g. 2500 or 500
 * @return {number} Vector type bsid, e.g. 500
 */
exports.type_bsid = function(a_bsid)
{
  return (a_bsid >= S_STRIDE) ? (a_bsid % S_STRIDE) : a_bsid;
};

/**
 * Laser of a laser bsid.
 * @param {number} a_bsid  e.g. 2500
 * @return {number|undefined} 0-based laser index, undefined for a plain vector type bsid
 */
exports.laser_index_of = function(a_bsid)
{
  if (a_bsid < S_STRIDE) return undefined;
  return Math.floor(a_bsid / S_STRIDE) - 1;
};

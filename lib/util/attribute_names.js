/************************************************************
 * MODULE NAME: attribute_names.js
 *
 * PURPOSE:
 *   Central list of all toolpath attribute names. Using these
 *   constants instead of string literals avoids typing errors
 *   (a misspelled attribute name is silently ignored by the host).
 *
 * BACKGROUND:
 *   An attribute is a named value (integer or real number) that is
 *   stored at a path (polyline or hatch block) or at a single point of
 *   it. Attributes carry everything the later steps need to know about
 *   a path: which laser parameter set (BSID) to use, which laser of a
 *   multi-laser machine exposes it, to which island it belongs, ...
 *   The export reads them to write the machine file, the sorter reads
 *   them to compute the exposure order, the preview uses them for
 *   colors.
 *   MPBF background: The BSID (build style ID) tells the machine which
 *   laser parameter set (power in W, speed in mm/s, focus in mm) to
 *   use for a path, for example one ID for contours and one for hatches.
 *
 * WORKFLOW:
 *   declareBuildAttributes declares the names, makeExposureLayer
 *   writes them, post-processing and export read them.
 *
 * USAGE:
 *   var ATTR = require('../util/attribute_names.js').ATTR;
 *   a_hatch.setAttributeInt(ATTR.BSID, 500);
 *
 * DEPENDENCIES:
 *   Builtins: none (pure module, can be tested with Node.js)
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Tip: Every attribute that is not predefined (names
 *   starting with '_') must be declared in declareBuildAttributes,
 *   otherwise the host ignores it without an error message.
 *   Why declare? The declaration tells the host the name and the type
 *   (int or real) of every custom attribute before any path is created.
 *   The prefix 'oss_' marks the attributes that are specific to this
 *   project (island id and island bounding box).
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

// Tip: Object.freeze makes the object read-only. In strict
// mode an accidental assignment like ATTR.BSID = 'x' throws an error
// instead of changing the name. Careful: reading a name that does not
// exist (typo ATTR.BISD) gives undefined without an error.
exports.ATTR = Object.freeze({
  BSID: 'bsid',                 // int, vector type id
  LASER_INDEX: 'laser_index',   // int, 0-based laser index
  POWER: 'power',               // real, block power AND per-edge point attribute
  SPEED: 'speed',               // real, scan speed in mm/s
  FOCUS: 'focus',               // real, focus offset in mm
  ISLAND_ID: 'oss_islid',       // int, 1-based island counter per layer and model, 0 = no island
  ISL_MIN_X: 'oss_isl_min_x',   // real, island bounding box (used for sorting)
  ISL_MIN_Y: 'oss_isl_min_y',
  ISL_MAX_X: 'oss_isl_max_x',
  ISL_MAX_Y: 'oss_isl_max_y',
  DISP_COLOR: '_disp_color',    // predefined, do NOT declare (preview color)
  PROCESSING_ORDER: '_processing_order' // predefined, do NOT declare (exposure order)
});

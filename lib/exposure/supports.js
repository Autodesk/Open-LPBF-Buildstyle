/************************************************************
 * MODULE NAME: supports.js
 *
 * PURPOSE:
 *   Create the exposure vectors of wall supports (open polylines).
 *
 * WORKFLOW:
 *   Called from makeExposureLayer for every open support polyline.
 *
 * USAGE:
 *   var SUPPORTS = require('../exposure/supports.js');
 *   let l_hatch = SUPPORTS.make_wall_support_hatch(l_polyline_iterator);
 *
 * DEPENDENCIES:
 *   Builtins: bsHatch, bsModel, vec2
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *
 * BACKGROUND:
 *   MPBF background: Supports are extra structures below overhangs.
 *   They hold the overhang in place, conduct heat into the build plate
 *   and resist the warping caused by residual stress. They are removed
 *   after the build, so they should be strong enough but easy to break
 *   off and use little material and time.
 *   - Wall supports are thin walls. In a layer they arrive as open
 *     polylines (lines with a start and an end, no area). Each line is
 *     melted with a single laser track, i.e. the wall is one melt track
 *     wide.
 *   - Solid supports are areas (islands) and are hatched like part
 *     areas (see makeExposureLayer, BSID support_solid).
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HATCH = requireBuiltin('bsHatch');
var MODEL = requireBuiltin('bsModel');
var VEC2 = requireBuiltin('vec2');

/**
 * Wall support vectors of one open polyline.
 * The polylines are connected, collinear pieces are merged and the
 * blocks are sorted to keep the jumps short.
 * WHY: support polylines often consist of many short pieces and
 * points. Exposing them piece by piece would cause many laser on/off
 * switches and many jumps. The three steps below reduce both.
 * Note: each call handles one polyline only, so the sorting below does
 * not optimize the jumps between different support polylines.
 * @param {bsPolylineIterator} a_poly_it  Iterator pointing to the support polyline
 * @return {bsHatch} New hatch with model subtype "support"
 */
exports.make_wall_support_hatch = function(a_poly_it)
{
  let r_hatch = new HATCH.bsHatch();
  a_poly_it.polylineToHatch(r_hatch);
  if (r_hatch.isEmpty()) return r_hatch;

  // Connect polylines to longer polylines and reduce the number of points.
  // All distances in mm: end points closer than 0.001 mm (1 micrometer)
  // are treated as the same point. Self connect: a polyline whose start
  // and end meet is closed. Point reduction removes points that deviate
  // less than 0.001 mm from a straight line; the negative edge length
  // limit (-1) means that no edges are removed because of their length.
  r_hatch.connectHatchBlocks({
    bEnableSelfConnect: true,
    fSelfConnectMaxDist: 0.001,
    fMaxConnectDist: 0.001,
    fPointReductionDeviationTol: 0.001,
    fPointReductionEdgeLengthLimit: -1.0
  });

  // Reduce the number of direction changes.
  // Segments within 0.02 mm of one straight line count as collinear and
  // go into the same block, also across gaps of up to 4 mm (the laser
  // skips the gap). bFlipLines: segments that point the other way are
  // flipped, so the whole line is exposed in one direction.
  r_hatch.mergeCollinearLines({
    fCollinearTol: 0.02,
    fMaxSkipDist: 4.0,
    bFlipLines: true
  });

  // Reduce the jump length (blocks may be flipped).
  // The first block is the one near the platform origin (0, 0); then the
  // next block is chosen to keep the jumps short.
  r_hatch.sortHatchBlocksForMinJumpLength({
    startPos: new VEC2.Vec2(0.0, 0.0),
    bFlip: true
  });

  // The model subtype marks the vectors as support (not part), e.g. for
  // the preview, the sorting and the export.
  r_hatch.setModelSubtype(MODEL.nSubtypeSupport);
  return r_hatch;
};

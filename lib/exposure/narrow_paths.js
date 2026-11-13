/************************************************************
 * MODULE NAME: narrow_paths.js
 *
 * PURPOSE:
 *   Create "blocked paths": center lines of regions that are too
 *   narrow for the compensated border. Without them, thin walls
 *   and small tips would not be exposed at all.
 *
 * WORKFLOW:
 *   Called from makeExposureLayer together with the first border.
 *
 * USAGE:
 *   var NARROW = require('../exposure/narrow_paths.js');
 *   let l_hatch = NARROW.create_blocked_paths(a_island, 0.06, 0.02);
 *
 * DEPENDENCIES:
 *   Builtins: bsHatch
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *
 * BACKGROUND:
 *   The first border runs at the beam compensation distance b inside
 *   the outline (see contours.js). A wall that is thinner than 2 * b
 *   has no room for this offset path: the inward offset makes it
 *   vanish, so neither border nor hatch would melt it. Example: with
 *   b = 0.06 mm, every wall thinner than 0.12 mm (and every sharp tip
 *   where the walls come closer than that) would be missing.
 *   The fix is a single open line along the middle of such a region
 *   (its "center line"): one melt track roughly fills the thin wall.
 *   - Narrow bridge  : a thin connection between two wider areas.
 *   - Narrow appendix: a thin dead end, e.g. the tip of a sharp corner
 *     or a thin fin that sticks out of the part.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HATCH = requireBuiltin('bsHatch');

/**
 * Blocked paths of an island.
 * - Narrow bridges: regions that vanish completely with the given offset.
 * - Narrow appendices: tips that vanish with the offset; the trim
 *   length 1.2 * beam compensation shortens them so that they do not
 *   run into the compensated border.
 * WHY the trim: the appendix line ends where the first border is still
 * present. If the line ran into the border, both tracks would overlap
 * there and that spot would get extra energy. The value is the offset
 * used for the outer end points of the appendix line; 1.2 * b is 20 %
 * more than the border offset itself, i.e. a small safety distance.
 * @param {bsIsland} a_island     Island (not modified)
 * @param {number} a_beam_comp    Beam compensation in mm (> 0)
 * @param {number} a_min_length   Shorter lines are deleted (0 = keep all), in mm
 * @return {bsHatch} Open polylines
 */
exports.create_blocked_paths = function(a_island, a_beam_comp, a_min_length)
{
  // Both builtins clear their result hatch before they write into it, so
  // each one gets its own hatch; the appendix lines are then appended to
  // the bridge lines (moveDataFrom empties the source hatch). The offset
  // is negative because the border offset goes inwards.
  let r_hatch = new HATCH.bsHatch();
  let l_appendix_hatch = new HATCH.bsHatch();
  a_island.createNarrowBridgePolylines(r_hatch, -a_beam_comp);
  a_island.createNarrowAppendixPolylines(l_appendix_hatch, -a_beam_comp, 1.2 * a_beam_comp);
  r_hatch.moveDataFrom(l_appendix_hatch);
  // Tiny pieces (e.g. from small notches in the outline) are not worth
  // a separate exposure; they would only add jumps and laser on/off.
  if (a_min_length > 0)
  {
    r_hatch.deleteShortLines(a_min_length);
  }
  return r_hatch;
};

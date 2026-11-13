/************************************************************
 * MODULE NAME: hatch_options.js
 *
 * PURPOSE:
 *   Build the option object for island.hatchExt2() from a HATCH
 *   configuration and hatch one area with it.
 *
 * WORKFLOW:
 *   Used by hatch_patterns.js (all patterns) and by
 *   stripe_block_sort.js (hatching of single stripes).
 *   It is a separate module so that both can use it without
 *   requiring each other.
 *
 * USAGE:
 *   var HATCH_OPTIONS = require('./hatch_options.js');
 *   let l_hatch = HATCH_OPTIONS.hatch_island(l_area, l_hatch_cfg, 67.0, l_gas_dir);
 *
 * DEPENDENCIES:
 *   Builtins: bsHatch, vec2
 *   Modules : ../geometry/gas_flow.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Important: hatchExt2 raises an error for unknown option keys.
 *   Only the keys listed below are supported by all host versions
 *   this project is written for.
 *
 * BACKGROUND:
 *   - Hatching = filling an area with parallel straight lines (hatch
 *     lines / hatch vectors). Each line is one laser scan.
 *   - Hatch distance (hatch spacing) = distance between two neighboring
 *     lines in mm, typically 0.08 to 0.12 mm. It is smaller than the
 *     melt track width, so neighboring tracks overlap and melt together
 *     without gaps of unmelted powder.
 *   - Hatch angle in degrees: hatchExt2 creates lines parallel to the
 *     Y axis for 0 degrees; other values rotate the lines.
 *   - A hatch block is a group of consecutive lines that is exposed as
 *     one unit. With block sort, the lines are grouped into blocks
 *     (e.g. the two sides around a hole) and the blocks are ordered.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HATCH = requireBuiltin('bsHatch');
var VEC2 = requireBuiltin('vec2');
var GAS_FLOW = require('../geometry/gas_flow.js');

/**
 * Option object for hatchExt2.
 * - Alternating: every second line is exposed in the opposite direction
 *   (no jump back to the start side).
 * - Fixed zero origin: the hatch lines of neighboring islands are aligned
 *   on the same grid, so overlaps between areas look clean.
 * - Block sort (optional): lines are grouped into blocks that are
 *   exposed against the gas flow direction.
 * WHY alternating: without it the laser would have to jump back over
 *   the whole area after every line, which costs time.
 * WHY fixed zero origin: the line positions are computed from the
 *   platform origin (0, 0) and not from the corner of each area. Two
 *   areas that touch (e.g. volume and downskin hatch of the same island)
 *   then continue the same line grid instead of starting with a random
 *   shift, which could leave a double line or a too-wide gap at the seam.
 * @param {Object} a_cfg      HATCH object (hatch_distance, sorting)
 *        hatch_distance in mm; sorting: {optimized, run_ahead_limit,
 *        min_block_segments, max_merge_distance}, 0 = host default
 * @param {number} a_angle    Hatch line angle in degrees
 * @param {{x:number, y:number}} a_gas_dir  Gas flow direction (unit vector)
 * @return {Object} Options for hatchExt2
 */
exports.build_hatch_ext2_options = function(a_cfg, a_angle, a_gas_dir)
{
  // Flags are bits; '|' (bitwise OR) combines several flags into one number.
  let l_flags = HATCH.nHatchFlagAlternating | HATCH.nHatchFlagFixedZeroOrigin;
  if (a_cfg.sorting.optimized)
  {
    // Enhanced block sort: avoids leaving unfilled areas behind for too
    // long when the hatching runs around one side of a hole.
    l_flags = l_flags | HATCH.nHatchFlagBlocksortEnhanced;
  }

  // fHatchDensity: the builtin calls the hatch distance (mm) "density".
  // nCycles: 1 = all lines of an area in one hatch block sequence (no
  //   split into interleaved cycles with every second line).
  // fCollinearBorderSnapTol: hatch lines that lie within this tolerance
  //   of a border segment with the same direction are snapped onto it
  //   (tolerance = 1/10 of the hatch distance).
  // hatchOrigin: only used with nHatchFlagFixedOrigin (not set here);
  //   FixedZeroOrigin always uses (0, 0). Passed for clarity.
  let r_opts = {
    fHatchDensity: a_cfg.hatch_distance,
    fHatchAngle: a_angle,
    nCycles: 1,
    fCollinearBorderSnapTol: a_cfg.hatch_distance / 10.0,
    hatchOrigin: new VEC2.Vec2(0.0, 0.0),
    nFlags: l_flags
  };

  if (a_cfg.sorting.optimized)
  {
    // Blocks move against the gas flow: downstream blocks are exposed first.
    // MPBF background: the spatter and fume of the running exposure are
    // blown downstream onto blocks that are already finished, not onto
    // powder that is still to be melted (see gas_flow.js).
    let l_v = GAS_FLOW.against_flow(a_gas_dir);
    r_opts.blocksortVec = new VEC2.Vec2(l_v.x, l_v.y);
    // 0 = keep the default of the host.
    // Only set keys are passed, so the host defaults stay in effect otherwise:
    // - run ahead limit (mm): how far the hatching front may run ahead of
    //   areas that were left behind (e.g. on the other side of a hole),
    // - min block segments: blocks with fewer lines are merged into a
    //   neighboring block (avoids many tiny blocks and jumps),
    // - max merge distance (mm): neighboring blocks are only merged if
    //   they are closer than this.
    if (a_cfg.sorting.run_ahead_limit > 0) r_opts.fBlocksortRunAheadLimit = a_cfg.sorting.run_ahead_limit;
    if (a_cfg.sorting.min_block_segments > 0) r_opts.nMinBlockSegmentCount = a_cfg.sorting.min_block_segments;
    if (a_cfg.sorting.max_merge_distance > 0) r_opts.fMaxBlockMergeDistance = a_cfg.sorting.max_merge_distance;
  }
  return r_opts;
};

/**
 * Hatch one area into a new hatch.
 * @param {bsIsland} a_isl    Area (not modified); may contain several regions
 * @param {Object} a_cfg      HATCH object
 * @param {number} a_angle    Hatch line angle in degrees
 * @param {{x:number, y:number}} a_gas_dir  Gas flow direction (unit vector)
 * @return {bsHatch} New hatch (empty if the area is empty)
 */
exports.hatch_island = function(a_isl, a_cfg, a_angle, a_gas_dir)
{
  let r_hatch = new HATCH.bsHatch();
  if (a_isl.isEmpty()) return r_hatch;
  a_isl.hatchExt2(r_hatch, exports.build_hatch_ext2_options(a_cfg, a_angle, a_gas_dir));
  return r_hatch;
};

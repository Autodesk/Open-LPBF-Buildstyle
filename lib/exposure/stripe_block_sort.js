/************************************************************
 * MODULE NAME: stripe_block_sort.js
 *
 * PURPOSE:
 *   Improved exposure order for the stripe pattern:
 *   1. stripes are identified by their stripe index (not by their
 *      position in the cell list),
 *   2. stripes are exposed downstream first (gas flow),
 *   3. inside a stripe the hatch blocks are chained with a
 *      nearest-neighbor search to avoid long jumps back,
 *   4. the scan direction of the blocks is never changed by the
 *      chaining: without the option every stripe keeps the direction
 *      against the gas flow chosen by the block sort,
 *   5. optional boustrophedon order over the stripes
 *      ("alternate stripe direction"): every second stripe is reversed.
 *
 * WORKFLOW:
 *   Called by hatch_patterns.js for the pattern 'stripe' when the
 *   option "improved stripe sorting (script)" is active.
 *
 * USAGE:
 *   var STRIPE_SORT = require('./stripe_block_sort.js');
 *   let l_hatch = STRIPE_SORT.hatch_and_sort_stripes(l_stripes, l_cfg, l_angle, l_gas_dir);
 *
 * DEPENDENCIES:
 *   Builtins: bsHatch
 *   Modules : ./hatch_options.js, ../geometry/gas_flow.js,
 *             ../util/math_utils.js, ../util/log.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Complexity: O(B^2) per stripe (B = blocks of one stripe, usually
 *   small). For very many blocks a spatial search tree
 *   (bsBoundingTree2D) could be used for the neighbor search.
 *   Tip: The final processing order inside one island and
 *   vector type is kept by the post-processing sorter, because it
 *   sorts stably.
 *
 * BACKGROUND:
 *   - One stripe may be cut into several pieces ("cells") by holes or
 *     by the island shape. All cells with the same stripe index belong
 *     to the same stripe and are exposed together.
 *   - A hatch block is a group of hatch lines that the laser exposes in
 *     one go (with alternating line direction). Between blocks the
 *     laser jumps with the beam switched off.
 *   - MPBF background: The stripes are exposed downstream first, so the
 *     fume and spatter of the current stripe are blown onto stripes
 *     that are already finished (see gas_flow.js). Short jumps between
 *     blocks save time and keep the heat input local and regular.
 *   - "Boustrophedon" (Greek: "as the ox turns while plowing"): every
 *     second stripe is exposed in the opposite direction, so the laser
 *     continues near where the previous stripe ended.
 *   - The trade-off: keeping every stripe against the gas flow costs a
 *     jump back to the start side after each stripe; alternating saves
 *     these jumps, but every second stripe then runs with the gas flow.
 *     That is why the direction is a user option and is not changed
 *     silently to shorten a jump.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HATCH = requireBuiltin('bsHatch');
var HATCH_OPTIONS = require('./hatch_options.js');
var GAS_FLOW = require('../geometry/gas_flow.js');
var MATH = require('../util/math_utils.js');
var LOG = require('../util/log.js');

/**
 * Fallback: hatch all stripes at once (order is then defined by the host).
 * The warning is printed only once per script context (warning_once),
 * because this function may be called for every stripe area.
 * @param {bsIsland} a_stripes  Stripes created by createStripes
 * @param {Object} a_cfg        HATCH object
 * @param {number} a_angle      Hatch angle in degrees
 * @param {{x:number, y:number}} a_gas_dir  Gas flow direction
 * @param {string} a_reason     Text for the warning
 * @return {bsHatch}
 */
function hatch_all_stripes(a_stripes, a_cfg, a_angle, a_gas_dir, a_reason)
{
  LOG.warning_once('stripe_sort_fallback',
    'Improved stripe sorting is not available (' + a_reason + '). Standard stripe hatching is used.');
  return HATCH_OPTIONS.hatch_island(a_stripes, a_cfg, a_angle, a_gas_dir);
}

/**
 * Comparison of stripe groups: downstream first, then stripe index.
 * Tip: Array.sort calls this function with two elements. A
 * negative result puts a_a first, a positive result puts a_b first.
 * The stripe index is the tie breaker, so groups with equal keys
 * always get the same order (deterministic result).
 */
function compare_stripe_groups(a_a, a_b)
{
  if (a_a.stripe_key !== a_b.stripe_key) return a_a.stripe_key - a_b.stripe_key;
  return a_a.key - a_b.key;
}

/**
 * Group stripe cells by their stripe index (nPatternX).
 * getPatternInfo() returns the position of a cell in the stripe
 * pattern; nPatternX is the stripe number. If the host does not
 * provide this information, the caller falls back to the standard
 * hatching (return value undefined).
 * Tip: A Map stores key -> value pairs (here: stripe index ->
 * list of cells) and keeps the order in which the keys were added.
 * @param {bsIsland[]} a_cells  Stripe cells
 * @return {Object[]|undefined} Groups { key, cells[] } or undefined if the pattern info is missing
 */
function group_cells_by_stripe(a_cells)
{
  let l_map = new Map();
  for (let i = 0; i < a_cells.length; ++i)
  {
    let l_cell = a_cells[i];
    // Defensive checks: older hosts may not offer getPatternInfo.
    if (typeof l_cell.getPatternInfo !== 'function') return undefined;
    let l_info = l_cell.getPatternInfo();
    if (!l_info || (typeof l_info.nPatternX !== 'number')) return undefined;
    let l_key = l_info.nPatternX;
    if (!l_map.has(l_key)) l_map.set(l_key, []);
    l_map.get(l_key).push(l_cell);
  }
  // Convert the Map into a plain array that can be sorted.
  let r_groups = [];
  let l_keys = Array.from(l_map.keys());
  for (let i = 0; i < l_keys.length; ++i)
  {
    r_groups.push({ key: l_keys[i], cells: l_map.get(l_keys[i]) });
  }
  return r_groups;
}

/**
 * Sort key of a stripe group: downstream key of the mean center of its cells.
 * The center of each cell is the center of its bounding box; the mean
 * of all cells is a cheap approximation of the stripe position.
 * @param {Object} a_group  { key, cells[] } (stripe_key is added)
 * @param {{x:number, y:number}} a_gas_dir
 * @return {void}
 */
function compute_stripe_key(a_group, a_gas_dir)
{
  let l_sx = 0.0;
  let l_sy = 0.0;
  for (let i = 0; i < a_group.cells.length; ++i)
  {
    let l_b = a_group.cells[i].getBounds();
    l_sx += 0.5 * (l_b.minX + l_b.maxX);
    l_sy += 0.5 * (l_b.minY + l_b.maxY);
  }
  // Math.max(1, ...) avoids a division by zero (a group always has at
  // least one cell, this is only a safety net).
  let l_n = Math.max(1, a_group.cells.length);
  a_group.stripe_key = GAS_FLOW.downstream_key(l_sx / l_n, l_sy / l_n, a_gas_dir);
}

/**
 * Hatch all cells of one stripe and collect the hatch blocks.
 * Each cell is hatched on its own (with the same angle and options as
 * the standard stripe hatching), so its blocks can be reordered freely.
 * Blocks with fewer than 2 points contain no line and are skipped.
 * @param {Object} a_group  { key, cells[] }
 * @param {Object} a_cfg    HATCH object
 * @param {number} a_angle  Hatch angle in degrees
 * @param {{x:number, y:number}} a_gas_dir
 * @return {bsHatchBlock[]} Blocks with at least 2 points
 */
function collect_stripe_blocks(a_group, a_cfg, a_angle, a_gas_dir)
{
  let r_blocks = [];
  for (let i = 0; i < a_group.cells.length; ++i)
  {
    let l_hatch = HATCH_OPTIONS.hatch_island(a_group.cells[i], a_cfg, a_angle, a_gas_dir);
    if (l_hatch.isEmpty()) continue;
    let l_blocks = l_hatch.getHatchBlockArray();
    for (let k = 0; k < l_blocks.length; ++k)
    {
      if (l_blocks[k].getPointCount() >= 2) r_blocks.push(l_blocks[k]);
    }
  }
  return r_blocks;
}

/**
 * Chain the blocks of one stripe with a greedy nearest-neighbor search.
 * HOW: start with the block that begins furthest downstream (only for
 * the very first block of the area), then repeatedly take the remaining
 * block whose start point is closest to the current laser position.
 * "Greedy" means: always take the best next step; this is not
 * guaranteed to give the shortest total path, but it is simple and
 * usually good.
 * The blocks are only reordered, never reversed: their scan direction
 * was already decided by the caller (gas flow or alternation).
 * @param {bsHatchBlock[]} a_blocks  Blocks (not modified)
 * @param {{x:number, y:number}|undefined} a_prev_end  End point of the previous block
 *        (undefined for the first stripe of the area)
 * @param {{x:number, y:number}} a_gas_dir
 * @return {{order:bsHatchBlock[], last_end:({x:number, y:number}|undefined)}}
 */
function chain_blocks(a_blocks, a_prev_end, a_gas_dir)
{
  // slice() copies the array, so removing elements below does not
  // change the array of the caller.
  let l_remaining = a_blocks.slice();
  let l_order = [];
  let l_prev_end = a_prev_end;

  while (l_remaining.length > 0)
  {
    let l_best = 0;

    if (typeof l_prev_end === 'undefined')
    {
      // First block of all: the one that starts furthest downstream.
      let l_best_key = Infinity;
      for (let i = 0; i < l_remaining.length; ++i)
      {
        let l_p = l_remaining[i].getPoint(0);
        let l_key = GAS_FLOW.downstream_key(l_p.x, l_p.y, a_gas_dir);
        if (l_key < l_best_key) { l_best_key = l_key; l_best = i; }
      }
    }
    else
    {
      // Distance from the current laser position to the start point of
      // each remaining block; the block with the closest start wins.
      // Only the start point counts, because the block is exposed from
      // its start (a block whose end is close would need a reversal,
      // which would change the scan direction).
      let l_best_dist = Infinity;
      for (let i = 0; i < l_remaining.length; ++i)
      {
        let l_first = l_remaining[i].getPoint(0);
        let l_d = MATH.dist(l_prev_end.x, l_prev_end.y, l_first.x, l_first.y);
        if (l_d < l_best_dist)
        {
          l_best_dist = l_d;
          l_best = i;
        }
      }
    }

    // splice(index, 1) removes the chosen block from the remaining list.
    let l_chosen = l_remaining[l_best];
    l_remaining.splice(l_best, 1);
    l_order.push(l_chosen);
    // The new laser position is the end point of the chosen block.
    l_prev_end = l_chosen.getPoint(l_chosen.getPointCount() - 1);
  }
  return { order: l_order, last_end: l_prev_end };
}

/**
 * Hatch stripes and return the blocks in the final exposure order.
 * Never throws: on any problem the standard stripe hatching is used.
 * Steps: group cells by stripe -> sort stripes downstream first ->
 * hatch each stripe -> chain its blocks -> optionally reverse every
 * second stripe -> append all blocks to one result hatch.
 * @param {bsIsland} a_stripes  Stripes created by createStripes
 * @param {Object} a_cfg        HATCH object
 * @param {number} a_angle      Hatch angle in degrees
 * @param {{x:number, y:number}} a_gas_dir  Gas flow direction
 * @return {bsHatch} Hatch in the final exposure order
 */
exports.hatch_and_sort_stripes = function(a_stripes, a_cfg, a_angle, a_gas_dir)
{
  try
  {
    if (a_stripes.isEmpty()) return new HATCH.bsHatch();

    let l_groups = group_cells_by_stripe(a_stripes.getIslandArray());
    if (!l_groups)
    {
      return hatch_all_stripes(a_stripes, a_cfg, a_angle, a_gas_dir, 'no stripe index');
    }

    for (let i = 0; i < l_groups.length; ++i)
    {
      compute_stripe_key(l_groups[i], a_gas_dir);
    }
    l_groups.sort(compare_stripe_groups);

    let r_hatch = new HATCH.bsHatch();
    // The laser end position is carried over from stripe to stripe, so
    // the first block of the next stripe is the one closest to it.
    let l_prev_end = undefined;
    // Counts only stripes that really get exposed, so that the
    // boustrophedon alternation is not disturbed by empty stripes.
    let l_exposed_stripes = 0;
    for (let g = 0; g < l_groups.length; ++g)
    {
      let l_blocks = collect_stripe_blocks(l_groups[g], a_cfg, a_angle, a_gas_dir);
      if (l_blocks.length === 0) continue;

      // Boustrophedon: every second exposed stripe runs backwards.
      // The blocks are reversed BEFORE they are chained, so the
      // nearest-neighbor chaining starts next to where the previous
      // stripe ended (no long jump back to the far end of the stripe).
      // Without the option every stripe keeps the direction against
      // the gas flow from the block sort.
      if ((a_cfg.stripe.alternate === true) && ((l_exposed_stripes % 2) === 1))
      {
        for (let k = 0; k < l_blocks.length; ++k)
        {
          l_blocks[k].flip();
        }
      }

      let l_chain = chain_blocks(l_blocks, l_prev_end, a_gas_dir);
      l_prev_end = l_chain.last_end;
      for (let k = 0; k < l_chain.order.length; ++k)
      {
        r_hatch.addHatchBlock(l_chain.order[k]);
      }
      ++l_exposed_stripes;
    }
    return r_hatch;
  }
  catch (e)
  {
    // Any builtin error (e.g. an unexpected geometry) -> standard hatching.
    return hatch_all_stripes(a_stripes, a_cfg, a_angle, a_gas_dir, String(e && e.message ? e.message : e));
  }
};

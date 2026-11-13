/************************************************************
 * MODULE NAME: hatch_patterns.js
 *
 * PURPOSE:
 *   Fill an area with hatch vectors using one of the patterns
 *   meander, stripe, chess(board), hexagon or offset (concentric).
 *
 * WORKFLOW:
 *   Called from makeExposureLayer for every hatch area (volume,
 *   core, downskin, upskin, solid support).
 *
 * USAGE:
 *   var PATTERNS = require('../exposure/hatch_patterns.js');
 *   let l_res = PATTERNS.create_pattern_hatch(l_area, l_hatch_cfg, {
 *     line_angle: 67.0, gas_dir: { x: 1, y: 0 }, layer_index: 1, seed: 42,
 *     rotation: { rot: l_hatch_cfg.rotation, layer_index: 1, gas_angle: 0.0 } });
 *   if (l_res.ok) { ... l_res.hatch ... }
 *
 * DEPENDENCIES:
 *   Builtins: bsHatch, bsIsland, vec2
 *   Modules : ./hatch_options.js, ./stripe_block_sort.js,
 *             ./pattern_rotation.js, ../geometry/island_ops.js,
 *             ../util/math_utils.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   To add a pattern: add a 'case' in create_pattern_hatch and a
 *   function make_<pattern>_hatch below (plus parameters in
 *   param_factories.create_hatch_group and param_readers.read_hatch).
 *
 * BACKGROUND:
 *   MPBF background: Each laser line heats the metal to melting and
 *   it then cools down within milliseconds. The shrinking during
 *   cooling leaves residual stress in the part; it is largest along
 *   the scan direction and grows with the length of the scan vectors.
 *   Long vectors also let the previous line cool down more before the
 *   next one is placed beside it, so the melt pool varies across a big
 *   area. The patterns below differ in how they limit this:
 *   - meander: one set of parallel lines over the whole area (simple,
 *     few jumps, but long vectors on large areas),
 *   - stripe : the area is cut into stripes (default width 10 mm);
 *     the lines only run across one stripe, so they stay short,
 *   - chess  : square fields (default 5 mm); neighboring fields use
 *     line directions 90 degrees apart (short vectors in X and Y),
 *   - hexagon: hexagonal cells (default side 3 mm) in three groups
 *     with 0 / 60 / 120 degrees extra angle,
 *   - offset : concentric rings that follow the outline.
 *   Stripes, fields and cells overlap slightly (default 0.05 mm), so
 *   that the seams between them are melted completely.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HATCH = requireBuiltin('bsHatch');
var ISLAND = requireBuiltin('bsIsland');
var VEC2 = requireBuiltin('vec2');
var HATCH_OPTIONS = require('./hatch_options.js');
var STRIPE_SORT = require('./stripe_block_sort.js');
var ROTATION = require('./pattern_rotation.js');
var ISL = require('../geometry/island_ops.js');
var MATH = require('../util/math_utils.js');

/**
 * Safety limit for the concentric pattern (avoids endless loops).
 * Example: 10000 rings * 0.1 mm hatch distance = 1000 mm of offset,
 * more than half of any usual build plate, so in normal use the loop
 * ends earlier because the area is used up.
 */
var S_MAX_OFFSET_RINGS = 10000;

/**
 * Hatch angle for a pattern sub-group (e.g. odd chess fields).
 * Without a limitation window the extra angle is simply added. With an
 * active window the sub-groups also stay inside the window: the extra
 * angle is scaled to the window width (see 'Sub-groups' in
 * pattern_rotation.js), e.g. chess fields then differ by width / 2.
 * @param {Object} a_ctx     Context of create_pattern_hatch (uses a_ctx.rotation)
 * @param {number} a_extra   Extra angle in degrees
 * @return {number} Angle in degrees
 */
function angle_with_extra(a_ctx, a_extra)
{
  let l_r = a_ctx.rotation;
  return ROTATION.get_line_angle(l_r.rot, l_r.layer_index, l_r.gas_angle, a_extra);
}

/**
 * Group (0, 1, 2) of a hexagon cell. Neighboring cells always belong
 * to different groups; each group is hatched with its own angle.
 * HOW: along a row the group repeats every 3 cells (x mod 3); every
 * second row is shifted by 2 cells, so that the cells of the rows
 * above and below get other groups than their neighbors in this row.
 * MATH.mod is used instead of the % operator: % of JavaScript returns
 * negative values for negative numbers (-1 % 3 = -1), and Math.abs
 * would mirror the pattern at index 0. MATH.mod continues the regular
 * pattern for cells left of / below the pattern origin
 * (..., -2 -> 1, -1 -> 2, 0 -> 0, 1 -> 1, ...).
 * @param {number} a_x_index  Pattern index X of the cell
 * @param {number} a_y_index  Pattern index Y of the cell (row)
 * @return {number} 0, 1 or 2
 */
function get_hexagon_group(a_x_index, a_y_index)
{
  if (MATH.mod(a_y_index, 2) === 0)
  {
    return MATH.mod(a_x_index, 3);
  }
  return MATH.mod(a_x_index + 2, 3);
}

/**
 * Meander: parallel lines over the whole area.
 * "Meander" because the alternating line direction (see
 * hatch_options.js) makes the laser path snake back and forth.
 * @param {bsIsland} a_area  Area (not modified)
 * @param {Object} a_cfg     HATCH object
 * @param {Object} a_ctx     Context of create_pattern_hatch
 * @return {bsHatch} New hatch
 */
function make_meander_hatch(a_area, a_cfg, a_ctx)
{
  return HATCH_OPTIONS.hatch_island(a_area, a_cfg, a_ctx.line_angle, a_ctx.gas_dir);
}

/**
 * Stripes: the area is divided into stripes of a given width. The hatch
 * lines run across each stripe. createStripes and the hatching use the
 * SAME angle (same convention as the stripe example of the host).
 * (createStripes: 0 degrees = stripes parallel to X; hatchExt2:
 * 0 degrees = lines parallel to Y, i.e. across the stripe.)
 * The vector length is limited to about the stripe width; the stripe
 * direction rotates together with the hatch angle from layer to layer.
 * @param {bsIsland} a_area  Area (not modified)
 * @param {Object} a_cfg     HATCH object (uses a_cfg.stripe: width and
 *                           overlap in mm, script_sort, alternate)
 * @param {Object} a_ctx     Context of create_pattern_hatch
 * @return {bsHatch} New hatch
 */
function make_stripe_hatch(a_area, a_cfg, a_ctx)
{
  let l_width = a_cfg.stripe.width;
  let l_stripes = new ISLAND.bsIsland();
  // Arguments: result, width, minimum width, overlap, length (0 = endless), angle, reference point
  // Minimum width = 1/6 of the stripe width: narrower rest stripes at the
  // area border are merged into the neighboring stripe (no tiny stripes).
  // Reference point (0, 0): the stripe borders lie on a fixed grid of the
  // platform, so all islands of a layer share the same stripe layout.
  a_area.createStripes(l_stripes, l_width, l_width / 6.0, a_cfg.stripe.overlap, 0.0,
    a_ctx.line_angle, new VEC2.Vec2(0.0, 0.0));

  // Optional script sort (stripe_block_sort.js): stripes downstream first
  // and nearest-neighbor chaining of blocks. Otherwise the host orders
  // the blocks of all stripes.
  if (a_cfg.stripe.script_sort === true)
  {
    return STRIPE_SORT.hatch_and_sort_stripes(l_stripes, a_cfg, a_ctx.line_angle, a_ctx.gas_dir);
  }
  return HATCH_OPTIONS.hatch_island(l_stripes, a_cfg, a_ctx.line_angle, a_ctx.gas_dir);
}

/**
 * Chessboard: square fields; neighboring fields are hatched with
 * 90 degrees difference to distribute stresses more evenly.
 * MPBF background: Residual stress is higher along the scan direction.
 * If all fields had the same direction, the stress would add up along
 * one axis; alternating the direction field by field mixes the two
 * directions on a short length scale.
 * @param {bsIsland} a_area  Area (not modified)
 * @param {Object} a_cfg     HATCH object (uses a_cfg.chess: size and overlap in mm)
 * @param {Object} a_ctx     Context of create_pattern_hatch
 * @return {bsHatch} New hatch (even fields first, then odd fields)
 */
function make_chess_hatch(a_area, a_cfg, a_ctx)
{
  let l_size = a_cfg.chess.size;
  let l_ov = a_cfg.chess.overlap;
  let l_fields = new ISLAND.bsIsland();
  // fShift 0: no row offset (a real chessboard, not a brick pattern).
  // fMinArea = 1 % of a full field: smaller rest pieces at the area
  // border are merged into adjacent fields.
  // The field grid is rotated with the hatch angle around (0, 0).
  a_area.createRectangles(l_fields, {
    fRectSizeX: l_size, fRectSizeY: l_size,
    fOverlapX: l_ov, fOverlapY: l_ov,
    fShift: 0.0,
    fAngle: a_ctx.line_angle,
    fMinArea: l_size * l_size / 100.0,
    Origin: new VEC2.Vec2(0.0, 0.0)
  });

  // Split into the "black" and "white" fields of the chessboard.
  let l_odd = new ISLAND.bsIsland();
  let l_even = new ISLAND.bsIsland();
  l_fields.splitCheckerboard(l_odd, l_even);

  let r_hatch = HATCH_OPTIONS.hatch_island(l_even, a_cfg, a_ctx.line_angle, a_ctx.gas_dir);
  let l_odd_hatch = HATCH_OPTIONS.hatch_island(l_odd, a_cfg, angle_with_extra(a_ctx, 90.0), a_ctx.gas_dir);
  // moveDataFrom appends the blocks (the source hatch is emptied).
  r_hatch.moveDataFrom(l_odd_hatch);
  return r_hatch;
}

/**
 * Hexagons: hexagonal cells in three groups, each group with an angle
 * offset of 0, 60 or 120 degrees.
 * Three groups are needed because in a hexagon grid three cells meet
 * at each corner; with three directions no two touching cells share
 * the same line direction (idea as for the chessboard, but with
 * three evenly spread directions 60 degrees apart).
 * @param {bsIsland} a_area  Area (not modified)
 * @param {Object} a_cfg     HATCH object (uses a_cfg.hexagon: side and overlap in mm)
 * @param {Object} a_ctx     Context of create_pattern_hatch
 * @return {bsHatch} New hatch (group 0, then 1, then 2)
 */
function make_hexagon_hatch(a_area, a_cfg, a_ctx)
{
  let l_side = a_cfg.hexagon.side;
  let l_cells_isl = new ISLAND.bsIsland();
  // fMinArea = side^2 / 100: tiny rest cells at the border are merged
  // into adjacent cells.
  a_area.createHexagons(l_cells_isl, {
    fSideLength: l_side,
    fOverlap: a_cfg.hexagon.overlap,
    fAngle: a_ctx.line_angle,
    Origin: new VEC2.Vec2(0.0, 0.0),
    fMinArea: l_side * l_side / 100.0
  });

  // Sort every cell into its group with the pattern position (X, Y index)
  // that createHexagons stored in the cell.
  let l_groups = [new ISLAND.bsIsland(), new ISLAND.bsIsland(), new ISLAND.bsIsland()];
  let l_cells = l_cells_isl.getIslandArray();
  for (let i = 0; i < l_cells.length; ++i)
  {
    let l_info = l_cells[i].getPatternInfo();
    let l_group = get_hexagon_group(l_info.nPatternX, l_info.nPatternY);
    l_groups[l_group].addIslands(l_cells[i]);
  }

  let r_hatch = new HATCH.bsHatch();
  for (let g = 0; g < l_groups.length; ++g)
  {
    // Group 0 uses the main angle, groups 1 and 2 add 60 / 120 degrees.
    let l_angle = (g === 0) ? a_ctx.line_angle : angle_with_extra(a_ctx, g * 60.0);
    let l_group_hatch = HATCH_OPTIONS.hatch_island(l_groups[g], a_cfg, l_angle, a_ctx.gas_dir);
    r_hatch.moveDataFrom(l_group_hatch);
  }
  return r_hatch;
}

/**
 * Offset (concentric): rings parallel to the outline with the hatch
 * distance. The direction alternates from ring to ring, which
 * distributes the heat more evenly.
 * The rings follow the shape, so there are no line ends at the border
 * (good for small or thin areas); the order can be outside-in or
 * inside-out (a_cfg.offset.inside_out).
 * @param {bsIsland} a_area  Area (not modified)
 * @param {Object} a_cfg     HATCH object (hatch_distance in mm, offset.inside_out)
 * @return {bsHatch} New hatch with closed rings
 */
function make_offset_hatch(a_area, a_cfg)
{
  let l_d = a_cfg.hatch_distance;
  let l_rings = [];
  for (let k = 0; k < S_MAX_OFFSET_RINGS; ++k)
  {
    // The first ring lies half a hatch distance inside the area border.
    // Ring k lies at 0.5 * d + k * d, so neighboring rings are d apart.
    // Every ring is computed from the original area (no error build-up).
    let l_ring_isl = ISL.offset(a_area, -(0.5 * l_d + k * l_d));
    if (l_ring_isl.isEmpty()) break;
    let l_ring_hatch = new HATCH.bsHatch();
    l_ring_isl.borderToHatch(l_ring_hatch);
    if ((k % 2) === 1) l_ring_hatch.flip(false, true);
    l_rings.push(l_ring_hatch);
  }

  // The rings were collected from outside to inside; inside_out reverses
  // the exposure order (innermost ring first).
  let r_hatch = new HATCH.bsHatch();
  if (a_cfg.offset.inside_out === true)
  {
    for (let i = l_rings.length - 1; i >= 0; --i) r_hatch.moveDataFrom(l_rings[i]);
  }
  else
  {
    for (let i = 0; i < l_rings.length; ++i) r_hatch.moveDataFrom(l_rings[i]);
  }
  return r_hatch;
}

/**
 * Hatch an area with the configured pattern.
 * Never throws: errors are returned as { ok:false, message }, so one
 * problematic island does not abort the whole layer.
 * Tip: An uncaught exception in makeExposureLayer would stop
 * the calculation of the layer. With the {ok, message} result the
 * caller can log a warning and continue with the next area.
 * @param {bsIsland} a_area  Area (not modified)
 * @param {Object} a_cfg     HATCH object
 * @param {{line_angle:number, gas_dir:{x:number, y:number}, layer_index:number, seed:number,
 *          rotation:{rot:Object, layer_index:number, gas_angle:number}}} a_ctx
 *        line_angle: hatch angle of this layer in degrees (pattern_rotation.js),
 *        gas_dir: gas flow unit vector, layer_index: 0-based layer index of the part,
 *        seed: random seed of this area,
 *        rotation is used to compute sub-group angles (chess, hexagon)
 * @return {{ok:boolean, hatch:(bsHatch|undefined), message:string}}
 */
exports.create_pattern_hatch = function(a_area, a_cfg, a_ctx)
{
  if (a_area.isEmpty())
  {
    return { ok: true, hatch: new HATCH.bsHatch(), message: '' };
  }

  let l_hatch;
  try
  {
    switch (a_cfg.pattern)
    {
      case 'meander': l_hatch = make_meander_hatch(a_area, a_cfg, a_ctx); break;
      case 'stripe':  l_hatch = make_stripe_hatch(a_area, a_cfg, a_ctx); break;
      case 'chess':   l_hatch = make_chess_hatch(a_area, a_cfg, a_ctx); break;
      case 'hexagon': l_hatch = make_hexagon_hatch(a_area, a_cfg, a_ctx); break;
      case 'offset':  l_hatch = make_offset_hatch(a_area, a_cfg); break;
      default:
        return { ok: false, hatch: undefined, message: 'Unknown hatch pattern: ' + a_cfg.pattern };
    }
    // Very short vectors are removed: the laser needs some distance to
    // reach a stable melt pool, and tiny vectors mostly add jump time.
    // Inside the try block: this is a builtin call, too.
    if (a_cfg.min_vector_length > 0)
    {
      l_hatch.deleteShortLines(a_cfg.min_vector_length);
    }
  }
  catch (e)
  {
    // Builtins report problems (e.g. invalid options) as exceptions;
    // they are converted into a normal result here.
    let l_msg = (e && e.message) ? e.message : String(e);
    return { ok: false, hatch: undefined, message: 'Hatch pattern ' + a_cfg.pattern + ' failed: ' + l_msg };
  }
  return { ok: true, hatch: l_hatch, message: '' };
};

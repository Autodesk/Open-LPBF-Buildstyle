/************************************************************
 * MODULE NAME: exposure_sorter.js
 *
 * PURPOSE:
 *   Define the final exposure order of all paths of one layer
 *   (attribute '_processing_order').
 *
 * BACKGROUND:
 *   MPBF background: The order in which the laser exposes the paths
 *   of a layer changes the result, not only the build time:
 *   - Gas flow: a shielding gas (for example argon) flows over the
 *     powder bed and carries away fumes and spatter (small ejected
 *     particles). Spatter landing on powder that is still to be
 *     exposed causes defects, so areas far downstream are exposed
 *     first and the laser works its way "against" the gas flow.
 *   - Heat: exposing one part completely before the next one, or
 *     island by island, changes how much time an area has to cool.
 *   - Vector types: the scanning order table decides, for example,
 *     whether contours (border paths) are exposed before the hatches
 *     (fill lines) or after them. Contours first give a defined edge
 *     before the core is melted; contours last can smooth the edge
 *     where the hatch vectors end. The user chooses this per BSID.
 *   Terms: an island is one closed region (outer contour + holes) of a
 *   part in one layer; a BSID (build style ID) identifies the vector
 *   type and its laser parameter set.
 *
 * WORKFLOW:
 *   Called in the multi-threaded post-processing step for every
 *   layer, as the first step: before the laser assignment, the power
 *   optimization and the exposure time estimation, which all follow
 *   the order written here.
 *
 *   Sort modes:
 *   - 'platform': by scanning order over the whole platform
 *     (all parts: contours first, then hatches, ...).
 *   - 'model'   : part by part; inside a part by scanning order.
 *   - 'island'  : island by island (supports of a part first);
 *     inside an island by scanning order.
 *   - 'global'  : by scanning order over the whole platform, and inside
 *     one vector type EVERY path by its own position, from downstream
 *     to upstream. Parts and islands are no sort level: all models are
 *     treated as one. A hatch block (e.g. one stripe, chess field or
 *     hexagon cell, a "sub-island") is placed by the center of its own
 *     bounds, so the stripes of a long part and of a small part next to
 *     it are exposed in one sweep against the gas flow. Paths that are
 *     equally far downstream (same 1 mm band) are exposed across the
 *     flow in one direction (GAS_FLOW.cross_key).
 *   In 'platform', 'model' and 'island' the islands are ordered along
 *   the gas flow (downstream first), so the fumes are blown away from
 *   areas that are not exposed yet; all paths of an island share the
 *   island position and stay together.
 *   group_key gives the sort group of a path (scanning order value
 *   inside the same part / island, or on the whole platform); the laser
 *   assignment uses it to balance the lasers group by group.
 *
 * USAGE:
 *   var SORTER = require('../sorting/exposure_sorter.js');
 *   let l_ranks = SORTER.compute_model_ranks(l_bounds_list, true, l_gas_dir);
 *   SORTER.sort_layer(modelData, n, { mode: 'island', sort_models: true,
 *     gas_dir: l_gas_dir, scan_order: { '100': 10, '500': 50 }, model_rank: l_ranks });
 *
 * DEPENDENCIES:
 *   Builtins: bsPolylineIterator, bsModel
 *   Modules : ../geometry/gas_flow.js, ../util/attribute_names.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   To add a sort mode: add a case in make_sort_key.
 *   Tip: Array.prototype.sort is stable in the script
 *   engine. The original position 'orig' is still used as the last
 *   key, so the order inside an island (for example the result of
 *   the block sorting) is kept in any case.
 *   Tip: The sorter does not move any path. It only writes
 *   the number '_processing_order' (0 = first) to every path; the host
 *   and the export use this number as the exposure order.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var POLY_IT = requireBuiltin('bsPolylineIterator');
var MODEL = requireBuiltin('bsModel');
var GAS_FLOW = require('../geometry/gas_flow.js');
var ATTR = require('../util/attribute_names.js').ATTR;

/**
 * Scanning order of vector types without an entry (exposed last).
 * Any large number works, as long as it is larger than all values
 * the user can enter in the scanning order table.
 */
var S_UNKNOWN_ORDER = 1000000;

/**
 * Size of an island bucket along the gas flow in mm.
 * Islands whose centers lie within the same 1 mm band (measured along
 * the gas flow) count as "equally far downstream"; they are then
 * ordered by island id. Without buckets, tiny coordinate differences
 * could swap the order of such islands from layer to layer.
 */
var S_ISLAND_BUCKET_MM = 1.0;

/**
 * Rank of each model for the sorting.
 * A model is one part (or support structure) on the build platform.
 * With a_sort_models the model whose bounding box center lies furthest
 * downstream gets rank 0 and is exposed first (see gas_flow.js).
 * The ranks are the same for all layers, so the order of the models
 * does not jump between layers.
 * @param {Array} a_model_bounds_array  Per model index: {min_x, min_y, max_x, max_y} in mm,
 *                                      or undefined if the model has no bounds
 * @param {boolean} a_sort_models       true: sort models along the gas flow
 * @param {{x:number, y:number}} a_gas_dir  Unit vector of the gas flow direction
 * @return {number[]} Rank per model index (0 = first)
 */
exports.compute_model_ranks = function(a_model_bounds_array, a_sort_models, a_gas_dir)
{
  // Default: rank = model index (the order in which the models were added).
  let l_count = a_model_bounds_array.length;
  let r_ranks = [];
  for (let i = 0; i < l_count; ++i) r_ranks.push(i);
  if (!a_sort_models) return r_ranks;

  let l_entries = [];
  for (let i = 0; i < l_count; ++i)
  {
    let l_b = a_model_bounds_array[i];
    // Models without bounds (for example empty slots) get key 0.
    let l_key = 0.0;
    if (l_b)
    {
      l_key = GAS_FLOW.downstream_key(0.5 * (l_b.min_x + l_b.max_x), 0.5 * (l_b.min_y + l_b.max_y), a_gas_dir);
    }
    l_entries.push({ index: i, key: l_key });
  }
  l_entries.sort(compare_model_entries);
  // Position in the sorted list = rank of the model.
  for (let k = 0; k < l_entries.length; ++k)
  {
    r_ranks[l_entries[k].index] = k;
  }
  return r_ranks;
};

/**
 * Models downstream first; equal keys keep the model index order.
 * Tip: A compare function for Array.sort returns a negative
 * number if a_a comes first, a positive number if a_b comes first and
 * 0 if both are equal.
 */
function compare_model_entries(a_a, a_b)
{
  if (a_a.key !== a_b.key) return a_a.key - a_b.key;
  return a_a.index - a_b.index;
}

/**
 * Read an integer attribute, 0 if it is missing.
 * @param {bsPolylineIterator} a_poly
 * @param {string} a_name  Attribute name (see attribute_names.js)
 * @return {number}
 */
function get_int_or_zero(a_poly, a_name)
{
  let l_v = a_poly.getAttributeIntExt(a_name);
  return (typeof l_v === 'number') ? l_v : 0;
}

/**
 * Center of the island the path belongs to. Uses the island bounds
 * stored during the exposure creation; falls back to the bounds of
 * the path itself.
 * Why the island bounds? All paths of one island (contours, hatches,
 * ...) get the same center and therefore the same gas flow bucket, so
 * they stay together. With the bounds of each single path, a hatch
 * and its contour could land in different buckets.
 * @param {bsPolylineIterator} a_poly
 * @return {{x:number, y:number}} Center in mm
 */
function get_island_center(a_poly)
{
  let l_min_x = a_poly.getAttributeRealExt(ATTR.ISL_MIN_X);
  let l_min_y = a_poly.getAttributeRealExt(ATTR.ISL_MIN_Y);
  let l_max_x = a_poly.getAttributeRealExt(ATTR.ISL_MAX_X);
  let l_max_y = a_poly.getAttributeRealExt(ATTR.ISL_MAX_Y);
  if ((typeof l_min_x === 'number') && (typeof l_min_y === 'number') &&
      (typeof l_max_x === 'number') && (typeof l_max_y === 'number'))
  {
    return { x: 0.5 * (l_min_x + l_max_x), y: 0.5 * (l_min_y + l_max_y) };
  }
  let l_b = a_poly.getBounds();
  return { x: 0.5 * (l_b.minX + l_b.maxX), y: 0.5 * (l_b.minY + l_b.maxY) };
}

/**
 * Sort key tuple of one item. All entries are numbers, so the
 * lexicographic comparison is a strict weak ordering.
 * Tip: "Lexicographic" works like sorting words in a
 * dictionary: the first entry decides; only if it is equal, the
 * second entry decides, and so on. The order of the entries in the
 * tuple therefore defines the priority of the sort criteria.
 * Meaning of the entries:
 *   model_rank    : model order (see compute_model_ranks)
 *   support_rank  : 0 = support, 1 = part (supports first)
 *   order         : scanning order of the vector type (BSID)
 *   island_bucket : position of the island along the gas flow (downstream first)
 *   islid         : island id (keeps the paths of one island together)
 *   path_bucket   : position of the path ITSELF along the gas flow (mode 'global')
 *   cross_key     : position of the path across the gas flow (mode 'global')
 *   orig          : original position (keeps the existing order)
 * @param {Object} a_item  Item (see sort_layer)
 * @param {Object} a_cfg   Sorter settings
 * @return {number[]}
 */
function make_sort_key(a_item, a_cfg)
{
  switch (a_cfg.mode)
  {
    case 'model':
      return [a_item.model_rank, a_item.order, a_item.island_bucket, a_item.islid, a_item.orig];
    case 'island':
      return [a_item.model_rank, a_item.support_rank, a_item.island_bucket, a_item.islid, a_item.order, a_item.orig];
    case 'global':
      // No model, support or island entry: all paths of one vector type
      // are sorted by their own position only.
      return [a_item.order, a_item.path_bucket, a_item.cross_key, a_item.orig];
    default: // 'platform'
      // sort_models = true: inside one vector type, the gas flow
      // position is more important than the model order.
      if (a_cfg.sort_models)
      {
        return [a_item.order, a_item.island_bucket, a_item.model_rank, a_item.islid, a_item.orig];
      }
      return [a_item.order, a_item.model_rank, a_item.island_bucket, a_item.islid, a_item.orig];
  }
}

/**
 * Element-wise comparison of two key tuples of equal length.
 * @return {number} -1 if a_a comes first, 1 if a_b comes first, 0 if equal
 */
function compare_keys(a_a, a_b)
{
  for (let i = 0; i < a_a.length; ++i)
  {
    if (a_a[i] !== a_b[i]) return (a_a[i] < a_b[i]) ? -1 : 1;
  }
  return 0;
}

/**
 * Sort item of one path, with its key tuple.
 * The values are passed as a plain object, so the same item (and key)
 * can be built for a bsPolylineIterator (sort_layer) and for a hatch
 * block (group_key, used by the laser assignment).
 * @param {{model_index:number, bsid:number, islid:number,
 *          center:{x:number, y:number}, path_center:{x:number, y:number},
 *          is_support:boolean}} a_values
 *        center = island center in mm (see get_island_center);
 *        path_center = center of the bounds of the path itself in mm
 *        (only used by the mode 'global'; center is used if it is missing)
 * @param {number} a_orig  Original position of the path
 * @param {Object} a_cfg   Sorter settings (see sort_layer)
 * @return {Object} Item { orig, model_rank, order, islid, island_bucket, support_rank,
 *         path_bucket, cross_key, key }
 */
function make_item(a_values, a_orig, a_cfg)
{
  // The table keys are strings ('500'), so the BSID number is converted.
  let l_order = a_cfg.scan_order[String(a_values.bsid)];
  let l_rank = a_cfg.model_rank[a_values.model_index];
  let l_path = a_values.path_center ? a_values.path_center : a_values.center;
  let r_item = {
    orig: a_orig,
    model_rank: (typeof l_rank === 'number') ? l_rank : a_values.model_index,
    order: (typeof l_order === 'number') ? l_order : S_UNKNOWN_ORDER,
    islid: a_values.islid,
    island_bucket: GAS_FLOW.bucket(GAS_FLOW.downstream_key(a_values.center.x, a_values.center.y, a_cfg.gas_dir),
      S_ISLAND_BUCKET_MM),
    support_rank: a_values.is_support ? 0 : 1,
    path_bucket: GAS_FLOW.bucket(GAS_FLOW.downstream_key(l_path.x, l_path.y, a_cfg.gas_dir), S_ISLAND_BUCKET_MM),
    cross_key: GAS_FLOW.cross_key(l_path.x, l_path.y, a_cfg.gas_dir),
    key: undefined
  };
  r_item.key = make_sort_key(r_item, a_cfg);
  return r_item;
}

/**
 * Number of leading entries of the key tuple (see make_sort_key) that
 * form a sort group: everything up to and including the scanning order.
 *   platform: [order]                                   -> 1
 *   model   : [model_rank, order]                       -> 2
 *   island  : [model_rank, support_rank, island_bucket, islid, order] -> 5
 *   global  : [order]                                   -> 1
 */
var S_GROUP_KEY_LENGTH = Object.freeze({ platform: 1, model: 2, island: 5, global: 1 });

/**
 * Key of the sort group of a path, as text.
 * A sort group is a run of paths that follow each other in the sorted
 * order and share the same scanning order value inside the same part
 * (mode 'model') or island (mode 'island'); in the modes 'platform' and
 * 'global' all paths with the same scanning order form one group.
 * Why: the laser assignment balances the lasers group by group (one
 * "pass" per group). Because the group key is a prefix of the sort key,
 * all paths of a group are neighbors in the sorted order.
 * @param {{model_index:number, bsid:number, islid:number, center:{x:number, y:number},
 *          path_center:{x:number, y:number}, is_support:boolean}} a_values  See make_item
 * @param {Object} a_cfg  Sorter settings (see sort_layer)
 * @return {string} e.g. '0|1|-12|3|40'
 */
exports.group_key = function(a_values, a_cfg)
{
  let l_key = make_item(a_values, 0, a_cfg).key;
  let l_len = S_GROUP_KEY_LENGTH[a_cfg.mode];
  if (typeof l_len !== 'number') l_len = S_GROUP_KEY_LENGTH.platform;
  return l_key.slice(0, l_len).join('|');
};

/** Comparison of two items by their key tuples. */
function compare_items(a_a, a_b)
{
  return compare_keys(a_a.key, a_b.key);
}

/**
 * Center of the bounds of the path itself (used by the mode 'global').
 * @param {bsPolylineIterator} a_poly
 * @return {{x:number, y:number}} Center in mm
 */
function get_path_center(a_poly)
{
  let l_b = a_poly.getBounds();
  return { x: 0.5 * (l_b.minX + l_b.maxX), y: 0.5 * (l_b.minY + l_b.maxY) };
}

/**
 * Sort all exposure paths of one layer and write '_processing_order'.
 * The paths of all models of the layer are sorted together, because the
 * laser exposes the whole platform layer in one sequence.
 * The key tuple of each path is computed once before sorting (not in
 * the compare function), because the compare function is called many
 * times per path.
 * @param {bsModelData} a_model_data
 * @param {number} a_layer_nr
 * @param {{mode:string, sort_models:boolean, gas_dir:{x:number, y:number},
 *          scan_order:Object, model_rank:number[]}} a_cfg
 *        mode: 'platform' | 'model' | 'island' | 'global'; scan_order: { '<bsid>': order },
 *        smaller order = exposed earlier; model_rank from compute_model_ranks
 * @return {{ok:boolean, count:number}} count = number of sorted paths
 */
exports.sort_layer = function(a_model_data, a_layer_nr, a_cfg)
{
  // 'rw' requests writable paths, because the order attribute is written.
  let l_polys = a_model_data.getLayerPolylineArray(a_layer_nr, POLY_IT.nLayerExposure, 'rw');
  if (!l_polys || (l_polys.length === 0)) return { ok: true, count: 0 };

  let l_items = [];
  for (let i = 0; i < l_polys.length; ++i)
  {
    let l_poly = l_polys[i];
    let l_item = make_item({
      model_index: l_poly.getModelIndex(),
      bsid: get_int_or_zero(l_poly, ATTR.BSID),
      islid: get_int_or_zero(l_poly, ATTR.ISLAND_ID),
      center: get_island_center(l_poly),
      // Only needed by the mode 'global' (saves one bounds call per path otherwise).
      path_center: (a_cfg.mode === 'global') ? get_path_center(l_poly) : undefined,
      is_support: l_poly.getModelSubtype() === MODEL.nSubtypeSupport
    }, i, a_cfg);
    l_item.poly = l_poly;
    l_items.push(l_item);
  }

  l_items.sort(compare_items);
  // Position after sorting = exposure order (0 = exposed first).
  for (let k = 0; k < l_items.length; ++k)
  {
    l_items[k].poly.setAttributeInt(ATTR.PROCESSING_ORDER, k);
  }
  return { ok: true, count: l_items.length };
};

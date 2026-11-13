/************************************************************
 * MODULE NAME: start_point_history.js
 *
 * PURPOSE:
 *   Choose the start point of closed contours so that it is not
 *   placed on top of the start points of the previous layers.
 *   The start point of a contour is where the seam is. Seams that
 *   lie on top of each other create visible defects on the part
 *   surface; distributing them reduces such defects.
 *
 * BACKGROUND:
 *   MPBF background: A contour is a closed border path around an
 *   island. Where the laser switches on and off, the melt track
 *   starts and ends: there is a small overlap or gap, a bump or a
 *   pore. This spot is called the seam. If every layer starts the
 *   contour at the same point, the seams stack up to a vertical line
 *   (a "zipper") on the part surface, which is rough and can be a weak
 *   spot. Moving the start point away from the start points of the
 *   last few layers spreads these small defects over the surface.
 *   Modes (from the start point settings):
 *   - 'previous'        : candidates are checked in contour order.
 *   - 'random_previous' : candidates are checked in a random (but
 *                         reproducible) order.
 *
 * WORKFLOW:
 *   Used by the single-threaded post-processing step, which visits
 *   the layers in strictly ascending order:
 *     store = create_store();
 *     for every layer:
 *       for every closed contour: apply(contour, get_history(store, key, n), cfg, seed);
 *       commit_layer(store);
 *   Why single-threaded? Each layer needs the result of the layers
 *   below it. With several threads, the layers would be processed in
 *   an unpredictable order and the history would be wrong.
 *
 * USAGE:
 *   var START_HIST = require('../sorting/start_point_history.js');
 *   let l_store = START_HIST.create_store();
 *   let l_hist = START_HIST.get_history(l_store, '0_border_first', 3);
 *   START_HIST.apply(l_poly, l_hist, { mode: 'previous', min_distance: 0.5 }, 42);
 *   START_HIST.commit_layer(l_store);
 *
 * DEPENDENCIES:
 *   Builtins: none
 *   Modules : ../util/math_utils.js, ../util/random.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   One history per key (for example per model and contour family),
 *   so different contour types do not influence each other.
 *   Note: the history stores points only, not which contour (or
 *   island) they belong to. A start point is compared with the start
 *   points of ALL contours of the same key in the previous layers.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var MATH = require('../util/math_utils.js');
var RANDOM = require('../util/random.js');

/**
 * Maximum number of candidate points per contour (limits the run time).
 * Each candidate is compared with every remembered start point, so the
 * cost grows with candidates * history size.
 */
var S_MAX_CANDIDATES = 64;

/** Distance (mm) below which the last point equals the first point. */
var S_SAME_POINT_TOL = 1e-6;

/**
 * Create an empty store for all histories.
 * Tip: A Map is a key -> value container. Here the key is a
 * string such as '0_border_first' and the value is one history.
 * @return {{map:Map}}
 */
exports.create_store = function()
{
  return { map: new Map() };
};

/**
 * Get (or create) the history for one key.
 * History layout:
 *   layers  : start points of the last max_layers layers (oldest first),
 *             one array of points per layer
 *   current : start points chosen in the layer that is processed now;
 *             they become history in commit_layer()
 * Keeping "current" separate makes sure that contours of the same
 * layer do not push each other away.
 * @param {{map:Map}} a_store   Store from create_store
 * @param {string} a_key        For example '<model index>_<family>'
 * @param {number} a_layer_count Number of previous layers to remember (>= 1)
 * @return {{max_layers:number, layers:Array, current:Array}}
 */
exports.get_history = function(a_store, a_key, a_layer_count)
{
  if (!a_store.map.has(a_key))
  {
    a_store.map.set(a_key, {
      max_layers: Math.max(1, a_layer_count),
      layers: [],
      current: []
    });
  }
  return a_store.map.get(a_key);
};

/**
 * Smallest distance between a point and all remembered start points.
 * @param {{x:number, y:number}} a_p  Candidate point in mm
 * @param {Array} a_layers  Array of arrays of points
 * @return {number} Distance in mm or Infinity if there is no history
 */
function min_distance_to_history(a_p, a_layers)
{
  let r_min = Infinity;
  for (let l = 0; l < a_layers.length; ++l)
  {
    let l_points = a_layers[l];
    for (let i = 0; i < l_points.length; ++i)
    {
      let l_d = MATH.dist(a_p.x, a_p.y, l_points[i].x, l_points[i].y);
      if (l_d < r_min) r_min = l_d;
    }
  }
  return r_min;
}

/**
 * Candidate point indices of a contour (all points or an even selection).
 * Example: a contour with 640 points gives the indices 0, 10, 20, ...
 * Only existing contour points are used as start points, so the
 * geometry of the contour is not changed.
 * @param {number} a_n_eff  Number of distinct points
 * @return {number[]} Point indices
 */
function make_candidates(a_n_eff)
{
  let r_cands = [];
  if (a_n_eff <= S_MAX_CANDIDATES)
  {
    for (let i = 0; i < a_n_eff; ++i) r_cands.push(i);
    return r_cands;
  }
  for (let i = 0; i < S_MAX_CANDIDATES; ++i)
  {
    r_cands.push(Math.floor(i * a_n_eff / S_MAX_CANDIDATES));
  }
  return r_cands;
}

/**
 * Choose and set the start point of one closed contour.
 * The first candidate that is far enough away from all remembered
 * start points wins. If none is far enough, the candidate with the
 * largest distance is used.
 * "First that is good enough" (instead of "the best") stops the search
 * early, which saves run time on contours with many points.
 * @param {bsPolylineIterator} a_poly  Closed polyline (writable)
 * @param {Object} a_hist   History from get_history
 * @param {{mode:string, min_distance:number}} a_cfg  Start point settings
 *        mode: 'previous' or 'random_previous'; min_distance in mm
 * @param {number} a_seed   Seed for the mode 'random_previous'
 *        (same seed -> same candidate order -> same toolpath on every run)
 */
exports.apply = function(a_poly, a_hist, a_cfg, a_seed)
{
  let l_n = a_poly.getPointCount();
  if (l_n < 1) return;

  // A closed polygon may repeat its first point at the end.
  // That duplicate is not a separate candidate.
  let l_first = a_poly.getXYCoord(0);
  let l_last = a_poly.getXYCoord(l_n - 1);
  let l_n_eff = (MATH.dist(l_first.x, l_first.y, l_last.x, l_last.y) < S_SAME_POINT_TOL) ? (l_n - 1) : l_n;
  // Fewer than 3 distinct points is not a real closed contour: keep it.
  if (l_n_eff < 3) return;

  let l_cands = make_candidates(l_n_eff);
  if (a_cfg.mode === 'random_previous')
  {
    RANDOM.shuffle_in_place(l_cands, RANDOM.create_rng(a_seed));
  }

  // l_best_score starts below any real distance (distances are >= 0),
  // so the first candidate always becomes the current best.
  let l_best_idx = l_cands[0];
  let l_best_score = -1.0;
  let l_best_point = undefined;
  for (let i = 0; i < l_cands.length; ++i)
  {
    let l_p = a_poly.getXYCoord(l_cands[i]);
    let l_score = min_distance_to_history(l_p, a_hist.layers);
    // Far enough away: take it and stop searching. Without history the
    // score is Infinity, so the first candidate is taken.
    if (l_score >= a_cfg.min_distance)
    {
      l_best_idx = l_cands[i];
      l_best_point = l_p;
      break;
    }
    if (l_score > l_best_score)
    {
      l_best_score = l_score;
      l_best_idx = l_cands[i];
      l_best_point = l_p;
    }
  }

  // Index 0 is already the start point: no change needed.
  if (l_best_idx !== 0)
  {
    a_poly.setClosedPolyStartPoint(l_best_idx);
  }
  // Remember the chosen point for the following layers (after commit_layer).
  a_hist.current.push({ x: l_best_point.x, y: l_best_point.y });
};

/**
 * Finish a layer: the start points of this layer become history.
 * Call once per layer, after all contours of the layer were processed.
 * The oldest layers are dropped, so only the last max_layers layers are
 * remembered (start point setting history_layers); older start points
 * no longer influence the choice.
 * Every key in the store gets an entry per layer, even an empty one if
 * the key had no contour in this layer, so max_layers counts layers.
 * @param {{map:Map}} a_store
 */
exports.commit_layer = function(a_store)
{
  let l_hists = Array.from(a_store.map.values());
  for (let i = 0; i < l_hists.length; ++i)
  {
    let l_h = l_hists[i];
    l_h.layers.push(l_h.current);
    l_h.current = [];
    while (l_h.layers.length > l_h.max_layers)
    {
      l_h.layers.shift();
    }
  }
};

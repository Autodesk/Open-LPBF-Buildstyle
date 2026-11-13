/************************************************************
 * MODULE NAME: random.js
 *
 * PURPOSE:
 *   Reproducible pseudo random numbers. The same seed always
 *   gives the same sequence, so a toolpath calculation gives the
 *   same result every time (important for previews and tests).
 *
 * BACKGROUND:
 *   MPBF background: Some toolpath features are randomized on purpose,
 *   for example the start point of a contour (so that the seams of the
 *   layers do not stack up to a vertical line on the part surface).
 *   "Random" here only needs to look irregular; it does not need to be
 *   unpredictable.
 *   Why a seed instead of true randomness?
 *   - Reproducible: calculating the same job twice gives exactly the
 *     same toolpath, so a preview matches the exported file and test
 *     results can be compared.
 *   - Thread independent: the host calculates layers in parallel and in
 *     an unpredictable order. With one running generator (per thread
 *     or per job) the numbers of a layer would depend on which layers
 *     were calculated before it. Here every
 *     layer / island / vector type gets its own seed from make_seed(),
 *     so the numbers depend only on WHAT is calculated, not WHEN.
 *
 * WORKFLOW:
 *   Used for random contour start points, random dash starts and
 *   the candidate order of the start point history.
 *
 * USAGE:
 *   var RANDOM = require('../util/random.js');
 *   let l_seed = RANDOM.make_seed(a_layer_nr, a_island_id, a_bsid);
 *   let l_rng = RANDOM.create_rng(l_seed);
 *   let l_value = RANDOM.next_float(l_rng);     // [0, 1)
 *
 * DEPENDENCIES:
 *   Builtins: none (pure module, can be tested with Node.js)
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Math.random() is intentionally not used: it cannot be seeded.
 *   Tip: The bit operators used below (^, >>>, |, &) work on
 *   32 bit integers. 'x >>> 0' converts a number to an unsigned 32 bit
 *   integer (0 .. 4294967295); Math.imul multiplies two 32 bit
 *   integers like a C program would (the result wraps around instead
 *   of becoming a large floating point number).
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

/**
 * Combine three integers into one seed value (spatial hash).
 * Different inputs give (with high probability) different seeds.
 * The three large multipliers are constants of a well known spatial
 * hash; XOR (^) mixes the three products. Neighboring inputs (layer
 * 10 and layer 11) therefore give very different seeds.
 * The inputs should be integers: ^ converts its operands to 32 bit
 * integers and drops any fraction.
 * @param {number} a_a  First integer (e.g. layer number)
 * @param {number} a_b  Second integer (e.g. island id)
 * @param {number} a_c  Third integer (e.g. vector type id)
 * @return {number} Unsigned 32 bit seed, never 0
 */
exports.make_seed = function(a_a, a_b, a_c)
{
  let r_seed = ((a_a * 73856093) ^ (a_b * 19349663) ^ (a_c * 83492791)) >>> 0;
  // 0 is mapped to 1, so callers can rely on a seed that is never 0.
  if (r_seed === 0) r_seed = 1;
  return r_seed;
};

/**
 * Convert a seed to a positive signed 32 bit integer.
 * Builtin functions expect a normal (signed) integer as random seed,
 * while make_seed() returns an unsigned value that can be larger.
 * '& 0x7FFFFFFF' clears the sign bit: the result is between 0 and
 * 2147483647 (the largest signed 32 bit integer).
 * @param {number} a_seed  Seed from make_seed()
 * @return {number} Seed in [1, 2147483647]
 */
exports.to_builtin_seed = function(a_seed)
{
  let r_seed = (a_seed & 0x7FFFFFFF);
  if (r_seed === 0) r_seed = 1;
  return r_seed;
};

/**
 * Create a random number generator state.
 * Tip: The state is a plain object owned by the caller. Each
 * caller creates its own generator, so two islands or two threads
 * never share (and disturb) the same sequence.
 * @param {number} a_seed  Seed (integer)
 * @return {{state:number}} Generator state, pass it to next_float()
 */
exports.create_rng = function(a_seed)
{
  return { state: (a_seed >>> 0) };
};

/**
 * Next pseudo random number (algorithm "Mulberry32": small, fast and
 * good enough for geometric randomization).
 * Each call advances the state by a fixed constant and scrambles it
 * with shifts and multiplications. The constants are part of the
 * published algorithm and must not be changed, otherwise all
 * randomized toolpaths change.
 * @param {{state:number}} a_rng  Generator state (modified)
 * @return {number} Value in [0, 1)
 */
exports.next_float = function(a_rng)
{
  a_rng.state = (a_rng.state + 0x6D2B79F5) >>> 0;
  let l_t = a_rng.state;
  l_t = Math.imul(l_t ^ (l_t >>> 15), l_t | 1);
  l_t ^= l_t + Math.imul(l_t ^ (l_t >>> 7), l_t | 61);
  // Unsigned 32 bit result divided by 2^32 gives a value in [0, 1).
  return ((l_t ^ (l_t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Shuffle an array in place (Fisher-Yates algorithm).
 * Every order has the same probability.
 * Walks from the last element to the first and swaps each element
 * with a randomly chosen element at the same or a lower position.
 * @param {Array} a_array  Array (modified)
 * @param {{state:number}} a_rng  Generator state (modified)
 * @return {Array} The same array (for convenience)
 */
exports.shuffle_in_place = function(a_array, a_rng)
{
  for (let i = a_array.length - 1; i > 0; --i)
  {
    // Random index l_j in [0, i].
    let l_j = Math.floor(exports.next_float(a_rng) * (i + 1));
    let l_tmp = a_array[i];
    a_array[i] = a_array[l_j];
    a_array[l_j] = l_tmp;
  }
  return a_array;
};

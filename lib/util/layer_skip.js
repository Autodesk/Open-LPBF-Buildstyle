/************************************************************
 * MODULE NAME: layer_skip.js
 *
 * PURPOSE:
 *   Decide if a vector type is exposed on a layer when the user
 *   configured "expose every n-th layer" (layer skip).
 *
 * BACKGROUND:
 *   MPBF background: A layer is one slice of the build, typically 20
 *   to 100 micrometers thick. Some vector types do not need to be
 *   exposed on every layer. Example: a core area can be melted only
 *   on every second layer with more energy, melting two powder layers
 *   at once, which saves build time. The user sets every_nth (1 = every
 *   layer, 2 = every second layer, ...) and an offset that shifts which
 *   layers are exposed. Different offsets for different vector types
 *   can be used to alternate them between layers.
 *
 * WORKFLOW:
 *   Called from makeExposureLayer for every vector type that has
 *   a layer skip configuration.
 *
 * USAGE:
 *   var LAYER_SKIP = require('../util/layer_skip.js');
 *   if (LAYER_SKIP.is_active(l_layer_index, { every_nth: 2, offset: 0 })) {...}
 *
 * DEPENDENCIES:
 *   Builtins: none (pure module, can be tested with Node.js)
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Tip: The function only answers "yes or no". It has no
 *   memory of earlier layers, so it gives the same answer no matter
 *   in which order (or in which thread) the layers are calculated.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

/**
 * Check if the layer has to be exposed.
 * The offset is the index of the first exposed layer:
 * a layer is exposed if (layer_index - offset) is a multiple of every_nth.
 * Example: every_nth = 2, offset = 0 -> layer index 0, 2, 4, ... are exposed.
 *          every_nth = 2, offset = 1 -> layer index 1, 3, 5, ... are exposed.
 *          every_nth = 5, offset = 1 -> layer index 1, 6, 11, ... are exposed.
 * Example of interleaving: every_nth = 3 with the offsets 0, 1 and 2 for
 * three vector types exposes each of them on every third layer, one
 * after the other (0, 3, ... / 1, 4, ... / 2, 5, ...).
 * The layer index counts from the first layer of the model (not from
 * the build platform), so the pattern starts with the part itself.
 * @param {number} a_layer_index  0-based layer index of the model
 * @param {{every_nth:number, offset:number}} a_cfg  Layer skip settings
 *        (undefined = no layer skip configured)
 * @return {boolean} true if the layer must be exposed
 */
exports.is_active = function(a_layer_index, a_cfg)
{
  // No settings, or every_nth <= 1 (also undefined or NaN): expose every layer.
  if (!a_cfg) return true;
  if (!(a_cfg.every_nth > 1)) return true;
  // A negative index should not happen. Exposing is the safe choice.
  if (a_layer_index < 0) return true;
  let l_offset = a_cfg.offset;
  if (typeof l_offset !== 'number') l_offset = 0;
  // Tip: % is the remainder of a division, e.g. 5 % 2 = 1.
  // A remainder of 0 means the layer is one of the "every n-th" layers.
  // In JavaScript the remainder has the sign of the dividend
  // ((0 - 1) % 5 = -1), so it is shifted into [0, every_nth) first.
  let l_rem = (a_layer_index - l_offset) % a_cfg.every_nth;
  if (l_rem < 0) l_rem += a_cfg.every_nth;
  return l_rem === 0;
};

/************************************************************
 * MODULE NAME: hull_core.js
 *
 * PURPOSE:
 *   Split a hatch area into a hull (outer shell of the part) and a
 *   core (inner volume). The core can be exposed with other settings
 *   and only every n-th layer (with n times the layer thickness).
 *
 * WORKFLOW:
 *   declareModelFeatures declares the hull/core feature with a
 *   parameter set name. makeExposureLayer calls split() with the
 *   same name for every volume area.
 *
 * USAGE:
 *   var HULL_CORE = require('../exposure/hull_core.js');
 *   let l_res = HULL_CORE.split(l_area, 'my_hull_core');
 *   // l_res.hull, l_res.core, l_res.core_active
 *
 * DEPENDENCIES:
 *   Builtins: bsSingleHullAndCoreGenerator, bsIsland
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Only call split() if the feature was declared in
 *   declareModelFeatures, otherwise the generator cannot be created.
 *
 * BACKGROUND:
 *   MPBF background: The quality requirements differ between the
 *   surface region and the inside of a part. The hull (a shell with a
 *   minimum wall thickness in mm, declared in declareModelFeatures)
 *   defines the visible surface and the accuracy; it is exposed in
 *   every layer. The core is hidden inside and can be exposed with
 *   more productive settings (e.g. higher power and speed). With
 *   "core skip" n, the core is only exposed every n-th layer; the
 *   laser then melts n layers of powder at once (n times the layer
 *   thickness), which saves time on large solid parts.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var HULL = requireBuiltin('bsSingleHullAndCoreGenerator');
var ISLAND = requireBuiltin('bsIsland');

/**
 * Split an area into hull and core.
 * On layers where the core is skipped, only the hull is returned and
 * the core island stays empty; the caller must not expose a core then
 * (the core material of the skipped layers is melted together with a
 * later core layer).
 * @param {bsIsland} a_area            Area (not modified)
 * @param {string} a_param_set_name    Name used in declareSingleHullCore
 * @return {{hull:bsIsland, core:bsIsland, core_active:boolean}}
 *         core_active is false on layers where the core is not exposed (core skip)
 */
exports.split = function(a_area, a_param_set_name)
{
  // The generator is created for the current layer with the settings
  // that were declared under this name (hull thickness, core skip).
  let l_gen = new HULL.bsSingleHullAndCoreGenerator(a_param_set_name);
  let l_hull = new ISLAND.bsIsland();
  l_gen.createHull(a_area, l_hull);
  let l_core = new ISLAND.bsIsland();
  // needCoreExposure() answers: "is this a layer where the core is exposed?"
  let l_active = l_gen.needCoreExposure();
  if (l_active)
  {
    l_gen.createCore(a_area, l_core);
  }
  return { hull: l_hull, core: l_core, core_active: l_active };
};

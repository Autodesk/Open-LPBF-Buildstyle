/************************************************************
 * MODULE NAME: skin_split.js
 *
 * PURPOSE:
 *   Detect skin areas of an island:
 *   - downskin: overhang areas with little or no solid material below
 *   - upskin: areas with no material in the layer above
 *
 * WORKFLOW:
 *   Called from makeExposureLayer for every part island. The skin
 *   areas are hatched with their own parameters and contours inside
 *   them can get their own vector type.
 *
 * USAGE:
 *   var SKIN = require('../exposure/skin_split.js');
 *   let l_ds = SKIN.split_downskin(a_model, a_island,
 *     { surface_angle: 45, reference_layers: 3, min_width: 0.1 });
 *
 * DEPENDENCIES:
 *   Builtins: bsIsland
 *   Modules : ../geometry/island_ops.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Tip: Skin detection compares with other layers. Declare
 *   lower_layers_dependence / upper_layers_dependence in
 *   declareBuildstyleProperties, so the single layer preview is correct.
 *
 * BACKGROUND:
 *   MPBF background:
 *   - Downskin (down-facing surface, overhang): area of the current
 *     layer that lies above loose powder instead of solid metal.
 *     Powder conducts heat much worse than solid metal, so the heat
 *     stays in the melt pool. With normal parameters the melt pool
 *     becomes too large, sinks into the powder below and leaves dross
 *     (stuck powder) and a rough bottom surface. Downskin areas are
 *     therefore exposed with less energy (e.g. lower power, higher
 *     speed; see the default downskin vector types, BSID + 1).
 *   - Upskin (up-facing surface): area with no part material in the
 *     layer above, i.e. the visible top surface. It is often exposed
 *     with its own settings for a smooth, dense top face.
 *   - Surface angle: angle between the part surface and the build
 *     plate. Walls steeper than the "self-supporting" angle (often
 *     about 45 degrees) can be built without downskin parameters.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var ISLAND = requireBuiltin('bsIsland');
var ISL = require('../geometry/island_ops.js');

/**
 * Downskin (multi-layer overhang) area of an island.
 * "Multi-layer": the builtin looks at several layers below
 * (reference_layers), not only at the directly preceding one. A
 * flat overhang shifts only a little from layer to layer; comparing
 * with more layers detects such areas more reliably.
 * Narrow downskin slivers (narrower than min_width) are removed with
 * a morphological opening (see island_ops.js).
 * @param {bsModel} a_model   Model of the island (needed to look at the layers below)
 * @param {bsIsland} a_island Island (not modified)
 * @param {{surface_angle:number, reference_layers:number, min_width:number}} a_cfg
 *        surface_angle: regions whose surface is flatter than this angle are downskin
 *                       (degrees, measured against the build plate),
 *        reference_layers: number of layers below that are compared (>= 1),
 *        min_width: minimum downskin width in mm (<= 0 = keep all)
 * @return {bsIsland} New island (empty if there is no downskin)
 */
exports.split_downskin = function(a_model, a_island, a_cfg)
{
  let l_vol = new ISLAND.bsIsland();
  let l_ovh = new ISLAND.bsIsland();
  // Only these option keys are used on purpose (unknown keys raise an error).
  // fOverlap 0: the overlap into the volume is added later by the caller
  //   (overhang.overlap in exposure_layer.js), only for the hatch area.
  // fTolerance 0.02 mm: calculation tolerance (reduces artifacts).
  // bIncreaseAccuracy: extra processing for a more accurate result
  //   (slower to compute).
  // bUseSolidSupportsBelow: solid supports in the layers below are taken
  //   into account, so areas resting on solid supports are not treated
  //   as overhang above powder.
  // bEnableSharpCorners: less rounded corners in the result.
  // volumeResult (the non-overhang part) is filled but not used here.
  a_island.splitMultiLayerOverhangExt2({
    srcModel: a_model,
    fMaxSurfaceAngle: a_cfg.surface_angle,
    fOverlap: 0.0,
    fTolerance: 0.02,
    bIncreaseAccuracy: true,
    iRefLayers: a_cfg.reference_layers,
    bUseSolidSupportsBelow: true,
    bEnableSharpCorners: true,
    volumeResult: l_vol,
    overhangResult: l_ovh
  });
  // The opening result is clipped to the island, so the downskin never
  // reaches outside of the part outline.
  return ISL.opening(l_ovh, a_cfg.min_width, a_island);
};

/**
 * Upskin area of an island.
 * splitSkin compares only with the next layer above (single-layer
 * upskin by design).
 * Like the downskin, thin slivers (narrower than min_width, mm) are
 * removed; along sloped top walls the single-layer comparison would
 * otherwise produce a thin upskin strip in every layer.
 * @param {bsIsland} a_island  Island (not modified)
 * @param {{min_width:number}} a_cfg
 * @return {bsIsland} New island (empty if there is no upskin)
 */
exports.split_upskin_one_layer = function(a_island, a_cfg)
{
  let l_us = new ISLAND.bsIsland();
  // splitSkin uses the current layer of makeExposureLayer implicitly.
  a_island.splitSkin(l_us);
  return ISL.opening(l_us, a_cfg.min_width, a_island);
};

/************************************************************
 * MODULE NAME: exposure_attributes.js
 *
 * PURPOSE:
 *   Write all toolpath attributes (vector type, laser settings,
 *   island id and bounds, preview color) to a hatch in one call.
 *
 * WORKFLOW:
 *   Called from makeExposureLayer for every hatch before it is
 *   moved into the layer result.
 *
 * USAGE:
 *   var EXPOSURE_ATTRIBUTES = require('../exposure/exposure_attributes.js');
 *   EXPOSURE_ATTRIBUTES.apply(l_hatch, { bsid: 500, island_id: 3, bounds: l_bounds,
 *     laser_index: 0, power: 280, speed: 1200, focus: 0, color_int: l_color });
 *
 * DEPENDENCIES:
 *   Builtins: none (works on the given bsHatch)
 *   Modules : ../util/attribute_names.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   All attributes used here must be declared in declareBuildAttributes.
 *
 * BACKGROUND:
 *   - Attributes are named values attached to each exposure vector
 *     block (like labels). The exporter, the preview, the sorting and
 *     the time estimation later read them back from the toolpath.
 *   - BSID (build style ID) = vector type, e.g. 100 = first border,
 *     500 = volume hatch, 501 = downskin hatch (downskin = normal + 1).
 *     The machine uses the BSID to select its laser parameter set.
 *   - Laser settings and units: power in W (watts), speed in mm/s
 *     (scan speed of the laser spot), focus as offset in mm from the
 *     nominal focus position (0 = nominal; a defocused beam gives a
 *     larger, less intense spot).
 *   MPBF background: power / speed (together with hatch distance and
 *   layer thickness) define the energy put into the powder. Too little
 *   energy leaves unmelted powder (lack of fusion), too much energy
 *   creates keyhole pores and spatter.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

// Tip: '.ATTR' picks one named export of the module. Using the
// constants instead of typing the attribute names avoids typos that
// would silently create an unknown attribute.
var ATTR = require('../util/attribute_names.js').ATTR;

/**
 * Set the toolpath attributes of all blocks of a hatch.
 * Every block of the hatch gets the same values, so call this once per
 * vector type and island (the caller splits the hatches accordingly).
 * @param {bsHatch} a_hatch  Hatch (modified). Empty hatches are ignored.
 * @param {{bsid:number, island_id:number,
 *          bounds:({min_x:number, min_y:number, max_x:number, max_y:number}|undefined),
 *          laser_index:number, power:number, speed:number, focus:number,
 *          color_int:number}} a_info  laser_index is 0-based
 *        bsid       : vector type id (BSID)
 *        island_id  : running island number in the layer (0 = no island,
 *                     e.g. open polylines and wall supports)
 *        bounds     : island bounding box in mm (undefined = not stored)
 *        laser_index: 0-based (the user interface shows 1-based numbers)
 *        power in W, speed in mm/s, focus offset in mm
 *        color_int  : preview color packed into one integer (built from the
 *                     RGB values of the vector type table)
 * @return {void}
 */
exports.apply = function(a_hatch, a_info)
{
  if (a_hatch.isEmpty()) return;

  // Integer attributes (setAttributeInt) for ids, real (floating point)
  // attributes (setAttributeReal) for physical values.
  a_hatch.setAttributeInt(ATTR.BSID, a_info.bsid);
  a_hatch.setAttributeInt(ATTR.LASER_INDEX, a_info.laser_index);
  a_hatch.setAttributeInt(ATTR.ISLAND_ID, a_info.island_id);
  a_hatch.setAttributeInt(ATTR.DISP_COLOR, a_info.color_int);
  a_hatch.setAttributeReal(ATTR.POWER, a_info.power);
  a_hatch.setAttributeReal(ATTR.SPEED, a_info.speed);
  a_hatch.setAttributeReal(ATTR.FOCUS, a_info.focus);

  // The island bounds are used later to sort whole islands along the gas flow.
  // They are stored on every block, because the sorting in post-processing
  // only sees single blocks and must know to which island area they belong.
  if (a_info.bounds)
  {
    a_hatch.setAttributeReal(ATTR.ISL_MIN_X, a_info.bounds.min_x);
    a_hatch.setAttributeReal(ATTR.ISL_MIN_Y, a_info.bounds.min_y);
    a_hatch.setAttributeReal(ATTR.ISL_MAX_X, a_info.bounds.max_x);
    a_hatch.setAttributeReal(ATTR.ISL_MAX_Y, a_info.bounds.max_y);
  }
};

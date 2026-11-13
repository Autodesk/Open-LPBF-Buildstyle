/************************************************************
 * MODULE NAME: build_job_image.js
 *
 * PURPOSE:
 *   Provide a PNG image of the build job for the export package:
 *   1. the image provided by the host application (if available),
 *   2. otherwise a top view drawn by the script (union of up to 40
 *      layers, parts over supports).
 *
 * WORKFLOW:
 *   Called once per export. The result is added to the package with
 *   zip_package.add_image_attachment.
 *
 * USAGE:
 *   var BUILD_JOB_IMAGE = require('../export/build_job_image.js');
 *   let l_img = BUILD_JOB_IMAGE.create_png_temp_file(modelData,
 *     { max_pixels: 1024, margin_mm: 5, model_info_attr: 'my_model_info' });
 *   if (l_img.ok) ZIP.add_image_attachment(l_archive, 'build_job_image.png', l_img);
 *
 * DEPENDENCIES:
 *   Builtins: bsFile, bsScalarValueGrid2D, bsModel
 *   Modules : ../util/log.js
 *
 * BACKGROUND:
 *   The preview image lets the machine operator check at a glance
 *   that the right job is loaded (which parts, where on the build
 *   plate) before hours of printing start. The 3MF package also uses
 *   it as thumbnail.
 *   Top view: looking down on the build plate along -Z. Parts and
 *   their supports are drawn as filled shapes with an outline.
 *   Island: one closed region of a part in one layer (outer contour
 *   plus holes). Supports are thin structures that hold overhangs
 *   and connect the part to the build plate; they are removed after
 *   the build.
 *   The drawing grid is a 2D image in memory: every pixel covers a
 *   square of l_step x l_step mm and stores 3 color values (0..255).
 *   PNG is a binary, lossless image format.
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. The model info attribute must contain
 *   { bounds: {min_x, min_y, max_x, max_y} } (object or JSON text).
 *   The drawing runs on the CPU and needs no graphics card.
 *   Extension: drawHatchLines / drawPolylineItLines of the grid could
 *   be used later to draw exposure vectors as well.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var FILE = requireBuiltin('bsFile');
var SV_GRID = requireBuiltin('bsScalarValueGrid2D');
var MODEL = requireBuiltin('bsModel');
var LOG = require('../util/log.js');

// The PNG export reads the 3 channels in the order blue, green, red.
// All colors are therefore defined directly as [blue, green, red].
// Example: [220, 160, 90] means red 90, green 160, blue 220 (a light blue).
var S_COLOR_BACKGROUND = [255, 255, 255];   // [blue, green, red] white
var S_COLOR_SUPPORT_FILL = [190, 190, 190]; // [blue, green, red] light gray
var S_COLOR_SUPPORT_LINE = [110, 110, 110]; // [blue, green, red] dark gray
var S_COLOR_PART_FILL = [220, 160, 90];     // [blue, green, red] light blue
var S_COLOR_PART_LINE = [140, 60, 20];      // [blue, green, red] dark blue

/**
 * Number of layers that are drawn into the top view.
 * A build can have thousands of layers; 40 evenly distributed layers
 * show the shape well enough and keep the export fast.
 */
var S_MAX_DRAWN_LAYERS = 40;

/** Smallest grid step allowed by the grid (mm). */
var S_MIN_STEP = 0.001;

/** Tray attribute with the image provided by the host. */
var S_HOST_IMAGE_ATTR = 'nf_build_job_image_file';

/**
 * Image provided by the host application.
 * The tray is the build plate with all its models. If the host
 * stored an image file there, it is used in preference to the simple
 * top view drawn by this script.
 * Any error (attribute unknown, not a file, empty file) simply means
 * "no host image"; the script then draws its own image.
 * @param {bsModelData} a_model_data
 * @return {bsFile|undefined}
 */
function get_host_image(a_model_data)
{
  let l_img;
  try
  {
    l_img = a_model_data.getTrayAttribEx(S_HOST_IMAGE_ATTR);
  }
  catch (e)
  {
    return undefined;
  }
  // Duck typing: anything with a getFileSize() function is treated as a file.
  if (!l_img || (typeof l_img.getFileSize !== 'function')) return undefined;
  if (l_img.getFileSize() <= 0) return undefined;
  return l_img;
}

/**
 * Read an object attribute (object or JSON text).
 * @param {bsModel} a_model
 * @param {string} a_name  Attribute name
 * @return {Object|undefined}
 */
function read_object_attrib(a_model, a_name)
{
  let l_v = a_model.getAttribEx(a_name);
  if (typeof l_v === 'string')
  {
    try { return JSON.parse(l_v); } catch (e) { return undefined; }
  }
  if (l_v && (typeof l_v === 'object')) return l_v;
  return undefined;
}

/**
 * Bounds of all models (from the model info attribute).
 * The result is the smallest rectangle (in mm, build plate x/y) that
 * contains all models. Models without valid bounds (missing, or with
 * zero / negative width or depth) are skipped.
 * Tip: '!(a > b)' is also true if a or b is NaN or undefined,
 * so invalid numbers are rejected as well.
 * @param {bsModelData} a_model_data
 * @param {string} a_attr  Name of the model info attribute
 * @return {{min_x:number, min_y:number, max_x:number, max_y:number}|undefined}
 */
function get_platform_bounds(a_model_data, a_attr)
{
  let r_b = undefined;
  for (let i = 0; i < a_model_data.getModelCount(); ++i)
  {
    let l_info = read_object_attrib(a_model_data.getModel(i), a_attr);
    if (!l_info || !l_info.bounds) continue;
    let l_b = l_info.bounds;
    if (!(l_b.max_x > l_b.min_x) || !(l_b.max_y > l_b.min_y)) continue;
    if (!r_b)
    {
      // First valid model: copy the values (do not keep a reference to l_b).
      r_b = { min_x: l_b.min_x, min_y: l_b.min_y, max_x: l_b.max_x, max_y: l_b.max_y };
      continue;
    }
    r_b.min_x = Math.min(r_b.min_x, l_b.min_x);
    r_b.min_y = Math.min(r_b.min_y, l_b.min_y);
    r_b.max_x = Math.max(r_b.max_x, l_b.max_x);
    r_b.max_y = Math.max(r_b.max_y, l_b.max_y);
  }
  return r_b;
}

/**
 * Draw all islands of one subtype (part or support) of one layer.
 * All islands are filled first and then outlined, so the outlines stay
 * visible on top of the fill. Failures only produce a warning (once),
 * because a less nice image must not stop the export.
 * @param {bsScalarValueGrid2D} a_grid
 * @param {bsModelData} a_model_data
 * @param {number} a_layer_nr  Layer number, 1-based
 * @param {number} a_subtype  MODEL.nSubtypePart or MODEL.nSubtypeSupport
 * @param {number[]} a_fill   Fill color [blue, green, red]
 * @param {number[]} a_line   Outline color [blue, green, red]
 */
function draw_layer_islands(a_grid, a_model_data, a_layer_nr, a_subtype, a_fill, a_line)
{
  let l_islands = [];
  let l_it = a_model_data.getFirstIsland(a_layer_nr);
  while (l_it && l_it.isValid())
  {
    if (l_it.getModelSubtype() === a_subtype)
    {
      // Only read access: no copy of the island needed.
      l_islands.push(l_it.getIsland());
    }
    l_it.next();
  }
  if (l_islands.length === 0) return;

  // Offset 0/0: island coordinates are in mm; the grid converts them to
  // pixels with its origin and step size.
  // Anti-aliasing smooths the edges (pixels on the border get a mixed color).
  if (!a_grid.fillIslandAreas(l_islands, 0.0, 0.0, SV_GRID.nLineTypeAntiAlias, a_fill))
  {
    LOG.warning_once('image_fill', 'Build job image: filling islands failed.');
  }
  if (!a_grid.drawIslandLines(l_islands, 0.0, 0.0, 1, SV_GRID.nLineTypeAntiAlias, a_line))
  {
    LOG.warning_once('image_line', 'Build job image: drawing outlines failed.');
  }
}

/**
 * Layer numbers to draw: up to S_MAX_DRAWN_LAYERS, evenly distributed.
 * The first (1) and the last layer are always included. Example: 100
 * layers, 40 steps -> 1, 4, 6, 9, ... 100. Duplicates (possible when
 * rounding) are skipped.
 * @param {number} a_layer_count
 * @return {number[]} 1-based layer numbers in increasing order
 */
function select_layers(a_layer_count)
{
  let r_layers = [];
  if (a_layer_count <= 0) return r_layers;
  let l_steps = Math.min(S_MAX_DRAWN_LAYERS, a_layer_count);
  let l_last = -1;
  for (let k = 0; k < l_steps; ++k)
  {
    let l_n = (l_steps === 1) ? 1 : 1 + Math.round(k * (a_layer_count - 1) / (l_steps - 1));
    if (l_n === l_last) continue;
    r_layers.push(l_n);
    l_last = l_n;
  }
  return r_layers;
}

/**
 * Draw the top view into a new temporary PNG file.
 * Steps: compute the image area (model bounds plus margin), create a
 * grid with square pixels, draw supports, then parts, export as PNG.
 * The pixel size l_step is chosen so that the longer side of the
 * image has about max_pixels pixels.
 * @param {bsModelData} a_model_data
 * @param {{max_pixels:number, margin_mm:number, model_info_attr:string}} a_opts
 * @return {{ok:boolean, file:(bsFile|undefined), source:string, is_temp:boolean, message:string}}
 */
function create_grid_image(a_model_data, a_opts)
{
  let l_b = get_platform_bounds(a_model_data, a_opts.model_info_attr);
  if (!l_b)
  {
    return { ok: false, file: undefined, source: 'grid', is_temp: false, message: 'No model bounds for build job image' };
  }
  // The margin leaves some white space around the parts.
  let l_min_x = l_b.min_x - a_opts.margin_mm;
  let l_min_y = l_b.min_y - a_opts.margin_mm;
  let l_dx = (l_b.max_x + a_opts.margin_mm) - l_min_x;
  let l_dy = (l_b.max_y + a_opts.margin_mm) - l_min_y;
  let l_step = Math.max(Math.max(l_dx, l_dy) / a_opts.max_pixels, S_MIN_STEP);

  let l_grid = new SV_GRID.bsScalarValueGrid2D();
  // 3 channels with 8 bits each (UInt8, values 0..255) = one color pixel.
  l_grid.initGrid({
    fGridOriginX: l_min_x, fGridOriginY: l_min_y, fGridOriginZ: 0.0,
    fGridStepSizeX: l_step, fGridStepSizeY: l_step,
    iGridStepCountX: Math.max(1, Math.ceil(l_dx / l_step)),
    iGridStepCountY: Math.max(1, Math.ceil(l_dy / l_step)),
    iGridValueChannelType: SV_GRID.nGridValueChannelTypeUInt8,
    iGridValueChannelCount: 3,
    initValueArray: S_COLOR_BACKGROUND
  });
  // initGrid always returns the grid object, also on failure (then the
  // grid is empty). Therefore isEmpty() is checked, not the return value.
  if (l_grid.isEmpty())
  {
    return { ok: false, file: undefined, source: 'grid', is_temp: false, message: 'initGrid failed' };
  }

  // The grid overwrites pixels (no transparency). Drawing all supports
  // first and then all parts keeps the parts visible on top, and the
  // image shows the union of all drawn layers.
  let l_layers = select_layers(a_model_data.getLayerCount());
  for (let i = 0; i < l_layers.length; ++i)
  {
    draw_layer_islands(l_grid, a_model_data, l_layers[i], MODEL.nSubtypeSupport, S_COLOR_SUPPORT_FILL, S_COLOR_SUPPORT_LINE);
  }
  for (let i = 0; i < l_layers.length; ++i)
  {
    draw_layer_islands(l_grid, a_model_data, l_layers[i], MODEL.nSubtypePart, S_COLOR_PART_FILL, S_COLOR_PART_LINE);
  }

  let l_tmp = new FILE.bsFile();
  if (!l_tmp.createTempFile())
  {
    l_grid.clear();
    return { ok: false, file: undefined, source: 'grid', is_temp: false, message: 'Failed to create temporary file' };
  }
  // PNG is binary data: no text encoding must change the bytes.
  l_tmp.setEncoding(FILE.nEncodingBinaryLE);
  // bFlipY: image row 0 is at the top, so +Y points up in the image.
  l_grid.exportToImageFilePNG(l_tmp, { iCompressionLevel: 6, bFlipY: true });
  l_grid.clear(); // free the memory
  // Nothing written (position still 0) means that the PNG export failed.
  if (l_tmp.tell() <= 0)
  {
    l_tmp.close();
    return { ok: false, file: undefined, source: 'grid', is_temp: false, message: 'PNG export failed' };
  }
  return { ok: true, file: l_tmp, source: 'grid', is_temp: true, message: '' };
}

/**
 * PNG image of the build job.
 * The function never throws: errors are returned as ok = false with a
 * message, because a missing preview image must not stop the export
 * of the toolpath (the caller only logs a warning).
 * The caller owns the returned file and must close it, for example
 * with zip_package.add_image_attachment or release_image_attachment.
 * @param {bsModelData} a_model_data
 * @param {{max_pixels:number, margin_mm:number, model_info_attr:string}} a_opts
 *        max_pixels: pixels of the longer image side; margin_mm: white
 *        border around the parts (mm); model_info_attr: model attribute
 *        with the bounds
 * @return {{ok:boolean, file:(bsFile|undefined), source:string, is_temp:boolean, message:string}}
 *         source is 'host' or 'grid'; is_temp tells whether the file is a temporary file
 */
exports.create_png_temp_file = function(a_model_data, a_opts)
{
  // The host image is already a PNG file.
  let l_host = get_host_image(a_model_data);
  if (l_host)
  {
    return { ok: true, file: l_host, source: 'host', is_temp: false, message: '' };
  }

  let r_res;
  try
  {
    r_res = create_grid_image(a_model_data, a_opts);
  }
  catch (e)
  {
    r_res = { ok: false, file: undefined, source: 'grid', is_temp: false,
      message: 'Build job image failed: ' + ((e && e.message) ? e.message : String(e)) };
  }
  return r_res;
};

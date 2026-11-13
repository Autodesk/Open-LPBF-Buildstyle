/************************************************************
 * MODULE NAME: zip_package.js
 *
 * PURPOSE:
 *   Write ZIP archives (also used for 3MF packages, which are ZIP
 *   files with a defined structure).
 *
 * WORKFLOW:
 *   open_zip -> add_text / add_temp_file / add_existing_file -> close_zip
 *   Every entry is first written to a temporary file; the archive
 *   then copies the temporary file into the entry.
 *   Why temporary files: the archive writer must know the size of an
 *   entry when the entry starts (putNextEntry). The size of a text is
 *   only known after it was written, so it is written to a temporary
 *   file first and the file size is used.
 *
 * USAGE:
 *   var ZIP = require('../export/zip_package.js');
 *   let l_res = ZIP.open_zip(exportFile, 6);
 *   if (!l_res.ok) return l_res;
 *   ZIP.add_text(l_res.archive, 'info/readme.txt', 'Hello');
 *   ZIP.close_zip(l_res.archive);
 *
 * DEPENDENCIES:
 *   Builtins: bsFile, bsFileArchiveWriter
 *   Modules : none
 *
 * BACKGROUND:
 *   An export package is the single file that is copied to the
 *   machine. It contains everything the machine (or an analysis
 *   tool) needs for one build job: the toolpath of every layer, the
 *   laser parameters, a preview image and the parameter snapshots
 *   that document how the job was made.
 *   A ZIP archive is one file that contains many files ("entries"),
 *   each with a name (which may include folders) and usually
 *   compressed. Toolpath text compresses very well, because the same
 *   digits and keywords repeat millions of times.
 *   Text files (CLI, LSR, XML, JSON) store numbers as readable
 *   characters; binary files (PNG image) store raw bytes. Both kinds
 *   can be entries of the same ZIP.
 *   The functions here return true/false or {ok, message} instead of
 *   throwing exceptions, so the caller can decide what to do and can
 *   report a clear message to the user.
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it.
 *   Tip: Entry names with '/' create sub folders inside
 *   the archive (for example 'layers/layer_00001.lsr').
 *   Tip: An entry name must be unique inside one archive;
 *   this module does not check it.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var FILE = requireBuiltin('bsFile');
var FAW = requireBuiltin('bsFileArchiveWriter');

/**
 * Create a temporary file with the given encoding.
 * The encoding defines how characters are turned into bytes, for
 * example UTF-8 (any character, 1..4 bytes each) or ANSI (one byte
 * per character). Toolpath text only uses ASCII characters, where
 * both encodings give the same bytes.
 * @param {number} a_encoding  For example FILE.nEncodingUTF8
 * @return {bsFile|undefined} Open temporary file or undefined on failure
 */
exports.create_temp_file = function(a_encoding)
{
  let r_file = new FILE.bsFile();
  if (!r_file.createTempFile()) return undefined;
  r_file.setEncoding(a_encoding);
  return r_file;
};

/**
 * Open a ZIP archive on the export file.
 * The archive writes directly into the export file that the host
 * opened for the user selected file name.
 * openArchiveExt reports failure by returning false or by throwing
 * (e.g. invalid options); both cases are turned into {ok:false}, so
 * the caller never writes entries into an archive that is not open.
 * @param {bsFile} a_file   Export file (opened by the host)
 * @param {number} a_level  Compression level 0..9 (0 = store only,
 *                          9 = smallest file but slowest; 6 is the
 *                          usual compromise)
 * @return {{ok:boolean, archive:(bsFileArchiveWriter|undefined), message:string}}
 */
exports.open_zip = function(a_file, a_level)
{
  if (!a_file || !a_file.isOpened())
  {
    return { ok: false, archive: undefined, message: 'Export file is not open' };
  }
  let l_archive = new FAW.bsFileArchiveWriter();
  let l_opened = false;
  try
  {
    l_opened = l_archive.openArchiveExt(a_file, {
      iArchiveType: FAW.nFileArchiveZip,
      iCompressionLevel: a_level
    });
  }
  catch (e)
  {
    let l_msg = (e && e.message) ? e.message : String(e);
    return { ok: false, archive: undefined, message: 'Could not open the ZIP archive: ' + l_msg };
  }
  // '=== false' only: a host that returns nothing (undefined) is treated
  // as success, the same rule as for writeFile in write_entry.
  if (l_opened === false)
  {
    return { ok: false, archive: undefined, message: 'Could not open the ZIP archive' };
  }
  return { ok: true, archive: l_archive, message: '' };
};

/**
 * Copy the content of a file (from position 0 to a_size) into a new entry.
 * An empty entry (size 0) is valid: only the entry header is written.
 * @param {bsFileArchiveWriter} a_archive
 * @param {string} a_name  Entry name inside the archive
 * @param {bsFile} a_file  Source file
 * @param {number} a_size  Number of bytes to copy
 * @return {boolean} true on success
 */
function write_entry(a_archive, a_name, a_file, a_size)
{
  a_archive.putNextEntry(a_name, a_size);
  if (a_size <= 0) return true;
  // '!== false' treats any other return value (also undefined) as success.
  return a_archive.writeFile(a_file, 0, a_size) !== false;
}

/**
 * Add a text entry (UTF-8).
 * Use this for small and medium texts that already exist as one
 * string (XML package files, JSON parameter files). Large layer data
 * should be written piece by piece into a temporary file instead
 * (see add_temp_file), so the whole text never has to be in memory.
 * @param {bsFileArchiveWriter} a_archive
 * @param {string} a_name  Entry name inside the archive
 * @param {string} a_text
 * @return {boolean} true on success
 */
exports.add_text = function(a_archive, a_name, a_text)
{
  let l_tmp = exports.create_temp_file(FILE.nEncodingUTF8);
  if (!l_tmp) return false;
  l_tmp.writeString(a_text);
  // After writing, the write position equals the size in bytes.
  let l_size = l_tmp.tell();
  let r_ok = write_entry(a_archive, a_name, l_tmp, l_size);
  l_tmp.close();
  return r_ok;
};

/**
 * Add a temporary file that was written by the caller. The current
 * write position is the size. The temporary file is closed afterwards.
 * Typical use: a writer streams one layer (or all layers) line by line
 * into the temporary file; this keeps the memory use low even for
 * builds with thousands of layers.
 * @param {bsFileArchiveWriter} a_archive
 * @param {string} a_name
 * @param {bsFile} a_tmp  Temporary file; do not use it after this call
 * @return {boolean}
 */
exports.add_temp_file = function(a_archive, a_name, a_tmp)
{
  let l_size = a_tmp.tell();
  let r_ok = write_entry(a_archive, a_name, a_tmp, l_size);
  a_tmp.close();
  return r_ok;
};

/**
 * Add an existing file (for example a file provided by the host).
 * The file is not closed (it belongs to the caller).
 * Here the whole file is copied (getFileSize), not only the part up
 * to the current position.
 * @param {bsFileArchiveWriter} a_archive
 * @param {string} a_name
 * @param {bsFile} a_file
 * @return {boolean}
 */
exports.add_existing_file = function(a_archive, a_name, a_file)
{
  let l_size = a_file.getFileSize();
  return write_entry(a_archive, a_name, a_file, l_size);
};

/**
 * Add the result of build_job_image.create_png_temp_file.
 * The image file is closed afterwards in both cases: a temporary file
 * is not needed any more, and a file handle provided by the host must
 * be closed after use.
 * The PNG is a binary file; it is copied byte by byte, no encoding
 * is applied.
 * @param {bsFileArchiveWriter} a_archive
 * @param {string} a_name
 * @param {{ok:boolean, file:bsFile, is_temp:boolean}} a_image
 * @return {boolean} false if there is no image or writing failed
 */
exports.add_image_attachment = function(a_archive, a_name, a_image)
{
  if (!a_image || !a_image.ok) return false;
  // A temporary file was written by the script: its write position is the size.
  if (a_image.is_temp) return exports.add_temp_file(a_archive, a_name, a_image.file);
  let r_ok = exports.add_existing_file(a_archive, a_name, a_image.file);
  a_image.file.close();
  return r_ok;
};

/**
 * Close the image file without adding it (for example when the export
 * was cancelled before the image was written).
 * Call it on every early return, so no file handle stays open.
 * @param {{ok:boolean, file:bsFile}|undefined} a_image
 */
exports.release_image_attachment = function(a_image)
{
  if (a_image && a_image.ok && a_image.file) a_image.file.close();
};

/**
 * Add several text entries.
 * All entries are attempted even if one fails, so as much
 * documentation as possible ends up in the package.
 * @param {bsFileArchiveWriter} a_archive
 * @param {string} a_prefix  Prefix for all names (for example 'Metadata/')
 * @param {Array} a_texts    [{name, text}]
 * @return {boolean} true if all entries were written
 */
exports.add_text_attachments = function(a_archive, a_prefix, a_texts)
{
  let r_ok = true;
  for (let i = 0; i < a_texts.length; ++i)
  {
    if (!exports.add_text(a_archive, a_prefix + a_texts[i].name, a_texts[i].text)) r_ok = false;
  }
  return r_ok;
};

/**
 * Finish the archive.
 * Must be called exactly once, also after errors: only closing writes
 * the ZIP directory at the end of the file. Without it the package
 * cannot be opened.
 * @param {bsFileArchiveWriter} a_archive
 */
exports.close_zip = function(a_archive)
{
  a_archive.closeArchive();
};

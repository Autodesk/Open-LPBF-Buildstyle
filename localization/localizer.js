/************************************************************
 * MODULE NAME: localizer.js
 *
 * PURPOSE:
 *   Return user visible texts in the language of the host
 *   application (process.language).
 *
 * BACKGROUND:
 *   Localization means showing the user interface in the user's
 *   language. The code never contains the visible texts itself; it
 *   asks for a text by a short key, for example 'grp_scanning_order'.
 *   Each language has one JSON file that maps the keys to texts:
 *     lang_en.json: { "grp_scanning_order": "Scanning order", ... }
 *     lang_de.json: { "grp_scanning_order": "Scanreihenfolge", ... }
 *   The same key gives the text of the language that is selected in
 *   the host (process.language, for example 'en' or 'de').
 *   The keys are an internal identifier and must not be translated.
 *
 * WORKFLOW:
 *   Used by the parameter declaration (names, descriptions, units,
 *   choice options) and by the export filter declaration.
 *
 * USAGE:
 *   var LOCALIZER = require('localization/localizer.js');
 *   let l_text = LOCALIZER.GetMessage('grp_hatching');
 *
 * DEPENDENCIES:
 *   Builtins: bsFile
 *   Modules : none (reads localization/lang_*.json)
 *
 * REUSE NOTES:
 *   Only English and German are fully translated. The other language
 *   files may be empty or incomplete. Therefore every key that is
 *   missing in the current language falls back to English. Only if the
 *   key is missing in English too, an exception is thrown (this is a
 *   programming error that must be fixed in lang_en.json).
 *   Tip: Always add a new text to lang_en.json first.
 *   Note: "empty" means a JSON file with an empty object '{}'. Only
 *   lang_en.json and the file of the host language are read. A missing
 *   or invalid file of the host language prints a warning and the
 *   texts appear in English; a missing or invalid lang_en.json throws
 *   (see LoadLanguageModules).
 *   Why an exception here instead of a return code? A missing English
 *   text is a bug in the project, not a user error, and it should be
 *   found the first time the text is used during development.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var FILE = requireBuiltin('bsFile');

// Language id -> file name (relative to the project folder).
// The ids must match the values of process.language of the host.
// To add a language: create the JSON file and add one line here.
var S_LANGUAGE_FILES = [
  ['en', 'localization/lang_en.json'],
  ['de', 'localization/lang_de.json'],
  ['ja', 'localization/lang_ja.json'],
  ['ko', 'localization/lang_ko.json'],
  ['zh-Hans', 'localization/lang_zh-Hans.json'],
  ['zh-Hant', 'localization/lang_zh-Hant.json'],
  ['es', 'localization/lang_es.json'],
  ['fr', 'localization/lang_fr.json'],
  ['pt-BR', 'localization/lang_pt-BR.json'],
  ['it', 'localization/lang_it.json'],
  ['pl', 'localization/lang_pl.json'],
  ['tr', 'localization/lang_tr.json']
];

var S_FALLBACK_LANGUAGE = 'en';

// Cache of the parsed language files: language id -> { key: text }.
// Only the host language and English are read, once per script context
// (each worker thread has its own copy of this module and therefore
// its own cache).
var language_modules = {};
var language_modules_loaded = false;
// Message of a failed English load. Kept, so later calls report the
// real cause without reading the file again.
var language_load_error = '';

/**
 * Load one language file into language_modules.
 * Throws if the file cannot be opened or is not valid JSON.
 * @param {string} a_sLanguageId    e.g. 'de'
 * @param {string} a_sJsonFileName  e.g. 'localization/lang_de.json'
 */
function LoadLanguageModule(a_sLanguageId, a_sJsonFileName)
{
  let l_lang_file = new FILE.bsFile();

  // OpenFileFromBuildstyleLib opens a file inside the build style
  // project folder; the files are read as UTF-8, so non-Latin
  // characters (for example Japanese) are kept.
  if (FILE.OpenFileFromBuildstyleLib(a_sJsonFileName, l_lang_file, FILE.nEncodingUTF8))
  {
    // readSubStr(-1): read the whole file as one string.
    let l_json_str = l_lang_file.readSubStr(-1);
    language_modules[a_sLanguageId] = JSON.parse(l_json_str);
  }
  else
  {
    throw new Error("Failed to load file '" + a_sJsonFileName + "'");
  }
}

/**
 * File name of a language id.
 * @param {string} a_sLanguageId  e.g. 'de'
 * @return {string} File name, '' if the language is not in S_LANGUAGE_FILES
 */
function FindLanguageFile(a_sLanguageId)
{
  for (let i = 0; i < S_LANGUAGE_FILES.length; ++i)
  {
    if (S_LANGUAGE_FILES[i][0] === a_sLanguageId) return S_LANGUAGE_FILES[i][1];
  }
  return '';
}

/**
 * Load the host language and English once (lazy, on first use).
 * "Lazy" means the files are only read when the first text is
 * requested, not when the module is loaded. Later calls return at once,
 * also after a failure (no retry from disk).
 * - English is required (fallback of every key): a failure throws, and
 *   every later call throws the same message.
 * - The host language is optional: a missing or invalid file only
 *   prints a warning, the texts then appear in English.
 */
function LoadLanguageModules()
{
  if (language_modules_loaded)
  {
    if (language_load_error !== '') throw new Error(language_load_error);
    return;
  }
  language_modules_loaded = true;

  try
  {
    LoadLanguageModule(S_FALLBACK_LANGUAGE, FindLanguageFile(S_FALLBACK_LANGUAGE));
  }
  catch (e)
  {
    language_load_error = (e && e.message) ? e.message : String(e);
    throw new Error(language_load_error);
  }

  let l_language_id = process.language;
  if (l_language_id === S_FALLBACK_LANGUAGE) return;
  let l_file_name = FindLanguageFile(l_language_id);
  if (l_file_name === '') return;
  try
  {
    LoadLanguageModule(l_language_id, l_file_name);
  }
  catch (e)
  {
    let l_msg = (e && e.message) ? e.message : String(e);
    process.printWarning('Localization: ' + l_msg + '; English texts are used instead.');
  }
}

/**
 * Get the localized message for the given id.
 * Lookup order: current language -> English -> exception.
 * @param {string} a_sId  Message key
 * @return {string} Text in the current language, English as fallback
 */
exports.GetMessage = function(a_sId)
{
  LoadLanguageModules();

  // 1. Current language of the host
  // (undefined if the host language is not in S_LANGUAGE_FILES or its
  // file could not be loaded)
  let l_language = language_modules[process.language];
  if ((l_language !== undefined) && (l_language[a_sId] !== undefined))
  {
    return l_language[a_sId];
  }

  // 2. Fallback per key: English (the reference language)
  // Per key means: a partly translated file still shows its own
  // texts; only the missing keys appear in English.
  let l_english = language_modules[S_FALLBACK_LANGUAGE];
  if ((l_english !== undefined) && (l_english[a_sId] !== undefined))
  {
    return l_english[a_sId];
  }

  // 3. Missing in English too: a programming error (see REUSE NOTES).
  throw new Error(
    "Missing localized string [" + a_sId + "] for language [" + process.language + "]");
};

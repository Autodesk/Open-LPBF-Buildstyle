/************************************************************
 * MODULE NAME: log.js
 *
 * PURPOSE:
 *   Small logging facade. All library modules write their
 *   messages through this module, so the output format (prefix)
 *   is the same everywhere and can be changed in one place.
 *
 * WORKFLOW:
 *   Used in every phase (parameters, exposure, post-processing,
 *   export). The project sets the prefix once in main/main.js.
 *
 * USAGE:
 *   var LOG = require('../util/log.js');
 *   LOG.set_prefix('[MY_PROJECT] ');
 *   LOG.warning('Something unexpected happened');
 *   LOG.warning_once('stipple_start', 'Shown only once per run');
 *
 * DEPENDENCIES:
 *   Builtins: none (uses the global 'process' object of the host)
 *   Modules : none
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Tip: A "facade" is a thin wrapper with a simple
 *   interface. If the host offers another output function one day,
 *   only this file has to change, not every module that logs.
 *   Log messages are plain English texts. Texts shown in the user
 *   interface (parameter names, descriptions) are localized instead
 *   (see localization/localizer.js).
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

// Module state. Every script context (e.g. every worker thread of the
// host) loads its own copy of this module, so the state is per context.
// Consequence: set_prefix must be called in every context (main.js does
// it at load time), and warning_once can show a warning once per
// context, so a multi-threaded step may print it once per thread.
var S_state = {
  prefix: '',
  // Keys of warnings that were already printed (see warning_once).
  // Tip: A Set stores each value at most once and can quickly
  // answer "is this value in the set?".
  warned_keys: new Set()
};

/**
 * Set the text that is put in front of every message.
 * The prefix makes it easy to find the messages of this build style
 * in a log that also contains messages of the host.
 * @param {string} a_prefix  e.g. '[MY_PROJECT] ' (empty string = no prefix)
 * @return {void}
 */
exports.set_prefix = function(a_prefix)
{
  // Anything that is not a string (undefined, a number, ...) resets the prefix.
  if (typeof a_prefix === 'string')
  {
    S_state.prefix = a_prefix;
  }
  else
  {
    S_state.prefix = '';
  }
};

/**
 * Print an information message.
 * @param {string} a_msg  English message text
 * @return {void}
 */
exports.info = function(a_msg)
{
  process.printInfo(S_state.prefix + a_msg);
};

/**
 * Print a warning message.
 * Tip: Use warnings for problems that do not stop the
 * calculation (e.g. one island could not be hatched).
 * @param {string} a_msg  English message text
 * @return {void}
 */
exports.warning = function(a_msg)
{
  process.printWarning(S_state.prefix + a_msg);
};

/**
 * Print an error message.
 * Printing an error does not abort the calculation. To abort, the
 * host entry point has to throw an exception.
 * @param {string} a_msg  English message text
 * @return {void}
 */
exports.error = function(a_msg)
{
  process.printError(S_state.prefix + a_msg);
};

/**
 * Print a warning only the first time the given key is used.
 * This avoids flooding the log with the same warning for every layer.
 * Example: a build with 2000 layers and the same problem on every
 * layer prints one warning instead of 2000.
 * @param {string} a_key  Unique key of the warning
 * @param {string} a_msg  English message text
 * @return {void}
 */
exports.warning_once = function(a_key, a_msg)
{
  if (S_state.warned_keys.has(a_key))
  {
    return;
  }
  S_state.warned_keys.add(a_key);
  exports.warning(a_msg);
};

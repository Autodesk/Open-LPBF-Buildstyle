/************************************************************
 * MODULE NAME: version_check.js
 *
 * PURPOSE:
 *   Warn the user if the build style processor of the host is
 *   older than the version this project was written for.
 *
 * BACKGROUND:
 *   The build style processor is the part of the host application
 *   that runs this script and provides the builtins (requireBuiltin).
 *   Newer processor versions add builtin functions and options. A
 *   script written for a newer version can fail or behave differently
 *   on an older one, for example when a builtin function is missing.
 *   A clear warning at the start is easier to understand than an error
 *   deep inside the calculation.
 *
 * WORKFLOW:
 *   Called once from declareMachine.
 *
 * USAGE:
 *   var VERSION_CHECK = require('../util/version_check.js');
 *   VERSION_CHECK.warn_if_older('1.25.12');
 *
 * DEPENDENCIES:
 *   Builtins: none (uses process.version of the host)
 *   Modules : ./log.js
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it. Settings are passed as plain objects.
 *   Tip: Version strings must be compared number by number.
 *   As plain strings, '1.9' would be "larger" than '1.25' because the
 *   character '9' comes after '2'.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

var LOG = require('./log.js');

/**
 * Split a version string like '1.25.12.4711' into numbers.
 * Every part between two dots gives exactly one number, so the
 * positions never shift: the first group of digits inside the part is
 * used ('v1' -> 1, '12-beta' -> 12, '12 (build 7)' -> 12), and a part
 * without any digit counts as 0 ('1.x.3' -> [1, 0, 3]).
 * Tip: /\d+/ is a regular expression that finds the first run
 * of one or more digits; exec() returns null if there is none.
 * @param {string} a_version  Version string
 * @return {number[]} e.g. [1, 25, 12, 4711]; empty array for a non-string
 */
function parse_version(a_version)
{
  let r_numbers = [];
  if (typeof a_version !== 'string') return r_numbers;
  let l_parts = a_version.split('.');
  for (let i = 0; i < l_parts.length; ++i)
  {
    let l_match = /\d+/.exec(l_parts[i]);
    // Radix 10: always decimal, even for parts with leading zeros.
    r_numbers.push(l_match ? parseInt(l_match[0], 10) : 0);
  }
  return r_numbers;
}

/**
 * Compare two version strings numerically.
 * Missing parts count as 0, so '1.25' equals '1.25.0'.
 * Example: compare_versions('1.25.12', '1.25.9') > 0 (12 > 9).
 * @param {string} a_a  Version A
 * @param {string} a_b  Version B
 * @return {number} < 0 if A is older, 0 if equal, > 0 if A is newer
 */
function compare_versions(a_a, a_b)
{
  let l_a = parse_version(a_a);
  let l_b = parse_version(a_b);
  let l_count = Math.max(l_a.length, l_b.length);
  for (let i = 0; i < l_count; ++i)
  {
    let l_va = (i < l_a.length) ? l_a[i] : 0;
    let l_vb = (i < l_b.length) ? l_b[i] : 0;
    // The first differing part decides.
    if (l_va !== l_vb) return l_va - l_vb;
  }
  return 0;
}

/**
 * Print a warning if the processor version is older than a_min_version.
 * The calculation is not aborted (the warning is only a hint).
 * The result is returned as a boolean instead of throwing, so the
 * caller can decide whether an older version is acceptable.
 * @param {string} a_min_version  Minimum version, e.g. '1.25.12'
 * @return {boolean} true if the version is ok (or unknown)
 */
exports.warn_if_older = function(a_min_version)
{
  let l_version = process.version;
  // Unknown version (not provided by the host): no warning, assume ok.
  if (typeof l_version !== 'string' || l_version.length === 0)
  {
    return true;
  }
  if (compare_versions(l_version, a_min_version) < 0)
  {
    LOG.warning('Build style processor version ' + l_version +
      ' is older than ' + a_min_version);
    return false;
  }
  return true;
};

// Also exported, so other modules can compare version strings too.
exports.compare_versions = compare_versions;

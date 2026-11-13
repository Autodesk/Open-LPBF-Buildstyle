/************************************************************
 * MODULE NAME: xml_text.js
 *
 * PURPOSE:
 *   Small helpers to write XML text safely (escaping and number
 *   formatting).
 *
 * WORKFLOW:
 *   Used by the 3MF toolpath writer to build XML strings.
 *   The writer builds every XML file as plain JavaScript strings
 *   (no XML library). These helpers make sure that the strings are
 *   always well-formed XML and that numbers look the same in every
 *   file.
 *
 * USAGE:
 *   var XML = require('../export/xml_text.js');
 *   let l_s = '<part' + XML.attr('id', 1) + XML.attr('name', 'A & B') + '/>';
 *   // -> <part id="1" name="A &amp; B"/>
 *
 * DEPENDENCIES:
 *   Builtins: none (pure JavaScript, can be tested outside the host)
 *   Modules : none
 *
 * BACKGROUND:
 *   XML is a text format made of elements like <layer> ... </layer>
 *   and attributes like id="1". Five characters have a special
 *   meaning in XML: '<' and '>' start and end a tag, '&' starts an
 *   entity (for example '&amp;'), and '"' / ''' end an attribute
 *   value. If such a character appears inside a value it must be
 *   replaced by its entity ("escaped"), otherwise the reader of the
 *   file (for example the machine software) cannot parse the file.
 *   Tip: 'exports.xyz = function ...' makes xyz visible to
 *   other files that load this module with require().
 *
 * REUSE NOTES:
 *   Project independent. Copy the whole 'lib' folder into another
 *   project to reuse it.
 *   Tip: Every text that comes from the user (for example
 *   part names) must be escaped, otherwise a single '&' or '"'
 *   makes the whole XML file invalid.
 *   Limitation: control characters (codes below 32 except tab, line
 *   feed and carriage return) are not allowed in XML 1.0 at all and
 *   are not removed here.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

/**
 * Escape a value for use inside an XML attribute ("...").
 * '&' is replaced first: otherwise the '&' of the entities created
 * by the later replacements ('&lt;' ...) would be escaped again.
 * The '/g' flag of each regular expression replaces ALL occurrences,
 * not only the first one.
 * @param {*} a_value  Any value (converted to a string)
 * @return {string} Text that can be placed between the quotes of an
 *         attribute, for example 'A & B' -> 'A &amp; B'
 */
exports.escape_attr = function(a_value)
{
  return String(a_value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

/**
 * One XML attribute with a leading space.
 * The leading space allows simple chaining:
 * '<part' + attr('id', 1) + attr('uuid', u) + '/>'.
 * @param {string} a_name   Attribute name (written as is, must be a
 *                          valid XML name; it is NOT escaped)
 * @param {*} a_value       Attribute value (escaped)
 * @return {string} ' name="value"'
 */
exports.attr = function(a_name, a_value)
{
  return ' ' + a_name + '="' + exports.escape_attr(a_value) + '"';
};

/**
 * Number with at most a_digits decimals and without trailing zeros.
 * Why: shorter text means smaller files, and toFixed() alone would
 * write '0.500000'. The round trip toFixed -> Number -> toString
 * removes the trailing zeros. toString() of such a rounded number
 * normally gives plain decimal notation (no '1e-7' style exponent).
 * @param {number} a_v       Value (must be a number, not undefined)
 * @param {number} a_digits  Maximum number of decimals (0..20)
 * @return {string} For example num(0.50000, 6) -> '0.5'
 */
exports.num = function(a_v, a_digits)
{
  let r_s = Number(a_v.toFixed(a_digits)).toString();
  // Avoid '-0' for tiny negative values.
  // Defensive check: in standard JavaScript (-0).toString() already
  // returns '0', so this branch only matters for unusual engines.
  return (r_s === '-0') ? '0' : r_s;
};

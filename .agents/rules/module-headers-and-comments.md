---
description: Mandatory module header, JSDoc on every function, English-only explanatory comments
alwaysApply: true
globs: ["**/*.js"]
---

# Module headers and comments

This project is meant to teach as well as to work. Readers include process engineers who are new to JavaScript and developers who are new to LPBF. Comments carry that knowledge, so they are part of the deliverable.

## Module header

Every `.js` file starts with a block comment in this form:

```js
/************************************************************
 * MODULE NAME: <file_name>.js
 *
 * PURPOSE:
 *   What the module does, in a few sentences.
 *
 * WORKFLOW:
 *   Which entry point or step calls it, and when.
 *
 * USAGE:
 *   var NAME = require('../folder/<file_name>.js');
 *   let l_res = NAME.some_function(...);
 *
 * DEPENDENCIES:
 *   Builtins: bsXxx, ... (or: none)
 *   Modules : ../util/log.js, ... (or: none)
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
```

The copyright line must match the copyright notice in `LICENSE` exactly.

Required sections: `MODULE NAME`, `PURPOSE`, `WORKFLOW`, `USAGE`, `DEPENDENCIES`.

Optional sections, used where they add value: `REUSE NOTES` (all `lib/` modules), `BACKGROUND` (the physics or machine behavior), `NOTES`, `EXTENSION NOTES`.

When you change what a module requires or exports, update `DEPENDENCIES` and `USAGE` in the same change.

## Functions

- Every function, exported or internal, gets a JSDoc block with a one-line summary, `@param {type} name` with units, and `@return`.
- Document result objects in the type: `@return {{ok:boolean, message:string}}`.

## Comment style

- All comments are in **English**.
- Explain **why**, not only what. Use the existing markers:
  - `Tip:` explains a JavaScript or host concept to a reader who is new to it.
  - `Why:` explains a design decision.
  - `Note:` points out a non-obvious consequence.
- Use the glossary terms from the header of `main/main.js` (island, hatch, stripe, BSID, downskin, scan field, ...).
- Write plain, short sentences. Avoid jargon that the glossary does not define.
- Do not leave commented-out code, debug output or personal TODOs without context.

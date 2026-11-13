---
description: The ATU build style runtime is not Node.js; use host builtins and project-relative require
alwaysApply: true
globs: ["**/*.js"]
---

# Host environment: ATU build style processor

The code runs inside the build style processor of ATU, on the Google V8 engine. It looks like Node.js but **is not**.

## Available

- `requireBuiltin('bsXxx')` returns a host module. Assign it to an UPPER_CASE alias at the top of the module:
  ```js
  var HATCH = requireBuiltin('bsHatch');
  var ISLAND = requireBuiltin('bsIsland');
  ```
  Builtins used in this project: `bsBuildParam`, `bsColRGBAi`, `bsFile`, `bsFileArchiveWriter`, `bsHatch`, `bsHatchInfo`, `bsIsland`, `bsModel`, `bsModelFeatures`, `bsParam`, `bsPolylineIterator`, `bsSingleHullAndCoreGenerator`, `StringUtil`.
- `require('path/to/module.js')` loads a project module once per script context and returns its `exports`. Paths are relative to the project folder (`main/`) or to the current file (`lib/`). See `lib-is-project-independent.md`.
- The global `process` object: `process.version` (processor version), `process.language` (host UI language), `process.printInfo` / `process.printWarning` (use them only through `lib/util/log.js`).
- Standard ECMAScript objects such as `Math`, `JSON`, `Map`, `Set`, `Array` and `Object.freeze`.

## Not available

- No Node.js APIs or modules: no `fs`, `path`, `os`, `Buffer`, `child_process`, no `npm` packages. Use `bsFile` and `bsFileArchiveWriter` for files.
- No ES modules: no `import` or `export` statements.
- No browser APIs: no `window`, `document`, `fetch`, timers.
- No network access.

## Compatibility

- `main/main.js` defines `S_min_processor_version`. `declareMachine` warns if the host is older (`lib/util/version_check.js`).
- Before you use a builtin function or option that this project does not use yet, check the ATU build style documentation for the processor version that added it. If it needs a newer version, raise `S_min_processor_version` and mention that in the change description.
- Do not guess builtin APIs. If you cannot confirm that a function exists, ask, or follow an existing call in this repository.
- Host-defined entry points and constants (for example, `MODEL_FEATURES.nFeatureShadowBox`) keep their host spelling.

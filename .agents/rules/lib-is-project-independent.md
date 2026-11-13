---
description: lib/ is a reusable library; it never depends on main/ or localization/
alwaysApply: true
globs: ["lib/**/*.js", "main/**/*.js"]
---

# `lib/` is project independent

The `lib/` folder is designed to be copied as a whole into other build styles. `main/` is the project-specific wiring that connects `lib/` to this build style.

## Rules for `lib/`

- **Never require `main/` or `localization/`** from a `lib/` module.
- **Use relative paths** between `lib/` modules: `require('../util/log.js')`, `require('./laser_bsid.js')`. This keeps `lib/` working wherever it is copied.
- **Settings come in as plain objects.** A `lib/` function does not read parameters from the host itself. `main/settings.js` reads parameters once in `prepareModelExposure`, converts them to plain objects and passes them on.
- **Localized text is injected.** If a `lib/` module needs user-visible text (for example, the parameter factories), it receives a text function such as `a_text` from the caller. See `lib/params/param_factories.js`.
- **No project constants.** BSIDs, vector type keys, export filter IDs and the project name belong in `main/`. A `lib/` module receives them as arguments.
- Each `lib/` module header has a `REUSE NOTES` section that states this independence.

## Rules for `main/`

- Use project-root paths: `require('lib/exposure/contours.js')`, `require('main/settings.js')`.
- Keep `main/` thin: read settings, call `lib/` functions, combine results. Put reusable algorithms in `lib/`.

## When you are unsure

If a new function needs something from `main/`, pass it in as an argument or settings field. Do not add the dependency.

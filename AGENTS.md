# AGENTS.md

This file gives guidance to AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository.

## Additional rules: `.agents/rules/`

This repository keeps its detailed coding rules in `.agents/rules/*.md`. **These rules are binding.** Treat them as part of this file, not as optional notes.

Before you write or change code, read the rules that apply. Every rule has a front matter block:

- `alwaysApply: true` means the rule applies to every change.
- `globs:` lists the files where the rule is most relevant.

Current rules:

| File | Covers |
|------|--------|
| `javascript-style.md` | Naming prefixes (`a_`, `l_`, `r_`, `S_`), Allman braces and single-line statements, `'use strict'`, strict equality |
| `module-headers-and-comments.md` | Mandatory module header sections, JSDoc, English-only explanatory comments |
| `error-handling.md` | `{ ok, message }` result objects; only `main/main.js` throws to the host |
| `lib-is-project-independent.md` | `lib/` never requires `main/`; settings come in as plain objects |
| `multi-threaded-exposure.md` | `makeExposureLayer` runs in parallel script contexts; no layer state in module variables |
| `host-environment.md` | ATU build style runtime: `requireBuiltin`, `require` paths, no Node.js or browser APIs |
| `localization.md` | All user-visible text through `LOCALIZER.GetMessage`; keep all 12 language files in sync |
| `project-file.md` | Register new files in `OSS_MPBF_01.fsp`; keep entry points and BSIDs stable |
| `verify-changes.md` | Local checks to run, and fixing root causes instead of hiding symptoms |
| `open-source-hygiene.md` | No confidential data, no temporary files, product naming, license headers |

The table is only a summary. Read the rule file itself for its content. If a rule file is added, removed or changed, the file on disk wins over this table. Update this table in the same change.

On a conflict between a rule file and this file, follow the more specific and more recently updated guidance, and say which one you followed.

## Project overview

**Open LPBF Buildstyle** is an open source build style for laser powder bed fusion (LPBF), also called metal powder bed fusion (MPBF). The project is named `OSS_MPBF_01`.

A build style is a set of JavaScript modules that runs inside **ATU (Advanced Toolpath Utility)** from Autodesk. ATU slices the parts; the build style turns every slice into laser vectors (contours, hatches, supports), orders them, assigns them to lasers, optimizes power, estimates exposure time and exports the result.

- **Repository**: https://github.com/Autodesk/Open-LPBF-Buildstyle
- **License**: BSD 2-Clause (`LICENSE`)
- **Language**: JavaScript, run by the ATU build style processor (Google V8 engine). This is not Node.js.
- **Project file**: `OSS_MPBF_01.fsp` (XML; lists every file of the build style)
- **Minimum build style processor version**: `1.25.12` (`S_min_processor_version` in `main/main.js`)
- **Build style version**: `PROJECT_VERSION` in `main/settings.js`

## Repository layout

```
OSS_MPBF_01.fsp     Project file; open this in ATU
main/               Project-specific wiring (entry points, parameter tree, BSID table)
lib/                Reusable, project-independent modules
  params/           Parameter group class, group factories and readers
  exposure/         Contours, hatch patterns, rotation, skin split, hull/core, supports
  geometry/         Island operations and gas flow
  sorting/          Exposure order and contour start point history
  power/            Power model and power optimization
  multi_laser/      Scanner array, swimlanes, laser assignment (load balancing)
  time/             Exposure time estimation and scanner delays
  export/           Toolpath reader and LSR, CLI+, 3MF and ZIP writers
  util/             Attribute names, log, math, random, layer skip, version check
localization/       localizer.js and lang_<language>.json (12 languages)
```

Start reading at `main/main.js`. Its header contains a glossary of LPBF terms (island, hatch, stripe, BSID, downskin, scan field, swimlane and more) and a guide to the rest of the code. Use those terms in code and comments.

## Execution model

ATU calls the entry points exported by `main/main.js` in this order:

1. `about` - version info
2. `declareParameters` - parameter tree (built in `main/param_groups.js`)
3. `declareMachine` - machine name, materials, layer thicknesses
4. `declareBuildAttributes` - attributes stored at the vectors
5. `declareExportFilter` - export formats
6. `declareModelFeatures` - shadow box, hull and core
7. `prepareModelExposure` - read parameters once per model and store them as model attributes (`main/settings.js`)
8. `makeExposureLayer` - vectors of one layer; **runs multi-threaded** (`main/exposure_layer.js`)
9. `configurePostProcessingSteps` - start points, order, laser assignment, power, time (`main/postprocess.js`)
10. `exportToFile` / `exportToDirectory` - write the export package (`main/export_main.js`)

`declareBuildstyleProperties` is also exported. Entry point names and their camelCase arguments are defined by the host and must not be renamed.

## Key domain concepts

- **BSID (build style ID)**: integer at every vector that selects the laser parameter set. The full table is `VECTOR_TYPES` in `main/vector_types.js`. Downskin variant = normal BSID + 1. All BSIDs must stay below 1000, because the laser assignment encodes `(laser index + 1) * 1000 + BSID` (`lib/multi_laser/laser_bsid.js`).
- **Custom table**: one entry per BSID with laser number, power (W), speed (mm/s) and focus offset (mm). Exporters read it.
- **Units**: lengths in mm, power in W, speed in mm/s, angles in degrees, layer thickness in micrometers, delays in microseconds.

## Common extension tasks

These recipes are also in the `EXTENSION NOTES` of `main/main.js`. Keep both places in sync.

- **New vector type**: add an entry to `VECTOR_TYPES` in `main/vector_types.js`, add the `vec_<key>` text to all language files, create the vectors in `main/exposure_layer.js`.
- **New hatch pattern**: key in `PART_PATTERN_KEYS` (`main/param_groups.js`), parameters in `create_hatch_group` (`lib/params/param_factories.js`), reader in `read_hatch` (`lib/params/param_readers.js`), `case` in `create_pattern_hatch` (`lib/exposure/hatch_patterns.js`).
- **New exporter**: use the path records of `toolpath_reader.read_layer_paths` and add attachments with `add_common_attachments` (`main/export_main.js`). Every export filter needs a unique, stable filter ID string.
- **New file**: add it to the matching `<Filter>` in `OSS_MPBF_01.fsp`.

## Verifying changes

There is no automated test suite. The build style only runs inside ATU. Before you finish:

1. Run the local static checks in `.agents/rules/verify-changes.md` (syntax check of every `.js` file, JSON and key check of the language files).
2. State clearly what you could not verify. Changes to toolpath generation, export or post-processing need a run in ATU: open `OSS_MPBF_01.fsp`, compute a test part, check the log for `[OSS_MPBF_01]` warnings, check the preview and export.

## Git and contributions

- Do not commit or push unless the user asks.
- Keep commits focused. Do not mix formatting changes with behavior changes.
- Source files use CRLF line endings. Keep the existing line endings of any file you edit.

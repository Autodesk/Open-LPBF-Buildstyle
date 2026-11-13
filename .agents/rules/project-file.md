---
description: Keep OSS_MPBF_01.fsp in sync with the files; keep host-facing IDs stable
alwaysApply: true
globs: ["OSS_MPBF_01.fsp", "main/**/*.js", "lib/**/*.js", "localization/**"]
---

# Project file and stable identifiers

## `OSS_MPBF_01.fsp`

ATU loads the build style through the project file `OSS_MPBF_01.fsp`. It lists every file in one of three filters: `main`, `lib` and `localization`.

- When you add a file, add a `<File Path="..."/>` line to the matching filter.
- When you rename or delete a file, update or remove its line.
- Keep forward slashes in paths. Keep the existing XML formatting and CRLF line endings.
- Do not change `ProjectUUID` or `Type`.

## Identifiers that must stay stable

Saved ATU projects, machine parameter tables and downstream tools rely on these values. Do not change them without an explicit decision by the maintainers, and call the change out as breaking:

- **Entry point names** exported by `main/main.js` (`about`, `declareParameters`, `makeExposureLayer`, ...).
- **BSIDs** in `VECTOR_TYPES` (`main/vector_types.js`). New types get new, unused numbers below 1000. The downskin variant is the normal BSID + 1.
- **Export filter IDs** (`S_filter_*` in `main/export_main.js`). A new filter gets a new unique ID string in the same format.
- **Parameter IDs** in the parameter tree (`main/param_groups.js`, `lib/params/param_factories.js`). Renaming a parameter loses the user's stored value.
- **Model attribute names** (`MODEL_ATTR` in `main/settings.js`) and vector attribute names (`lib/util/attribute_names.js`).
- **Localization keys** (see `localization.md`).

## Versioning

- `PROJECT_VERSION` in `main/settings.js` is the build style version shown in `about()`. Use `<major>.<minor>.<patch>`.
- Raise the version when behavior or output changes. Maintainers decide the exact number at release time; do not bump it on your own unless asked.

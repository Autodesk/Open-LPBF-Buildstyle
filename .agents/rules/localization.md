---
description: All user-visible text goes through the localizer; keep all language files in sync
alwaysApply: true
globs: ["localization/**", "main/**/*.js", "lib/params/**/*.js"]
---

# Localization

## User-visible text

- Every text that the user sees in ATU (parameter names, descriptions, units, choice options, export filter names, the build style description) comes from `LOCALIZER.GetMessage('key')`. Never hard-code such text in the code.
- Log messages (`LOG.warning`, `LOG.info`) are English and are **not** localized.
- In `lib/`, receive the text function as an argument (see `lib-is-project-independent.md`).

## Language files

The project ships 12 language files in `localization/`: `en`, `de`, `es`, `fr`, `it`, `ja`, `ko`, `pl`, `pt-BR`, `tr`, `zh-Hans`, `zh-Hant`. All files have the same set of keys.

When you add or rename a key:

1. Add it to `lang_en.json` first. English is the fallback; a key missing in English throws at run time.
2. Add the same key to **every** other `lang_*.json`, in the same position as in `lang_en.json`.
3. If you cannot provide a good translation, use the English text and say so in the change description. Do not leave a key out.

When you remove a key, remove it from all files.

## Key naming

Keys are internal IDs and are never translated. Follow the existing prefixes:

| Prefix | Use |
|--------|-----|
| `grp_` | Parameter group name |
| `vec_` | Vector type name (`vec_<key>` for every entry in `VECTOR_TYPES`) |
| `filter_` | Export filter name |
| `unit_` | Unit label |
| `bs_` | Build style metadata |
| none | Parameter name in snake_case, for example `hatch_offset` |

Descriptions (tooltips) use the same key with the suffix `_descr`: `grp_hull_core_descr`, `hatch_offset_descr`.

## Adding a language

Create `lang_<id>.json` with all keys, add one line to `S_LANGUAGE_FILES` in `localization/localizer.js`, and add the file to the `localization` filter in `OSS_MPBF_01.fsp`. The ID must match `process.language` of the host.

## Format

Language files are UTF-8 JSON. Keep the blank-line grouping of `lang_en.json`. Check that every file still parses after an edit (see `verify-changes.md`).

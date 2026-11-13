---
description: JavaScript naming and formatting conventions of this build style
alwaysApply: true
globs: ["**/*.js"]
---

# JavaScript style

Match the style of the surrounding code. The rules below describe what the existing modules already do.

## Naming

| Kind | Convention | Example |
|------|------------|---------|
| File names | snake_case | `hatch_patterns.js`, `laser_assignment_math.js` |
| Functions (exported and internal) | snake_case | `make_contour_hatch`, `read_layer_paths` |
| Function arguments | `a_` prefix | `a_island`, `a_inset` |
| Local variables | `l_` prefix | `l_isl`, `l_materials` |
| Return value variable | `r_` prefix | `r_hatch`, `r_map` |
| Module-level state (static) | `S_` prefix | `S_state`, `S_color_cache`, `S_project_version` |
| Class members | `m_` prefix | `m_displayName` |
| Constants and exported tables | UPPER_SNAKE_CASE | `VECTOR_TYPES`, `MODEL_ATTR`, `PROJECT_VERSION` |
| Builtin and module aliases | UPPER_SNAKE_CASE | `var HATCH = requireBuiltin('bsHatch');` |
| Loop counters | short names | `i`, `k` |

**Exception:** host entry points in `main/main.js` (`declareParameters`, `makeExposureLayer`, ...) and their arguments (`modelData`, `nLayerNr`, ...) use camelCase, because the host defines these names. Do not rename them.

## Formatting

- Start every module with `'use strict';` right after the header comment.
- Allman braces: the opening brace goes on its own line for functions, `if`, `else`, `for` and `while`.
- Indent with 2 spaces. No tabs.
- Always use braces, even for single-line blocks.
- Use `let` for local variables. Use `var` for module-level aliases and `S_` state, as the existing code does.
- Always use `===` and `!==`.
- Export with `exports.name = function(a_arg) { ... };`. Do not use `module.exports = ...` or ES module `export`.

## Keep it simple and debuggable

- Prefer plain `for` loops and explicit `if` statements over chained functional constructs, so the code is easy to step through in the ATU debugger.
- One purpose per function. Split long functions into named helpers.
- Name values with units when it helps: `l_speed_mm_s`, `l_delay_us`.
- Do not introduce new language features or patterns that no other module uses without a clear reason.

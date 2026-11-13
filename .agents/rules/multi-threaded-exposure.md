---
description: makeExposureLayer runs in parallel script contexts; module state is per thread
alwaysApply: true
globs: ["main/exposure_layer.js", "main/main.js", "lib/exposure/**/*.js", "lib/geometry/**/*.js", "lib/util/**/*.js"]
---

# Multi-threaded exposure

ATU calls `makeExposureLayer` for many layers at the same time. Each worker thread has its **own script context**: every module is loaded again per thread, and module variables are **not shared** between threads.

## Do

- Pass all data a layer needs through arguments and model attributes. `prepareModelExposure` stores the settings as model attributes; `makeExposureLayer` reads them back (`require_model_object` in `main/main.js`).
- Keep layer results local to the call that creates them, and hand them to the host through the hatch result.
- Make per-layer behavior a function of the layer number and settings only. For random choices, build the seed with `RANDOM.make_seed(layer_nr, island_id, bsid)` and never use `Math.random()` (see `lib/util/random.js`). The same input must always give the same vectors.
- Do work that needs several layers (start point history, ordering, laser assignment, power, time) in post-processing (`configurePostProcessingSteps`, `main/postprocess.js`).

## Do not

- Do not store layer results, counters or "previous layer" data in module variables. The next layer may run in another thread, and layers do not run in order.
- Do not rely on `S_` caches to be filled. A cache is allowed only if every thread can rebuild it from constant data (for example, `S_color_cache` in `main/vector_types.js`).
- Do not assume `LOG.warning_once` prints once per build. It prints once per script context.

## Parameter cache

Parameter values can change between calls when the user edits them. Every entry point that reads parameters calls `clear_cached_parameter_values()` first. Keep this pattern in new entry points.

# Open LPBF Buildstyle

An open source build style for laser powder bed fusion (LPBF), also called metal powder bed fusion (MPBF), written in JavaScript for **ATU (Advanced Toolpath Utility)** from Autodesk.

A build style decides how the laser melts each layer of a part: which paths it scans, in which order, with which laser and with which parameters. This project gives you a complete, documented build style that you can use as it is, study to learn how LPBF toolpaths are made, or adapt to your own machine and material.

**Documentation website: [autodesk.github.io/Open-LPBF-Buildstyle](https://autodesk.github.io/Open-LPBF-Buildstyle/)**: tutorials for every feature, with videos in ATU, interactive models and code walkthroughs.

## Features

- **Contours**: first border with beam compensation, following borders, fill contours, contour direction and start point control, line stipple.
- **Hatching**: meander, stripe, chess, hexagon and offset patterns, with hatch angle rotation from layer to layer (default +67°).
- **Skin handling**: separate downskin and upskin areas with their own parameters.
- **Hull and core**: outer shell and inner core with different hatching; the core can be exposed only every n-th layer.
- **Narrow regions**: blocked paths for areas too thin for regular contours.
- **Supports**: wall supports and solid supports.
- **Exposure order**: configurable order of vector types, sorting along the shielding gas flow, platform, model, island or global build order.
- **Multi-laser machines**: scanner array with overlapping scan fields and laser assignment (load balancing) with field split and swimlane strategies.
- **Power optimization** and **exposure time estimation** with scanner delays.
- **Export**: LSR, CLI+ (single file or one file per layer, in a ZIP) and 3MF toolpath packages (with power ramps, power per edge or power support points).
- **Localized user interface** in 12 languages.

## Requirements

- ATU with build style processor version **1.25.12** or newer. The build style shows a warning if the processor is older.

No other software is needed. The build style runs inside ATU; there is nothing to build or install.

## Getting started

1. Clone the repository:
   ```bash
   git clone https://github.com/Autodesk/Open-LPBF-Buildstyle.git
   ```
2. In ATU, open the project file `OSS_MPBF_01.fsp`.
3. Add a part, choose a material and a layer thickness, and compute the toolpath.
4. Check the preview. Each vector type has its own color.
5. Export with one of the export filters (LSR, CLI+ or 3MF).

> **Note:** The default laser parameters (power, speed, focus) are generic examples. They are not validated for any machine or material. Set the parameters for your machine and material before you use the output on real hardware.

## How it works

ATU calls the entry points that `main/main.js` exports, in this order:

| Step | Entry point | What it does |
|------|-------------|--------------|
| 1 | `about` | Version info |
| 2 | `declareParameters` | Builds the parameter tree the user edits |
| 3 | `declareMachine` | Machine name, materials, layer thicknesses |
| 4 | `declareBuildAttributes` | Attributes stored at every vector |
| 5 | `declareExportFilter` | Export formats |
| 6 | `declareModelFeatures` | Shadow box, hull and core |
| 7 | `prepareModelExposure` | Reads the parameters once per model |
| 8 | `makeExposureLayer` | Creates the vectors of one layer (runs multi-threaded) |
| 9 | `configurePostProcessingSteps` | Start points, exposure order, laser assignment, power, time |
| 10 | `exportToFile` | Writes the export package |

Every vector carries a **BSID** (build style ID) that selects its laser parameter set:

| BSID | Vector type | BSID | Vector type |
|------|-------------|------|-------------|
| 100 | First border | 500 | Volume hatch |
| 101 | First border, downskin | 501 | Downskin hatch |
| 110 | Blocked path | 510 | Core hatch |
| 200 | Following borders | 520 | Upskin hatch |
| 201 | Following borders, downskin | 600 | Open path of a part |
| 300 | Fill contour | 700 | Wall support |
| 301 | Fill contour, downskin | 710 | Solid support |

With laser assignment, the laser is encoded in the BSID: `(laser index + 1) * 1000 + BSID`. For example, 2500 is a volume hatch on the second laser.

New to LPBF? The header of `main/main.js` has a glossary of the terms used in the code, such as island, hatch, stripe, downskin, scan field and swimlane.

## Project structure

```
OSS_MPBF_01.fsp     Project file; open this in ATU
main/               Project-specific wiring
  main.js           Entry points, glossary and reading guide
  vector_types.js   BSID table with default parameters and colors
  param_groups.js   Parameter tree
  settings.js       Parameters -> plain settings objects
  exposure_layer.js Vectors of one layer
  postprocess.js    Steps over the whole build
  export_main.js    Export filters
lib/                Reusable modules, independent of this project
  params/           Parameter groups, factories and readers
  exposure/         Contours, hatch patterns, skin, hull/core, supports
  geometry/         Island operations and gas flow
  sorting/          Exposure order and start point history
  power/            Power model and optimization
  multi_laser/      Scanner array and laser assignment
  time/             Exposure time and scanner delays
  export/           LSR, CLI+, 3MF and ZIP writers
  util/             Logging, math, random numbers and other helpers
localization/       Texts in 12 languages
```

The modules in `lib/` do not depend on `main/`. They take plain settings objects, so you can copy the whole `lib/` folder into your own build style and write your own `main/` wiring.

## Customizing

Typical changes, step by step:

- **Change default parameters** of a vector type: edit `VECTOR_TYPES` in `main/vector_types.js`.
- **Add a vector type**: add an entry to `VECTOR_TYPES`, add the text `vec_<key>` to all language files, and create the vectors in `main/exposure_layer.js`.
- **Add a hatch pattern**: add the key to `PART_PATTERN_KEYS` (`main/param_groups.js`), its parameters to `create_hatch_group` (`lib/params/param_factories.js`), its reader to `read_hatch` (`lib/params/param_readers.js`) and its implementation to `create_pattern_hatch` (`lib/exposure/hatch_patterns.js`).
- **Add an exporter**: read the vectors with `read_layer_paths` (`lib/export/toolpath_reader.js`) and register the filter in `main/export_main.js`.

Register every new file in `OSS_MPBF_01.fsp`.

## Localization

All texts that the user sees come from `localization/lang_<language>.json`: English, German, Spanish, French, Italian, Japanese, Korean, Polish, Portuguese (Brazil), Turkish, Chinese (Simplified) and Chinese (Traditional). English is the fallback for missing texts. When you add a text, add it to `lang_en.json` first, then to all other language files.

## Contributing

Contributions are welcome. Before you open a pull request:

- Follow the conventions in [AGENTS.md](AGENTS.md) and [.agents/rules/](.agents/rules/). They apply to human contributors and AI coding agents alike.
- Run the local checks in [.agents/rules/verify-changes.md](.agents/rules/verify-changes.md).
- Test your change in ATU and describe what you tested.
- Do not include confidential data, such as customer parts or non-public machine parameters.

To report a bug or suggest a feature, open an issue on GitHub.

## License

This project is licensed under the BSD 2-Clause License. See [LICENSE](LICENSE) for the full text.

Copyright (c) 2026, Autodesk Inc. (Original Author)

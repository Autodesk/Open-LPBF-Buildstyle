---
description: Public repository; no confidential data, no temporary files, correct product naming
alwaysApply: true
---

# Open source hygiene

This repository is public. Everything you add can be read, copied and indexed by anyone.

## No confidential or internal content

Do not add any of the following to code, comments, commit messages or documentation:

- Internal URLs, ticket links or ticket IDs, internal server or share names, build agent names.
- Credentials, API keys, tokens or license keys.
- Customer names, customer part geometry, customer build data or customer-specific parameter sets.
- Machine vendor parameters, recipes or file formats that are not public.
- Personal data, such as names or email addresses, except in a contributors list that the person agreed to.
- Code or text copied from closed source code or from other projects with an incompatible license.

Default laser parameters in this project are generic examples. Do not replace them with validated values from a real machine or material unless they are public and their source is cited.

## No temporary files in the repository

Only files that are meant to be committed belong in the working tree.

- Do not create one-off scripts, debug logs, exported toolpaths, ZIP files or screenshots in the repository. Use the system temp directory.
- Remove debug output (`LOG.info` calls added for an investigation) before you finish.
- Do not commit ATU user files, build outputs or editor settings.

## Product naming

- The host application is **ATU (Advanced Toolpath Utility)** from Autodesk. Write "ATU" in new text.
- Do not use the old name "Fabbify" or "Fabbify Studio" in new code, comments or documentation.
- In code comments, "the host" or "the host application" is fine and keeps `lib/` independent of a specific product.

## Licensing

- The project is licensed under the BSD 2-Clause License (`LICENSE` in the repository root). Do not change or remove `LICENSE`.
- Every new source file uses the same copyright line as the existing files.
- Add third-party code only if its license is compatible with BSD 2-Clause, and record its origin and license in the module header. Do not add code under copyleft licenses (for example GPL) without an explicit decision by the maintainers.

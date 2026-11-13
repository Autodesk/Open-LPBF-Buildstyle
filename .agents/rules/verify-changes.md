---
description: Local checks before finishing, and fixing root causes instead of symptoms
alwaysApply: true
---

# Verify changes

There is no automated test suite: the build style only runs inside ATU. Run the local checks below, then state clearly what still needs a run in ATU.

## Local checks

Node.js is used only as a **syntax checker** here. The code does not run in Node.js (`requireBuiltin` does not exist there).

1. Syntax check every JavaScript file:
   ```bash
   for f in $(find main lib localization -name '*.js'); do node --check "$f" || echo "FAIL $f"; done
   ```
2. Check that every language file parses and has the same keys, in the same order, as `lang_en.json`:
   ```bash
   node -e "const fs=require('fs');const d='localization/';const en=Object.keys(JSON.parse(fs.readFileSync(d+'lang_en.json','utf8')));for(const f of fs.readdirSync(d).filter(x=>x.endsWith('.json'))){const k=Object.keys(JSON.parse(fs.readFileSync(d+f,'utf8')));console.log(f,JSON.stringify(k)===JSON.stringify(en)?'ok':'MISMATCH')}"
   ```
3. Check that every `.js` and `.json` file under `main/`, `lib/` and `localization/` is listed in `OSS_MPBF_01.fsp`, and that every listed file exists.
4. Search for every caller of a function whose signature or result shape you changed, and update them.

## Checks in ATU

Changes to parameters, toolpath generation, post-processing or export need a run in ATU:

1. Open `OSS_MPBF_01.fsp` in ATU and compute a test part.
2. Check the log for messages with the `[OSS_MPBF_01]` prefix.
3. Check the toolpath preview (colors come from `VECTOR_TYPES`).
4. Export with every affected export filter and open the result.

If you cannot run ATU, say so and list what the user should check.

## Fix the root cause

A failure, a warning in the log or wrong vectors are a signal about the code. Treat them that way.

- Fix the module that causes the problem: the algorithm, the settings conversion or the parameter default.
- Do not hide it: do not catch and ignore errors, do not suppress warnings, do not special-case one test part, and do not weaken input validation.
- If an input is really unsupported, return `{ ok: false, message }` with a clear text, and document the limit in the module header.
- If you only work around a problem, say what the real defect is and why the workaround is still acceptable.

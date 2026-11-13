---
description: Return { ok, message } result objects; only main/main.js throws to the host
alwaysApply: true
globs: ["lib/**/*.js", "main/**/*.js"]
---

# Error handling

## Return result objects, do not throw

Functions that can fail return a result object instead of throwing:

```js
return { ok: false, message: 'Hatch distance must be greater than 0.' };
return { ok: true, hatch: r_hatch };
```

- `ok` is always present. On failure, `message` is a plain English text that names the cause.
- Use the same shape even if a function cannot fail today (see `make_contour_hatch` in `lib/exposure/contours.js`). Callers can then handle every helper the same way.
- Callers must check `ok`. They decide what to do: abort, print a warning with `LOG.warning` and continue (for example, skip one island that cannot be hatched), or ignore the problem.

**Why:** a thrown exception stops the whole calculation in the host. Result objects show in the code which calls can fail, and let every caller choose how serious the failure is.

## Where exceptions are allowed

- `main/main.js` turns fatal results into `throw new Error(...)`. ATU shows the message to the user.
- Programming errors that must be found during development may throw. Existing cases: a missing English text in `localization/localizer.js`, an unknown parameter type or path in `lib/params/atu_param_group_class.js`, and the documented throws in `lib/params/param_readers.js` and `lib/export/tp3mf_writer.js`.
- Host builtins may throw. Where that is possible, say so in the JSDoc, as `tp3mf_writer.js` does.

Do not add new exceptions in `lib/` for situations a user can cause through parameters or geometry. Validate the input and return `{ ok: false, message }`.

## Warnings

- Use `lib/util/log.js` (`LOG.warning`, `LOG.warning_once`). Do not call `process.print*` directly from `lib/`.
- Log messages are English and are not localized. Texts shown in the user interface are localized (see `localization.md`).
- In per-layer code, use `LOG.warning_once` with a stable key to avoid flooding the log.

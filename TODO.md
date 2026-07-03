# TODO

## Frontend: version picker

The data layer already stores full per-version metadata (title, description,
favicon, format, encrypted, label, size, created_at) for every version, and
`GET /api/artifacts/:id` returns the complete version history. The viewer
route (`GET /a/:id`) serves any version via `?v=N`. What's missing is a
**frontend control** that lets a viewer browse versions.

### Goal

A small, unobtrusive version selector on the artifact page so a viewer can:

- See how many versions exist and which one they're looking at.
- Switch to an older version (and back to the latest) without editing the URL.
- See each version's label and timestamp.

### Constraints

- Must work inside the strict CSP (`sandbox allow-scripts; default-src
  'none'`) — no external requests, all inline. The metadata for the picker
  must be inlined into the page at serve time (the sandbox blocks `fetch`
  to `/api/artifacts/:id`).
- Must respect the theme system (`data-theme` light/dark).
- Must not appear on the encrypted unlock shell (the shell loads before
  decryption; the picker belongs to the rendered content inside the sandbox
  iframe, or it should be omitted for encrypted artifacts until unlocked).
- Keep it minimal — a `select` or a small dropdown, not a full sidebar.
  Matches the existing theme-toggle button's restraint.

### Implementation sketch

1. **Server (`src/index.ts` + `src/wrap.ts`)**: when serving `GET /a/:id` for
   a plain artifact, inline the version list (version numbers + labels +
   timestamps, capped to the last ~50) as a JSON blob in the page. Add a
   `<oa-version-picker>` element + a small inline script that, on change,
   navigates to `?v=<n>`.
2. **Markup**: a compact control near the theme toggle (bottom-right cluster)
   showing "v3 of 5" with a dropdown. Highlight the current version.
3. **Encrypted artifacts**: skip the picker on the unlock shell. Inside the
   decrypted iframe, the picker can be part of the wrapped document if the
   version metadata is inlined into the envelope's template — but this is
   more involved; a simpler first cut is to only show the picker for plain
   artifacts and leave encrypted ones as "latest only" until a later pass.
4. **Tests**: extend `tests/worker/viewer.test.ts` to assert the picker is
   present on plain pages with >1 version, reflects `?v=`, and is absent on
   the encrypted unlock shell.

### Out of scope for this pass

- Diffing between versions.
- Deleting old versions from the UI (the API has no per-version delete; the
  whole artifact is deleted via `DELETE /api/artifacts/:id`).

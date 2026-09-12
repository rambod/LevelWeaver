# Documentation and code audit

Date: 2026-09-13. Generator version after fixes: **0.1.4**.

## Scope and method

Reviewed the product brief, generation lawbook, runtime rules, generation pipeline,
validators, mesh builders, preview resource handling, export, and store/UI workflow.
The working tree was clean at the start. The original production build passed,
but there was no automated test command. Eight initial regression tests reproduced
defects before fixes; additional regressions cover winding, requested portal sizes,
store behavior, real GLB serialization, and download URL lifetime.

This is a focused correctness audit, not certification that every numbered law
or every seed/configuration is supported. No rendering redesign, backend, or new
runtime dependency was introduced.

## Documentation and rule improvements

- Added `README.md` with installation, commands, architecture, failure behavior,
  and the distinction between automated tests and historical debug scripts.
- Added `AGENTS.md` with contributor rules for validation, deterministic generation,
  resource ownership, artifact/config separation, regression tests, and verification.
- Clarified document authority and distinguished example APIs and reference
  dimensions from actual runtime defaults. Fixed the stale project-brief link.
- Defined the supported input envelope, diagnostic candidate contract, export
  requirements, and generator-version policy. Hard validity requirements remain
  requirements; lower error counts do not make a failed candidate valid.

## Fixed defects

| Finding | Resolution and evidence |
| --- | --- |
| Numeric fields accepted NaN/Infinity, fractional counts and unbounded workloads | Validate all numeric fields before arithmetic; reject invalid counts, ranges and selectors. Tests cover every numeric field, resource limits and prototype-key preset names. |
| A one-room configuration can overwrite Spawn with Exit | Require at least two rooms for the current mandatory Spawn/Exit topology. |
| Stair math accepted NaN/Infinity tread depth | Reject non-finite treads before computing a flight. |
| Door validation could accept dimensions below the user's request | Enforce requested width/height during repair scoring and final validation; reject a requested gate wider than its corridor before generation. |
| Box and corridor winding disagreed with face normals | Correct box Z faces and orient arbitrary box/ribbon triangles against their outward normals. Tests cover reflected/rotated boxes, straight/turning corridors; final mesh validation detects opposing winding. |
| Export mesh validation skipped most stair parts and attribute integrity | Check steps, risers, stringers, landings, shaft walls/floor, normals, UVs, triangle indices and attribute lengths. |
| Export trusted incomplete/stale success state | Require successful validation and recheck structural meshes and transforms before Three.js conversion. |
| Preview ignored the artifact theme when loading a map | Apply the generated configuration's theme during scene update. |
| Theme switching leaked materials and rebuilt geometry | Reassign shared materials in place and dispose the prior material set; geometry identities and collision snapshots survive recoloring. |
| Export theme/filename could disagree with the displayed artifact | Keep theme changes in the artifact's configuration; capture the artifact for asynchronous export and use its seed for the filename. Include seed, units, generator version and configuration in GLB scene extras. |
| Temporary export geometries and materials were never disposed | Release resources on both exporter success and failure. |
| Blob URLs were revoked immediately after clicking an unattached link | Attach the download link, remove it after clicking, and defer URL release. Automated regression verifies the lifetime; browser download completion remains unverified. |
| Regenerate, Random Seed and preset selection bypassed generation error handling | Route all actions through one UI wrapper and consistent store failure state. Failed generation preserves the prior artifact. Successful scene replacement exits walk mode. |
| Vite/esbuild dependency advisories | Updated Vite from 5.4.21 to 6.4.3 and retained compatible Vue plugin 5.2.4. `npm audit` reports zero vulnerabilities. |

The Vite update uses the nearest patched major supported by the existing plugin.
The upstream [Windows path handling advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)
lists 6.4.3 as patched. This is a development dependency update, not a claim that
the application was exploited.

## Verification

- `npm test`: **13 passing tests**. Includes actual `GLTFExporter` binary output,
  GLB header/JSON inspection, material values, metadata, hierarchy, resource
  disposal on success/failure, and malformed-input regressions.
- `npm run test:seeds`: **32 passing cases**, each generated twice and compared
  deeply. Eight presets × seeds **1, 7, 42, 99**, using
  `applyPreset(getDefaultConfig(), preset)` with the specified seed.
  Every case has the requested room count, valid mesh buffers/winding, and zero
  hard validation errors. Input configuration is unchanged by generation.
- `npm run build`: passes Vue/TypeScript checks and Vite production bundling.
- `npm audit`: zero reported vulnerabilities after the dependency update.
- In-app browser: default map renders; theme selection preserves displayed map
  statistics; fractional room count produces a configuration error; Regenerate
  produces the same handled error; prior artifact remains; valid input recovers.
  Final geometry changes were visually inspected after reload.

## Remaining limitations and follow-up priorities

1. **Coverage is bounded.** This matrix does not cover all map shapes, parameter
   extremes, or seeds. It checks analytical/grid validation, not a full physical
   walkthrough of every route. The existing `stairbot.ts` skips some failures and
   prints results without failing the process; it remains a diagnostic tool.
2. **Target architecture is not fully implemented.** The lawbook's distinct
   immutable connection-intent model, explicit junction semantics and full staged
   reservation API remain targets. For example, overlapping portal separation is
   currently reported as a warning to accommodate shared mouths; explicit shared
   portal records would allow strict classification without guessing intent.
3. **Generation runs on the main thread.** Retry counts and input sizes are bounded,
   but large/difficult maps can still stall interaction. The 32-case matrix took
   about 42 seconds for 64 generations on this machine after stricter gate checks.
   Profile representative large maps before choosing a worker architecture.
4. **Bundling warning remains.** The main production chunk is about 721 kB
   (202 kB gzip). Build passes; code splitting and render performance need separate
   profiling rather than hiding the warning.
5. **Export interoperability coverage is incomplete.** Binary GLB contents pass
   automated inspection. The in-app browser's download-event wait timed out without
   an application error, so a completed save was not confirmed. Unreal, Blender,
   Firefox and a complete pointer-lock walkthrough were not tested in this audit.
6. **External reference audit is limited.** Historical architectural/research links
   in the lawbook were preserved, not re-certified. They are background references;
   runtime dimensions and executable tests define the implemented behavior.

Stricter input/portal checks and corrected winding intentionally change acceptance
and some geometry/layout results. Seeds must be reproduced with the same generator
version; **0.1.3 and 0.1.4 are not interchangeable**.

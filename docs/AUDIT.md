# Documentation and code audit

Date: 2026-09-13. Generator version after fixes: **0.1.6**.

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
| Regenerate, Random Seed and preset selection bypassed generation error handling | Route all actions through one UI wrapper and consistent store failure state. Rejected configurations preserve the prior artifact with an alert; diagnostic candidates (`ok: false`) replace the preview with visible validation errors and cannot export. Successful scene replacement exits walk mode. |
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

## Follow-up review (2026-09-13, generator version unchanged: **0.1.4**)

Re-checked this audit against the implementation. `npm test` (13 passing),
`npm run test:seeds` (32 passing), `npm audit` (zero vulnerabilities), and the
Vite bundle size (~721 kB / ~202 kB gzip) all still match this document, and the
DPLAN reference link resolves. Four corrections were made; none changes
generation output or validation acceptance, so `GENERATOR_VERSION` stays 0.1.4:

- `npm run build` typechecking had regressed: `tests/regressions.test.ts` passed
  an `Error` where `@types/three` declares the exporter error callback as
  `ErrorEvent` (the Three.js runtime rejects with `Error`). The test now casts,
  and `exportGLB` preserves a rejection `.message` before falling back to
  `String(error)`. Full `npm run build` passes again.
- Form bounds were narrower than the lawbook §0 envelope they claimed to
  expose: Rooms minimum 4 (runtime: 2), Dead Ends maximum 0.5 (runtime: 1.0),
  Seed maximum 999999 (runtime: u32), Corridor/Gate minimum 1.0 m (runtime:
  0.80 m agent minimum). Widened to the envelope; envelope endpoints are now
  asserted in the existing configuration regression test.
- Failure wording distinguished: rejected configurations preserve the prior
  artifact; diagnostic candidates (`ok: false`) replace the preview with
  visible errors and cannot export (lawbook §0 contract and the table above).
- `README.md` project map now lists all `src/core` modules and the actual
  `src/generator` stage directories.

## Full-system audit (2026-09-13, generator version **0.1.4 → 0.1.5**)

Deep pass over topology, rooms, placement, corridors, stairs, validation,
presets, and export, driven by measurements (8 presets × 25 random seeds =
200 generations, plus the 32-case matrix). Output and acceptance changed, so
`GENERATOR_VERSION` was bumped per `AGENTS.md`; seeds reproduce only on the
same version.

Baseline before fixes: 196/200 ok (98.0%). Every hard failure was one of two
signatures: (a) an islanded upper floor — omitted stairs cascading into
`FLOOR_DISCONNECTED` + `GRAPH_DISCONNECTED` + `NAV_UNREACHABLE_ROOM`; the
retry loop usually cured it but sometimes exhausted. (b) tower-shaft mouths
cut at 1.2 m against requested 1.8 m gates (`PORTAL_TOO_NARROW`): towers were
~1% of built stairs and 100% of them failed validation. Dead-end hubs
(13/206) and leaf spawns (11/96) were common; all eight presets dealt
near-identical room mixes (only counts differed).

Stairs and vertical circulation:

- Tower mouths now meet the requested gate width (`towerMouthWidthFor` in
  `src/generator/vertical`): wider gates get a wider, recentered hole inside
  the shaft inner faces with corner-margin checks; gates wider than the
  shaft skip towers honestly (in-room fallback, then omission). Towers went
  from 3 to 138 per 240 links with zero narrow-gate failures.
- Shafts are reserved BEFORE corridors claim open space (lawbook §40):
  a towers-only probe pass feeds shaft rects into routing as pseudo-room
  obstacles (A*, smoothing, verifier) without touching midpoint selection
  or validation. Optional parameters only — legacy routing is byte-identical
  when no shafts reserve.
- Omitted links now report `STAIR_NO_PLACEMENT` (tier 1 in `errorTier`):
  bridge omissions (no alternate realized path) are errors in attempt
  scoring and the final report; redundant omissions are warnings on the
  final report only, so intent edges are never silently dropped (§87).
- `circulationGap` is derived from the router's own clearance
  (`corridorWidth/2 + wallThickness + ROUTING_MARGIN`, floored at 3.5 m);
  the `0.45` margin lives in one place (`src/core/rules`) and the density
  feasibility check uses the same function.

Corridors:

- The best-of-two variant search grew from 4 to 10 wall-ban combos with
  first-clean-wins ordering (clean edges cost exactly what they did; only
  foul edges search deeper), and the variant pass now also triggers on
  `CORRIDOR_CROSSING`, not just mouth fouls.
- Junction objects (§34/§35 construction) remain future work: crossings
  ship, validators report, bounded retry re-routes. See remaining gaps.

Topology, halls, and dead ends:

- Degree repair (lawbook §14, soft): hubs top up to 3, halls/arenas/
  connectors/stair-halls to 2, spawn/exit to 2 (linear end stations exempt),
  on placed rooms with real footprints (§100 capacity) and a 24 m
  short-link cap so repair cannot drag placement across the map.
- Dead-end pruning never cuts vertical links or spawn/exit incident edges,
  respects type minimums, and caps branch depth at 2 (lawbook §13).
  Dead-end hubs fell 13 → 5 per comparable sweep; zero-link rooms stayed 0.
- Loop extras pre-check §100 wall capacity (tree and guarantee links stay
  exempt — connectivity beats looks).
- Large-room quota is a deterministic seeded reservation, not a coin flip.

Presets (lawbook §88-89, validity never bypassed):

- Per-preset room-type lottery weights (`Preset.roomTypeWeights`): office
  deals halls/standards, warehouse chambers, horror halls/closets, arena
  loops for FPS, etc. Mixes now differ visibly where they were noise.
- Wall-height character: office/horror 3.2 m, dungeon 3.8 m, warehouse
  4.2 m high-bay. Corridor widths unchanged.

Verification after fixes: `npm test` **19/19** (6 new regressions, each with
fixed rooms/config/seed), `npm run build` passes (typecheck + Vite;
bundle ~728 kB / ~205 kB gzip after the feature pass),
`npm run test:seeds` **32/32**, `npm audit` zero vulnerabilities, wide sweep
**200/200 with zero errors** (previously 196/200). Generation is ~2-3×
faster on average (attempt-0 succeeds far more often, so retry rarely runs).

Remaining gaps (honest failures by design, never silent corruption):

- Extreme packing (e.g. 4 m corridors between 20 m+ rooms) can still
  produce mouth/crossing fouls on adversarial seeds (~1% on warehouse-class
  sweeps, 0% on the other seven presets). Diagnostics name the corridor and
  the code; export stays refused; a new seed retries cleanly.
- In-room stair arrivals avoid upper corridor slabs but cannot cut them;
  arrival holes exist for room slabs only.
- Only tower shafts reserve early; full vertical-before-circulation
  co-design (in-room entries steering mouth choice) is future work.
- Redundant vertical intents report `STAIR_NO_PLACEMENT` warnings instead
  of being removed from the graph; explicit and export-safe.

## Solidity pass (2026-09-13, generator version **0.1.5 → 0.1.6**)

Fresh seeds plus extreme-config fuzz (278 generations, each generated twice
and compared: **zero nondeterminism**), focused on generation solidity —
speed, scale behaviour, and the legal-minimum envelope. Small maps
(≤40 rooms: every preset and seed-matrix case) are byte-identical by
construction; every scale mitigation below is gated above them.
`GENERATOR_VERSION` bumped (validation acceptance changed for narrow
corridors; budgets/loops change large-map outputs).

Correctness:

- Narrow-but-legal corridors (0.8 m) failed navigation validation: the
  0.1 m walkable strip rasterized to zero cells when the centerline fell
  between cell centers, and the corner-cut guard then ate even the
  centerline chain on diagonals. The grid now opens explicit centerline
  cells (traversable by construction — same honesty class as door-throat
  bridges; sub-diameter corridors stay dark) and the flood may step
  diagonally between two centerline cells (exact by transitivity along the
  sampled chain). The 0.8 m extreme config passes; white-box regression
  pins both directions.
- Navigation resolution adapts to 0.5 m past 1M cells (rooms keep ≥3 cells
  across their smallest legal interior; links stay exact), bounding
  validation memory/time on huge maps.

Performance (measured wall-clock, same machine):

- Routing queries use a uniform-grid spatial index (lawbook §95) with the
  exact legacy predicates — verdicts identical by construction (buckets can
  only skip entries that fail the predicate). A* and the simple fallback
  share one query per call; the dead `isPointBlocked` helper is gone.
- Retry budgets scale harder: >50 rooms 2×2 attempts, >80 rooms 1×2.
  Loop extras scale 40/n past 40 rooms. Variant mouth repair runs only at
  ≤50 rooms (at scale the fouls are systematic, not unlucky mouths).
- 100 rooms: 189 s → 18 s. 60 rooms: 34 s → 7.5 s. Presets: unchanged
  (~0.3 s). Routing `0.45` margin centralized as `ROUTING_MARGIN`.

Verification: `npm test` **20/20** (1 new regression), `npm run build`
passes (bundle ~729 kB / ~205 kB gzip), `npm run test:seeds` **32/32**,
`npm audit` clean, sweep 263/278 (94.6%). Non-preset failures: 100-room
systematic corridor fouls ×6 (fast and honest, see below), ring-dense
singles ×3, and 6 config throws that were test-patch artifacts (gate wider
than corridor — correctly rejected; the 2-room minimum generates in ~15 ms).
Seeds reproduce only on the same version; 0.1.5 ≠ 0.1.6 outputs at scale
and on narrow corridors.

Remaining gaps: 100-room single-floor maps systematically over-constrain
planar routing without junction objects (seals/crossings in the dozens);
ring-band monsters and miter-joint wall spikes are unmodeled by the
capsule math; in-room stair arrivals avoid but cannot cut corridor slabs;
full vertical-before-circulation co-design stays future work.

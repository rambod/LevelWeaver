# Documentation and code audit

Date: 2026-09-13. Generator version after fixes: **0.1.7**.

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

## Open-gaps pass (2026-09-13, generator version **0.1.6 → 0.1.7**)

Closed the remaining structural gaps that measurements could pin to a
mechanism, with a router foul-provenance census (temporary, removed
afterwards) guiding each fix. Outputs change only on previously-failing
seeds — every repair is gated so clean layouts never change — but the
version still bumps per `AGENTS.md`.

Topology:

- Ring/cross intent chords that span infeasible voids (courtyard hole,
  inter-arm corners) are born unroutable. Tree, extras, and same-floor
  merges now prefer hole-clear pairs (chord sampled against the boundary
  shape) with unfiltered fallback, so connectivity guarantees hold.
  Chords of convex shapes never leave the shape: identical pools and RNG
  streams there, provably zero churn. Two of three ring-dense failures
  fixed at the source.

Junctions (lawbook §34-35, the crossing fix):

- `findCorridorCrossings` (shared with the validator, identical verdicts)
  also reports the first proper X-crossing point; near-miss brushes stay
  errors but are not junction candidates.
- `planJunctions` converts up to 3 crossing pairs per layout into explicit
  plaza rooms (sized for one gate per wall, checked against boundary,
  rooms, and tower shafts): blind intent edges are removed, all four ends
  rewired through the plaza, and only the stubs re-route — kept corridors
  stay byte-identical via prebuilt seeding (paths, mouths, doors).
  Removed pairs are forbidden from resurrecting as subdivision hops, and
  hop search prefers plazas (validator-skipped shared endpoints).
- Best-of-two adoption: the repair only lands on strictly better tiers.
  The third ring-dense failure now resolves through a live plaza; the
  32-case matrix is untouched (no crossings there).

Stairs:

- Tower planning now mirrors the seal validator in both directions:
  shaft walls vs every gate thread (validator-exact segments), and the
  shaft mouth thread vs exact corridor wall volumes. Capsule avoidance
  alone missed the 0.6-1.15 m thread band; walk-zone checks alone missed
  corridor walls. Proven gap closed by construction, not by tuning.

Verification: `npm test` **22/22** (2 new: white-box plaza conversion
plus the ring/40448 integration pin), `npm run build` green,
`npm run test:seeds` **32/32** (junction-aware room count), `npm audit`
clean, 130-generation sweep 127/130 (97.7%) with zero nondeterminism.
Residual failures are dense-map corridor fouls (60-room, warehouse-class
singles) that fail honestly with named codes. Seeds reproduce only on the
same version; 0.1.6 ≠ 0.1.7 outputs on previously-failing seeds.

Still open (no measured mechanism, architectural): junction absorption of
third ribbons through a plaza spot (vetoed, stays reported), miter-joint
wall spikes beyond capsule math, in-room arrivals vs corridor slabs, full
vertical-first co-design, and systematic 100-room single-floor
over-constraint without junctions at that density.

## Solidity pass 2 (2026-09-15, generator version **0.1.7 → 0.1.8**)

Targeted the two measured residual classes from the sweeps above —
wide-corridor mouth fouls (warehouse 4 m ribbons re-entering endpoints)
and hole-blocked junction plazas (ring courtyard crossings with no
placeable center) — with repairs gated so clean layouts never change.
`GENERATOR_VERSION` bumped per `AGENTS.md` (acceptance changed on
previously-failing seeds; clean seeds are byte-identical by construction).

Corridors (`src/generator/corridors`):

- Foul subdivision searches 15 m for midpoint hops (was 12 m). The 12 m
  radius is kept for long-link pre-subdivision; only pinched
  mid/mouth-foul edges search wider, so clean edges route byte-identically.
  Warehouse/181 (mouth foul) now subdivides into clean hops and passes;
  warehouse/141 improves 3 errors → 1 honest mouth foul. Ring/40457
  improves 2 errors → 1 crossing before the junction fix below cures it.

Generation (`src/core/generation`):

- Junction plazas use deterministic spiral placement: exact crossing
  point first, then compass rings at 1-6 m. Exact-center plazas never
  move (ring/40448 byte-identical); hole-blocked centers nudge into the
  walkable band. Best-of-two adoption still rejects the repair unless
  strictly better, so bad nudges never land. Ring/40457 (brush + seal)
  now resolves through a nudged plaza and passes.
- Small-map retry budgets grow 8 → 12 layouts (≤20 rooms only). Clean
  seeds break early on attempt 0 (no cost, no output change); failing
  small seeds get 36 layouts instead of 24. Large-map budgets unchanged
  (main-thread stall risk, lawbook §94).

Verification after fixes: `npm test` **24/24** (2 new: warehouse/181
mouth-subdivision pin, ring/40457 nudged-plaza pin, each with full
config + seed and determinism check), `npm run test:seeds` **32/32**,
`npm audit` clean. Focused sweeps (each generated twice, zero
nondeterminism): warehouse preset seeds 100-199 **99/100** (was 98/100;
residual warehouse/141 fails honestly with a single
`CORRIDOR_ROOM_COLLISION` mouth foul, export refused); ring 24-room
seeds 40440-40459 **18/20** (was 17/20; residuals 40454
`PORTAL_SEALED` + mouth foul and 40458 lone `CORRIDOR_CROSSING`, both
honest with named codes). Presets × seeds 100-109 **80/80**. Seeds
reproduce only on the same version; 0.1.7 ≠ 0.1.8 outputs on
previously-failing seeds (clean seeds unchanged).

Still open (unchanged architectural gaps, plus one new measurement):
extreme 4 m-corridor packing still over-constrains ~1% of
warehouse-class seeds (141: single mouth foul after 36 layouts);
ring-band hole crossings without a band spot in 6 m stay honest
failures (40458); brush crossings with no proper point stay
non-junction candidates by design (lawbook §34-35); miter-joint spikes,
in-room arrivals vs corridor slabs, full vertical-first co-design, and
100-room single-floor over-constraint remain future work. No validator
was weakened and no error downgraded to make seeds pass.

## Solidity pass 3 (2026-09-15, generator version **0.1.8 → 0.1.9**)

Two measured defects, both fixed with repairs gated so clean layouts
never change (`GENERATOR_VERSION` bumped: acceptance changed on
previously-failing seeds; clean seeds are byte-identical by
construction — attempt-0 still wins and breaks before any comparison,
exact-center plazas still place first, foul-only code paths never run
on clean edges).

Retry selection ranked unrepairable placement failures evenly with
repairable routing failures (`src/core/validation`):

- `ErrorTiers` gains `t1p` (placement: `ROOM_OVERLAP`, `ROOM_NESTED`,
  `ROOM_OUT_OF_BOUNDS`, `ROOM_TOO_SMALL` — shared predicate
  `isPlacementFailure`, mirroring the mouth-repair veto plus
  `ROOM_TOO_SMALL`, since rooms are never resized after sizing).
  `compareTiers` orders `t1p` before total `t1`, then `t2`, `t3`;
  `clean()` semantics are unchanged. Rationale (lawbook §2, §70
  repair order): no corridor, mouth, or stair repair can cure a
  body-truth placement failure — only a different placement can — so a
  layout with one 9 m² overlap must never beat a placeable layout with
  two repairable mouth fouls. Ring/40462 and ring/40473 shipped massive
  overlaps (9–10 m²) as winners under even trading; both now resolve
  to placeable (still honestly failing) winners. The mouth-repair veto
  itself is intentionally untouched, so variant behavior on failing
  layouts is unchanged.

Compact junction plazas (`src/core/generation`, `planJunctions`):

- Spiral candidates now try full side then a 2.4 m fallback at each
  offset (2.4 m clears the 2.4 m room minimum and hosts one 1.8 m gate
  per wall per §100: needs 2.3 m). Dense bands that cannot clear 4 m
  (3 m plaza + 0.5 m pads) often clear 3.4 m. Full-size center goes
  first, so existing plazas never shrink; best-of-two adoption still
  rejects compact plazas whose stubs foul. White-box probe: a crossing
  whose 3 m center is fouled by a parked room converts to a 2.4 m
  plaza with all four ends realized (one via §87 hop around the
  blocker).

Verification after fixes: `npm test` **26/26** (2 new: tier-ordering
unit pin + compact-plaza white-box pin with corridor reachability
proof), `npm run test:seeds` **32/32**, `npm run build` green.
Focused sweeps (each generated twice, zero nondeterminism): presets ×
seeds 200-209 **80/80**; warehouse 200-229 **30/30**; ring 24-room
40460-40484 **20/25** (residuals, all honest with named codes:
40461 seal + mid-foul, 40462 4 seals + mouth foul, 40469 lone seal,
40473 6 seals + 3 mouth fouls, 40483 lone crossing). Seeds reproduce
only on the same version; 0.1.8 ≠ 0.1.9 on previously-failing seeds.

Measured but deferred (no safe mechanism this pass):

- Residual seals are all corridor-wall-caused (in-room stairs only;
  tower count is zero on every residual seed — the h2 planner mirror
  holds). Two sub-causes observed: neighbor-ribbon walls crossing
  threads, and own-wall turn-in-bubble seals (40454 dist 0.00).
  Corridor-intrusion predicates in router and validator were diffed
  line-by-line and agree (same erosion, exemptions, sampling), so
  shipped fouls come from bounded-recursion exhaustion (depth-3 hops
  ship honestly, lawbook §69), not predicate drift. Hypotheses for
  next pass (not implemented): cap exit-leg straightening at half
  door distance for short pinched pairs, and a second junction round
  for independent residual crossings.
- Junction-stub phantom edges (graph claims a room–plaza edge no
  shipped corridor realizes; BFS/reachability use corridors, so levels
  still validate honestly): 3–4 levels per sweep, including passing
  ones (e.g. horrorFacility/208, ring/40465). Cleanup was deferred
  because removal could drop a passing plaza below the ≥4-connection
  structural assertion; the safe form (realize-via-alt-mouths first,
  remove only with ≥4 realized left) is specified for next pass.
- Ring-band hole crossings needing a >6 m nudge (40458, deep in the
  courtyard void) stay honest failures; wider spirals were judged
  likely to lose best-of-two adoption to long foul-prone stubs.

## Solidity pass 4 (2026-09-16, generator version **0.1.9 → 0.1.10**)

Ring-band census on 0.1.9 (24-room seeds 40460-40484: 24/30, all
double-generated with zero nondeterminism) showed three fixable
classes: lone crossings with no plaza placed, mid-size winners stuck
at 15 layout draws, and phantom stub edges padding plaza topology.
All three fixes are gated so previously-passing seeds keep passing
(proved below); `GENERATOR_VERSION` bumped for output/acceptance
changes on previously-failing seeds.

Generation (`src/core/generation`):

- 21-30-room retry bracket grows 5 → 8 layouts (15 → 24 draws).
  Clean seeds break early on attempt 0 at identical cost; failing mid
  seeds get a wider repair search. Ring/40489 (lone crossing, no
  placeable plaza inside 15 draws) now passes; 40454 and 40458 also
  resolve clean, as do 40469 and 40483 on re-measurement. Proven
  necessary: with 5 layouts 40489 fails in 10.5 s; with 8 it passes.
- Plaza spiral widens 6 → 9 m, strictly additive (rings 7-9 run only
  when 0-6 m all fail, center-first order kept), still under
  best-of-two adoption. Negligible cost: extra rect checks run only
  when crossings exist.
- §87 honesty in `planJunctions`: stub pairs with no shipped direct
  corridor lose the direct edge on both ends instead of lingering as
  phantom linkages. Hop trips stay connected through their shipped hop
  corridors (recorded downstream); ends left with nothing surface as
  honest disconnects. Corridor-based validators never saw these edges,
  so tiers and best-of-two adoption are unaffected by the cleanup
  itself. Measured safe: the 32-case matrix contains zero plazas, and
  the ring integration pins hold (below).

Experiments run and deliberately reverted (recorded so they are not
retried blindly):

- Junction stub routing with alternate mouths: +40% wall-clock on
  junction layouts with no measured win beyond the three fixes above
  (40489 still passes with legacy facing-wall stubs, faster).
- Ring-hole void routing (block the courtyard hole in A*/smoothing/
  verifier): fixed one seed but broke the passing ring/40448 pin with
  a `PORTAL_SEALED`, and worsened another — hole-cutting plus junction
  repair is currently the working ring strategy. Remains future work
  with co-designed band routing.

Verification after fixes: `npm test` **27/27** (1 new: ring/40489
budget pin with full config + seed and determinism check),
`npm run test:seeds` **32/32**, `npm run build` green (typecheck +
Vite; bundle ~734 kB / ~207 kB gzip, known chunk warning unchanged).
Ring 24-room spot re-measurement (single generation): 40454 clean
(via plaza), 40458 clean (routing found, no plaza needed), 40469
clean, 40483 clean, 40489 clean (pinned); previously-phantom passing
plazas now ship zero phantom edges (40465, 40474, horrorFacility/208
all clean with every plaza edge realized); residuals 40461 (lone
`PORTAL_SEALED`), 40462 (lone `CORRIDOR_CROSSING`, down from 4 seals
+ mouth foul), 40473 (`CORRIDOR_CROSSING` + mouth foul + seal);
warehouse/141 still a single mouth-foul `CORRIDOR_ROOM_COLLISION`.
One pinned expectation updated honestly: ring/40448's wider budget
finds a fully clean routing with no crossing at all, so its pin now
asserts clean + crossing-free + deterministic (renamed accordingly)
instead of plaza presence; junction repair stays pinned by the
white-box test, ring/40457, and the compact-plaza test (which now
also pins the no-phantom invariant). Seeds reproduce only on the same
version; 0.1.9 ≠ 0.1.10 on previously-failing seeds (and on passing
layouts whose plazas reseat via the compact fallback — still passing).

Still open: short-pair own-wall seals (turn-in-bubble on long twisty
band corridors, e.g. ex-40454 class — exit-leg capping hypothesis
recorded last pass), brush crossings with no proper point (by design),
miter-joint spikes, in-room arrivals vs corridor slabs, full
vertical-first co-design, 100-room single-floor over-constraint, and
main-thread stall on failing mid-size seeds (~20 s worst case;
clean seeds break early).

## Geometry seams + materials pass (2026-09-16, generator version **0.1.10 → 0.1.11**)

Walk-mode screenshots showed two seam classes plus flat lighting:
a see-through slit at some corridor→room joints, a dark moat where
stairs meet the upper floor, and near-black interiors. Measured first
(node-only mesh audit, no screenshots): corridor ends buried exactly
0.15 into the 0.30 wall band (mid-band burial of open tube ends), and
landing exit edges stopped 0.26–0.63 short of the upper slab (the
stairwell hole outgrows every landing by the 0.35 body clearance).

Corridor joints (`src/generator/geometry`, lawbook §52-53):

- `SPATIAL_DEFAULTS.jointOverlap` (new, 0.35, single source): ribbon
  ends extend past the door plane through the full band plus a 0.05
  proud jamb — no butt faces left to slit. Stays below the 0.7 m
  validator door exemption and navigation throat bridges, so all
  checks agree; the jamb never narrows clear width. The walk-collision
  slab mirror (`corridorSlabBoxes`) imports the same value.
- Wall ribbons get end caps (both ends, full height, auto-oriented):
  open tube ends can no longer read as dark slits at grazing angles.
  Corridor walls are not walk colliders (analytic capsules are), so
  this is render-only by construction.
- Shared-hole trim liners (trim slot 3, first real use of the slot):
  merged spans wider than any single mouth used to stand open beside
  the ribbon. Fillers close exactly the uncovered sub-spans (>0.05,
  same sliver rule) at full jamb height — never inside a clear mouth
  interval, so clear width, collision, and door validation agree.
  Single-mouth spans emit nothing (empty meshes skipped downstream).
- Tower shafts keep their 0.15 overlap deliberately: shaft walls are
  closed boxes (no open-tube class), and deeper burial would drift
  past the rect-based seal checks into walk space.

Stair arrivals (`src/generator/vertical`, lawbook §46):

- Straight landings and switchback decks extend exactly
  `SPATIAL_DEFAULTS.stairwellClear` (new, 0.35, shared with hole
  cutting in `@/core/generation` — the local `HOLE_CLEAR` literal is
  gone) past the footprint edge on the exit side (canonical -along
  for switchbacks, proven from the exit-sign rule), butt-joining the
  hole edge: no moat, no tuck-underlap to z-fight, tops flush so no
  rise changes. Upper-wall clearance was verified against the
  exit-maneuvering rule (walls sit ≥1.0 m past the edge; extension is
  0.35). Validators read plans, not meshes — stair/headroom/slab
  checks are untouched; walk collision gains the bridged deck boxes
  (walkable, intended).

Materials/lighting, material-only (no geometry rebuild, preview and
GLB export share `createMaterials`, so they agree automatically):

- Hemisphere + stronger ambient in the preview scene: interiors lit
  only through doorways no longer fall to black in walk mode.
- Greybox (default, unpinned) lifted a stop; industrial/sciFi hexes
  untouched (pinned by export/preview regressions).

Verification after fixes: `npm test` **32/32** (5 new: joint burial
+ caps, trim liners + single-door control, straight/switchback exit
coverage, end-to-end step-off moat on dungeon/7, lighting/theme
slots), `npm run test:seeds` **32/32**, `npm run build` green.
Seeds reproduce only on the same version; 0.1.10 ≠ 0.1.11 geometry
(all renders/exports rebuild from the new description; clean
acceptance unchanged — no validator touched).

## Redundant-ribbon drop pass (2026-09-17, generator version **0.1.11 → 0.1.12**)

Broad census on 0.1.11 (single generation each): all 8 shapes × 1/2/3
floors at 12 rooms **72/72**, min-room stacking (2 rooms over 2
floors), 5 floors, wall-height/door extremes, and max large-room
quotas all pass. The only failures are dense large single-floor maps:
linear 30-room seed 21 (two mid-route room intrusions) and branching
40-room seed 22 (crossing + seal) — classic loop-extra chords no
placement can route. Both are fixed below by one mechanism.

Post-hoc redundant-foul drop (`src/core/generation`, lawbook §12
loop feasibility, §70 local repair, §87 explicitness):

- After mouth and junction repairs, corridors still shipping
  `CORRIDOR_CROSSING` or `CORRIDOR_ROOM_COLLISION` (mid-route and
  endpoint mouth-foul flavors) are tested against the realized
  same-floor corridor graph: endpoints connected through OTHER
  corridors means the ribbon is decorative. The corridor AND its
  graph edge go explicitly (both ends), the tail rebuilds so doors,
  stairs, and slabs re-derive consistently, and the result lands only
  when strictly better. Corridors only — never graph intent
  (unrealized edges must not read as redundancy) and never stair
  detours (phantom-stair lesson from `pruneMonsterLinks`, which this
  mirrors post-hoc). Backbone bridges always survive the probe, so no
  third room can island. Three gates keep it from ever hurting an
  attempt: ≤50 rooms (main-thread cost), no placement failures
  (drops cannot cure those), and a droppable-class hard error present
  — layouts without errors return the identical reference.
- Paper trail without tier distortion: drop records ride
  `LayoutResult.dropped` (fresh tails start empty; the mouth-variant
  carries records across rebuilds) and the final stage-gate re-emits
  each as a `CORRIDOR_REDUNDANT_DROPPED` warning (new code, warnings
  never fail a level). Selection compares exactly the clean layout
  the drop produced.
- New structural invariant this exposed and fixed along the way: the
  final report rebuilds validation fresh from shipped geometry, so
  attempt-local findings never travelled — the `dropped` records are
  now the (only) channel, re-emitted at the gate.

Verification after fixes: `npm test` **34/34** (2 new: redundancy
probe unit pin — triangle redundant, bridge/cross-floor/unknown kept
— plus the linear30/21 integration pin with full config + seed and
determinism check), `npm run test:seeds` **32/32**, `npm run build`
green. Linear30/21 flips clean (two intrusions dropped, warning
recorded); branching40/22 improves 3 errors → 1 honest
`PORTAL_SEALED` (two coincident own-wall funnel seals on one wall —
mouth-variant and drops exhausted, recorded below); warehouse/141
keeps its single mouth foul untouched (backbone bridge: the probe
correctly refuses). One pinned expectation updated honestly:
ring/40457's drop repair removes the crossing ribbons as redundant
instead of plazating them, so its pin now asserts clean +
crossing/seal-free + deterministic (mechanism still covered by the
white-box, compact-plaza, and linear pins). Seeds reproduce only on
the same version; 0.1.11 ≠ 0.1.12 on previously-failing seeds.

Still open: own-wall funnel seals on shared walls (both mouths of a
two-gate funnel sealed by their own turning ribbons — needs mouth
co-design, not more retries), brush crossings with no proper point
(by design), short-pair own-wall seals, miter-joint spikes, in-room
arrivals vs corridor slabs, full vertical-first co-design, 100-room
single-floor over-constraint, and main-thread stall on failing
mid-size seeds (~25 s worst case; clean seeds break early).

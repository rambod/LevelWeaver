# LevelWeaver

A browser-only Vue/TypeScript application for generating, previewing, walking
through, and exporting procedural 3D level blockouts as GLB. World units are meters.

## Development

Use Node.js 22 LTS and npm (the audit used Node 22.22.3).

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run test:seeds
npm run build
npm run preview
```

`npm test` runs automated regressions through Node's test runner and the existing
`tsx` dependency. `test:seeds` checks a bounded, explicit seed matrix; it is not
proof that every configuration succeeds. `build` runs Vue/TypeScript checking
and creates `dist/`. No backend, credentials, or environment variables are needed.

`typecheck` checks browser code with `tsconfig.app.json`, Node diagnostics/tests
with the root `tsconfig.json`, and Vite configuration with `tsconfig.node.json`.
Node types are an explicit development dependency. Browser compilation exposes
only Vite/browser globals. All configurations keep strict typing; unused-variable
checks also apply to browser code, while exploratory Node scripts may retain
unused probes. The build runs all three checks so script errors cannot be missed.

## Workflow and failure behavior

Select a preset, adjust parameters, and generate. Regenerate retains the seed;
Random Seed changes it. Walk uses WASD, mouse look, sprint and jump; Escape exits.
Theme selection changes materials without changing the layout.

Gate width must fit the corridor width, and generated openings must meet the
requested gate dimensions. Adjust both controls when narrowing passages.

Configuration errors leave the previous generated map in place and display an
error. A bounded search can return an invalid diagnostic candidate with visible
validation errors. Such a candidate is not a successful generation and cannot
export. Reduce density or change the seed when constraints cannot be satisfied.
Export uses the displayed map's seed and current theme, even if form edits have
not produced another map.

## Project map

| Location | Responsibility |
| --- | --- |
| `src/core/types`, `rules`, `random` | Canonical data, limits, dimensions, seeded RNG |
| `src/core/generation` | Generation orchestration and bounded retries |
| `src/generator` | Boundary, topology, room placement, corridors, stairs, geometry |
| `src/core/validation` | Structured geometry and traversal findings |
| `src/renderer` | Three.js preview and resource ownership |
| `src/playtest` | Movement and collision |
| `src/export/gltf` | Validated GLB export |
| `src/stores/level.ts`, `src/App.vue` | State and browser workflow |
| `tests` | Automated regressions and seed checks |

The root `dbg*.ts` and `stairbot.ts` files are historical diagnostic tools, not
acceptance tests. Some assume particular generated stair IDs or skip failures.

## Documentation authority

- `AGENTS.md`: contributor workflow and required checks.
- `LEVELWEAVER.md`: product scope; examples describe intent, not exact APIs.
- `LEVELWEAVER_GENERATION_LAWBOOK.md`: validity requirements, with an implementation
  contract near the top distinguishing current behavior from target architecture.
- `docs/AUDIT.md`: audit findings, verification, and remaining limitations.

Runtime defaults live in `src/core/presets` and `src/core/rules`; dimensional
examples in the lawbook are not a second configuration source.

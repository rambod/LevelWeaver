# Contributor rules

Read `README.md` for commands, `LEVELWEAVER.md` for product scope, and
`LEVELWEAVER_GENERATION_LAWBOOK.md` before changing generation or validation.

- Keep generation browser-safe, deterministic, and independent of Vue and Three.js.
  Use plain typed data as the canonical model; render and export are adapters.
- Validate numeric inputs before allocation, iteration, or spatial arithmetic.
  Reject non-finite values, invalid enums, fractional counts, and unsupported
  resource sizes. HTML input limits are not runtime validation.
- Never disable a hard validator or downgrade an error to make a seed pass.
  A failed candidate may be inspected with visible diagnostics but cannot export.
- Preserve the generated configuration separately from editable form values.
  Export seed/version metadata must describe the generated artifact. Theme changes
  must agree between preview and export without regenerating geometry.
- Use centralized dimensional rules. Document the purpose of algorithm-specific
  tolerances; do not copy gameplay dimensions into unrelated modules.
- Own and dispose rendering resources explicitly. Recoloring must not rebuild
  geometry or invalidate collision snapshots.
- Add an automated regression for every correctness fix. Generation regressions
  must record the full configuration and seed. Tests must assert outcomes and
  exit unsuccessfully on failures; console-only diagnostic scripts are not tests.
- Run `npm test` and `npm run build`. For generator changes also run
  `npm run test:seeds`; report failed configurations and validation codes.
- Increment `GENERATOR_VERSION` when output or acceptance behavior changes.
  Update documentation in the same change; distinguish implemented behavior,
  target requirements, and known gaps rather than claiming complete compliance.
- Preserve unrelated user changes and historical debug scripts. Avoid adding
  dependencies or undertaking broad rewrites without a concrete need.

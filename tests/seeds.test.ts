import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateLevel } from '../src/core/generation'
import { getDefaultConfig, applyPreset, presets } from '../src/core/presets'
import { validateExportModel } from '../src/core/validation'

for (const preset of Object.keys(presets)) {
  for (const seed of [1, 7, 42, 99]) {
    test(`${preset}: seed ${seed} is deterministic, with honest validation`, () => {
      const config = { ...applyPreset(getDefaultConfig(), preset), seed }
      const original = structuredClone(config)
      const level = generateLevel(config)
      assert.deepEqual(config, original, 'generation must not mutate inputs')
      assert.deepEqual(generateLevel(config), level)
      assert.equal(level.rooms.length, config.roomCount)
      assert.deepEqual(validateExportModel(level), [])
      assert.equal(level.ok, level.validation.errors.length === 0)
      assert.equal(level.ok, true, 'known-good seed must remain valid')
      console.log(JSON.stringify({ preset, seed, ok: level.ok,
        errors: [...new Set(level.validation.errors.map(i => i.code))] }))
    })
  }
}

import { ref, shallowRef } from 'vue'
import type { LevelConfig } from '@/core/types'
import { getDefaultConfig, applyPreset } from '@/core/presets'
import { generateLevel, type GeneratedLevel } from '@/core/generation'

// Central UI state for the level workflow.
//
// The store only holds state and delegates to the pure procedural core
// (`generateLevel`). It never touches Three.js: the preview layer observes
// `generatedLevel` and renders it. This keeps the dependency direction
// UI -> core -> (renderer observes), per LEVELWEAVER.md section 4.
const config = ref<LevelConfig>(getDefaultConfig())
const generatedLevel = shallowRef<GeneratedLevel | null>(null)
const generationError = ref<string | null>(null)
const isGenerating = ref(false)
const walkMode = ref(false)
const showAdvanced = ref(false)

export function useLevelStore() {
  function generate(): boolean {
    isGenerating.value = true
    generationError.value = null
    try {
      generatedLevel.value = generateLevel(config.value)
      return true
    } catch (error) {
      generationError.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      isGenerating.value = false
    }
  }

  function regenerate(): boolean {
    // Deterministic rebuild with the SAME seed (useful after tweaking
    // parameters by hand). Use randomSeed() for a new layout.
    return generate()
  }

  function randomSeed(): boolean {
    // Lawbook §8/§107: no Math.random() anywhere — including seed picks.
    // crypto.getRandomValues is the browser-correct nondeterministic
    // source for the "Random" button; generation itself stays seeded.
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    config.value = {
      ...config.value,
      seed: buf[0] % 1000000,
    }
    return generate()
  }

  function selectPreset(presetKey: string): boolean {
    config.value = applyPreset(config.value, presetKey)
    return generate()
  }

  function setTheme(theme: string): void {
    config.value = { ...config.value, theme }
    const level = generatedLevel.value
    if (level) {
      generatedLevel.value = {
        ...level, config: { ...level.config, theme },
        rooms: level.rooms.map(room => ({ ...room, materialTheme: theme })),
      }
    }
  }

  function setWalkMode(enabled: boolean): void {
    walkMode.value = enabled
  }

  function toggleAdvanced(): void {
    showAdvanced.value = !showAdvanced.value
  }

  return {
    config,
    generatedLevel,
    generationError,
    isGenerating,
    walkMode,
    showAdvanced,
    generate,
    regenerate,
    randomSeed,
    selectPreset,
    setTheme,
    setWalkMode,
    toggleAdvanced,
  }
}

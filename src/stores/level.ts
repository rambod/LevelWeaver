import { ref } from 'vue'
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
const generatedLevel = ref<GeneratedLevel | null>(null)
const isGenerating = ref(false)
const walkMode = ref(false)
const showAdvanced = ref(false)

export function useLevelStore() {
  function generate(): void {
    isGenerating.value = true
    try {
      generatedLevel.value = generateLevel(config.value)
    } finally {
      isGenerating.value = false
    }
  }

  function regenerate(): void {
    // Deterministic rebuild with the SAME seed (useful after tweaking
    // parameters by hand). Use randomSeed() for a new layout.
    generate()
  }

  function randomSeed(): void {
    // Lawbook §8/§107: no Math.random() anywhere — including seed picks.
    // crypto.getRandomValues is the browser-correct nondeterministic
    // source for the "Random" button; generation itself stays seeded.
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    config.value = {
      ...config.value,
      seed: buf[0] % 1000000,
    }
    generate()
  }

  function selectPreset(presetKey: string): void {
    config.value = applyPreset(config.value, presetKey)
    generate()
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
    isGenerating,
    walkMode,
    showAdvanced,
    generate,
    regenerate,
    randomSeed,
    selectPreset,
    setWalkMode,
    toggleAdvanced,
  }
}

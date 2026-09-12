<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import * as THREE from 'three'
import type { GeneratedLevel } from '@/core/generation'
import { presets, shapes, themes } from '@/core/presets'
import { useLevelStore } from '@/stores/level'
import { LevelScene } from '@/renderer/scene'
import { CameraController } from '@/renderer/camera'
import { snapshotCollisionBoxes, corridorWallBoxes } from '@/playtest/collision'
import { corridorHeightFor } from '@/core/types'
import { findSpawnRoom, spawnEyePosition } from '@/playtest/controller'
import { exportGLB, downloadGLB } from '@/export/gltf'
import ParamSlider from '@/ui/controls/ParamSlider.vue'
import LevelStats from '@/ui/components/LevelStats.vue'

// State lives in the level store (UI state + pure core generation).
// This component only adds renderer synchronization on top of it.
const store = useLevelStore()
const config = store.config
const generatedLevel = store.generatedLevel
const isGenerating = store.isGenerating
const showAdvanced = store.showAdvanced
const walkMode = store.walkMode
const viewportRef = ref<HTMLElement | null>(null)

// Three.js
let scene: LevelScene | null = null
let cameraController: CameraController | null = null
let renderer: THREE.WebGLRenderer | null = null
let animationFrameId: number | null = null
let lastTime = 0
// Cached collision boxes: snapshotted once per generation so the render
// loop doesn't traverse the scene graph or clone bounding boxes per frame.
let collisionBoxes: THREE.Box3[] = []

// Initialize Three.js
const initThree = () => {
  if (!viewportRef.value) return

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(viewportRef.value.clientWidth, viewportRef.value.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  viewportRef.value.appendChild(renderer.domElement)

  scene = new LevelScene()
  cameraController = new CameraController(renderer.domElement, viewportRef.value.clientWidth, viewportRef.value.clientHeight)

  // Handle resize
  window.addEventListener('resize', onResize)

  // Start render loop
  animate()
}

const onResize = () => {
  if (!viewportRef.value || !renderer || !cameraController) return
  const width = viewportRef.value.clientWidth
  const height = viewportRef.value.clientHeight
  renderer.setSize(width, height)
  cameraController.resize(width, height)
}

const animate = (time: number = 0) => {
  animationFrameId = requestAnimationFrame(animate)
  const deltaTime = (time - lastTime) / 1000
  lastTime = time

  if (cameraController) {
    cameraController.update(deltaTime, collisionBoxes)
  }

  if (renderer && scene) {
    renderer.render(scene.scene, cameraController!.camera)
  }
}

// Generate level: run the pure core generator via the store, then sync
// the preview scene, collision cache, and camera to the new level.
// Impossible configurations fail with an explicit message (lawbook §73)
// instead of silently producing broken geometry.
const generate = async () => {
  isGenerating.value = true
  await nextTick()

  try {
    store.generate()
    const level = generatedLevel.value as GeneratedLevel | null
    if (!level) return
    syncScene(level)
    if (level.validation && level.validation.errors.length > 0) {
      console.warn(
        `[LevelWeaver] level has ${level.validation.errors.length} hard validation error(s):`,
        level.validation.errors.map(e => `[${e.code}] ${e.message}`),
      )
    }
  } catch (err) {
    console.error('Generation failed:', err)
    alert(err instanceof Error ? err.message : String(err))
  } finally {
    isGenerating.value = false
  }
}

const syncScene = (level: GeneratedLevel) => {
    scene?.updateLevel(level)

    // Cache walk-mode collision boxes once per generation.
    scene?.scene.updateMatrixWorld(true)
    const walkMeshes: THREE.Mesh[] = []
    scene?.levelGroup.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return
      // Corridor ribbon WALLS are excluded: a diagonal ribbon's mesh AABB
      // is far fatter than the wall and would seal nearby doorways. Their
      // place is taken by exact per-segment side boxes below (lawbook §56).
      // Corridor floors stay (thin slabs, harmless with grounded epsilon).
      const inCorridor = obj.parent?.userData?.type === 'corridor'
      if (obj.name === 'floor' || obj.name.startsWith('step') || obj.name.startsWith('landing')) {
        walkMeshes.push(obj)
      } else if (obj.name.startsWith('wall') && !inCorridor) {
        walkMeshes.push(obj)
      }
    })
    collisionBoxes = snapshotCollisionBoxes(walkMeshes)
    for (const corridor of level.corridors) {
      const pts = corridor.pathPoints && corridor.pathPoints.length > 0
        ? corridor.pathPoints
        : [corridor.startPos, corridor.endPos]
      collisionBoxes.push(
        ...corridorWallBoxes(
          pts,
          corridor.width,
          corridor.floorIndex * level.floorHeight,
          corridorHeightFor(level.config),
        ),
      )
    }

    // Reset camera to view the level
    cameraController?.reset()
    if (level.rooms.length > 0) {
      const box = new THREE.Box3()
      for (const room of level.rooms) {
        const halfW = room.width / 2
        const halfD = room.depth / 2
        box.expandByPoint(new THREE.Vector3(room.position.x - halfW, room.position.y, room.position.z - halfD))
        box.expandByPoint(new THREE.Vector3(room.position.x + halfW, room.position.y + room.height, room.position.z + halfD))
      }
      cameraController?.focusOnBounds(box)
    }
}

const regenerate = () => {
  // Re-run the generator with the SAME seed: deterministic rebuild.
  // (Use "Random Seed" for a new layout.)
  store.regenerate()
  const level = generatedLevel.value as GeneratedLevel | null
  if (level) syncScene(level)
}

const randomSeed = () => {
  store.randomSeed()
  const level = generatedLevel.value as GeneratedLevel | null
  if (level) syncScene(level)
}

const selectPreset = (presetKey: string) => {
  store.selectPreset(presetKey)
  const level = generatedLevel.value as GeneratedLevel | null
  if (level) syncScene(level)
}

const exportLevel = async () => {
  if (!generatedLevel.value) return
  try {
    const blob = await exportGLB(generatedLevel.value)
    downloadGLB(blob, `level_${config.value.seed}.glb`)
  } catch (err) {
    console.error('Export failed:', err)
    alert('Export failed. Check console for details.')
  }
}

const toggleWalkMode = () => {
  store.setWalkMode(!walkMode.value)
  if (walkMode.value && generatedLevel.value && cameraController) {
    // Spawn the player on the spawn room floor (eye 1.8m above floor top).
    const spawn = findSpawnRoom(generatedLevel.value.rooms)
    if (spawn) {
      cameraController.placeAt(spawnEyePosition(spawn))
    }
  }
  cameraController?.setWalkMode(walkMode.value)
}

const resetCamera = () => {
  cameraController?.reset()
  store.setWalkMode(false)
  cameraController?.setWalkMode(false)
}

watch(() => config.value.theme, (newTheme) => {
  scene?.setTheme(newTheme)
})

onMounted(() => {
  initThree()
  generate()
})

onUnmounted(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
  window.removeEventListener('resize', onResize)
  renderer?.dispose()
  scene?.dispose()
  cameraController?.dispose()
})
</script>

<template>
  <div class="app">
    <!-- Header -->
    <header class="header">
      <h1 class="title">LevelWeaver</h1>
      <div class="header-actions">
        <button class="btn btn-primary" @click="generate" :disabled="isGenerating">
          {{ isGenerating ? 'Generating...' : 'Generate' }}
        </button>
        <button class="btn btn-secondary" @click="exportLevel" :disabled="!generatedLevel">
          Export GLB
        </button>
      </div>
    </header>

    <div class="main-layout">
      <!-- Left Panel -->
      <aside class="sidebar">
        <!-- Preset -->
        <div class="panel-section">
          <label class="label">Preset</label>
          <select class="input" v-model="config.preset" @change="selectPreset(config.preset)">
            <option v-for="(preset, key) in presets" :key="key" :value="key">
              {{ preset.name }}
            </option>
          </select>
        </div>

        <!-- Main Shape -->
        <div class="panel-section">
          <label class="label">Shape</label>
          <select class="input" v-model="config.shape" @change="generate">
            <option v-for="shape in shapes" :key="shape.value" :value="shape.value">
              {{ shape.label }}
            </option>
          </select>
        </div>

        <!-- Area -->
        <div class="panel-section">
          <label class="label">Area (m²)</label>
          <input type="number" class="input" v-model.number="config.area" @change="generate" min="100" max="50000" step="100" />
        </div>

        <!-- Room Count -->
        <div class="panel-section">
          <label class="label">Rooms</label>
          <input type="number" class="input" v-model.number="config.roomCount" @change="generate" min="4" max="100" step="1" />
        </div>

        <!-- Floors -->
        <div class="panel-section">
          <label class="label">Floors</label>
          <input type="number" class="input" v-model.number="config.floorCount" @change="generate" min="1" max="5" step="1" />
        </div>

        <!-- Advanced Settings Toggle -->
        <button class="btn btn-toggle" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? 'Hide' : 'Show' }} Advanced
        </button>

        <!-- Advanced Settings -->
        <div v-show="showAdvanced" class="advanced-settings">
          <ParamSlider label="Room Size Variation" v-model="config.roomSizeVariation" :min="0" :max="1" :step="0.05" @change="generate" />
          <ParamSlider label="Corridor Width" v-model="config.corridorWidth" :min="1" :max="6" :step="0.5" @change="generate" />
          <ParamSlider label="Connectivity" v-model="config.connectivity" :min="0" :max="1" :step="0.05" @change="generate" />
          <ParamSlider label="Verticality" v-model="config.verticality" :min="0" :max="1" :step="0.05" @change="generate" />
          <ParamSlider label="Wall Height (m)" v-model="config.wallHeight" :min="3.2" :max="5.5" :step="0.1" @change="generate" />
          <ParamSlider label="Gate Width (m)" v-model="config.doorWidth" :min="1" :max="3" :step="0.1" @change="generate" />
          <ParamSlider label="Gate Height (m)" v-model="config.doorHeight" :min="2" :max="3" :step="0.1" @change="generate" />
          <ParamSlider label="Dead Ends" v-model="config.deadEnds" :min="0" :max="0.5" :step="0.05" @change="generate" />

          <div class="panel-section">
            <label class="label">Large Rooms</label>
            <input type="number" class="input" v-model.number="config.largeRoomCount" @change="generate" min="0" max="10" step="1" />
          </div>
        </div>

        <!-- Theme -->
        <div class="panel-section">
          <label class="label">Theme</label>
          <select class="input" v-model="config.theme">
            <option v-for="theme in themes" :key="theme" :value="theme">
              {{ theme.charAt(0).toUpperCase() + theme.slice(1) }}
            </option>
          </select>
        </div>

        <!-- Seed -->
        <div class="panel-section seed-row">
          <label class="label">Seed</label>
          <div class="seed-inputs">
            <input type="number" class="input" v-model.number="config.seed" @change="generate" min="0" max="999999" />
            <button class="btn btn-small" @click="randomSeed">Random</button>
          </div>
        </div>

        <!-- Actions -->
        <div class="panel-actions">
          <button class="btn btn-primary full-width" @click="generate" :disabled="isGenerating">
            {{ isGenerating ? 'Generating...' : 'Generate' }}
          </button>
          <button class="btn btn-secondary full-width" @click="regenerate">
            Regenerate
          </button>
          <button class="btn btn-secondary full-width" @click="randomSeed">
            Random Seed
          </button>
        </div>

        <!-- Info -->
        <LevelStats :level="generatedLevel" />
      </aside>

      <!-- Viewport -->
      <main class="viewport-container" ref="viewportRef">
        <div class="viewport-overlay">
          <div class="mode-indicator" :class="{ active: walkMode }">
            {{ walkMode ? 'WALK MODE (WASD + Mouse, Click to lock)' : 'ORBIT MODE (Drag to orbit, Scroll to zoom)' }}
          </div>
          <div class="viewport-controls">
            <button class="btn btn-small" @click="toggleWalkMode" :class="{ active: walkMode }">
              {{ walkMode ? 'Exit Walk' : 'Walk' }}
            </button>
            <button class="btn btn-small" @click="resetCamera">
              Reset View
            </button>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.app {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: #16213e;
  border-bottom: 1px solid #0f3460;
}

.title {
  font-size: 1.25rem;
  font-weight: 600;
  color: #00ff88;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.main-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.sidebar {
  width: 280px;
  background: #16213e;
  border-right: 1px solid #0f3460;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.panel-section label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #8899aa;
}

.input {
  background: #0f0f23;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 8px 10px;
  color: #e0e0e0;
  font-size: 0.875rem;
}

.input:focus {
  outline: none;
  border-color: #00ff88;
}

.slider {
  width: 100%;
  accent-color: #00ff88;
}

.value {
  font-size: 0.75rem;
  color: #8899aa;
  text-align: right;
}

.seed-row .seed-inputs {
  display: flex;
  gap: 8px;
}

.seed-row .seed-inputs .input {
  flex: 1;
}

.btn {
  background: #0f3460;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 8px 16px;
  color: #e0e0e0;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn:hover:not(:disabled) {
  background: #1a4a7a;
  border-color: #00ff88;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: #00ff88;
  border-color: #00ff88;
  color: #1a1a2e;
  font-weight: 600;
}

.btn-primary:hover:not(:disabled) {
  background: #00cc6a;
  border-color: #00cc6a;
}

.btn-secondary {
  background: #0f3460;
}

.btn-small {
  padding: 6px 12px;
  font-size: 0.75rem;
}

.btn-toggle {
  background: transparent;
  border: none;
  color: #00ff88;
  padding: 4px 0;
  font-size: 0.75rem;
  text-align: left;
}

.btn-toggle:hover {
  text-decoration: underline;
}

.full-width {
  width: 100%;
}

.panel-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.advanced-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid #2a2a4a;
}

.level-info {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #2a2a4a;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.75rem;
}

.info-row {
  display: flex;
  justify-content: space-between;
}

.viewport-container {
  flex: 1;
  position: relative;
  background: #1a1a2e;
}

.viewport-container canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.viewport-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  padding: 16px;
}

.mode-indicator {
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 0.75rem;
  color: #8899aa;
  align-self: flex-start;
}

.mode-indicator.active {
  border-color: #00ff88;
  color: #00ff88;
}

.viewport-controls {
  margin-top: auto;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  pointer-events: auto;
}

.viewport-controls .btn.active {
  background: #00ff88;
  border-color: #00ff88;
  color: #1a1a2e;
}
</style>
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { getDefaultConfig } from '../src/core/presets'
import { validateConfigFeasibility, stairMathFor } from '../src/core/rules'
import { validateExportModel, validateDoors } from '../src/core/validation'
import { LevelScene } from '../src/renderer/scene'
import { exportGLB, levelFilename, downloadGLB } from '../src/export/gltf'
import { useLevelStore } from '../src/stores/level'
import { fixtureLevel } from './fixtures'
import type { LevelConfig, MeshData, StairsGeometry } from '../src/core/types'
import { createBoxMesh, createOrientedBox } from '../src/core/meshdata'
import { generateCorridorGeometry } from '../src/generator/geometry'

test('configuration rejects non-finite numbers before spatial arithmetic', () => {
  const base = getDefaultConfig()
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'number') continue
    for (const invalid of [NaN, Infinity, -Infinity, '']) {
      const config = { ...base, [key]: invalid } as LevelConfig
      assert.ok(validateConfigFeasibility(config).length > 0, `${key}=${invalid}`)
    }
  }
})

test('configuration enforces counts, ranges, enums and bounded workloads', () => {
  const base = getDefaultConfig()
  const cases = [
    { roomCount: 1 }, { roomCount: 2.5 }, { roomCount: 101 },
    { floorCount: 1.5 }, { floorCount: 6 }, { area: -1 }, { area: 50001 },
    { seed: -1 }, { seed: 0.5 }, { seed: 4294967296 },
    { largeRoomCount: -1 }, { largeRoomCount: 0.5 }, { largeRoomCount: 15 },
    { connectivity: 1.1 }, { verticality: -0.1 }, { deadEnds: 2 }, { roomSizeVariation: -1 },
    { shape: 'unknown' }, { theme: 'unknown' }, { preset: 'unknown' },
    { preset: 'toString' },
  ]
  for (const fields of cases) {
    assert.ok(validateConfigFeasibility({ ...base, ...fields } as LevelConfig).length, JSON.stringify(fields))
  }
  assert.deepEqual(validateConfigFeasibility(base), [])
  // Lawbook §0 envelope endpoints the UI exposes must stay accepted:
  // minimum room count (with largeRoomCount refitted), full dead-end
  // range, agent-minimum corridor/gate widths, and u32 seed maximum.
  for (const fields of [
    { roomCount: 2, largeRoomCount: 0 },
    { deadEnds: 1 },
    { corridorWidth: 0.8, doorWidth: 0.8 },
    { doorWidth: 0.8 },
    { seed: 4294967295 },
  ]) {
    assert.deepEqual(validateConfigFeasibility({ ...base, ...fields } as LevelConfig), [], JSON.stringify(fields))
  }
})

test('stair math rejects non-finite treads and preserves legal rise', () => {
  for (const tread of [NaN, Infinity, -Infinity, 0.1]) {
    assert.throws(() => stairMathFor(4, tread))
  }
  const stair = stairMathFor(4)
  assert.ok(Math.abs(stair.stepCount * stair.stepHeight - 4) < 1e-10)
})

test('box and corridor triangles face outward and agree with declared normals', () => {
  const meshes = [createBoxMesh(2, 3, 4, 5, 6, 7, 0)]
  for (const sign of [1, -1]) {
    meshes.push(createOrientedBox({ x: 2, y: 3, z: 4 }, {
      u: { x: 0.6, y: 0, z: 0.8 }, v: { x: 0, y: 1, z: 0 },
      w: { x: -0.8 * sign, y: 0, z: 0.6 * sign },
    }, 5, 6, 7, 0))
  }
  const startPos = { x: 0, y: 0, z: 0 }
  const endPos = { x: 8, y: 0, z: 6 }
  for (const pathPoints of [[startPos, endPos], [startPos, { x: 8, y: 0, z: 0 }, endPos]]) {
    const [corridor] = generateCorridorGeometry([{
      id: 'corridor_test', startRoomId: 'a', endRoomId: 'b', floorIndex: 0,
      width: 2, startPos, endPos, pathPoints,
    }])
    meshes.push(corridor.floor, ...corridor.walls, corridor.ceiling)
  }
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const points = [0, 1, 2].map(k => new THREE.Vector3().fromArray(mesh.vertices, mesh.indices[i + k] * 3))
      const normal = new THREE.Vector3().fromArray(mesh.normals, mesh.indices[i] * 3)
      const geometric = points[1].sub(points[0]).cross(points[2].sub(points[0]))
      assert.ok(geometric.dot(normal) > 0, `triangle ${i / 3} faces inward`)
    }
  }
})

test('mesh validation checks every stair part and all attributes', () => {
  const slots = ['steps', 'risers', 'stringers', 'landing', 'towerFloor', 'towerWall']
  for (const slot of slots) {
    for (const attribute of ['vertices', 'normals', 'uvs'] as const) {
      const level = fixtureLevel()
      const bad = structuredClone(level.roomGeometry[0].floor[0])
      bad[attribute][0] = NaN
      const stair = {
        id: 'stairs_test', steps: [], risers: [], stringers: [], landing: [], tower: null,
      } as unknown as StairsGeometry
      if (slot === 'towerFloor' || slot === 'towerWall') {
        stair.tower = { floor: slot === 'towerFloor' ? bad : level.roomGeometry[0].floor[0],
          walls: slot === 'towerWall' ? [bad] : [] } as StairsGeometry['tower']
      } else (stair[slot as 'steps'] as MeshData[]).push(bad)
      level.stairs.push(stair)
      assert.ok(validateExportModel(level).some(i => i.code === 'GEOMETRY_NONFINITE'), `${slot}.${attribute}`)
    }
  }
})

test('portals cannot silently shrink below the requested dimensions', () => {
  const level = fixtureLevel()
  const room = level.rooms[0]
  const issues = validateDoors(level.rooms, new Map([[room.id, [{
    roomId: room.id, targetRoomId: 'room_1', wallIndex: 0,
    position: { x: room.position.x, y: 0, z: room.position.z - room.depth / 2 },
    width: 1.2, height: 2.1,
  }]]]), level.config)
  assert.ok(issues.some(i => i.code === 'PORTAL_TOO_NARROW' && i.severity === 'error'))
  assert.ok(issues.some(i => i.code === 'PORTAL_TOO_LOW' && i.severity === 'error'))
  assert.ok(validateConfigFeasibility({ ...level.config, corridorWidth: 1 }).some(
    i => i.code === 'CONFIG_DOOR_CORRIDOR_WIDTH'))
})

test('mesh validation rejects invalid indices and mismatched attributes', () => {
  for (const corrupt of [
    (m: MeshData) => { m.indices[0] = m.vertices.length },
    (m: MeshData) => { m.normals = new Float32Array(1) },
    (m: MeshData) => { m.indices = new Uint32Array([0, 1]) },
  ]) {
    const level = fixtureLevel()
    corrupt(level.roomGeometry[0].floor[0])
    assert.ok(validateExportModel(level).length)
  }
})

test('preview uses artifact theme and recolors without replacing geometry', () => {
  const level = fixtureLevel()
  level.config.theme = 'industrial'
  const scene = new LevelScene()
  scene.updateLevel(level)
  const wall = scene.levelGroup.children[0].children.find(m => m.name === 'wall_0') as THREE.Mesh
  assert.equal((wall.material as THREE.MeshStandardMaterial).color.getHex(), 0x5a5a5a)
  const geometry = wall.geometry
  let disposed = 0
  for (const material of scene.getMaterials().values()) material.addEventListener('dispose', () => disposed++)
  scene.setTheme('sciFi')
  assert.equal(scene.levelGroup.children[0].children.find(m => m.name === 'wall_0'), wall)
  assert.equal(wall.geometry, geometry)
  assert.equal((wall.material as THREE.MeshStandardMaterial).color.getHex(), 0x2a3a4a)
  assert.equal(disposed, 6)
  scene.dispose()
})

test('export refuses failed, unvalidated, mutated geometry and non-finite transforms', async () => {
  for (const corrupt of [
    (l: ReturnType<typeof fixtureLevel>) => { l.ok = false },
    (l: ReturnType<typeof fixtureLevel>) => { l.validation = undefined as never },
    (l: ReturnType<typeof fixtureLevel>) => { l.roomGeometry[0].floor[0].vertices[0] = NaN },
    (l: ReturnType<typeof fixtureLevel>) => { l.rooms[0].position.x = Infinity },
  ]) {
    const level = fixtureLevel()
    corrupt(level)
    await assert.rejects(exportGLB(level), /export refused/)
  }
})

test('export releases temporary resources on success and failure', async (t) => {
  for (const fail of [false, true]) {
    let geometries = 0, materials = 0, disposedGeometries = 0, disposedMaterials = 0
    const parse: GLTFExporter['parse'] = (scene, done, error) => {
      const seen = new Set<THREE.Material>()
      const roots = Array.isArray(scene) ? scene : [scene]
      roots.forEach(root => root.traverse((obj: THREE.Object3D) => {
        if (!(obj instanceof THREE.Mesh)) return
        geometries++
        obj.geometry.addEventListener('dispose', () => disposedGeometries++)
        seen.add(obj.material as THREE.Material)
      }))
      materials = seen.size
      for (const m of seen) m.addEventListener('dispose', () => disposedMaterials++)
      // The runtime rejects with an Error, but @types/three declares the
      // exporter error callback as (error: ErrorEvent) => void. Cast keeps
      // the runtime value (so `instanceof Error` still matches) while
      // satisfying `npm run build` typechecking.
      if (fail) error(new Error('simulated exporter failure') as unknown as ErrorEvent)
      else done(new ArrayBuffer(4))
    }
    const patch = t.mock.method(GLTFExporter.prototype, 'parse', parse)
    if (fail) await assert.rejects(exportGLB(fixtureLevel()), /simulated/)
    else await exportGLB(fixtureLevel())
    assert.ok(geometries > 0)
    assert.equal(disposedGeometries, geometries)
    assert.equal(disposedMaterials, materials)
    patch.mock.restore()
  }
})

test('every store generation action reports failure and retains the artifact', () => {
  const store = useLevelStore()
  const level = fixtureLevel()
  store.generatedLevel.value = level
  store.config.value = { ...getDefaultConfig(), area: -1 }
  for (const action of [store.generate, store.regenerate, store.randomSeed,
    () => store.selectPreset('dungeon')]) {
    assert.equal(action(), false)
    assert.equal(store.generatedLevel.value, level)
    assert.match(store.generationError.value!, /configuration/)
    assert.equal(store.isGenerating.value, false)
  }
  store.config.value = { ...getDefaultConfig(), seed: 999 }
  store.setTheme('industrial')
  assert.equal(store.generatedLevel.value!.config.theme, 'industrial')
  assert.equal(store.generatedLevel.value!.config.seed, level.seed)
  assert.equal(levelFilename(store.generatedLevel.value!), `level_${level.seed}.glb`)
  assert.equal(store.generatedLevel.value!.roomGeometry, level.roomGeometry)
  store.config.value = getDefaultConfig()
  store.generatedLevel.value = null
})

test('real GLB output contains geometry, artifact metadata and chosen materials', async () => {
  // Node supplies Blob; this tiny adapter provides the browser FileReader API
  // used by the real GLTFExporter for its two binary assembly passes.
  const previous = globalThis.FileReader
  class BinaryReader {
    result: ArrayBuffer | null = null
    onloadend?: () => void
    async readAsArrayBuffer(blob: Blob) {
      this.result = await blob.arrayBuffer()
      this.onloadend?.()
    }
  }
  globalThis.FileReader = BinaryReader as unknown as typeof FileReader
  try {
    const level = fixtureLevel()
    level.config.theme = 'industrial'
    const bytes = await (await exportGLB(level)).arrayBuffer()
    const header = new DataView(bytes)
    assert.equal(header.getUint32(0, true), 0x46546c67, 'GLB magic')
    assert.equal(header.getUint32(4, true), 2)
    assert.equal(header.getUint32(8, true), bytes.byteLength)
    const jsonLength = header.getUint32(12, true)
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)))
    assert.equal(gltf.scenes[0].extras.seed, level.seed)
    assert.equal(gltf.scenes[0].extras.generatorVersion, level.generatorVersion)
    assert.equal(gltf.scenes[0].extras.units, 'meters')
    assert.equal(gltf.scenes[0].extras.config.theme, 'industrial')
    assert.ok(gltf.nodes.some((n: { name: string }) => n.name === 'Floor_00'))
    assert.ok(gltf.nodes.some((n: { name: string }) => n.name === 'Room_0'))
    assert.ok(gltf.meshes.length > 0)
    const wallColor = new THREE.Color(0x5a5a5a)
    assert.ok(gltf.materials.some((m: { pbrMetallicRoughness: { baseColorFactor: number[] } }) =>
      Math.abs(m.pbrMetallicRoughness.baseColorFactor[0] - wallColor.r) < 1e-6))
  } finally {
    if (previous) globalThis.FileReader = previous
    else Reflect.deleteProperty(globalThis, 'FileReader')
  }
})

test('download keeps its Blob URL alive until the browser can consume it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const original = globalThis.document
  let attached = false, clicked = false, removed = false
  const anchor = { href: '', download: '',
    click() { assert.ok(attached); clicked = true }, remove() { removed = true } }
  globalThis.document = {
    createElement: () => anchor,
    body: { appendChild: () => { attached = true } },
  } as unknown as Document
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {})
  t.mock.method(URL, 'createObjectURL', () => 'blob:test')
  try {
    downloadGLB(new Blob(['test']), 'level_42.glb')
    assert.equal(anchor.download, 'level_42.glb')
    assert.ok(clicked && removed)
    assert.equal(revoke.mock.callCount(), 0)
    t.mock.timers.tick(1000)
    assert.equal(revoke.mock.callCount(), 1)
  } finally {
    if (original) globalThis.document = original
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

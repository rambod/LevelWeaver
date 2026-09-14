import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { getDefaultConfig, pickWeightedRoomType, presets } from '../src/core/presets'
import { validateConfigFeasibility, stairMathFor } from '../src/core/rules'
import { validateExportModel, validateDoors } from '../src/core/validation'
import { LevelScene } from '../src/renderer/scene'
import { exportGLB, levelFilename, downloadGLB } from '../src/export/gltf'
import { useLevelStore } from '../src/stores/level'
import { fixtureLevel } from './fixtures'
import type { Corridor, DoorOpening, LevelConfig, MeshData, Room, StairsGeometry } from '../src/core/types'
import { createBoxMesh, createOrientedBox } from '../src/core/meshdata'
import { generateCorridorGeometry } from '../src/generator/geometry'
import { generateCorridors } from '../src/generator/corridors'
import { generateTopology, topUpDegrees } from '../src/generator/topology'
import { assignRoomSizes } from '../src/generator/rooms'
import { planStairs, towerMouthWidthFor } from '../src/generator/vertical'
import { omittedStairIssues } from '../src/core/generation'
import { SeededRandom } from '../src/core/random'

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

test('tower shaft mouths meet the requested gate width', () => {
  // Lawbook §24 + §0 contract. Hand-built stack forces a tower: the 4x4
  // host fits no in-room flight, open boundary leaves shaft room, and the
  // 12x12 upper holds the arrival landing. gateWidth 1.8 (the default).
  const rooms: Room[] = [
    { id: 'room_0', type: 'standard', position: { x: 0, y: 0, z: 0 }, width: 4, depth: 4, height: 3.5, floorIndex: 0, materialTheme: 'greybox', connections: ['room_1'] },
    { id: 'room_1', type: 'standard', position: { x: 2, y: 4, z: 0 }, width: 12, depth: 12, height: 3.5, floorIndex: 1, materialTheme: 'greybox', connections: ['room_0'] },
  ]
  const doors = new Map<string, DoorOpening[]>()
  const plans = planStairs(rooms, doors, {
    boundary: { shape: 'square', width: 50, depth: 50, center: { x: 0, y: 0 } },
    corridorSlabsByFloor: new Map(),
    corridorDegree: new Map(),
    floorHeight: 4, gateWidth: 1.8, gateHeight: 2.4,
  })
  const tower = plans.find(p => p.kind === 'tower')
  assert.ok(tower, 'tiny host with open surroundings must plan a tower shaft')
  const mouths = doors.get('room_0') ?? []
  assert.ok(mouths.length > 0, 'tower mouth joins the door map')
  for (const mouth of mouths) {
    assert.ok(mouth.width + 1e-9 >= 1.8, `tower mouth ${mouth.width} m must meet requested 1.8 m`)
  }
  // Helper contract: flight-width floor, requested width above, shaft cap.
  assert.equal(towerMouthWidthFor(1.8, 1.2), 1.8)
  assert.equal(towerMouthWidthFor(1.0, 1.2), 1.2)
  assert.equal(towerMouthWidthFor(2.9, 1.2), null)
  assert.equal(towerMouthWidthFor(NaN, 1.2), null)
})

test('omitted vertical links report STAIR_NO_PLACEMENT by bridge impact', () => {
  const mkRoom = (id: string, floor: number, conns: string[]): Room => ({
    id, type: 'standard', position: { x: 0, y: floor * 4, z: 0 }, width: 8, depth: 8,
    height: 3.5, floorIndex: floor, materialTheme: 'greybox', connections: conns,
  })
  const rooms = [mkRoom('a', 0, ['b']), mkRoom('b', 1, ['a'])]
  // No realization and no alternate path: tier-1 bridge error with link ids.
  const errors = omittedStairIssues(rooms, [], [], false)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'STAIR_NO_PLACEMENT')
  assert.equal(errors[0].severity, 'error')
  assert.deepEqual(errors[0].objectIds, ['a', 'b'])
  // Built link: silent.
  assert.deepEqual(omittedStairIssues(rooms, [], [{ lowerRoomId: 'a', upperRoomId: 'b' }], true), [])
  // Alternate realized path: no error; warning only on the final report.
  const corridor: Corridor = {
    id: 'corridor_a_b', startRoomId: 'a', endRoomId: 'b',
    startPos: { x: 0, y: 0, z: 0 }, endPos: { x: 0, y: 4, z: 0 }, width: 2, floorIndex: 0,
  }
  assert.deepEqual(omittedStairIssues(rooms, [corridor], [], false), [])
  const warnings = omittedStairIssues(rooms, [corridor], [], true)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].code, 'STAIR_NO_PLACEMENT')
  assert.equal(warnings[0].severity, 'warning')
})

test('semantic degree repair tops up hubs and spawn without long drags', () => {
  // Lawbook §14: hub ≥3, spawn ≥2 (non-linear). Hand-built placed rooms;
  // far room (>24 m) must stay an honest leaf.
  const mkRoom = (id: string, type: Room['type'], x: number, z: number, conns: string[]): Room => ({
    id, type, position: { x, y: 0, z }, width: type === 'hub' ? 14 : 7, depth: type === 'hub' ? 14 : 7,
    height: 3.5, floorIndex: 0, materialTheme: 'greybox', connections: conns,
  })
  const rooms: Room[] = [
    mkRoom('hub0', 'hub', 0, 0, ['s0']),
    mkRoom('s0', 'standard', 10, 0, ['hub0']),
    mkRoom('s1', 'standard', -10, 0, []),
    mkRoom('far', 'standard', 100, 0, []),
    mkRoom('sp', 'spawn', 0, 20, ['s2']),
    mkRoom('s2', 'standard', 8, 20, ['sp']),
  ]
  const config = { ...getDefaultConfig(), shape: 'rectangle' as const }
  topUpDegrees(rooms, config)
  const deg = (id: string): number => rooms.find(r => r.id === id)!.connections.length
  assert.ok(deg('hub0') >= 3, `hub topped to trunk degree, got ${deg('hub0')}`)
  assert.ok(deg('sp') >= 2, `spawn topped off leaf status, got ${deg('sp')}`)
  assert.equal(deg('far'), 0, 'unreachable room stays an honest leaf')
  // Linear maps exempt end stations by design.
  const linear = rooms.map(r => ({ ...r, connections: [...r.connections] }))
  const spLinear = linear.find(r => r.id === 'sp')!
  spLinear.connections = ['s2']
  topUpDegrees(linear, { ...config, shape: 'linear' as const })
  assert.equal(linear.find(r => r.id === 'sp')!.connections.length, 1)
})

test('large-room quota is a deterministic reservation', () => {
  // Warehouse asks 3 large rooms in 10: the quota must materialize (not a
  // 30% coin flip) and reproduce bit-for-bit.
  const config = { ...getDefaultConfig(), roomCount: 12, floorCount: 1, largeRoomCount: 3, preset: 'warehouse', seed: 5 }
  const boundary = { shape: 'rectangle' as const, width: 70, depth: 70, center: { x: 0, y: 0 } }
  const first = generateTopology(config, boundary, new SeededRandom(5))
  const second = generateTopology(config, boundary, new SeededRandom(5))
  assert.deepEqual(first.map(r => r.type), second.map(r => r.type))
  const larges = first.slice(1, -1).filter(r => r.type === 'hub' || r.type === 'arena')
  assert.ok(larges.length >= 3, `quota forces ≥3 large rooms, got ${larges.length}`)
})

test('preset room-type profiles differentiate the lottery', () => {
  // Lawbook §89: same seed, different preset character. Fixed-stream
  // distribution pins with wide margins (deterministic, not statistical).
  const draw = (preset: string): Record<string, number> => {
    const rng = new SeededRandom(42)
    const counts: Record<string, number> = {}
    for (let i = 0; i < 400; i++) {
      const t = pickWeightedRoomType(rng, presets[preset].roomTypeWeights)
      counts[t] = (counts[t] ?? 0) + 1
    }
    return counts
  }
  const office = draw('office')
  assert.ok(office.hall! >= 80, `office deals halls, got ${office.hall}`)
  assert.ok((office.arena ?? 0) <= 20, `office avoids arenas, got ${office.arena}`)
  const dungeon = draw('dungeon')
  assert.ok(dungeon.standard! >= 150, `dungeon deals standards, got ${dungeon.standard}`)
  const warehouse = draw('warehouse')
  assert.ok(warehouse.arena! >= 50, `warehouse deals arenas, got ${warehouse.arena}`)
  assert.ok((warehouse.hall ?? 0) <= 40, `warehouse avoids halls, got ${warehouse.hall}`)
  const horror = draw('horrorFacility')
  assert.ok(horror.hall! >= 70, `horror deals halls, got ${horror.hall}`)
  assert.ok((horror.arena ?? 0) <= 30, `horror avoids arenas, got ${horror.arena}`)
})

test('tower reservations steer corridor routing around shafts', () => {
  // Lawbook §40: with a shaft reserved mid-link, the direct edge fouls and
  // realizes as hops through the midpoint room instead of shipping through.
  const mkRoom = (id: string, x: number, z: number, conns: string[]): Room => ({
    id, type: 'standard', position: { x, y: 0, z }, width: 6, depth: 6,
    height: 3.5, floorIndex: 0, materialTheme: 'greybox', connections: conns,
  })
  const rooms = [mkRoom('room_a', 0, 0, ['room_b']), mkRoom('room_b', 20, 0, ['room_a']), mkRoom('room_m', 10, 9, [])]
  const config = { ...getDefaultConfig(), roomCount: 3, floorCount: 1 }
  const plain = generateCorridors(rooms, config, false)
  assert.equal(plain.length, 1)
  assert.deepEqual([plain[0].startRoomId, plain[0].endRoomId].sort(), ['room_a', 'room_b'])
  const steered = generateCorridors(rooms, config, false,
    [{ key: 't', rect: { minX: 8, maxX: 12, minZ: -2, maxZ: 2 }, upperFloor: 0 }])
  const pairs = steered.map(c => [c.startRoomId, c.endRoomId].sort().join('-')).sort()
  assert.deepEqual(pairs, ['room_a-room_m', 'room_b-room_m'])
})

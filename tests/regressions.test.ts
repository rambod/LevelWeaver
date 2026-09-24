import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { getDefaultConfig, applyPreset, pickWeightedRoomType, presets } from '../src/core/presets'
import { validateConfigFeasibility, stairMathFor, SPATIAL_DEFAULTS } from '../src/core/rules'
import { validateExportModel, validateDoors, validateNavigationGrid, findCorridorCrossings, tiersOf, compareTiers, isPlacementFailure } from '../src/core/validation'
import type { GenerationIssue, IssueCode } from '../src/core/validation'
import { LevelScene } from '../src/renderer/scene'
import { createMaterials, getAvailableThemes } from '../src/renderer/materials'
import { exportGLB, levelFilename, downloadGLB } from '../src/export/gltf'
import { useLevelStore } from '../src/stores/level'
import { fixtureLevel } from './fixtures'
import type { Corridor, DoorOpening, LevelConfig, MeshData, Room, StairsGeometry } from '../src/core/types'
import { createBoxMesh, createOrientedBox } from '../src/core/meshdata'
import { generateCorridorGeometry, generateRoomGeometry } from '../src/generator/geometry'
import { generateCorridors } from '../src/generator/corridors'
import { generateTopology, topUpDegrees } from '../src/generator/topology'
import { assignRoomSizes } from '../src/generator/rooms'
import { planStairs, towerMouthWidthFor, buildStairsGeometry } from '../src/generator/vertical'
import type { StairPlan } from '../src/generator/vertical'
import { omittedStairIssues, planJunctions, generateLevel } from '../src/core/generation'
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

test('narrow-but-legal corridors stay reachable on the navigation grid', () => {
  // Lawbook §5/§59: a 0.8 m corridor admits the agent, so the validator
  // must not lose its 0.1 m walkable strip between 0.25 m cell centers.
  // Hand-built pair (deterministic, no seed): spawn + standard joined by a
  // straight 0.8 m corridor with throats on both gates.
  const mkRoom = (id: string, type: Room['type'], x: number): Room => ({
    id, type, position: { x, y: 0, z: 0 }, width: 6, depth: 6,
    height: 3.5, floorIndex: 0, materialTheme: 'greybox',
    connections: [id === 'a' ? 'b' : 'a'],
  })
  const rooms = [mkRoom('a', 'spawn', 0), mkRoom('b', 'standard', 10)]
  const corridors: Corridor[] = [{
    id: 'corridor_a_b', startRoomId: 'a', endRoomId: 'b',
    startPos: { x: 3, y: 0, z: 0 }, endPos: { x: 7, y: 0, z: 0 },
    width: 0.8, floorIndex: 0,
    pathPoints: [{ x: 3, y: 0, z: 0 }, { x: 7, y: 0, z: 0 }],
  }]
  const doors = new Map<string, DoorOpening[]>([
    ['a', [{ roomId: 'a', wallIndex: 1, position: { x: 3, y: 0, z: 0 }, width: 0.8, height: 2.4, targetRoomId: 'b' }]],
    ['b', [{ roomId: 'b', wallIndex: 3, position: { x: 7, y: 0, z: 0 }, width: 0.8, height: 2.4, targetRoomId: 'a' }]],
  ])
  assert.deepEqual(validateNavigationGrid(rooms, doors, corridors, [], 4), [])
  // Negative control: without the corridor the far room is unreachable.
  const stranded = validateNavigationGrid(rooms, new Map(), [], [], 4)
  assert.ok(stranded.some(i => i.code === 'NAV_UNREACHABLE_ROOM' && i.objectIds.includes('b')))
})

test('junction repair converts crossings into shared plazas', () => {
  // Lawbook §34-35. Hand-built X-crossing (deterministic, no seed): two
  // straight corridors crossing at the origin with clear surroundings.
  const mkRoom = (id: string, x: number, z: number, conns: string[]): Room => ({
    id, type: 'standard', position: { x, y: 0, z }, width: 6, depth: 6,
    height: 3.5, floorIndex: 0, materialTheme: 'greybox', connections: conns,
  })
  const rooms = [
    mkRoom('a', -10, 0, ['b']), mkRoom('b', 10, 0, ['a']),
    mkRoom('c', 0, -10, ['d']), mkRoom('d', 0, 10, ['c']),
  ]
  const mkCorr = (id: string, s: string, e: string, x1: number, z1: number, x2: number, z2: number): Corridor => ({
    id, startRoomId: s, endRoomId: e,
    startPos: { x: x1, y: 0, z: z1 }, endPos: { x: x2, y: 0, z: z2 },
    width: 2, floorIndex: 0,
    pathPoints: [{ x: x1, y: 0, z: z1 }, { x: x2, y: 0, z: z2 }],
  })
  const corridors = [
    mkCorr('corridor_a_b', 'a', 'b', -7, 0, 7, 0),
    mkCorr('corridor_c_d', 'c', 'd', 0, -7, 0, 7),
  ]
  assert.equal(findCorridorCrossings(corridors).length, 1)
  const config = { ...getDefaultConfig(), roomCount: 4, floorCount: 1 }
  const boundary = { shape: 'square' as const, width: 60, depth: 60, center: { x: 0, y: 0 } }
  const out = planJunctions(rooms, corridors, config, boundary, 4, [])
  assert.ok(out, 'placeable X-crossing must junction')
  assert.equal(out.rooms.length, 5)
  const j = out.rooms.find(r => r.junction)!
  assert.equal(j.type, 'connector')
  assert.equal(j.connections.length, 4)
  const byId = new Map(out.rooms.map(r => [r.id, r]))
  assert.ok(!byId.get('a')!.connections.includes('b'), 'blind intent removed')
  assert.ok(!byId.get('c')!.connections.includes('d'), 'blind intent removed')
  for (const e of ['a', 'b', 'c', 'd']) {
    assert.ok(byId.get(e)!.connections.includes(j.id), `${e} joins the plaza`)
  }
  // Every remaining crossing shares the plaza (recorded junction): the
  // validator honors shared endpoints without code changes.
  for (const x of findCorridorCrossings(out.corridors)) {
    const shared =
      x.a.startRoomId === j.id || x.a.endRoomId === j.id ||
      x.b.startRoomId === j.id || x.b.endRoomId === j.id
    assert.ok(shared, `${x.a.id} x ${x.b.id} shares the plaza`)
  }
})

test('ring crossing seed stays clean and crossing-free', () => {
  // Full generation regression (config + seed recorded): ring/40448
  // failed with a lone CORRIDOR_CROSSING before junction repair.
  // History: 0.1.7-0.1.9 winners converted the crossing into a live
  // plaza; the wider 0.1.10 retry budget finds a fully clean routing
  // with no crossing at all. Both outcomes are honest — pin the current
  // one (clean, deterministic, crossing-free). Junction repair itself
  // stays pinned by the white-box test, ring/40457, and the compact test.
  const config = {
    ...getDefaultConfig(),
    roomCount: 24, floorCount: 2, area: 6000, shape: 'ring' as const,
    largeRoomCount: 2, seed: 40448,
  }
  const level = generateLevel(config)
  assert.equal(level.ok, true)
  assert.deepEqual(generateLevel(config), level)
  assert.ok(!level.validation.errors.some(i => i.code === 'CORRIDOR_CROSSING'))
})

test('wide-corridor mouth foul subdivides through a nearby room', () => {
  // Full generation regression (config + seed recorded): warehouse/181
  // failed with CORRIDOR_ROOM_COLLISION (mouth foul: 4 m ribbon
  // re-entering its endpoint away from the doorway) before foul
  // subdivision searched 15 m for midpoint hops. Lawbook §70 step 5.
  const config = { ...applyPreset(getDefaultConfig(), 'warehouse'), seed: 181 }
  const level = generateLevel(config)
  assert.equal(level.ok, true)
  assert.deepEqual(generateLevel(config), level)
  assert.ok(!level.validation.errors.some(i => i.code === 'CORRIDOR_ROOM_COLLISION'))
  assert.ok(!level.validation.errors.some(i => i.code === 'PORTAL_SEALED'))
})

test('hole-blocked crossing nudges its plaza into the walkable band', () => {
  // Full generation regression (config + seed recorded): ring/40457
  // failed with PORTAL_SEALED + CORRIDOR_CROSSING (brush crossing with no
  // junction point, plus a sealed gate) before plaza spiral search tried
  // band positions around blocked crossing points. Lawbook §34-35.
  const config = {
    ...getDefaultConfig(),
    roomCount: 24, floorCount: 2, area: 6000, shape: 'ring' as const,
    largeRoomCount: 2, seed: 40457,
  }
  const level = generateLevel(config)
  assert.equal(level.ok, true)
  assert.deepEqual(generateLevel(config), level)
  assert.ok(level.rooms.some(r => r.junction), 'nudged plaza recorded')
  assert.ok(!level.validation.errors.some(i => i.code === 'CORRIDOR_CROSSING'))
  assert.ok(!level.validation.errors.some(i => i.code === 'PORTAL_SEALED'))
})

test('retry selection ranks unrepairable placement failures above routing failures', () => {
  // Lawbook §2 + §70: overlap/nesting/bounds/size can only be cured by a
  // different placement, never by corridor repair — so one overlap must
  // lose to any number of repairable mouth fouls in attempt selection.
  const mk = (code: IssueCode, severity: GenerationIssue['severity'] = 'error'): GenerationIssue => ({
    code, severity, stage: 'test', objectIds: [], message: code,
  })
  assert.ok(isPlacementFailure('ROOM_OVERLAP'))
  assert.ok(isPlacementFailure('ROOM_NESTED'))
  assert.ok(isPlacementFailure('ROOM_OUT_OF_BOUNDS'))
  assert.ok(isPlacementFailure('ROOM_TOO_SMALL'))
  assert.ok(!isPlacementFailure('PORTAL_SEALED'))
  assert.ok(!isPlacementFailure('CORRIDOR_CROSSING'))
  assert.ok(!isPlacementFailure('STAIR_NO_PLACEMENT'))
  const overlapPlusSeal = tiersOf([mk('ROOM_OVERLAP'), mk('PORTAL_SEALED')])
  assert.equal(overlapPlusSeal.t1p, 1)
  assert.equal(overlapPlusSeal.t1, 2)
  const fiveSeals = tiersOf([
    mk('PORTAL_SEALED'), mk('PORTAL_SEALED'), mk('PORTAL_SEALED'),
    mk('PORTAL_SEALED'), mk('PORTAL_SEALED'),
  ])
  assert.equal(fiveSeals.t1p, 0)
  assert.equal(fiveSeals.t1, 5)
  assert.ok(compareTiers(fiveSeals, overlapPlusSeal) < 0, 'placeable layout wins despite more fouls')
  assert.ok(compareTiers(overlapPlusSeal, fiveSeals) > 0)
  // Clean equivalence and warning handling are unchanged.
  assert.deepEqual(tiersOf([]), { t1: 0, t1p: 0, t2: 0, t3: 0 })
  assert.equal(tiersOf([mk('ROOM_ASPECT', 'warning')]).t3, 1)
  assert.equal(compareTiers(tiersOf([]), tiersOf([])), 0)
})

test('dense band crossing falls back to a compact 2.4 m plaza', () => {
  // White-box junction repair (deterministic, no seed): hand-built
  // X-crossing at the origin with a blocker room parked so the full-size
  // 3 m center square is fouled but a 2.4 m square fits. Lawbook §34-35
  // plus §100 wall capacity (2.4 m still hosts one 1.8 m gate per wall).
  const mkRoom = (id: string, x: number, z: number, w: number, d: number, conns: string[]): Room => ({
    id, type: 'standard', position: { x, y: 0, z }, width: w, depth: d,
    height: 3.5, floorIndex: 0, materialTheme: 'greybox', connections: conns,
  })
  const rooms = [
    mkRoom('a', -10, 0, 6, 6, ['b']), mkRoom('b', 10, 0, 6, 6, ['a']),
    mkRoom('c', 0, -10, 6, 6, ['d']), mkRoom('d', 0, 10, 6, 6, ['c']),
    mkRoom('blocker', 0, 2.9, 2, 2, []),
  ]
  const mkCorr = (id: string, s: string, e: string, x1: number, z1: number, x2: number, z2: number): Corridor => ({
    id, startRoomId: s, endRoomId: e,
    startPos: { x: x1, y: 0, z: z1 }, endPos: { x: x2, y: 0, z: z2 },
    width: 2, floorIndex: 0,
    pathPoints: [{ x: x1, y: 0, z: z1 }, { x: x2, y: 0, z: z2 }],
  })
  const corridors = [
    mkCorr('corridor_a_b', 'a', 'b', -7, 0, 7, 0),
    mkCorr('corridor_c_d', 'c', 'd', 0, -7, 0, 7),
  ]
  assert.equal(findCorridorCrossings(corridors).length, 1)
  const config = { ...getDefaultConfig(), roomCount: 5, floorCount: 1 }
  const boundary = { shape: 'square' as const, width: 60, depth: 60, center: { x: 0, y: 0 } }
  const out = planJunctions(rooms, corridors, config, boundary, 4, [])
  assert.ok(out, 'compact fallback must place where full size cannot')
  assert.equal(out.rooms.length, 6)
  const j = out.rooms.find(r => r.junction)!
  assert.equal(j.width, 2.4)
  assert.equal(j.depth, 2.4)
  // §87 honesty: the south stub subdivides around the blocker, so the
  // direct d-plaza edge is dropped explicitly instead of lingering as a
  // phantom linkage — while d stays connected through the hop.
  assert.deepEqual([...j.connections].sort(), ['a', 'b', 'c'])
  const byId = new Map(out.rooms.map(r => [r.id, r]))
  assert.ok(!byId.get('d')!.connections.includes(j.id), 'phantom edge dropped on both ends')
  assert.ok(!byId.get('blocker')!.connections.includes(j.id), 'hop recording is downstream job')
  // No remaining plaza edge lacks a shipped direct corridor.
  const keys = new Set(out.corridors.map(c => [c.startRoomId, c.endRoomId].sort().join('|')))
  for (const e of j.connections) {
    assert.ok(keys.has([j.id, e].sort().join('|')), `${j.id}-${e} is realized`)
  }
  assert.ok(!byId.get('a')!.connections.includes('b'), 'blind intent removed')
  assert.ok(!byId.get('c')!.connections.includes('d'), 'blind intent removed')
  // Every plaza end is spatially realized: a direct stub, or a hop
  // through another room (§87 — the south stub subdivides around the
  // blocker). Reachability over shipped corridors is the honest check.
  const adj = new Map<string, Set<string>>()
  for (const r of out.rooms) adj.set(r.id, new Set())
  for (const c of out.corridors) {
    adj.get(c.startRoomId)?.add(c.endRoomId)
    adj.get(c.endRoomId)?.add(c.startRoomId)
  }
  for (const e of ['a', 'b', 'c', 'd']) {
    const seen = new Set<string>([e])
    const queue = [e]
    while (queue.length > 0) {
      const cur = queue.pop()!
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb)
          queue.push(nb)
        }
      }
    }
    assert.ok(seen.has(j.id), `${e} reaches the plaza over shipped corridors`)
  }
})

test('wider mid-size retry budget repairs a lone ring-band crossing', () => {
  // Full generation regression (config + seed recorded): ring/40489
  // failed with a lone CORRIDOR_CROSSING (no placeable plaza inside the
  // 15-layout budget) before the 21-30-room bracket grew to 24 draws.
  // (~20 s: the winning attempt needs deep retries.)
  const config = {
    ...getDefaultConfig(),
    roomCount: 24, floorCount: 2, area: 6000, shape: 'ring' as const,
    largeRoomCount: 2, seed: 40489,
  }
  const level = generateLevel(config)
  assert.equal(level.ok, true)
  assert.deepEqual(generateLevel(config), level)
  assert.ok(!level.validation.errors.some(i => i.code === 'CORRIDOR_CROSSING'))
})

test('corridor joints bury past the wall band and close tube ends', () => {
  // Lawbook §52: ribbon ends must not leave see-through slits. Wall
  // tubes get end caps, and every end extends jointOverlap past the door
  // plane (through the 0.30 band plus a proud jamb).
  const corridor: Corridor = {
    id: 'corridor_test', startRoomId: 'a', endRoomId: 'b', floorIndex: 0,
    width: 2, startPos: { x: -7, y: 0, z: 0 }, endPos: { x: 7, y: 0, z: 0 },
    pathPoints: [{ x: -7, y: 0, z: 0 }, { x: 7, y: 0, z: 0 }],
  }
  const [built] = generateCorridorGeometry([corridor], 3.5)
  const overlap = SPATIAL_DEFAULTS.jointOverlap
  let minX = Infinity, maxX = -Infinity
  for (const m of [...built.walls, built.floor]) {
    for (let i = 0; i < m.vertices.length; i += 3) {
      minX = Math.min(minX, m.vertices[i])
      maxX = Math.max(maxX, m.vertices[i])
    }
  }
  assert.ok(minX <= -7 - overlap + 1e-6, `start burial ${minX}`)
  assert.ok(maxX >= 7 + overlap - 1e-6, `end burial ${maxX}`)
  // End caps: triangles whose normals run along the corridor axis at an
  // end plane (wall ribbons used to end as open tubes).
  let caps = 0
  for (const m of built.walls) {
    for (let i = 0; i < m.indices.length; i += 3) {
      const n = new THREE.Vector3().fromArray(m.normals, m.indices[i] * 3)
      if (Math.abs(n.x) < 0.99) continue
      const xs = [0, 1, 2].map(k => new THREE.Vector3().fromArray(m.vertices, m.indices[i + k] * 3).x)
      if (xs.every(x => Math.abs(x - minX) < 0.01 || Math.abs(x - maxX) < 0.01)) caps++
    }
  }
  assert.ok(caps >= 4, `both tube ends capped (both walls), found ${caps} cap triangles`)
})

test('shared doorway holes get trim liners outside clear mouth spans', () => {
  // Two gates 1.1 m apart share one merged hole: the strips between and
  // around the mouths are wall, not opening. Fillers (trim slot) close
  // exactly those strips and never enter a clear span.
  const room: Room = {
    id: 'room_0', type: 'standard', position: { x: 0, y: 0, z: 0 },
    width: 10, depth: 10, height: 3.5, floorIndex: 0,
    materialTheme: 'greybox', connections: [],
  }
  const door = (z: number): DoorOpening => ({
    roomId: 'room_0', wallIndex: 1, position: { x: 5, y: 0.1, z },
    width: 1.0, height: 2.4, targetRoomId: 'other',
  })
  const [two] = generateRoomGeometry([room], new Map([['room_0', [door(-0.55), door(0.55)]]]))
  const trims = two.walls.filter(m => m.materialIndex === 3 && m.vertices.length > 0)
  assert.ok(trims.length > 0, 'merged span emits trim fillers')
  // Mouth intervals [-1.05,-0.05] and [0.05,1.05]: only the 0.1 middle
  // strip plus nothing else may be filled.
  let zMin = Infinity, zMax = -Infinity, xMin = Infinity, xMax = -Infinity, yMax = -Infinity
  for (const m of trims) {
    for (let i = 0; i < m.vertices.length; i += 3) {
      zMin = Math.min(zMin, m.vertices[i + 2]); zMax = Math.max(zMax, m.vertices[i + 2])
      xMin = Math.min(xMin, m.vertices[i]); xMax = Math.max(xMax, m.vertices[i])
      yMax = Math.max(yMax, m.vertices[i + 1])
    }
  }
  assert.ok(zMin >= -0.05 - 1e-6 && zMax <= 0.05 + 1e-6, `filler stays in the gap strip, got [${zMin}, ${zMax}]`)
  assert.ok(xMin >= 5 - SPATIAL_DEFAULTS.wallThickness - 1e-6 && xMax <= 5 + 1e-6, 'filler stays inside the band')
  assert.ok(yMax <= 2.4 + 1e-6, 'filler stays below the header')
  // Single-mouth control: hole == mouth, so no trim may appear.
  const [one] = generateRoomGeometry([room], new Map([['room_0', [door(0)]]]))
  assert.ok(one.walls.every(m => m.materialIndex !== 3 || m.vertices.length === 0), 'no fillers without shared spans')
})

test('stair landings meet the stairwell hole edge flush at step-off', () => {
  // Lawbook §46: the exit edge extends exactly stairwellClear past the
  // footprint edge to butt-join the hole edge — no step-off moat, no
  // tuck-underlap to z-fight, tops flush with the arrival slab.
  const lo: Room = {
    id: 'lo', type: 'standard', position: { x: 0, y: 0, z: 0 }, width: 10, depth: 10,
    height: 3.5, floorIndex: 0, materialTheme: 'greybox', connections: ['up'],
  }
  const up: Room = {
    id: 'up', type: 'standard', position: { x: 0, y: 4, z: 0 }, width: 10, depth: 10,
    height: 3.5, floorIndex: 1, materialTheme: 'greybox', connections: ['lo'],
  }
  const sm = stairMathFor(4.0)
  const straight: StairPlan = {
    link: { lowerRoomId: 'lo', upperRoomId: 'up' }, hostRoomId: 'lo', ascending: true,
    axis: 'x', dir: 1, x: 0, z: 0, width: 1.4, depth: 8.2, kind: 'inroom',
    switchback: false, stepCount: sm.stepCount, stepHeight: sm.stepHeight, stepDepth: sm.stepDepth,
    towerRect: null, towerDoor: null,
  }
  const [straightBuilt] = buildStairsGeometry([straight], [lo, up], 4.0)
  const lBox = (m: MeshData): { minX: number; maxX: number; maxY: number } => {
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < m.vertices.length; i += 3) {
      minX = Math.min(minX, m.vertices[i]); maxX = Math.max(maxX, m.vertices[i])
      maxY = Math.max(maxY, m.vertices[i + 1])
    }
    return { minX, maxX, maxY }
  }
  const sl = lBox(straightBuilt.landing[0])
  assert.ok(Math.abs(sl.maxX - (8.2 / 2 + SPATIAL_DEFAULTS.stairwellClear)) < 1e-6, `landing meets hole edge, got ${sl.maxX}`)
  // Float32 storage: exact-decimal tops (4.2) round-trip within 1e-6.
  assert.ok(Math.abs(sl.maxY - 4.2) < 1e-6, `landing flush with slab, got ${sl.maxY}`)
  // Switchback arrival deck: exit is always toward canonical -along, so
  // the deckStart side extends to its hole edge with a flush top.
  const folded: StairPlan = { ...straight, width: 2.4, depth: 4.5, switchback: true }
  const [foldBuilt] = buildStairsGeometry([folded], [lo, up], 4.0)
  const deck = foldBuilt.landing[foldBuilt.landing.length - 1]
  const dl = lBox(deck)
  assert.ok(Math.abs(dl.minX - (-4.5 / 2 - SPATIAL_DEFAULTS.stairwellClear)) < 1e-6, `deck meets hole edge, got ${dl.minX}`)
  assert.ok(Math.abs(dl.maxY - (sm.stepCount * sm.stepHeight + 0.2)) < 1e-6, `deck flush with slab, got ${dl.maxY}`)
})

test('generated stair arrivals step onto slab without a moat', () => {
  // End-to-end version of the landing pin above (config + seed
  // recorded): every arrival's exit edge must sit within a hair of an
  // upper floor part, with tops flush. Exit side is read off the
  // landing itself (landings always sit at the exit end).
  const config = { ...applyPreset(getDefaultConfig(), 'dungeon'), seed: 7 }
  const level = generateLevel(config)
  assert.equal(level.ok, true)
  assert.deepEqual(generateLevel(config), level)
  assert.ok(level.stairs.length > 0, 'seed must exercise stairs')
  for (const s of level.stairs) {
    const upper = level.rooms.find(r => r.id === s.upperRoomId)!
    const ug = level.roomGeometry.find(g => g.id === upper.id)!
    const sy = s.startFloor * level.floorHeight
    // Frames: stair meshes are world-space (builder bakes plan.x/z;
    // only the group Y offset applies), room meshes are room-local.
    // Exit side comes from the ARRIVAL-level landing mass only: lower
    // turn landings would drag the centroid the wrong way.
    let top = -Infinity
    for (const m of s.landing) {
      for (let i = 0; i < m.vertices.length; i += 3) {
        top = Math.max(top, m.vertices[i + 1] + sy)
      }
    }
    let cx = 0, cz = 0, n = 0
    for (const m of s.landing) {
      let mTop = -Infinity
      for (let i = 0; i < m.vertices.length; i += 3) {
        mTop = Math.max(mTop, m.vertices[i + 1] + sy)
      }
      if (top - mTop > 0.05) continue
      for (let i = 0; i < m.vertices.length; i += 3) {
        cx += m.vertices[i]; cz += m.vertices[i + 2]; n++
      }
    }
    assert.ok(n > 0, `${s.id} has arrival-level landing`)
    cx /= n; cz /= n
    const along = s.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 }
    // Exit side: landing mass sits toward the exit end by construction.
    const sgn = Math.sign((cx - s.position.x) * along.x + (cz - s.position.z) * along.z) || 1
    const ex = along.x * sgn, ez = along.z * sgn
    let landMax = -Infinity
    for (const m of s.landing) {
      for (let i = 0; i < m.vertices.length; i += 3) {
        landMax = Math.max(landMax, m.vertices[i] * ex + m.vertices[i + 2] * ez)
      }
    }
    let slabMin = Infinity
    for (const f of ug.floor) {
      for (let i = 0; i < f.vertices.length; i += 3) {
        const a = (f.vertices[i] + upper.position.x) * ex + (f.vertices[i + 2] + upper.position.z) * ez
        if (a > landMax - 0.5 && a < slabMin) slabMin = a
      }
    }
    assert.ok(Math.abs(top - (upper.position.y + 0.2)) < 0.005, `${s.id} tops flush, got ${top}`)
    if (isFinite(slabMin)) {
      assert.ok(slabMin - landMax <= 0.05, `${s.id} step-off gap ${slabMin - landMax}`)
    }
  }
})

test('preview lighting fills interiors and theme slots stay valid', () => {
  // Walk mode lives inside rooms lit only through doorways: ambient +
  // hemisphere must exist so interiors never fall to black. Theme slots
  // keep engine-independent params (preview/export share them).
  const scene = new LevelScene()
  let hemi = 0, ambient = 0
  scene.scene.traverse(obj => {
    if (obj instanceof THREE.HemisphereLight) hemi++
    if (obj instanceof THREE.AmbientLight) ambient = (obj as THREE.AmbientLight).intensity
  })
  assert.equal(hemi, 1)
  assert.ok(ambient >= 0.5, `ambient fills interiors, got ${ambient}`)
  scene.dispose()
  for (const name of getAvailableThemes()) {
    const mats = createMaterials(name)
    assert.equal(mats.size, 6)
    for (const m of mats.values()) {
      const p = m as THREE.MeshStandardMaterial
      assert.ok(Number.isFinite(p.roughness) && p.roughness >= 0 && p.roughness <= 1, `${name} roughness`)
      assert.ok(Number.isFinite(p.metalness) && p.metalness >= 0 && p.metalness <= 1, `${name} metalness`)
    }
    mats.forEach(m => m.dispose())
  }
  const grey = (createMaterials('greybox').get(0) as THREE.MeshStandardMaterial).color.getHex()
  assert.equal(grey, 0x999999)
})

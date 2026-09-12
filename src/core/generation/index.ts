import type { LevelConfig, Room, Corridor, Boundary, DoorOpening, StairsGeometry } from '@/core/types'
import { floorHeightFor, corridorHeightFor } from '@/core/types'
import { SeededRandom, hashString } from '@/core/random'
import { circulationGap, gateWidthFor, validateConfigFeasibility, SPATIAL_DEFAULTS } from '@/core/rules'
import { buildLevelGraph, validateLevelGraph } from '@/core/levelGraph'
import { generateBoundary } from '@/generator/boundary'
import { generateTopology } from '@/generator/topology'
import { assignRoomSizes, placeRooms, resolveOverlaps } from '@/generator/rooms'
import { generateCorridors } from '@/generator/corridors'
import { generateRoomGeometry, generateCorridorGeometry } from '@/generator/geometry'
import type { RoomSlabHoles } from '@/generator/geometry'
import { planStairs, buildStairsGeometry, rewriteVerticalLinks, type StairPlan } from '@/generator/vertical'
import {
  compareTiers,
  reportOf,
  tiersOf,
  validateCorridors,
  validateDoors,
  validateExportModel,
  validateNavigationGrid,
  validatePortalCapacity,
  validatePortalSampling,
  validatePortalSeals,
  validateRealizedConnectivity,
  validateRoomAspects,
  validateRoomPlacement,
  validateSlabOpenings,
  validateStairHeadroom,
  validateStairs,
  validateStairsGeometry,
  type ErrorTiers,
  type GenerationIssue,
  type ValidationReport,
} from '@/core/validation'

export interface GeneratedLevel {
  config: LevelConfig
  boundary: Boundary
  rooms: Room[]
  corridors: Corridor[]
  stairs: StairsGeometry[]
  roomGeometry: ReturnType<typeof generateRoomGeometry>
  corridorGeometry: ReturnType<typeof generateCorridorGeometry>
  seed: number
  /** Floor spacing actually used (from wall height). */
  floorHeight: number
  /** Structured stage-gate findings (lawbook §84). Errors mean the level
   * violates a hard invariant even though a preview is still returned. */
  validation: ValidationReport
}

export function generateLevel(rawConfig: LevelConfig): GeneratedLevel {
  // Normalize: older configs / presets may lack the gate dimensions.
  // Defaults preserve the previous look (1.8 x 2.4 m gates).
  const config: LevelConfig = {
    ...rawConfig,
    doorWidth: rawConfig.doorWidth ?? 1.8,
    doorHeight: rawConfig.doorHeight ?? 2.4,
  }

  // Stage 0: feasibility gate (lawbook §73). Impossible configurations
  // fail with a clear message — never by silently shrinking dimensions.
  const configErrors = validateConfigFeasibility(config)
  if (configErrors.length > 0) {
    throw new Error(
      `[LevelWeaver] impossible configuration:\n` +
        configErrors.map(e => `  [${e.code}] ${e.message}`).join('\n'),
    )
  }

  // Lawbook §8.1: hierarchical deterministic streams. Each stage draws
  // from its own sub-seed so decoration tweaks can never reshuffle rooms.
  const root = new SeededRandom(config.seed)
  const boundaryRng = root.derive('boundary')
  const topologyRng = root.derive('topology')
  const sizingRng = root.derive('sizing')
  // All vertical dimensions derive from the configured wall height so
  // stacked floors, corridors, stairs, and doors stay consistent.
  const floorHeight = floorHeightFor(config)
  const corridorHeight = corridorHeightFor(config)

  // Stage 1: Generate boundary
  const boundary = generateBoundary(config, boundaryRng)

  // Stage 3 + stages 4-7b with TWO-LEVEL bounded deterministic retry
  // (lawbook §69-70). Inner loop re-runs placement → vertical rewrite →
  // corridors → doors → stairs with derived layout seeds (topology
  // preserved). If all 8 layouts keep hard errors, the OUTER loop
  // regenerates topology+sizes from a derived seed (repair step 9:
  // topology regen as last resort — e.g. a topology whose floor-0 rooms
  // are all too small to host any stair). Attempt 0 reproduces the exact
  // legacy stream sequence, and strictly-less replacement keeps it
  // whenever it already wins, so passing seeds never change output.
  // All attempt seeds are stable hashes, never hidden reseeds.
  const MAX_TOPO_ATTEMPTS = 3
  const MAX_LAYOUT_ATTEMPTS = 8
  // Attempt-0 topology+sizes, computed once and shared by all attempt-0
  // layouts (regenerating per attempt would consume the RNG stream and
  // reshuffle every seed).
  const sizedRooms0 = assignRoomSizes(generateTopology(config, boundary, topologyRng), config, sizingRng)
  // Lawbook §2 Order of Authority in repair selection: compare error
  // TIERS lexicographically (physical > traversal > quality), not raw
  // counts — a sealed gate must never trade evenly against a side stat.
  const better = (
    next: { tiers: ErrorTiers; stairPlans: StairPlan[] },
    layout: { tiers: ErrorTiers; stairPlans: StairPlan[] },
  ): boolean =>
    compareTiers(next.tiers, layout.tiers) < 0 ||
    (compareTiers(next.tiers, layout.tiers) === 0 && next.stairPlans.length > layout.stairPlans.length)
  const clean = (layout: { tiers: ErrorTiers }): boolean =>
    layout.tiers.t1 === 0 && layout.tiers.t2 === 0
  let layout = runLayoutAttempt(sizedRooms0, boundary, config, floorHeight, 0, 0)
  for (let topoAttempt = 0; topoAttempt < MAX_TOPO_ATTEMPTS; topoAttempt++) {
    if (topoAttempt > 0) {
      const tRng = new SeededRandom(hashString(`${config.seed}:topology:${topoAttempt}`))
      const sRng = new SeededRandom(hashString(`${config.seed}:sizing:${topoAttempt}`))
      const sizedRooms = assignRoomSizes(generateTopology(config, boundary, tRng), config, sRng)
      for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS; attempt++) {
        const next = runLayoutAttempt(sizedRooms, boundary, config, floorHeight, attempt, topoAttempt)
        if (better(next, layout)) {
          layout = next
        }
        if (clean(layout)) break
      }
    } else {
      for (let attempt = 1; attempt < MAX_LAYOUT_ATTEMPTS; attempt++) {
        if (clean(layout)) break
        const next = runLayoutAttempt(sizedRooms0, boundary, config, floorHeight, attempt, 0)
        if (better(next, layout)) {
          layout = next
        }
      }
    }
    if (clean(layout)) break
  }
  const { rooms, corridors, doorOpenings, stairPlans, slabHoles } = layout

// One spatial layout attempt (stages 4-7b). Pure and deterministic for
// (rooms, config, attempt, topoAttempt): the placement RNG nests both
// attempt indices as a stable hash, and every downstream stage
// (corridors, stairs) is itself deterministic.
function runLayoutAttempt(
  sizedRooms: Room[],
  boundary: Boundary,
  config: LevelConfig,
  floorHeight: number,
  attempt: number,
  topoAttempt: number,
): {
  rooms: Room[]
  corridors: Corridor[]
  doorOpenings: Map<string, DoorOpening[]>
  stairPlans: StairPlan[]
  slabHoles: Map<string, RoomSlabHoles>
  tiers: ErrorTiers
} {
  // Fresh copies: placement spreads rooms but shares connection arrays,
  // and the vertical rewrite reassigns them — never mutate the topology.
  const roomsInput = sizedRooms.map(r => ({ ...r, connections: [...r.connections] }))
  // topoAttempt 0 keeps the legacy placement stream exactly so passing
  // seeds reproduce bit-for-bit; higher attempts nest independently.
  const placementRng = topoAttempt === 0
    ? new SeededRandom(hashString(`${config.seed}:layout:${attempt}`))
    : new SeededRandom(hashString(`${config.seed}:layout:${topoAttempt}:${attempt}`))

  // Stage 4-5: place + resolve (per-floor, circulation gaps per §22).
  let rooms = placeRooms(roomsInput, boundary, config, placementRng)
  rooms = resolveOverlaps(rooms, boundary, circulationGap(config))

  // Stage 5b: vertical links rewritten by final overlap (lawbook §49).
  rewriteVerticalLinks(rooms, floorHeight)

  // Stage 6-7: corridors + gate openings (shared gate rule, §28).
  const corridors = generateCorridors(rooms, config)
  // Lawbook §87: long intent edges subdivided into hops (A-M, M-B) are
  // spatial realizations, not silent drops — record the hop edges in the
  // graph explicitly. Same-floor only, so vertical intent is untouched.
  for (const c of corridors) {
    const a = rooms.find(r => r.id === c.startRoomId)
    const b = rooms.find(r => r.id === c.endRoomId)
    if (a && b) {
      if (!a.connections.includes(b.id)) a.connections.push(b.id)
      if (!b.connections.includes(a.id)) b.connections.push(a.id)
    }
  }
  const doorOpenings = computeDoorOpenings(rooms, corridors, config)

  // Stage 7b: stairs with reserved slab holes.
  const corridorSlabs = collectCorridorSlabs(corridors)
  const corridorDegree = new Map<string, number>()
  for (const corridor of corridors) {
    corridorDegree.set(corridor.startRoomId, (corridorDegree.get(corridor.startRoomId) ?? 0) + 1)
    corridorDegree.set(corridor.endRoomId, (corridorDegree.get(corridor.endRoomId) ?? 0) + 1)
  }
  const quiet = attempt > 0
  const stairPlans = planStairs(rooms, doorOpenings, {
    corridorSlabsByFloor: corridorSlabs,
    boundary,
    corridorDegree,
    floorHeight,
    quiet,
  })
  mergeTowerDoors(rooms, doorOpenings, stairPlans, config)
  const slabHoles = computeSlabHoles(rooms, stairPlans)

  // Attempt score: layout-dependent hard errors — realized graph
  // traversal (§10, §62), sealed gates (§61), stair headroom (§45),
  // corridor lawfulness (§30/36), and physical grid navigation (§59-60).
  // Size/topology-bound checks (aspects, capacity, slabs) run once at the end.
  const attemptIssues: GenerationIssue[] = [
    ...validateRealizedConnectivity(rooms, corridors, stairPlans, config.floorCount),
    ...validatePortalSampling(rooms, doorOpenings, corridors, stairPlans),
    ...validatePortalSeals(rooms, doorOpenings, corridors),
    ...validateStairHeadroom(rooms, stairPlans, corridors),
    ...validateCorridors(corridors),
    ...validateNavigationGrid(rooms, doorOpenings, corridors, stairPlans, floorHeight),
    ...validateRoomPlacement(rooms, boundary),
    ...validateDoors(rooms, doorOpenings),
    ...validateStairs(stairPlans),
  ]
  return { rooms, corridors, doorOpenings, stairPlans, slabHoles, tiers: tiersOf(attemptIssues) }
}

  // Stage 8: Generate geometry
  const roomGeometry = generateRoomGeometry(rooms, doorOpenings, slabHoles)
  const corridorGeometry = generateCorridorGeometry(corridors, corridorHeight)
  const stairs = buildStairsGeometry(stairPlans, rooms, floorHeight)

  // Stage 8b: stage-gate validation (lawbook §68). Graph intent is NOT
  // enough: BFS runs over realized corridors + built stairs, rooms are
  // checked for overlap/nesting/bounds, gates for clear passability, and
  // stairs for riser/tread/width lawfulness. Findings are structured
  // (never bare console text) and travel with the level.
  const issues: GenerationIssue[] = []
  const graph = buildLevelGraph(rooms, corridors, config.floorCount, boundary)
  const legacy = validateLevelGraph(graph, stairPlans.map(p => p.link))
  if (legacy.isolatedRooms.length > 0) {
    console.warn(
      `[LevelWeaver] ${legacy.isolatedRooms.length} room(s) have no corridor or stair connections:`,
      legacy.isolatedRooms,
    )
  }
  issues.push(...validateRealizedConnectivity(rooms, corridors, stairPlans, config.floorCount))
  issues.push(...validateRoomPlacement(rooms, boundary))
  issues.push(...validateRoomAspects(rooms))
  issues.push(...validateDoors(rooms, doorOpenings))
  issues.push(...validatePortalCapacity(rooms, doorOpenings, config.doorWidth))
  issues.push(...validatePortalSampling(rooms, doorOpenings, corridors, stairPlans))
  issues.push(...validatePortalSeals(rooms, doorOpenings, corridors))
  issues.push(...validateCorridors(corridors))
  issues.push(...validateStairs(stairPlans))
  issues.push(...validateStairHeadroom(rooms, stairPlans, corridors))
  issues.push(...validateSlabOpenings(rooms, stairPlans, slabHoles))
  issues.push(...validateStairsGeometry(stairs))
  issues.push(...validateNavigationGrid(rooms, doorOpenings, corridors, stairPlans, floorHeight))
  issues.push(...validateExportModel({ roomGeometry, corridorGeometry, stairs }))
  const validation = reportOf(issues)
  if (validation.errors.length > 0) {
    console.warn(
      `[LevelWeaver] ${validation.errors.length} hard validation error(s):`,
      validation.errors.map(e => `[${e.code}] ${e.message}`),
    )
  }

  return {
    config,
    boundary,
    rooms,
    corridors,
    stairs,
    roomGeometry,
    corridorGeometry,
    seed: config.seed,
    floorHeight,
    validation,
  }
}

// Corridor slab footprints per floor (world XZ): stair arrivals must not
// land under a corridor slab crossing overhead.
function collectCorridorSlabs(corridors: Corridor[]): Map<number, { minX: number; maxX: number; minZ: number; maxZ: number }[]> {
  const slabs = new Map<number, { minX: number; maxX: number; minZ: number; maxZ: number }[]>()
  for (const corridor of corridors) {
    const pts = corridor.pathPoints && corridor.pathPoints.length > 0
      ? corridor.pathPoints
      : [corridor.startPos, corridor.endPos]
    let list = slabs.get(corridor.floorIndex)
    if (!list) {
      list = []
      slabs.set(corridor.floorIndex, list)
    }
    for (let i = 0; i < pts.length - 1; i++) {
      list.push({
        minX: Math.min(pts[i].x, pts[i + 1].x) - corridor.width / 2,
        maxX: Math.max(pts[i].x, pts[i + 1].x) + corridor.width / 2,
        minZ: Math.min(pts[i].z, pts[i + 1].z) - corridor.width / 2,
        maxZ: Math.max(pts[i].z, pts[i + 1].z) + corridor.width / 2,
      })
    }
  }
  return slabs
}

// Tower shaft mouths: door openings cut in the host wall where the shaft
// attaches (mouth matches the shaft, like corridor mouths match corridors).
// Gate dimensions come from settings so the player always fits.
function mergeTowerDoors(
  rooms: Room[],
  doorOpenings: Map<string, DoorOpening[]>,
  stairPlans: ReturnType<typeof planStairs>,
  config: LevelConfig,
): void {
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  for (const plan of stairPlans) {
    if (plan.kind !== 'tower' || !plan.towerDoor) continue
    const host = roomMap.get(plan.hostRoomId)
    const list = doorOpenings.get(plan.hostRoomId) ?? []
    list.push({
      roomId: plan.hostRoomId,
      wallIndex: plan.towerDoor.wallIndex,
      position: { x: plan.towerDoor.x, y: (host?.position.y ?? 0) + 0.1, z: plan.towerDoor.z },
      width: config.doorWidth,
      height: config.doorHeight,
      targetRoomId: plan.link.upperRoomId,
    })
    doorOpenings.set(plan.hostRoomId, list)
  }
}

// Stairwell holes: in-room stairs pierce the host ceiling above the flight;
// tower stairs stand outside (host ceiling stays intact). The upper room
// gets a floor hole where the flight overlaps it, so the landing genuinely
// arrives upstairs.
function computeSlabHoles(
  rooms: Room[],
  stairPlans: ReturnType<typeof planStairs>
): Map<string, RoomSlabHoles> {
  const holes = new Map<string, RoomSlabHoles>()
  const roomMap = new Map(rooms.map(r => [r.id, r]))

  const roomRect = (r: Room) => ({
    minX: r.position.x - r.width / 2,
    maxX: r.position.x + r.width / 2,
    minZ: r.position.z - r.depth / 2,
    maxZ: r.position.z + r.depth / 2,
  })
  const overlaps = (a: ReturnType<typeof roomRect>, b: ReturnType<typeof roomRect>) =>
    a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ

  const put = (roomId: string, patch: RoomSlabHoles) => {
    holes.set(roomId, { ...holes.get(roomId), ...patch })
  }

  for (const plan of stairPlans) {
    const lower = roomMap.get(plan.link.lowerRoomId)!
    const upper = roomMap.get(plan.link.upperRoomId)!
    if (!lower || !upper) continue

    const halfW = (plan.axis === 'z' ? plan.width : plan.depth) / 2
    const halfD = (plan.axis === 'z' ? plan.depth : plan.width) / 2
    const world = {
      minX: plan.x - halfW,
      maxX: plan.x + halfW,
      minZ: plan.z - halfD,
      maxZ: plan.z + halfD,
    }
    // Room-local ceiling hole for in-room hosts (tower stairs stand
    // outside: the host ceiling stays intact).
    if (plan.kind === 'inroom') {
      put(plan.hostRoomId, {
        ceiling: {
          minX: world.minX - lower.position.x,
          maxX: world.maxX - lower.position.x,
          minZ: world.minZ - lower.position.z,
          maxZ: world.maxZ - lower.position.z,
        },
      })
    }
    // Matching floor hole upstairs where the footprints overlap.
    if (overlaps(world, roomRect(upper))) {
      put(upper.id, {
        floor: {
          minX: Math.max(world.minX, upper.position.x - upper.width / 2) - upper.position.x,
          maxX: Math.min(world.maxX, upper.position.x + upper.width / 2) - upper.position.x,
          minZ: Math.max(world.minZ, upper.position.z - upper.depth / 2) - upper.position.z,
          maxZ: Math.min(world.maxZ, upper.position.z + upper.depth / 2) - upper.position.z,
        },
      })
    }
  }

  return holes
}

function computeDoorOpenings(rooms: Room[], corridors: Corridor[], config: LevelConfig): Map<string, DoorOpening[]> {
  const doorMap = new Map<string, DoorOpening[]>()
  const roomMap = new Map(rooms.map(r => [r.id, r]))

  for (const corridor of corridors) {
    const startRoom = roomMap.get(corridor.startRoomId)
    const endRoom = roomMap.get(corridor.endRoomId)
    if (!startRoom || !endRoom) continue

    // Add door to start room. Pinned mouth records from the router are
    // reused verbatim (lawbook §28): wall, lateral center, and width agree
    // with the corridor mouth by construction — even after mouth spreading
    // moved parallel corridors apart (§34). Legacy recompute as fallback.
    const startDoor = findDoorPosition(
      startRoom, endRoom.position, corridor.startPos, config, endRoom.id, corridor.startDoor,
    )
    if (startDoor) {
      if (!doorMap.has(startRoom.id)) doorMap.set(startRoom.id, [])
      doorMap.get(startRoom.id)!.push(startDoor)
    }

    // Add door to end room
    const endDoor = findDoorPosition(
      endRoom, startRoom.position, corridor.endPos, config, startRoom.id, corridor.endDoor,
    )
    if (endDoor) {
      if (!doorMap.has(endRoom.id)) doorMap.set(endRoom.id, [])
      doorMap.get(endRoom.id)!.push(endDoor)
    }
  }

  return doorMap
}

function findDoorPosition(
  room: Room,
  targetPos: { x: number; z: number },
  doorPos: { x: number; y: number; z: number },
  config: LevelConfig,
  targetRoomId: string,
  pinned?: { wallIndex: number; lateral: number; width: number }
): DoorOpening | null {
  const halfW = room.width / 2
  const halfD = room.depth / 2
  const doorHeight = config.doorHeight

  // Pinned mouth (normal case): wall, lateral center, and width come
  // straight from the router — no recompute that could drift.
  if (pinned) {
    let worldX = room.position.x
    let worldZ = room.position.z
    switch (pinned.wallIndex) {
      case 0: worldX += pinned.lateral; worldZ -= halfD; break
      case 1: worldX += halfW; worldZ += pinned.lateral; break
      case 2: worldX += pinned.lateral; worldZ += halfD; break
      default: worldX -= halfW; worldZ += pinned.lateral; break
    }
    return {
      roomId: room.id,
      wallIndex: pinned.wallIndex,
      position: { x: worldX, y: room.position.y + 0.1, z: worldZ },
      width: pinned.width,
      height: doorHeight,
      targetRoomId,
    }
  }

  // Legacy fallback (no pinned record): wall choice follows the direction
  // to the other room (identical rule to the corridor router). The center
  // follows the corridor's door point, which is already clamped, so this
  // clamp is idempotent.
  const relTX = targetPos.x - room.position.x
  const relTZ = targetPos.z - room.position.z
  const relDX = doorPos.x - room.position.x
  const relDZ = doorPos.z - room.position.z

  // Determine which wall the corridor connects to
  let wallIndex: number
  let doorCenter: number

  if (Math.abs(relTX) > Math.abs(relTZ)) {
    // Connects to +X or -X wall
    if (relTX > 0) {
      wallIndex = 1 // +X wall (right)
    } else {
      wallIndex = 3 // -X wall (left)
    }
    doorCenter = relDZ
  } else {
    // Connects to +Z or -Z wall
    if (relTZ > 0) {
      wallIndex = 2 // +Z wall (back)
    } else {
      wallIndex = 0 // -Z wall (front)
    }
    doorCenter = relDX
  }

  // Clamp door position to wall bounds with margin. Width follows the
  // shared gate rule (never wider than the setting, the corridor mouth,
  // or the wall itself). The corridor router uses the same rule, so the
  // mouth and the hole agree exactly.
  const wallLength = wallIndex % 2 === 0 ? room.width : room.depth
  const doorWidth = gateWidthFor(config, wallLength, config.corridorWidth)
  if (!(doorWidth > 0.05)) return null // wall far too short: no fake hole
  const cornerMargin = SPATIAL_DEFAULTS.doorCornerMargin
  const maxCenter = wallLength / 2 - doorWidth / 2 - cornerMargin
  const minCenter = -wallLength / 2 + doorWidth / 2 + cornerMargin
  const clampedCenter = maxCenter >= minCenter
    ? Math.max(minCenter, Math.min(maxCenter, doorCenter))
    : 0

  // Calculate world position of door center
  let worldX = room.position.x
  let worldZ = room.position.z
  
  switch (wallIndex) {
    case 0: // -Z front
      worldX += clampedCenter
      worldZ -= halfD
      break
    case 1: // +X right
      worldX += halfW
      worldZ += clampedCenter
      break
    case 2: // +Z back
      worldX += clampedCenter
      worldZ += halfD
      break
    case 3: // -X left
      worldX -= halfW
      worldZ += clampedCenter
      break
  }

  return {
    roomId: room.id,
    wallIndex,
    position: { x: worldX, y: room.position.y + 0.1, z: worldZ },
    width: doorWidth,
    height: doorHeight,
    targetRoomId,
  }
}

export function regenerateLevel(config: LevelConfig, newSeed?: number): GeneratedLevel {
  const newConfig = newSeed !== undefined ? { ...config, seed: newSeed } : config
  return generateLevel(newConfig)
}
import type { LevelConfig, Room, Corridor, Boundary, DoorOpening, Rect2D, StairsGeometry } from '@/core/types'
import { floorHeightFor, corridorHeightFor } from '@/core/types'
import { SeededRandom, hashString } from '@/core/random'
import { GENERATOR_VERSION, circulationGap, gateWidthFor, validateConfigFeasibility, SPATIAL_DEFAULTS } from '@/core/rules'
import { buildLevelGraph, validateLevelGraph } from '@/core/levelGraph'
import { generateBoundary, roomFootprintInBoundary } from '@/generator/boundary'
import { generateTopology, topUpDegrees } from '@/generator/topology'
import { assignRoomSizes, placeRooms, resolveOverlaps } from '@/generator/rooms'
import { generateCorridors } from '@/generator/corridors'
import { generateRoomGeometry, generateCorridorGeometry } from '@/generator/geometry'
import type { RoomSlabHoles } from '@/generator/geometry'
import { planStairs, buildStairsGeometry, rewriteVerticalLinks, type StairPlan, type TowerReservation } from '@/generator/vertical'
import {
  compareTiers,
  findCorridorCrossings,
  reportOf,
  tiersOf,
  validateCorridorIntrusions,
  validateCorridors,
  validateDoors,
  validateExportModel,
  validateLinkLengths,
  validateNavigationGrid,
  validatePortalCapacity,
  validatePortalSampling,
  validatePortalSeals,
  validateRealizedConnectivity,
  validateRoomAspects,
  validateRoomPlacement,
  validateSlabOpenings,
  validateStairArrivalWalls,
  validateStairClipping,
  validateStairHeadroom,
  validateStairs,
  validateStairsGeometry,
  type ErrorTiers,
  type GenerationIssue,
  type ValidationReport,
} from '@/core/validation'

// Links longer than this (room-center distance, same floor) are monster
// candidates: beyond the topology near-pick radius (45 m) with slack.
const MONSTER_LINK_OVER = 48
// Midpoint search radius shared with corridor subdivision: a monster WITH
// a midpoint room subdivides into hops instead of being pruned.
const MONSTER_MID_RADIUS = 12

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
  /** Generator version that produced this level (lawbook §8, §92). */
  generatorVersion: string
  /** Structured stage-gate findings (lawbook §84). Errors mean the level
   * violates a hard invariant even though a preview is still returned. */
  validation: ValidationReport
  /** True when the level passed every hard invariant (safe to export). */
  ok: boolean
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
  // preserved). If all layouts keep hard errors, the OUTER loop
  // regenerates topology+sizes from a derived seed (repair step 9:
  // topology regen as last resort — e.g. a topology whose floor-0 rooms
  // are all too small to host any stair). Attempt 0 reproduces the exact
  // legacy stream sequence, and strictly-less replacement keeps it
  // whenever it already wins, so passing seeds never change output.
  // All attempt seeds are stable hashes, never hidden reseeds.
  // Budgets scale DOWN with map size (lawbook §94): a 40-room map runs
  // ~70 corridor A* searches per attempt, so 24 full attempts hung for
  // 95 s. Large maps get fewer attempts — attempt 0 is always identical,
  // so clean seeds reproduce bit-for-bit regardless of budget. Tiers above
  // every shipped preset/matrix size (>40 rooms), so small maps are
  // byte-identical to narrower budgets.
  const MAX_TOPO_ATTEMPTS = config.roomCount > 80 ? 1 : config.roomCount > 30 ? 2 : 3
  const MAX_LAYOUT_ATTEMPTS =
    config.roomCount > 80 ? 2 : config.roomCount > 50 ? 2 : config.roomCount > 30 ? 3 : config.roomCount > 20 ? 5 : 12
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

  // Best-of-two mouth repair (lawbook §70 step 2): the attempts above all
  // use legacy facing-wall mouths. If the winning layout's only hard
  // fouls are mouth-geometry failures (sealed gates, endpoint mouth
  // intrusions, crossings — NOT placement failures, which mouths cannot
  // cure), rebuild the SAME placement with alternate-wall mouths and keep
  // the strictly better variant. Legacy wins ties, so clean seeds and
  // non-mouth failures reproduce exactly; only sealed layouts can change,
  // and only toward fewer hard errors. One extra routing pass, only when
  // triggered — clean generations pay nothing. Gated to ≤50 rooms: at
  // scale the fouls are systematic over-constraint, not unlucky mouths,
  // and a second full routing pass just burns main-thread seconds.
  if (config.roomCount <= 50 && layoutNeedsMouthRepair(layout)) {
    const altCorridors = generateCorridors(layout.roomsBase, config, true, layout.towerReservations)
    const alt = finishLayout(layout.roomsBase, altCorridors, boundary, config, floorHeight, layout.towerReservations)
    if (compareTiers(alt.tiers, layout.tiers) < 0) {
      layout = alt
    }
  }

  const { rooms, corridors, doorOpenings, stairPlans, slabHoles } = layout

// A layout qualifies for variant repair when alternate mouths can
// plausibly cure it: sealed gates, endpoint mouth intrusions, or corridor
// crossings (a new wall choice often routes around the other ribbon).
// Broken placement (overlap/nesting/out-of-bounds) vetoes: mouths cannot
// fix it, and the extra routing pass would be wasted.
function layoutNeedsMouthRepair(layout: LayoutResult): boolean {
  let mouthFoul = false
  for (const issue of layout.issues) {
    if (issue.severity !== 'error') continue
    if (
      issue.code === 'ROOM_OVERLAP' ||
      issue.code === 'ROOM_NESTED' ||
      issue.code === 'ROOM_OUT_OF_BOUNDS'
    ) {
      return false
    }
    if (issue.code === 'PORTAL_SEALED') mouthFoul = true
    // Endpoint mouth intrusions carry the '(mouth foul)' marker; unrelated
    // room crossings do not (see validateCorridorIntrusions).
    if (issue.code === 'CORRIDOR_ROOM_COLLISION' && issue.message.includes('(mouth foul)')) {
      mouthFoul = true
    }
    if (issue.code === 'CORRIDOR_CROSSING') mouthFoul = true
  }
  return mouthFoul
}

// One spatial layout attempt (stages 4-7b). Pure and deterministic for
// (rooms, config, attempt, topoAttempt): the placement RNG nests both
// attempt indices as a stable hash, and every downstream stage
// (corridors, stairs) is itself deterministic.
interface LayoutResult {
  /** Post-rewrite rooms, pre-hop (pristine base for variant rebuilds). */
  roomsBase: Room[]
  /** Rooms with realized hop edges recorded (§87). */
  rooms: Room[]
  corridors: Corridor[]
  doorOpenings: Map<string, DoorOpening[]>
  stairPlans: StairPlan[]
  slabHoles: Map<string, RoomSlabHoles>
  tiers: ErrorTiers
  issues: GenerationIssue[]
  /** Early tower-shaft reservations that steered corridor routing (§40). */
  towerReservations: TowerReservation[]
}

function runLayoutAttempt(
  sizedRooms: Room[],
  boundary: Boundary,
  config: LevelConfig,
  floorHeight: number,
  attempt: number,
  topoAttempt: number,
): LayoutResult {
  // Fresh copies: placement spreads rooms but shares connection arrays,
  // and the vertical rewrite reassigns them — never mutate the topology.
  const roomsInput = sizedRooms.map(r => ({ ...r, connections: [...r.connections] }))
  // topoAttempt 0 keeps the legacy placement stream exactly so passing
  // seeds reproduce bit-for-bit; higher attempts nest independently.
  const placementRng = topoAttempt === 0
    ? new SeededRandom(hashString(`${config.seed}:layout:${attempt}`))
    : new SeededRandom(hashString(`${config.seed}:layout:${topoAttempt}:${attempt}`))

  // Stage 4-5: place + resolve (per-floor, circulation gaps per §22).
  let roomsBase = placeRooms(roomsInput, boundary, config, placementRng)
  roomsBase = resolveOverlaps(roomsBase, boundary, circulationGap(config))

  // Semantic degree repair on PLACED rooms (lawbook §14): real footprints
  // for the §100 capacity check and real positions for the short-link cap,
  // after placement so new edges cannot distort it. Short by construction,
  // so corridors route them directly and stairs keep their hosts.
  topUpDegrees(roomsBase, config)

  // Stage 5b: vertical links rewritten by final overlap (lawbook §49).
  rewriteVerticalLinks(roomsBase, floorHeight)

  // Stage 5c: prune redundant monster loop-links (lawbook §12 loop
  // feasibility: reasonable geometric distance). Intent pairs chosen on
  // pre-placement positions can land absurdly far apart (sparse floors,
  // far extra picks); without a midpoint room to hop through they would
  // realize as 100 m monster corridors collecting seals and crossings.
  // Redundant ones are dropped explicitly — backbone bridges stay (they
  // are reported as LONG_LINK warnings so retry prefers compact
  // placements without failing legitimately sparse maps).
  pruneMonsterLinks(roomsBase)

  // Stage 6-7: corridors + gate openings (shared gate rule, §28).
  // Primary pass uses legacy facing-wall mouths (V0.1.0 behavior).
  // Lawbook §40: tower shafts are reserved BEFORE corridors claim open
  // space. The probe plans shafts only (no doors/corridors exist yet);
  // the final pass below re-plans every link with real constraints.
  const towerReservations = planTowerReservations(roomsBase, boundary, config, floorHeight)
  const corridors = generateCorridors(roomsBase, config, false, towerReservations)
  return finishLayout(roomsBase, corridors, boundary, config, floorHeight, towerReservations)
}

// Stages 6b-7b for a fixed placement: hop recording (§87), gate
// openings, stairs, slab holes, and attempt scoring. Pure for
// (roomsBase, corridors): the alt-mouth variant rebuilds from the same
// base, so neither variant pollutes the other with hop edges.
function finishTailLayout(
  roomsBase: Room[],
  corridors: Corridor[],
  boundary: Boundary,
  config: LevelConfig,
  floorHeight: number,
  towerReservations: TowerReservation[] = [],
): LayoutResult {
  // Hop copies: subdivision realizations join the graph explicitly on a
  // fresh copy so variant rebuilds never inherit stale hop edges.
  const rooms = roomsBase.map(r => ({ ...r, connections: [...r.connections] }))
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
  const corridorCapsules = collectCorridorCapsules(corridors, rooms, doorOpenings)
  const corridorDegree = new Map<string, number>()
  for (const corridor of corridors) {
    corridorDegree.set(corridor.startRoomId, (corridorDegree.get(corridor.startRoomId) ?? 0) + 1)
    corridorDegree.set(corridor.endRoomId, (corridorDegree.get(corridor.endRoomId) ?? 0) + 1)
  }
  const quiet = true
  const stairPlans = planStairs(rooms, doorOpenings, {
    corridorSlabsByFloor: corridorSlabs,
    corridorCapsulesByFloor: corridorCapsules,
    boundary,
    corridorDegree,
    floorHeight,
    gateWidth: config.doorWidth,
    gateHeight: config.doorHeight,
    quiet,
  })
  const slabHoles = computeSlabHoles(rooms, stairPlans)

  // Attempt score: layout-dependent hard errors — realized graph
  // traversal (§10, §62), omitted stair shafts (§49, bridge omissions
  // only: redundant ones must not reshuffle winning layouts), sealed
  // gates (§61), stair headroom (§45) and stair clipping (§40/49),
  // corridor lawfulness (§30-32/35-36), and physical grid navigation
  // (§59-60). Size/topology-bound checks (aspects, capacity, slabs) run
  // once at the end.
  const attemptIssues: GenerationIssue[] = [
    ...validateRealizedConnectivity(rooms, corridors, stairPlans, config.floorCount),
    ...omittedStairIssues(rooms, corridors, stairPlans.map(p => p.link), false),
    ...validatePortalSampling(rooms, doorOpenings, corridors, stairPlans),
    ...validatePortalSeals(rooms, doorOpenings, corridors, stairPlans),
    ...validateStairHeadroom(rooms, stairPlans, corridors),
    ...validateStairClipping(rooms, stairPlans),
    ...validateStairArrivalWalls(rooms, stairPlans),
    ...validateCorridors(corridors, corridorHeightFor(config)),
    ...validateCorridorIntrusions(rooms, corridors),
    ...validateNavigationGrid(rooms, doorOpenings, corridors, stairPlans, floorHeight),
    ...validateRoomPlacement(rooms, boundary),
    ...validateDoors(rooms, doorOpenings, config),
    ...validateStairs(stairPlans),
    ...validateLinkLengths(rooms),
  ]
  return { roomsBase, rooms, corridors, doorOpenings, stairPlans, slabHoles, tiers: tiersOf(attemptIssues), issues: attemptIssues, towerReservations }
}

// Junction repair wrapper (lawbook §34-35, §70): after the normal tail,
// convert blind corridor pass-throughs into explicit junction plazas and
// keep the strictly better variant. Layouts without proper X-crossings
// return byte-identical results (repair never triggers), so passing seeds
// cannot change output — only failing ones can improve.
function finishLayout(
  roomsBase: Room[],
  corridors: Corridor[],
  boundary: Boundary,
  config: LevelConfig,
  floorHeight: number,
  towerReservations: TowerReservation[] = [],
): LayoutResult {
  const base = finishTailLayout(roomsBase, corridors, boundary, config, floorHeight, towerReservations)
  const repaired = planJunctions(base.rooms, base.corridors, config, boundary, floorHeight, towerReservations)
  if (!repaired) return base
  // The repaired tail runs on the augmented pool (junctions + rewired
  // intent), so doors, stairs, geometry, and any later variant rebuild
  // all see the plazas. Best-of-two: adopt only strictly-better tiers.
  const fixed = finishTailLayout(repaired.rooms, repaired.corridors, boundary, config, floorHeight, towerReservations)
  return compareTiers(fixed.tiers, base.tiers) < 0 ? fixed : base
}

// Distance from point P to segment AB (2D). Local helper so the prune
// stays dependency-free (corridors module owns the canonical one).
function pointSegDist2D(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const lenSq = dx * dx + dz * dz
  if (lenSq < 1e-12) return Math.sqrt((px - ax) ** 2 + (pz - az) ** 2)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq))
  return Math.sqrt((px - (ax + t * dx)) ** 2 + (pz - (az + t * dz)) ** 2)
}

// Stage 5c repair (lawbook §12, §70): drop redundant same-floor intent
// edges that placement stretched past MONSTER_LINK_OVER with no midpoint
// room to hop through. Removal is explicit (both connection lists) and
// guarded by same-floor reachability: an edge goes only when its floor's
// corridor network stays connected without it. Cross-floor detours do NOT
// count (a stair detour may never materialize — omitted shafts — which
// islanded rooms behind phantom stairs in an earlier full-graph version).
// Backbone bridges always survive. Deterministic: longest first, ids
// break ties. Pure for the attempt (rooms already attempt-local copies).
function pruneMonsterLinks(rooms: Room[]): void {
  const byId = new Map(rooms.map(r => [r.id, r]))
  const dist = (a: Room, b: Room): number =>
    Math.sqrt((a.position.x - b.position.x) ** 2 + (a.position.z - b.position.z) ** 2)
  const hasMidpoint = (a: Room, b: Room): boolean => {
    for (const r of rooms) {
      if (r.id === a.id || r.id === b.id) continue
      if (r.floorIndex !== a.floorIndex) continue
      if (pointSegDist2D(r.position.x, r.position.z, a.position.x, a.position.z, b.position.x, b.position.z) <= MONSTER_MID_RADIUS) {
        return true
      }
    }
    return false
  }
  const connectedWithout = (skipA: string, skipB: string, floor: number): boolean => {
    // Same-floor reachability only: a dropped edge may count on a detour
    // through vertical links, but vertical links often fail to realize
    // (omitted shafts) while same-floor corridors realize reliably.
    // Counting a stair detour as redundancy islands rooms behind stairs
    // that never get built (measured: GRAPH_DISCONNECTED after pruning).
    const start = rooms.find(r => r.floorIndex === floor)!.id
    const seen = new Set<string>([start])
    const queue = [start]
    while (queue.length > 0) {
      const cur = queue.pop()!
      const node = byId.get(cur)
      if (!node) continue
      for (const nb of node.connections) {
        if ((cur === skipA && nb === skipB) || (cur === skipB && nb === skipA)) continue
        const other = byId.get(nb)
        if (!other || other.floorIndex !== floor || seen.has(nb)) continue
        seen.add(nb)
        queue.push(nb)
      }
    }
    return rooms.filter(r => r.floorIndex === floor).every(r => seen.has(r.id))
  }
  const candidates: { a: Room; b: Room; d: number }[] = []
  const seenPair = new Set<string>()
  for (const room of rooms) {
    for (const connId of room.connections) {
      const key = [room.id, connId].sort().join('|')
      if (seenPair.has(key)) continue
      seenPair.add(key)
      const other = byId.get(connId)
      if (!other || other.floorIndex !== room.floorIndex) continue
      const d = dist(room, other)
      if (d > MONSTER_LINK_OVER) candidates.push({ a: room, b: other, d })
    }
  }
  candidates.sort((p, q) =>
    q.d !== p.d ? q.d - p.d : (p.a.id + '|' + p.b.id < q.a.id + '|' + q.b.id ? -1 : 1),
  )
  for (const { a, b } of candidates) {
    if (!a.connections.includes(b.id)) continue // dropped as a side effect already
    if (hasMidpoint(a, b)) continue // subdivision realizes it as hops
    if (!connectedWithout(a.id, b.id, a.floorIndex)) continue // backbone bridge stays
    a.connections = a.connections.filter(c => c !== b.id)
    b.connections = b.connections.filter(c => c !== a.id)
  }
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
  issues.push(...omittedStairIssues(rooms, corridors, stairPlans.map(p => p.link), true))
  issues.push(...validateRoomPlacement(rooms, boundary))
  issues.push(...validateRoomAspects(rooms))
  issues.push(...validateDoors(rooms, doorOpenings, config))
  issues.push(...validatePortalCapacity(rooms, doorOpenings, config.doorWidth))
  issues.push(...validatePortalSampling(rooms, doorOpenings, corridors, stairPlans))
  issues.push(...validatePortalSeals(rooms, doorOpenings, corridors, stairPlans))
  issues.push(...validateCorridors(corridors, corridorHeight))
  issues.push(...validateCorridorIntrusions(rooms, corridors))
  issues.push(...validateStairs(stairPlans))
  issues.push(...validateStairHeadroom(rooms, stairPlans, corridors))
  issues.push(...validateStairClipping(rooms, stairPlans))
  issues.push(...validateStairArrivalWalls(rooms, stairPlans))
  issues.push(...validateLinkLengths(rooms))
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
    generatorVersion: GENERATOR_VERSION,
    validation,
    ok: validation.errors.length === 0,
  }
}

// Lawbook §40: probe tower-shaft sites BEFORE corridors are routed, so
// open-space shafts are reserved instead of being blocked by ribbons that
// ship first. Towers-only (in-room flights live inside rooms, which the
// router already avoids); doors/slabs/capsules do not exist yet, so the
// probe over-approximates — the final pass re-plans every link with real
// constraints and may still omit. Deterministic probe, discarded output.
function planTowerReservations(
  roomsBase: Room[],
  boundary: Boundary,
  config: LevelConfig,
  floorHeight: number,
): TowerReservation[] {
  const probes = planStairs(roomsBase, new Map(), {
    boundary,
    corridorSlabsByFloor: new Map(),
    corridorDegree: new Map(),
    floorHeight,
    gateWidth: config.doorWidth,
    gateHeight: config.doorHeight,
    quiet: true,
    towersOnly: true,
  })
  const floorOf = new Map(roomsBase.map(r => [r.id, r.floorIndex]))
  const out: TowerReservation[] = []
  for (const p of probes) {
    if (!p.towerRect) continue
    out.push({
      key: `${p.link.lowerRoomId}|${p.link.upperRoomId}`,
      rect: p.towerRect,
      upperFloor: floorOf.get(p.link.upperRoomId) ?? 0,
    })
  }
  return out
}

// Lawbook §49/§87: every cross-floor intent edge needs a spatial
// realization (built stair) or an explicit finding. Omitted links used to
// surface only as generic GRAPH_DISCONNECTED — which says where the map
// broke, not which shaft failed. Bridge omissions (no alternate realized
// path between the rooms) are tier-1 errors; redundant omissions (a path
// exists via other corridors/stairs) are warnings, reported only on the
// final candidate so they never steer attempt selection.
export function omittedStairIssues(
  rooms: Room[],
  corridors: Corridor[],
  builtLinks: { lowerRoomId: string; upperRoomId: string }[],
  reportRedundant: boolean,
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const byId = new Map(rooms.map(r => [r.id, r]))
  const adj = new Map<string, Set<string>>()
  for (const r of rooms) adj.set(r.id, new Set())
  const linkAdj = (a: string, b: string): void => {
    adj.get(a)?.add(b)
    adj.get(b)?.add(a)
  }
  for (const c of corridors) linkAdj(c.startRoomId, c.endRoomId)
  for (const p of builtLinks) linkAdj(p.lowerRoomId, p.upperRoomId)
  const reachable = (from: string, to: string): boolean => {
    if (from === to) return true
    const seen = new Set<string>([from])
    const queue = [from]
    while (queue.length > 0) {
      const cur = queue.pop()!
      for (const nb of adj.get(cur) ?? []) {
        if (nb === to) return true
        if (!seen.has(nb)) {
          seen.add(nb)
          queue.push(nb)
        }
      }
    }
    return false
  }
  const built = new Set(builtLinks.map(p => [p.lowerRoomId, p.upperRoomId].sort().join('|')))
  const seenLink = new Set<string>()
  const redundant: string[] = []
  for (const r of rooms) {
    for (const c of r.connections) {
      const o = byId.get(c)
      if (!o || Math.abs(o.floorIndex - r.floorIndex) !== 1) continue
      const lower = r.floorIndex < o.floorIndex ? r : o
      const upper = r.floorIndex < o.floorIndex ? o : r
      const key = `${lower.id}|${upper.id}`
      if (seenLink.has(key)) continue
      seenLink.add(key)
      if (built.has([lower.id, upper.id].sort().join('|'))) continue
      if (reachable(lower.id, upper.id)) {
        redundant.push(`${lower.id}->${upper.id}`)
      } else {
        issues.push({
          code: 'STAIR_NO_PLACEMENT',
          severity: 'error',
          stage: 'stairs',
          objectIds: [lower.id, upper.id],
          message:
            `Vertical link ${lower.id}->${upper.id} has no stair placement and no alternate realized path. ` +
            `Stack the rooms with more overlap or reduce density so a shaft fits.`,
        })
      }
    }
  }
  if (reportRedundant && redundant.length > 0) {
    const ids = [...new Set(redundant.flatMap(s => s.split('->')))].sort()
    issues.push({
      code: 'STAIR_NO_PLACEMENT',
      severity: 'warning',
      stage: 'stairs',
      objectIds: ids,
      message:
        `${redundant.length} redundant vertical link(s) omitted (an alternate realized path exists): ` +
        `${[...redundant].sort().join(', ')}.`,
    })
  }
  return issues
}

function rectsOverlapPad(a: Rect2D, b: Rect2D, pad: number): boolean {
  return a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad
}

function roomRectOf(r: Room): Rect2D {
  return {
    minX: r.position.x - r.width / 2,
    maxX: r.position.x + r.width / 2,
    minZ: r.position.z - r.depth / 2,
    maxZ: r.position.z + r.depth / 2,
  }
}

/**
 * Lawbook §34-35 junction repair: convert blind corridor pass-throughs
 * into explicit junction plazas (small connector rooms at the crossing,
 * all four ends rewired through them, corridors re-routed). Junction
 * stubs share the plaza as an endpoint, which IS the recorded-junction
 * representation the crossing validator honors — no validator change.
 * Bounded (max 3 pairs, one round, near-miss brushes skipped); returns
 * null when nothing placeable so clean layouts never change.
 */
export function planJunctions(
  rooms: Room[],
  corridors: Corridor[],
  config: LevelConfig,
  boundary: Boundary,
  floorHeight: number,
  towerReservations: TowerReservation[],
): { rooms: Room[]; corridors: Corridor[] } | null {
  const MAX_JUNCTIONS = 3
  const crossings = findCorridorCrossings(corridors).filter(c => c.point).slice(0, MAX_JUNCTIONS)
  if (crossings.length === 0) return null
  // One gate per wall plus corner margins and slack: four stubs usually
  // land on four different walls.
  const side = Math.max(3, config.doorWidth + 2 * SPATIAL_DEFAULTS.doorCornerMargin + 0.5)
  const pool = rooms.map(r => ({ ...r, connections: [...r.connections] }))
  const byId = new Map(pool.map(r => [r.id, r]))
  const placed: Rect2D[] = []
  const consumed = new Set<string>()
  const unlink = (a: string, b: string): void => {
    const ra = byId.get(a)
    const rb = byId.get(b)
    if (ra) ra.connections = ra.connections.filter(c => c !== b)
    if (rb) rb.connections = rb.connections.filter(c => c !== a)
  }
  let made = 0
  const forbidden = new Set<string>()
  const pairKeyOf = (a: string, b: string): string => [a, b].sort().join('-')
  for (const { a, b, point } of crossings) {
    if (!point) continue
    if (consumed.has(a.id) || consumed.has(b.id)) continue
    if (made >= MAX_JUNCTIONS) break
    const floor = a.floorIndex
    // Spiral placement (§34-35): the exact crossing point is often
    // unplaceable (ring courtyard hole, room overlap), but a spot a few
    // meters away in the walkable band still joins all four ends. Try the
    // center first, then deterministic compass rings at 1-6 m; the first
    // placeable spot wins, so clean exact-center plazas never move.
    // Best-of-two adoption below rejects the repair if the moved plaza's
    // stubs foul, so a bad nudge can never hurt the attempt.
    const offsets: { x: number; z: number }[] = [{ x: 0, z: 0 }]
    for (let r = 1; r <= 6; r++) {
      offsets.push(
        { x: r, z: 0 }, { x: -r, z: 0 }, { x: 0, z: r }, { x: 0, z: -r },
        { x: r, z: r }, { x: r, z: -r }, { x: -r, z: r }, { x: -r, z: -r },
      )
    }
    let px = point.x
    let pz = point.z
    let usedSide = side
    let rect: Rect2D | null = null
    // Compact fallback (lawbook §34, §100 wall capacity): a 3 m plaza
    // needs 4 m of clear band; dense bands often have only ~3 m. A
    // 2.4 m plaza still clears the room minimum (2.4 m) and hosts one
    // 1.8 m gate per wall (needs 2.3 m), so try it wherever full size
    // is blocked. Full size at every offset goes first, so existing
    // plazas never shrink and clean layouts never change; best-of-two
    // adoption below still rejects compact plazas whose stubs foul.
    const sides = side > 2.4 ? [side, 2.4] : [side]
    for (const o of offsets) {
      const cx = point.x + o.x
      const cz = point.z + o.z
      for (const s of sides) {
        const cand: Rect2D = {
          minX: cx - s / 2, maxX: cx + s / 2,
          minZ: cz - s / 2, maxZ: cz + s / 2,
        }
        if (!roomFootprintInBoundary({ x: cx, z: cz }, s, s, boundary, 0.5)) continue
        // Plazas avoid rooms, tower shafts, and each other (cheap rect
        // checks). Kept corridor ribbons are NOT pre-checked: a ribbon
        // through the spot reads as an intrusion downstream, and best-of-two
        // adoption rejects the repair — while near-misses stay repairable.
        let blocked = false
        for (const r of pool) {
          if (rectsOverlapPad(cand, roomRectOf(r), 0.5)) {
            blocked = true
            break
          }
        }
        if (!blocked) {
          for (const t of towerReservations) {
            if (rectsOverlapPad(cand, t.rect, 0.5)) {
              blocked = true
              break
            }
          }
        }
        if (!blocked) {
          for (const p of placed) {
            if (rectsOverlapPad(cand, p, s)) {
              blocked = true
              break
            }
          }
        }
        if (blocked) continue
        px = cx
        pz = cz
        usedSide = s
        rect = cand
        break
      }
      if (rect) break
    }
    if (!rect) continue
    // Rewire: drop the blind pass-throughs, join all four ends at J.
    const id = `junction_${made}`
    const ends = [a.startRoomId, a.endRoomId, b.startRoomId, b.endRoomId]
    if (ends.some(e => !byId.has(e))) continue
    // Forbid the removed pairs everywhere, including as subdivision hops:
    // their connectivity now runs A-J-B through the plaza stubs.
    forbidden.add(pairKeyOf(a.startRoomId, a.endRoomId))
    forbidden.add(pairKeyOf(b.startRoomId, b.endRoomId))
    unlink(a.startRoomId, a.endRoomId)
    unlink(b.startRoomId, b.endRoomId)
    const junction: Room = {
      id,
      type: 'connector',
      position: { x: px, y: floor * floorHeight, z: pz },
      width: usedSide,
      depth: usedSide,
      height: config.wallHeight,
      floorIndex: floor,
      materialTheme: config.theme,
      connections: [...ends],
      junction: true,
    }
    for (const e of ends) byId.get(e)!.connections.push(id)
    pool.push(junction)
    byId.set(id, junction)
    placed.push(rect)
    consumed.add(a.id)
    consumed.add(b.id)
    made++
  }
  if (made === 0) return null
  // Surgical re-route: shipped corridors that were not repaired stay
  // byte-identical (paths, mouths, doors); only the plaza stubs route
  // fresh, steered around everything kept. The wrapper keeps this only
  // when strictly better, so a bad rebuild can never hurt the attempt.
  const kept = corridors.filter(c => !consumed.has(c.id))
  const stubs = generateCorridors(pool, config, false, towerReservations, forbidden, kept)
  return { rooms: pool, corridors: stubs }
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

// Corridor wall capsules per floor for stair planning (lawbook §56):
// the exact centerline capsules the router reserves (ribbon + walls +
// door approach volumes), so tower shafts keep body clearance from
// corridor walls AND gate threads — rect slabs alone miss both (walls
// stick out 0.3, threads stick out 0.8+). Same math as walk-mode
// colliders and the seal validator: a site clear here is clear there.
function collectCorridorCapsules(
  corridors: Corridor[],
  rooms: Room[],
  doorOpenings: Map<string, DoorOpening[]>,
): Map<number, { ax: number; az: number; bx: number; bz: number; halfWidth: number }[]> {
  const WALL_NORMALS = [
    { x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 },
  ]
  const out = new Map<number, { ax: number; az: number; bx: number; bz: number; halfWidth: number }[]>()
  const atFloor = (floor: number) => {
    let list = out.get(floor)
    if (!list) {
      list = []
      out.set(floor, list)
    }
    return list
  }
  const wallT = SPATIAL_DEFAULTS.wallThickness
  const corridorWidthOf = new Map<string, number>()
  for (const c of corridors) {
    corridorWidthOf.set([c.startRoomId, c.endRoomId].sort().join('|'), c.width)
  }
  for (const c of corridors) {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    const list = atFloor(c.floorIndex)
    const halfWidth = c.width / 2 + 0.8
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x
      const dz = pts[i + 1].z - pts[i].z
      if (dx * dx + dz * dz < 1e-8) continue
      list.push({ ax: pts[i].x, az: pts[i].z, bx: pts[i + 1].x, bz: pts[i + 1].z, halfWidth })
    }
    // Side-wall capsules (exact ribbon walls): shaft sites must clear
    // the walls themselves, not just the generous centerline margin.
    const center = c.width / 2 + wallT / 2
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x
      const dz = pts[i + 1].z - pts[i].z
      const len = Math.sqrt(dx * dx + dz * dz)
      if (len < 1e-6) continue
      const ux = dx / len
      const uz = dz / len
      for (const side of [1, -1]) {
        const nx = -uz * side
        const nz = ux * side
        list.push({
          ax: pts[i].x + nx * center, az: pts[i].z + nz * center,
          bx: pts[i + 1].x + nx * center, bz: pts[i + 1].z + nz * center,
          halfWidth: wallT / 2,
        })
      }
    }
  }
  // Door approach volumes (gate thread ±0.8 m + ribbon + seal margin):
  // shafts park in the apron outside gates, across threads the slab
  // rects never cover. Width follows the corridor that owns the gate
  // (pinned mouth record), falling back to the gate width.
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  for (const [roomId, doors] of doorOpenings) {
    const room = roomMap.get(roomId)
    if (!room) continue
    const list = atFloor(room.floorIndex)
    for (const d of doors) {
      const n = WALL_NORMALS[d.wallIndex] ?? WALL_NORMALS[0]
      const cw = corridorWidthOf.get([roomId, d.targetRoomId].sort().join('|')) ?? d.width
      const halfWidth = cw / 2 + wallT + 0.55
      list.push({
        ax: d.position.x - n.x * 0.8, az: d.position.z - n.z * 0.8,
        bx: d.position.x + n.x * 0.8, bz: d.position.z + n.z * 0.8,
        halfWidth,
      })
    }
  }
  return out
}

// Browser-safe env check: `process` does not exist in Vite browser builds,
// so a bare `process.env.X` throws `ReferenceError: process is not defined`
// and breaks level generation. Read through globalThis instead (no @types/node needed).
function isHoleDebug(): boolean {
  return (
    (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.LW_HOLE_DEBUG === '1'
  )
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

  const put = (roomId: string, patch: { floor?: Rect2D; ceiling?: Rect2D }) => {
    let entry = holes.get(roomId)
    if (!entry) {
      entry = { floor: [], ceiling: [] }
      holes.set(roomId, entry)
    }
    // APPEND, never overwrite: one hub routinely hosts several stairs and
    // every flight needs its own opening (overwrite dropped all but the
    // last, leaving flights to pierce intact slabs).
    if (patch.floor) entry.floor.push(patch.floor)
    if (patch.ceiling) entry.ceiling.push(patch.ceiling)
  }

  for (const plan of stairPlans) {
    const lower = roomMap.get(plan.link.lowerRoomId)!
    const upper = roomMap.get(plan.link.upperRoomId)!
    if (!lower || !upper) continue
    if (isHoleDebug()) {
      console.log(`[hole] plan ${plan.link.lowerRoomId}->${plan.link.upperRoomId} kind=${plan.kind} x=${plan.x.toFixed(2)} z=${plan.z.toFixed(2)} w=${plan.width} d=${plan.depth} axis=${plan.axis}`)
      console.log(`[hole]   lower @(${lower.position.x.toFixed(2)},${lower.position.z.toFixed(2)}) upper @(${upper.position.x.toFixed(2)},${upper.position.z.toFixed(2)}) ${upper.width.toFixed(1)}x${upper.depth.toFixed(1)}`)
    }

    const halfW = (plan.axis === 'z' ? plan.width : plan.depth) / 2
    const halfD = (plan.axis === 'z' ? plan.depth : plan.width) / 2
    // Stairwell opening (bot-proven): the hole is the footprint grown by
    // body clearance (0.35 m) on every side, NOT the bare footprint. A
    // body standing on an edge tread (center 0.16+ inside the edge)
    // reaches 0.4 past it; with a footprint-exact hole the slab edge
    // grazes the column while the head is above the slab bottom —
    // residual ~1.2 m of solid slab no step-up clears. The growth stays
    // under every slab-avoidance pad (0.4+), so holes never eat corridor
    // slabs the planner routed around.
    const HOLE_CLEAR = 0.35
    const world = {
      minX: plan.x - halfW - HOLE_CLEAR,
      maxX: plan.x + halfW + HOLE_CLEAR,
      minZ: plan.z - halfD - HOLE_CLEAR,
      maxZ: plan.z + halfD + HOLE_CLEAR,
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
      if (isHoleDebug()) console.log(`[hole]   floor hole cut in ${upper.id}`)
    } else if (isHoleDebug()) {
      console.log(`[hole]   NO overlap: world [${world.minX.toFixed(1)},${world.maxX.toFixed(1)}]x[${world.minZ.toFixed(1)},${world.maxZ.toFixed(1)}] vs upper [${roomRect(upper).minX.toFixed(1)},${roomRect(upper).maxX.toFixed(1)}]x[${roomRect(upper).minZ.toFixed(1)},${roomRect(upper).maxZ.toFixed(1)}]`)
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

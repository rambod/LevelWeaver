import type { Room, MeshData, StairsGeometry, VerticalLink, DoorOpening, Rect2D, Boundary } from '@/core/types'
import { FLOOR_HEIGHT } from '@/core/types'
import { SPATIAL_DEFAULTS, stairMathFor } from '@/core/rules'
import { createBoxMesh, createOrientedBox } from '@/core/meshdata'
import { isPointInBoundary } from '@/generator/boundary'

// Vertical circulation (pipeline stage: "Add stairs or vertical connectors").
//
// Stairs always live INSIDE the lower linked room (never floating at
// midpoints): StairPlan fixes a rule-checked footprint (clear of doors,
// other stairs, shafts, and upper corridors), planStairs() also reserves
// matching floor/ceiling holes, and the builders emit LOCAL geometry
// (base at y=0); the renderer/exporter offsets each group by floor level.

// Walkable stair code (meters) from the centralized lawbook rules.
// Lawbook §41-44: riser/tread pairs must satisfy the IBC-derived range
// (riser <= 0.178 m, tread >= 0.28 m); the exact step count comes from
// stairMathFor(rise) = ceil(rise / maxRiser), never from room size.
// A short run never justifies ladder steps — oversized stairs simply
// don't fit and the link is reported instead of built broken.
const STAIR_TREAD = SPATIAL_DEFAULTS.stair.minTread // 0.28 m: most compact legal tread
/** Single straight flight width: lawbook default 1.20 m + comfort margin. */
const STAIR_WIDTH_STRAIGHT = 1.4
/** Folded switchback total width (two ~1.1 m flights side by side). */
const STAIR_WIDTH_SWITCHBACK = 2.2
const LANDING_DEPTH = SPATIAL_DEFAULTS.stair.landingDepth // 1.2 m
const FLOOR_THICKNESS = 0.2

// Habitability clearances (meters). The shaft gap keeps two stairwells
// from nesting into each other; 0.8 m still exceeds the agent diameter.
const STAIR_STAIR_GAP = 0.8
const STAIR_WALL_INSET = SPATIAL_DEFAULTS.doorCornerMargin // 0.25 m, lawbook §26

// Attached stair tower (outdoor shaft) dimensions.
const TOWER_WIDTH = 3.0
const TOWER_PARAPET = 1.1

// Max stair shafts per room: more is over-linking no room can host cleanly.
const MAX_VERTICAL_PER_ROOM = 3

export interface StairPlan {
  link: VerticalLink
  /** Room containing the stairs (always the lower room). */
  hostRoomId: string
  /** True when the host is the lower room (stairs ascend from it). */
  ascending: boolean
  /** Run axis in room space. */
  axis: 'x' | 'z'
  /** Ascent direction along axis (+1 toward +axis, -1 toward -axis). */
  dir: 1 | -1
  /** World-space footprint center. */
  x: number
  z: number
  width: number
  depth: number
  /** True for folded switchback flights (compact footprint, same slope). */
  switchback: boolean
  /** 'tower' = attached outdoor shaft; 'inroom' = flight inside host. */
  kind: 'tower' | 'inroom'
  stepCount: number
  stepHeight: number
  stepDepth: number
  /** Tower outer footprint + host-wall door (tower plans only). */
  towerRect: Rect2D | null
  towerDoor: { wallIndex: number; x: number; z: number } | null
}

export interface StairPlanContext {
  /** Upper-floor corridor slab footprints the arrival hole must avoid. */
  corridorSlabsByFloor: Map<number, Rect2D[]>
  /** Map boundary for tower placement. */
  boundary: Boundary
  /** Corridor links per room (for critical-first ordering). */
  corridorDegree: Map<string, number>
  /** Floor spacing (from wall height). Defaults to FLOOR_HEIGHT. */
  floorHeight?: number
  /** Suppress per-link omission warnings (layout retry probes). */
  quiet?: boolean
}

function rectsOverlap(a: Rect2D, b: Rect2D, pad = 0): boolean {
  return a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad
}

function pointRectDist(px: number, pz: number, r: Rect2D): number {
  const dx = Math.max(r.minX - px, 0, px - r.maxX)
  const dz = Math.max(r.minZ - pz, 0, pz - r.maxZ)
  return Math.sqrt(dx * dx + dz * dz)
}

// Walk-through zone in front of a doorway (inside the room): the opening
// span plus swing space. Stairs may stand BESIDE a door, never in its zone.
export function doorWalkZone(door: DoorOpening): Rect2D {
  const inward = door.wallIndex === 0 ? { x: 0, z: 1 }
    : door.wallIndex === 1 ? { x: -1, z: 0 }
    : door.wallIndex === 2 ? { x: 0, z: -1 }
    : { x: 1, z: 0 }
  const lateral = door.wallIndex % 2 === 0 ? 'x' : 'z'
  const halfSpan = door.width / 2 + 0.3
  const front = 1.2
  if (lateral === 'x') {
    return {
      minX: door.position.x - halfSpan,
      maxX: door.position.x + halfSpan,
      minZ: Math.min(door.position.z, door.position.z + inward.z * front),
      maxZ: Math.max(door.position.z, door.position.z + inward.z * front),
    }
  }
  return {
    minX: Math.min(door.position.x, door.position.x + inward.x * front),
    maxX: Math.max(door.position.x, door.position.x + inward.x * front),
    minZ: door.position.z - halfSpan,
    maxZ: door.position.z + halfSpan,
  }
}

export function stairBlocksDoor(stair: Rect2D, door: DoorOpening): boolean {
  return rectsOverlap(stair, doorWalkZone(door), 0)
}

// Signed distance to rect (positive inside, negative outside).
export function signedRectDist(px: number, pz: number, r: Rect2D): number {
  const dx = Math.max(r.minX - px, 0, px - r.maxX)
  const dz = Math.max(r.minZ - pz, 0, pz - r.maxZ)
  const outside = Math.sqrt(dx * dx + dz * dz)
  if (outside > 0) return -outside
  return Math.min(px - r.minX, r.maxX - px, pz - r.minZ, r.maxZ - pz)
}

// Approach zone in front of a stair entry (one landing depth of
// maneuvering room beyond the low end).
export function entryZoneOf(
  rect: Rect2D, axis: 'x' | 'z', dir: 1 | -1, ext = 1.2
): Rect2D {
  if (axis === 'z') {
    return dir > 0
      ? { minX: rect.minX, maxX: rect.maxX, minZ: rect.minZ - ext, maxZ: rect.minZ }
      : { minX: rect.minX, maxX: rect.maxX, minZ: rect.maxZ, maxZ: rect.maxZ + ext }
  }
  return dir > 0
    ? { minX: rect.minX - ext, maxX: rect.minX, minZ: rect.minZ, maxZ: rect.maxZ }
    : { minX: rect.maxX, maxX: rect.maxX + ext, minZ: rect.minZ, maxZ: rect.maxZ }
}

// Maneuvering strip just past a top landing along the exit direction.
export function exitZoneOf(landing: Rect2D, axis: 'x' | 'z', exitSign: 1 | -1, ext = 1.2): Rect2D {
  if (axis === 'z') {
    return exitSign > 0
      ? { minX: landing.minX, maxX: landing.maxX, minZ: landing.maxZ, maxZ: landing.maxZ + ext }
      : { minX: landing.minX, maxX: landing.maxX, minZ: landing.minZ - ext, maxZ: landing.minZ }
  }
  return exitSign > 0
    ? { minX: landing.maxX, maxX: landing.maxX + ext, minZ: landing.minZ, maxZ: landing.maxZ }
    : { minX: landing.minX - ext, maxX: landing.minX, minZ: landing.minZ, maxZ: landing.maxZ }
}

// Minimum edge-to-edge gap (negative when overlapping).
function rectGap(a: Rect2D, b: Rect2D): number {
  const dx = Math.max(b.minX - a.maxX, a.minX - b.maxX)
  const dz = Math.max(b.minZ - a.maxZ, a.minZ - b.maxZ)
  if (dx <= 0 && dz <= 0) return -Math.min(-dx, -dz)
  return Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dz, 0) ** 2)
}

function rectIntersection(a: Rect2D, b: Rect2D): Rect2D | null {
  const minX = Math.max(a.minX, b.minX)
  const maxX = Math.min(a.maxX, b.maxX)
  const minZ = Math.max(a.minZ, b.minZ)
  const maxZ = Math.min(a.maxZ, b.maxZ)
  if (maxX <= minX || maxZ <= minZ) return null
  return { minX, maxX, minZ, maxZ }
}

function roomRect(r: Room): Rect2D {
  return {
    minX: r.position.x - r.width / 2,
    maxX: r.position.x + r.width / 2,
    minZ: r.position.z - r.depth / 2,
    maxZ: r.position.z + r.depth / 2,
  }
}

// Stair-host bonus by room type (shared by topology intent and
// post-placement rewriting): halls and big rooms host flights, closets
// don't.
function hostBonus(type: Room['type']): number {
  switch (type) {
    case 'hub':
    case 'arena': return 9
    case 'hall':
    case 'objective': return 4
    case 'verticalConnector': return 6
    case 'storage':
    case 'spawn':
    case 'exit': return 1
    default: return 0.5
  }
}

/**
 * Post-placement vertical link rewrite (pipeline stage between placement
 * and corridors).
 *
 * Topology intent pairs were chosen on PRE-placement positions; placement
 * moves rooms, so intent pairs often end up far apart with no shared XZ —
 * and a stair without XZ overlap is a stair to nowhere (lawbook §49).
 * This step re-selects cross-floor links by FINAL geometry: candidate
 * pairs are ranked by actual footprint overlap (plus host size/type), the
 * best K per adjacent floor pair replace the intent edges, and the room
 * graph is updated explicitly (lawbook §87 — never silent).
 *
 * Same-floor edges are untouched, so corridor intent is preserved.
 */
export function rewriteVerticalLinks(rooms: Room[], floorHeight: number): void {
  const byId = new Map(rooms.map(r => [r.id, r]))
  const floors = [...new Set(rooms.map(r => r.floorIndex))].sort((a, b) => a - b)
  if (floors.length < 2) return

  // Host-fit test against the real step math: a lower room that cannot
  // even hold a folded flight forces a tower (or an honest omission), so
  // pairs with fittable hosts rank first.
  const math = stairMathFor(floorHeight, STAIR_TREAD)
  const straightLen = math.run + LANDING_DEPTH
  const switchDims = switchbackDims(math.stepCount, math.stepDepth)
  const fitsIn = (w: number, d: number, fw: number, fd: number): boolean =>
    (fd + 0.7 <= w && fw + 0.7 <= d) || (fd + 0.7 <= d && fw + 0.7 <= w)
  const hostFitBonus = (lower: Room): number => {
    if (fitsIn(lower.width, lower.depth, STAIR_WIDTH_STRAIGHT, straightLen)) return 8
    if (fitsIn(lower.width, lower.depth, switchDims.width, switchDims.depth)) return 5
    return 0
  }

  const overlapAreaOf = (a: Room, b: Room): number => {
    const ra = roomRect(a)
    const rb = roomRect(b)
    return (
      Math.max(0, Math.min(ra.maxX, rb.maxX) - Math.max(ra.minX, rb.minX)) *
      Math.max(0, Math.min(ra.maxZ, rb.maxZ) - Math.max(ra.minZ, rb.minZ))
    )
  }

  for (let f = 0; f < floors.length - 1; f++) {
    const lowerRooms = rooms.filter(r => r.floorIndex === floors[f])
    const upperRooms = rooms.filter(r => r.floorIndex === floors[f + 1])
    if (lowerRooms.length === 0 || upperRooms.length === 0) continue

    // Intent link count for this floor pair (preserves verticality).
    let intentCount = 0
    for (const l of lowerRooms) {
      for (const c of l.connections) {
        const other = byId.get(c)
        if (other && other.floorIndex === floors[f + 1]) intentCount++
      }
    }

    // Rank ALL cross-floor pairs by real overlap. Minimum 1.5 m² holds a
    // legal landing; anything less cannot host a V0.1 stair.
    const ranked = []
    for (const lower of lowerRooms) {
      for (const upper of upperRooms) {
        const overlap = overlapAreaOf(lower, upper)
        if (overlap < 1.5) continue
        ranked.push({
          lower,
          upper,
          score:
            overlap * 2 +
            (lower.width * lower.depth) / 10 +
            hostBonus(lower.type) +
            hostBonus(upper.type) / 2 +
            hostFitBonus(lower),
        })
      }
    }
    if (ranked.length === 0) continue // no stackable pair: keep intent, fail honestly later
    ranked.sort((p, q) =>
      q.score !== p.score
        ? q.score - p.score
        : p.lower.id + '|' + p.upper.id < q.lower.id + '|' + q.upper.id
          ? -1
          : 1,
    )

    // Remove intent cross-floor edges for this pair of floors...
    for (const l of lowerRooms) {
      l.connections = l.connections.filter(c => {
        const other = byId.get(c)
        return !other || other.floorIndex !== floors[f + 1]
      })
    }
    for (const u of upperRooms) {
      u.connections = u.connections.filter(c => {
        const other = byId.get(c)
        return !other || other.floorIndex !== floors[f]
      })
    }
    // ...and link the best K overlapping pairs (at least the top pair:
    // every occupied floor pair joins the traversal graph, lawbook §39).
    const keep = Math.min(ranked.length, Math.max(1, intentCount))
    for (let i = 0; i < keep; i++) {
      const { lower, upper } = ranked[i]
      if (!lower.connections.includes(upper.id)) lower.connections.push(upper.id)
      if (!upper.connections.includes(lower.id)) upper.connections.push(lower.id)
    }
  }
}

export function planStairs(
  rooms: Room[],
  doorsByRoom: Map<string, DoorOpening[]>,
  context?: StairPlanContext
): StairPlan[] {
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const plans: StairPlan[] = []
  // Standing-floor stair footprints + open shaft holes (both forbid new
  // footprints: stairs must not nest into each other or float over shafts).
  const footprints = new Map<number, Rect2D[]>()
  const floorHoles = new Map<number, Rect2D[]>()
  const slabsByFloor = context?.corridorSlabsByFloor ?? new Map<number, Rect2D[]>()
  const quiet = context?.quiet ?? false

  const atFloor = (map: Map<number, Rect2D[]>, floor: number): Rect2D[] => {
    let list = map.get(floor)
    if (!list) {
      list = []
      map.set(floor, list)
    }
    return list
  }

  // Walkable step math from the actual floor height (lawbook §41-43:
  // N = ceil(H / rMax), riser = H / N, run = N * tread). Never from room
  // size: a short run never justifies ladder steps — oversized stairs
  // simply don't fit and the link is reported instead of built broken.
  // No upper clamp: tall walls need proportionally more risers.
  const rise = context?.floorHeight ?? FLOOR_HEIGHT
  const stairMath = stairMathFor(rise, STAIR_TREAD)
  const stepCount = stairMath.stepCount
  const stepHeight = stairMath.stepHeight
  const stepDepth = stairMath.stepDepth
  const run = stairMath.run
  const straightDims = { width: STAIR_WIDTH_STRAIGHT, depth: run + LANDING_DEPTH }
  const switchDims = switchbackDims(stepCount, stepDepth)

  const st: StairPlanner = {
    rooms,
    roomMap,
    doorsByRoom,
    slabsByFloor,
    boundary: context?.boundary,
    footprints,
    floorHoles,
    towers: [],
    stepCount,
    stepHeight,
    stepDepth,
    run,
    reasons: new Map<string, number>(),
    atFloor,
  }

  // Vertical-link cap per room: a room with four shafts is over-linked
  // (no room has four clean shaft sites). Trimming redundant links never
  // isolates (rooms keep their first links), but unbounded links exhaust
  // small rooms and strand their last shaft.
  const keptCount = new Map<string, number>()

  // Critical-first order: links whose endpoints have the fewest corridor
  // alternatives get first pick of shaft sites, so scarce space never
  // strands a room's only vertical connection.
  const corridorDegree = context?.corridorDegree ?? new Map<string, number>()
  const links = findVerticalLinks(rooms).sort((p, q) => {
    const pc = Math.min(corridorDegree.get(p.lowerRoomId) ?? 0, corridorDegree.get(p.upperRoomId) ?? 0)
    const qc = Math.min(corridorDegree.get(q.lowerRoomId) ?? 0, corridorDegree.get(q.upperRoomId) ?? 0)
    if (pc !== qc) return pc - qc
    const pk = p.lowerRoomId < p.upperRoomId ? p.lowerRoomId + '|' + p.upperRoomId : p.upperRoomId + '|' + p.lowerRoomId
    const qk = q.lowerRoomId < q.upperRoomId ? q.lowerRoomId + '|' + q.upperRoomId : q.upperRoomId + '|' + q.lowerRoomId
    return pk < qk ? -1 : pk > qk ? 1 : 0
  })

  for (const link of links) {
    const lower = roomMap.get(link.lowerRoomId)!
    const upper = roomMap.get(link.upperRoomId)!
    if (!lower || !upper) continue

    // A link is critical while an endpoint has no other connection yet
    // (no corridors and no kept stairs): capping it could isolate a room,
    // so critical links bypass the cap.
    const lowerCritical = (corridorDegree.get(lower.id) ?? 0) === 0 && (keptCount.get(lower.id) ?? 0) === 0
    const upperCritical = (corridorDegree.get(upper.id) ?? 0) === 0 && (keptCount.get(upper.id) ?? 0) === 0
    if (!lowerCritical && !upperCritical &&
        ((keptCount.get(lower.id) ?? 0) >= MAX_VERTICAL_PER_ROOM ||
         (keptCount.get(upper.id) ?? 0) >= MAX_VERTICAL_PER_ROOM)) {
      if (!quiet) {
        console.warn(
          `[LevelWeaver] stair ${link.lowerRoomId}->${link.upperRoomId} omitted: ` +
          `room vertical-link cap (${MAX_VERTICAL_PER_ROOM}) reached.`
        )
      }
      continue
    }

    // Tower shaft first (compact folded flight: uniform look, walkable
    // slope, small shaft), then in-room straight flight (big rooms, narrow
    // width fits long halls), then in-room switchback (short but wide
    // rooms). In very small/narrow rooms none fits: the link is reported
    // explicitly (no stairs) instead of built broken.
    const before = new Map(st.reasons)
    const plan =
      tryTowerPlan(link, st, switchDims) ??
      tryInRoomPlan(link, st, straightDims, false) ??
      tryInRoomPlan(link, st, switchDims, true)
    if (!plan) {
      const lDims = lower ? `${lower.width.toFixed(1)}x${lower.depth.toFixed(1)}m` : '?'
      if (!quiet) {
        console.warn(
          `[LevelWeaver] stair ${link.lowerRoomId}->${link.upperRoomId} omitted: no rule-clean placement ` +
          `(host ${lDims}; straight needs ${straightDims.width.toFixed(1)}x${straightDims.depth.toFixed(1)}m, ` +
          `switchback ${switchDims.width.toFixed(1)}x${switchDims.depth.toFixed(1)}m; rejected: ${topReasons(st, before)}). ` +
          `No stairs built for this link.`
        )
      }
      continue
    }

    // Reserve footprint + arrival shaft so later stairs avoid them.
    recordPlan(st, plan)
    keptCount.set(lower.id, (keptCount.get(lower.id) ?? 0) + 1)
    keptCount.set(upper.id, (keptCount.get(upper.id) ?? 0) + 1)
    plans.push(plan)
  }

  return plans
}

interface StairPlanner {
  rooms: Room[]
  roomMap: Map<string, Room>
  doorsByRoom: Map<string, DoorOpening[]>
  slabsByFloor: Map<number, Rect2D[]>
  boundary: Boundary | undefined
  footprints: Map<number, Rect2D[]>
  floorHoles: Map<number, Rect2D[]>
  /** All tower outer rects (full-height shafts: any floor conflicts). */
  towers: Rect2D[]
  stepCount: number
  stepHeight: number
  stepDepth: number
  run: number
  /** Rejection census: why candidates fail (debuggability, lawbook §85). */
  reasons: Map<string, number>
  atFloor: (map: Map<number, Rect2D[]>, floor: number) => Rect2D[]
}

function noteRejection(st: StairPlanner, code: string): void {
  st.reasons.set(code, (st.reasons.get(code) ?? 0) + 1)
}

function topReasons(st: StairPlanner, before: Map<string, number>): string {
  const delta: [string, number][] = []
  for (const [code, count] of st.reasons) {
    const d = count - (before.get(code) ?? 0)
    if (d > 0) delta.push([code, d])
  }
  delta.sort((a, b) => b[1] - a[1])
  return delta.slice(0, 3).map(([c, n]) => `${c} x${n}`).join(', ') || 'no candidates'
}

/**
 * Folded switchback footprint: two half-runs side by side + turn landing.
 * Total width fits two legal flights; depth is roughly half a straight run.
 */
function switchbackDims(stepCount: number, stepDepth: number): { width: number; depth: number } {
  const nA = Math.ceil(stepCount / 2)
  return {
    width: STAIR_WIDTH_SWITCHBACK,
    depth: (nA - 1) * stepDepth + stepDepth * 1.15 / 2 + LANDING_DEPTH,
  }
}

export function flightRectOf(x: number, z: number, width: number, depth: number, axis: 'x' | 'z'): Rect2D {
  const halfAlong = depth / 2
  const halfAcross = width / 2
  return axis === 'z'
    ? { minX: x - halfAcross, maxX: x + halfAcross, minZ: z - halfAlong, maxZ: z + halfAlong }
    : { minX: x - halfAlong, maxX: x + halfAlong, minZ: z - halfAcross, maxZ: z + halfAcross }
}

// Top-landing rect (world) for arrival checks: straight flights land at
// the +dir end, switchbacks fold back and land near the -dir end on the
// return flight (computed from the step math, not guessed).
export function landingRectOf(plan: Pick<StairPlan, 'x' | 'z' | 'width' | 'depth' | 'axis' | 'dir' | 'switchback' | 'stepCount' | 'stepDepth'>): Rect2D {
  if (!plan.switchback) {
    const topSign = plan.dir > 0 ? 1 : -1
    const landLen = LANDING_DEPTH
    if (plan.axis === 'z') {
      const end = plan.z + topSign * (plan.depth / 2)
      const lo = Math.min(end, end - topSign * landLen)
      return { minX: plan.x - plan.width / 2, maxX: plan.x + plan.width / 2, minZ: lo, maxZ: lo + landLen }
    }
    const end = plan.x + topSign * (plan.depth / 2)
    const lo = Math.min(end, end - topSign * landLen)
    return { minX: lo, maxX: lo + landLen, minZ: plan.z - plan.width / 2, maxZ: plan.z + plan.width / 2 }
  }
  const nA = Math.ceil(plan.stepCount / 2)
  const nB = plan.stepCount - nA
  // Canonical top-tread center (matches createSwitchbackStairsMesh: A
  // treads, turn landing, then B treads back), mirrored by dir below.
  const topCanon = -plan.depth / 2 + (nA - 1) * plan.stepDepth + plan.stepDepth * 1.15 / 2 + LANDING_DEPTH - (nB - 1) * plan.stepDepth
  const half = LANDING_DEPTH / 2
  if (plan.axis === 'z') {
    const cz = plan.z + plan.dir * topCanon
    return { minX: plan.x - plan.width / 2, maxX: plan.x + plan.width / 2, minZ: cz - half, maxZ: cz + half }
  }
  const cx = plan.x + plan.dir * topCanon
  return { minX: cx - half, maxX: cx + half, minZ: plan.z - plan.width / 2, maxZ: plan.z + plan.width / 2 }
}

function recordPlan(st: StairPlanner, plan: StairPlan): void {
  const host = st.roomMap.get(plan.hostRoomId)!
  const upper = st.roomMap.get(plan.link.upperRoomId)!
  const placed = flightRectOf(plan.x, plan.z, plan.width, plan.depth, plan.axis)
  st.atFloor(st.footprints, host.floorIndex).push(placed)
  if (plan.towerRect) st.towers.push(plan.towerRect)
  if (upper) {
    const arrival = rectIntersection(placed, roomRect(upper))
    if (arrival) st.atFloor(st.floorHoles, upper.floorIndex).push(arrival)
  }
}

// In-room flight: straight (big rooms) or switchback (compact rooms).
// Same rule set as towers, applied inside the host room.
function tryInRoomPlan(
  link: VerticalLink,
  st: StairPlanner,
  dims: { width: number; depth: number },
  switchback: boolean
): StairPlan | null {
  const lower = st.roomMap.get(link.lowerRoomId)!
  const upper = st.roomMap.get(link.upperRoomId)!
  if (!lower || !upper) return null
  const host = lower
  const other = upper
  const hostRect = roomRect(host)
  const upperRect = roomRect(upper)
  const hostFloor = host.floorIndex
  const upperFloor = upper.floorIndex
  const { width, depth } = dims

  const dx = other.position.x - host.position.x
  const dz = other.position.z - host.position.z
  const facingAxis: 'x' | 'z' = Math.abs(dx) > Math.abs(dz) ? 'x' : 'z'
  const facingSign: 1 | -1 = (facingAxis === 'x' ? dx : dz) > 0 ? 1 : -1

  const orientations: { axis: 'x' | 'z'; dir: 1 | -1 }[] = [
    { axis: 'x', dir: 1 },
    { axis: 'x', dir: -1 },
    { axis: 'z', dir: 1 },
    { axis: 'z', dir: -1 },
  ]

  const doors = st.doorsByRoom.get(host.id) ?? []
  const upperSlabs = st.slabsByFloor.get(upperFloor) ?? []
  const sameFloorPrints = st.atFloor(st.footprints, hostFloor)
  const standingHoles = st.atFloor(st.floorHoles, hostFloor)

  let best: StairPlan | null = null
  let bestScore = -Infinity

  for (const { axis, dir } of orientations) {
    const alongRoom = axis === 'z' ? host.depth : host.width
    const acrossRoom = axis === 'z' ? host.width : host.depth
    if (depth + 0.7 > alongRoom || width + 0.7 > acrossRoom) {
      noteRejection(st, 'room-too-small')
      continue
    }
    const aRange = alongRoom / 2 - depth / 2 - STAIR_WALL_INSET
    const cRange = acrossRoom / 2 - width / 2 - STAIR_WALL_INSET

    for (let a = -aRange; a <= aRange + 1e-6; a += 0.5) {
      for (let c = -cRange; c <= cRange + 1e-6; c += 0.5) {
        const cx = axis === 'z' ? host.position.x + c : host.position.x + a
        const cz = axis === 'z' ? host.position.z + a : host.position.z + c
        const rect = flightRectOf(cx, cz, width, depth, axis)

        // 1. Footprint (+stringer margin) stays inside the host room.
        if (
          rect.minX - STAIR_WALL_INSET < hostRect.minX ||
          rect.maxX + STAIR_WALL_INSET > hostRect.maxX ||
          rect.minZ - STAIR_WALL_INSET < hostRect.minZ ||
          rect.maxZ + STAIR_WALL_INSET > hostRect.maxZ
        ) {
          noteRejection(st, 'footprint-outside-host')
          continue
        }

        // 2. Never block a doorway: stairs may stand beside a gate,
        // never in its walk-through zone (shared rule with towers).
        let doorClear = Infinity
        let doorBlocked = false
        for (const d of doors) {
          doorClear = Math.min(doorClear, pointRectDist(d.position.x, d.position.z, rect))
          if (stairBlocksDoor(rect, d)) doorBlocked = true
        }
        if (doorBlocked) {
          noteRejection(st, 'door-blocked')
          continue
        }

        // 3. Clear of other stairwells on this floor + open shafts below.
        let stairClear = Infinity
        let blocked = false
        for (const f of sameFloorPrints) {
          const gap = rectGap(rect, f)
          stairClear = Math.min(stairClear, gap)
          if (gap < STAIR_STAIR_GAP) {
            blocked = true
            break
          }
        }
        if (blocked) {
          noteRejection(st, 'stair-clash')
          continue
        }
        for (const h of standingHoles) {
          if (rectsOverlap(rect, h, 0.2)) {
            blocked = true
            break
          }
        }
        if (blocked) {
          noteRejection(st, 'shaft-clash')
          continue
        }

        // 4b. Never pierce a non-target upper room's floor.
        for (const r of st.rooms) {
          if (r.floorIndex !== upperFloor || r.id === upper.id) continue
          if (rectsOverlap(rect, roomRect(r), 0.2)) {
            blocked = true
            break
          }
        }
        if (blocked) {
          noteRejection(st, 'pierces-other-upper-room')
          continue
        }

        // 4c. The flight must not pass under an upper corridor slab:
        // headroom below a slab crossing overhead is un-walkable.
        for (const s of upperSlabs) {
          if (rectsOverlap(rect, s, 0.2)) {
            blocked = true
            break
          }
        }
        if (blocked) {
          noteRejection(st, 'slab-headroom')
          continue
        }

        // 5. Entry approach: maneuvering room in front of the bottom
        // step, inside the host room and clear of doors/stairs.
        // (Flights crammed nose-against a wall read as stuck.)
        {
          const entry = entryZoneOf(rect, axis, dir)
          const insideHost =
            entry.minX >= hostRect.minX - 0.1 && entry.maxX <= hostRect.maxX + 0.1 &&
            entry.minZ >= hostRect.minZ - 0.1 && entry.maxZ <= hostRect.maxZ + 0.1
          if (!insideHost) {
            noteRejection(st, 'entry-outside-host')
            continue
          }
          let entryBlocked = false
          for (const d of doors) {
            if (rectsOverlap(entry, doorWalkZone(d), 0)) {
              entryBlocked = true
              break
            }
          }
          if (!entryBlocked) {
            for (const f of sameFloorPrints) {
              if (rectsOverlap(entry, f, 0)) {
                entryBlocked = true
                break
              }
            }
          }
          if (entryBlocked) {
            noteRejection(st, 'entry-blocked')
            continue
          }
        }

        // 4. Upper arrival MUST pass through the link's upper room:
        // landing inside the overlap, shaft clear of slabs/stairs/holes.
        // No overlap = stair to nowhere (lawbook §49): reject.
        // Exit maneuvering room past the landing: the exit center must not
        // straddle the upper room's walls (stuck landing), nor sit under a
        // slab (checked above for the flight; rechecked for the exit here).
        {
          const landing = landingRectOf({ x: cx, z: cz, width, depth, axis, dir, switchback, stepCount: st.stepCount, stepDepth: st.stepDepth })
          if (!checkUpperArrival(rect, landing, upper, upperSlabs, st)) {
            noteRejection(st, 'no-arrival-overlap')
            continue
          }
          const exitSign = (dir > 0) !== switchback ? 1 : -1
          const exit = exitZoneOf(landing, axis, exitSign)
          const exitCx = (exit.minX + exit.maxX) / 2
          const exitCz = (exit.minZ + exit.maxZ) / 2
          if (Math.abs(signedRectDist(exitCx, exitCz, upperRect)) < 0.4) {
            noteRejection(st, 'exit-stuck-at-wall')
            continue
          }
          let exitBlocked = false
          for (const s of upperSlabs) {
            if (rectsOverlap(exit, s, 0.1)) {
              exitBlocked = true
              break
            }
          }
          if (exitBlocked) {
            noteRejection(st, 'exit-under-slab')
            continue
          }
        }

        const facing = axis === facingAxis && dir === facingSign ? 3 : 0
        const wallDist = Math.min(
          rect.minX - hostRect.minX, hostRect.maxX - rect.maxX,
          rect.minZ - hostRect.minZ, hostRect.maxZ - rect.maxZ
        )
        const score = facing + Math.min(doorClear, 3) + Math.min(stairClear, 4) + (wallDist < 1.0 ? 2 : 0)
        if (score > bestScore) {
          bestScore = score
          best = {
            link,
            hostRoomId: host.id,
            ascending: true,
            axis,
            dir,
            x: cx,
            z: cz,
            width,
            depth,
            stepCount: st.stepCount,
            stepHeight: st.stepHeight,
            stepDepth: st.stepDepth,
            kind: 'inroom',
            switchback,
            towerRect: null,
            towerDoor: null,
          }
        }
      }
    }
  }

  return best
}

// Attached outdoor stair tower: flush against one host wall, full-height
// shaft to the ground, open top with parapet. Fits regardless of room
// size, so walkable slope never depends on room dimensions.
function tryTowerPlan(
  link: VerticalLink,
  st: StairPlanner,
  dims: { width: number; depth: number }
): StairPlan | null {
  if (!st.boundary) return null
  const lower = st.roomMap.get(link.lowerRoomId)!
  const upper = st.roomMap.get(link.upperRoomId)!
  if (!lower || !upper) return null
  const host = lower
  const hostFloor = host.floorIndex
  const upperFloor = upper.floorIndex
  const { width, depth } = dims
  const towerLen = depth + 0.6
  const halfT = TOWER_WIDTH / 2

  const dx = upper.position.x - host.position.x
  const dz = upper.position.z - host.position.z
  const facingAxis: 'x' | 'z' = Math.abs(dx) > Math.abs(dz) ? 'x' : 'z'
  const facingSign: 1 | -1 = (facingAxis === 'x' ? dx : dz) > 0 ? 1 : -1
  const sides: { axis: 'x' | 'z'; sign: 1 | -1; wallIndex: number }[] = [
    { axis: 'x', sign: 1, wallIndex: 1 },
    { axis: 'x', sign: -1, wallIndex: 3 },
    { axis: 'z', sign: 1, wallIndex: 2 },
    { axis: 'z', sign: -1, wallIndex: 0 },
  ]
  // Facing wall first (deterministic): arrival lands toward the partner.
  sides.sort((p, q) => {
    const pf = p.axis === facingAxis && p.sign === facingSign ? 0 : 1
    const qf = q.axis === facingAxis && q.sign === facingSign ? 0 : 1
    return pf - qf
  })

  const doors = st.doorsByRoom.get(host.id) ?? []
  const hostSlabs = st.slabsByFloor.get(hostFloor) ?? []
  const upperSlabs = st.slabsByFloor.get(upperFloor) ?? []

  let best: StairPlan | null = null
  let bestScore = -Infinity

  for (const side of sides) {
    const alongWall = side.axis === 'x' ? host.depth : host.width
    const wallC = side.axis === 'x' ? host.position.z : host.position.x
    const wallPlane = side.axis === 'x'
      ? host.position.x + side.sign * (host.width / 2)
      : host.position.z + side.sign * (host.depth / 2)
    const maxLat = alongWall / 2 - halfT - 0.3
    if (maxLat < 0) continue

    for (let c = -maxLat; c <= maxLat + 1e-6; c += 0.5) {
      // Tower outer rect: near edge flush with the host wall plane.
      const near = wallPlane
      const far = wallPlane + side.sign * towerLen
      const t0 = wallC + c
      const rect: Rect2D = side.axis === 'x'
        ? { minX: Math.min(near, far), maxX: Math.max(near, far), minZ: t0 - halfT, maxZ: t0 + halfT }
        : { minX: t0 - halfT, maxX: t0 + halfT, minZ: Math.min(near, far), maxZ: Math.max(near, far) }

      // a. Inside the map: outer AABB plus ALL FOUR corners in the
      // shape (lawbook §64-65). Center-only tests let tower corners dangle
      // over the ring hole / off the cross arms on curved shapes.
      const cx = (rect.minX + rect.maxX) / 2
      const cz = (rect.minZ + rect.maxZ) / 2
      if (
        rect.minX < -st.boundary.width / 2 + 0.5 || rect.maxX > st.boundary.width / 2 - 0.5 ||
        rect.minZ < -st.boundary.depth / 2 + 0.5 || rect.maxZ > st.boundary.depth / 2 - 0.5 ||
        !isPointInBoundary({ x: cx, z: cz }, st.boundary, 1) ||
        !isPointInBoundary({ x: rect.minX + 0.3, z: rect.minZ + 0.3 }, st.boundary, 0) ||
        !isPointInBoundary({ x: rect.maxX - 0.3, z: rect.minZ + 0.3 }, st.boundary, 0) ||
        !isPointInBoundary({ x: rect.minX + 0.3, z: rect.maxZ - 0.3 }, st.boundary, 0) ||
        !isPointInBoundary({ x: rect.maxX - 0.3, z: rect.maxZ - 0.3 }, st.boundary, 0)
      ) {
        noteRejection(st, 'tower-outside-boundary')
        continue
      }

      // b. Clear of rooms on the host floor (except the host: abutting).
      let blocked = false
      for (const r of st.rooms) {
        if (r.floorIndex !== hostFloor || r.id === host.id) continue
        if (rectsOverlap(rect, roomRect(r), 1.0)) {
          blocked = true
          break
        }
      }
      if (blocked) {
        noteRejection(st, 'tower-hits-room')
        continue
      }

      // c. Clear of host-floor corridor slabs.
      for (const s of hostSlabs) {
        if (rectsOverlap(rect, s, 0.3)) {
          blocked = true
          break
        }
      }
      if (blocked) {
        noteRejection(st, 'tower-hits-corridor')
        continue
      }

      // d. Clear of other tower shafts (full height: any floor conflicts).
      for (const t of st.towers) {
        if (rectsOverlap(rect, t, 0.8)) {
          blocked = true
          break
        }
      }
      if (blocked) {
        noteRejection(st, 'tower-hits-tower')
        continue
      }

      // e. Ground column: clear of rooms on lower floors.
      for (const r of st.rooms) {
        if (r.floorIndex >= hostFloor) continue
        if (rectsOverlap(rect, roomRect(r), 0.5)) {
          blocked = true
          break
        }
      }
      if (blocked) {
        noteRejection(st, 'tower-column-blocked')
        continue
      }

      // f. Top: may overlap the arrival room (shaft curb), nothing else up there.
      for (const r of st.rooms) {
        if (r.floorIndex !== upperFloor || r.id === upper.id) continue
        if (rectsOverlap(rect, roomRect(r), 0.3)) {
          blocked = true
          break
        }
      }
      if (blocked) {
        noteRejection(st, 'tower-hits-upper-room')
        continue
      }
      for (const s of upperSlabs) {
        if (rectsOverlap(rect, s, 0.2)) {
          blocked = true
          break
        }
      }
      if (blocked) {
        noteRejection(st, 'tower-under-slab')
        continue
      }

      // g. No host doorway in the tower's way (shared walk-zone rule).
      for (const d of doors) {
        if (stairBlocksDoor(rect, d)) {
          blocked = true
          break
        }
      }
      if (blocked) {
        noteRejection(st, 'tower-blocks-door')
        continue
      }

      // h. Folded flight inside the tower + upper arrival rules.
      const flightX = side.axis === 'x' ? wallPlane + side.sign * (0.3 + depth / 2) : wallC + c
      const flightZ = side.axis === 'x' ? wallC + c : wallPlane + side.sign * (0.3 + depth / 2)
      const flight: Rect2D = flightRectOf(flightX, flightZ, width, depth, side.axis)
      if (!flightInsideTower(flight, rect)) {
        noteRejection(st, 'tower-flight-outside')
        continue
      }
      const landing = landingRectOf({ x: flightX, z: flightZ, width, depth, axis: side.axis, dir: side.sign, switchback: true, stepCount: st.stepCount, stepDepth: st.stepDepth })
      if (!checkUpperArrival(flight, landing, upper, upperSlabs, st)) {
        noteRejection(st, 'tower-no-arrival-overlap')
        continue
      }

      // Exit maneuvering room past the landing (arrival overlaps the
      // upper room — guaranteed by checkUpperArrival above).
      {
        const overlap = rectIntersection(flight, roomRect(upper))!
        const exitSign = side.sign > 0 ? -1 : 1 // switchbacks fold back
        const exit = exitZoneOf(landing, side.axis, exitSign)
        const exitCx = (exit.minX + exit.maxX) / 2
        const exitCz = (exit.minZ + exit.maxZ) / 2
        if (Math.abs(signedRectDist(exitCx, exitCz, roomRect(upper))) < 0.4) {
          noteRejection(st, 'tower-exit-stuck')
          continue
        }
        // Parapet ring vs upper doorways: an upper gate caught in the
        // shaft curb (hole excluded) can never open.
        const upperDoors = st.doorsByRoom.get(upper.id) ?? []
        let parapetBlocked = false
        for (const d of upperDoors) {
          const zw = doorWalkZone(d)
          if (rectsOverlap(zw, rect, 0) && !rectsOverlap(zw, overlap, 0)) {
            parapetBlocked = true
            break
          }
        }
        if (parapetBlocked) {
          noteRejection(st, 'tower-parapet-blocks-door')
          continue
        }
      }

      // Score: facing partner, clearance to towers/doors.
      let towerClear = Infinity
      for (const t of st.towers) towerClear = Math.min(towerClear, rectGap(rect, t))
      let hostDoorClear = Infinity
      for (const d of doors) {
        if (d.wallIndex !== side.wallIndex) continue
        const lat = side.axis === 'x' ? d.position.z : d.position.x
        hostDoorClear = Math.min(hostDoorClear, Math.abs(lat - (wallC + c)))
      }
      const facing = side.axis === facingAxis && side.sign === facingSign ? 3 : 0
      const score = facing + Math.min(towerClear, 4) + Math.min(hostDoorClear, 3)
      if (score > bestScore) {
        bestScore = score
        // Door center on the shared wall (mouth matches the shaft).
        const doorPos = side.axis === 'x'
          ? { x: wallPlane, z: wallC + c }
          : { x: wallC + c, z: wallPlane }
        best = {
          link,
          hostRoomId: host.id,
          ascending: true,
          axis: side.axis,
          dir: side.sign,
          x: flightX,
          z: flightZ,
          width,
          depth,
          stepCount: st.stepCount,
          stepHeight: st.stepHeight,
          stepDepth: st.stepDepth,
          kind: 'tower',
          switchback: true,
          towerRect: rect,
          towerDoor: { wallIndex: side.wallIndex, x: doorPos.x, z: doorPos.z },
        }
      }
    }
  }

  return best
}

// Flight must sit inside its tower shaft.
function flightInsideTower(flight: Rect2D, tower: Rect2D): boolean {
  return (
    flight.minX >= tower.minX - 1e-6 && flight.maxX <= tower.maxX + 1e-6 &&
    flight.minZ >= tower.minZ - 1e-6 && flight.maxZ <= tower.maxZ + 1e-6
  )
}

// Shared upper-arrival rule (lawbook §46-49): the flight MUST overlap the
// linked upper room so the top landing has a floor to arrive on. A flight
// that misses the upper room would rise through open air onto a "roof"
// with no walkable surface — a decorative stair to nowhere (§49
// FORBIDDEN). V0.1 has no roof-deck feature, so roof arrivals are
// rejected and the planner tries the next candidate instead.
function checkUpperArrival(
  flight: Rect2D,
  landing: Rect2D,
  upper: Room,
  upperSlabs: Rect2D[],
  st: StairPlanner
): boolean {
  const overlap = rectIntersection(flight, roomRect(upper))
  if (!overlap) return false // no roof arrivals in V0.1
  if (
    landing.minX < overlap.minX - 1e-6 || landing.maxX > overlap.maxX + 1e-6 ||
    landing.minZ < overlap.minZ - 1e-6 || landing.maxZ > overlap.maxZ + 1e-6
  ) return false
  for (const s of upperSlabs) {
    if (rectsOverlap(overlap, s, 0.4)) return false
  }
  for (const f of st.atFloor(st.footprints, upper.floorIndex)) {
    if (rectsOverlap(overlap, f, 0.1)) return false
  }
  for (const h of st.atFloor(st.floorHoles, upper.floorIndex)) {
    if (rectsOverlap(overlap, h, 0)) return false
  }
  return true
}

export function buildStairsGeometry(plans: StairPlan[], rooms: Room[], floorHeight: number): StairsGeometry[] {
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const stairs: StairsGeometry[] = []

  for (const plan of plans) {
    const lower = roomMap.get(plan.link.lowerRoomId)!
    const upper = roomMap.get(plan.link.upperRoomId)!
    if (!lower || !upper) continue

    const built = plan.switchback
      ? createSwitchbackStairsMesh(
        plan.x,
        plan.z,
        plan.width,
        plan.depth,
        plan.axis,
        plan.dir,
        0,
        plan.stepCount,
        plan.stepHeight,
        plan.stepDepth
      )
      : createStairsMesh(
        plan.x,
        plan.z,
        plan.width,
        plan.depth,
        floorHeight,
        plan.axis,
        plan.dir,
        0,
        plan.stepCount,
        plan.stepHeight,
        plan.stepDepth
      )

    // Attached shaft geometry (tower plans only).
    const tower = plan.towerRect && plan.towerDoor
      ? {
          ...createStairTower(plan.towerRect, plan.axis, plan.dir, lower.floorIndex, floorHeight),
          rect: plan.towerRect,
          door: { x: plan.towerDoor.x, y: lower.floorIndex * floorHeight, z: plan.towerDoor.z },
        }
      : null

    stairs.push({
      id: `stairs_${plan.link.lowerRoomId}_${plan.link.upperRoomId}`,
      startFloor: lower.floorIndex,
      endFloor: upper.floorIndex,
      hostRoomId: plan.hostRoomId,
      upperRoomId: plan.link.upperRoomId,
      kind: plan.kind,
      axis: plan.axis,
      position: { x: plan.x, y: lower.floorIndex * floorHeight, z: plan.z },
      width: plan.width,
      depth: plan.depth,
      stepCount: plan.stepCount,
      stepHeight: plan.stepHeight,
      stepDepth: plan.stepDepth,
      tower,
      steps: built.steps,
      risers: built.risers,
      stringers: built.stringers,
      landing: built.landing,
    })
  }

  return stairs
}

// Attached shaft: floor slab, two side walls + far end wall from the
// ground up to a parapet above the arrival level, open on the host side
// (the host wall + door close it) and open on top (arrival platform).
function createStairTower(
  rect: Rect2D,
  axis: 'x' | 'z',
  dir: 1 | -1,
  hostFloor: number,
  floorHeight: number
): { floor: MeshData; walls: MeshData[] } {
  const cx = (rect.minX + rect.maxX) / 2
  const cz = (rect.minZ + rect.maxZ) / 2
  const wX = rect.maxX - rect.minX
  const wZ = rect.maxZ - rect.minZ
  // Single source of truth (lawbook §7, §55).
  const t = SPATIAL_DEFAULTS.wallThickness
  // Local Y: group sits at the host floor base; walls run from the ground
  // (world y=0) to a parapet above the arrival level.
  const yDown = -hostFloor * floorHeight
  const yTop = floorHeight + TOWER_PARAPET
  const yMid = (yDown + yTop) / 2
  const yH = yTop - yDown

  const floor = createBoxMesh(cx, FLOOR_THICKNESS / 2 - 0.004, cz, wX, FLOOR_THICKNESS, wZ, 1)
  const walls: MeshData[] = []

  // Outward unit (host -> far end) in world XZ.
  const ox = axis === 'x' ? dir : 0
  const oz = axis === 'z' ? dir : 0

  if (axis === 'x') {
    // Side walls along X at both Z edges (inset inward).
    for (const s of [-1, 1]) {
      walls.push(createBoxMesh(cx, yMid, cz + s * (wZ / 2 - t / 2), wX, yH, t, 0))
    }
    // Far end wall (near end stays open toward the host door).
    walls.push(createBoxMesh(cx + ox * (wX / 2 - t / 2), yMid, cz, t, yH, wZ - 2 * t, 0))
  } else {
    for (const s of [-1, 1]) {
      walls.push(createBoxMesh(cx + s * (wX / 2 - t / 2), yMid, cz, t, yH, wZ, 0))
    }
    walls.push(createBoxMesh(cx, yMid, cz + oz * (wZ / 2 - t / 2), wX - 2 * t, yH, t, 0))
  }

  return { floor, walls }
}

function createStairsMesh(
  centerX: number, centerZ: number,
  width: number, depth: number,
  totalHeight: number,
  axis: 'x' | 'z',
  dir: 1 | -1,
  baseY: number,
  stepCount: number,
  stepHeight: number,
  stepDepth: number
): { steps: MeshData[]; risers: MeshData[]; stringers: MeshData[]; landing: MeshData[] } {
  const steps: MeshData[] = []
  const risers: MeshData[] = []
  const stringers: MeshData[] = []
  const landing: MeshData[] = []

  // Stairs ascend toward dir*axis. Map run/across
  // coordinates to world XZ.
  const toWorld = (along: number, y: number, across: number): { x: number; y: number; z: number } =>
    axis === 'z'
      ? { x: centerX + across, y, z: centerZ + along }
      : { x: centerX + along, y, z: centerZ + across }
  const putBox = (
    along: number, y: number, across: number,
    alongLen: number, h: number, acrossLen: number,
    materialIndex: number
  ): MeshData => {
    const c = toWorld(along, y, across)
    return axis === 'z'
      ? createBoxMesh(c.x, c.y, c.z, acrossLen, h, alongLen, materialIndex)
      : createBoxMesh(c.x, c.y, c.z, alongLen, h, acrossLen, materialIndex)
  }

  // Landing platform at the top (+along end, mirrored by dir).
  const landingY = baseY + totalHeight
  const landingCenter = dir * (depth / 2 - LANDING_DEPTH / 2)
  landing.push(putBox(landingCenter, landingY + FLOOR_THICKNESS / 2, 0, LANDING_DEPTH, FLOOR_THICKNESS, width, 1))

  // Stringers: sloped side beams. Slope basis: u along the slope,
  // v its normal, w across the run.
  const run = depth - LANDING_DEPTH
  const stringerLength = Math.sqrt(totalHeight * totalHeight + run * run)
  const cosA = run / stringerLength
  const sinA = totalHeight / stringerLength
  const halfW = width / 2
  const stringerDepth = 0.3
  const stringerHeight = 0.3
  for (const s of [-1, 1]) {
    const across = s * (halfW + stringerDepth / 2)
    // Beam center: halfway up the slope, starting at the low end.
    const lowAlong = dir * (-depth / 2 + LANDING_DEPTH)
    const midAlong = lowAlong + dir * (run / 2)
    const midY = baseY + totalHeight / 2
    const c = toWorld(midAlong, midY, across)
    // Slope direction in world space (ascending toward dir*along).
    const slope = axis === 'z'
      ? { x: 0, y: sinA, z: dir * cosA }
      : { x: dir * cosA, y: sinA, z: 0 }
    const normal = axis === 'z'
      ? { x: 0, y: cosA, z: -dir * sinA }
      : { x: -dir * sinA, y: cosA, z: 0 }
    const acrossAxis = axis === 'z'
      ? { x: 1, y: 0, z: 0 }
      : { x: 0, y: 0, z: 1 }
    stringers.push(createOrientedBox(
      c,
      { u: slope, v: normal, w: acrossAxis },
      stringerLength,
      stringerHeight,
      stringerDepth,
      0
    ))
  }

  for (let i = 0; i < stepCount; i++) {
    const y = baseY + i * stepHeight
    const along = dir * (-depth / 2 + LANDING_DEPTH + i * stepDepth)

    // Step tread (slight overlap avoids hairline gaps).
    steps.push(putBox(along, y + stepHeight / 2, 0, stepDepth * 1.15, stepHeight, width, 1))

    // Riser (vertical face toward the ascending side).
    if (i < stepCount - 1) {
      risers.push(putBox(along + dir * stepDepth / 2, y + stepHeight, 0, 0.15, stepHeight, width, 0))
    }
  }

  return { steps, risers, stringers, landing }
}

// Folded switchback flight: two half-runs side by side sharing one turn
// landing. Same riser/tread code as a straight flight in roughly half the
// footprint depth, so compact rooms can still host walkable stairs.
function createSwitchbackStairsMesh(
  centerX: number, centerZ: number,
  width: number, depth: number,
  axis: 'x' | 'z',
  dir: 1 | -1,
  baseY: number,
  stepCount: number,
  stepHeight: number,
  stepDepth: number
): { steps: MeshData[]; risers: MeshData[]; stringers: MeshData[]; landing: MeshData[] } {
  const steps: MeshData[] = []
  const risers: MeshData[] = []
  const stringers: MeshData[] = []
  const landing: MeshData[] = []
  const flightW = width / 2

  const toWorld = (along: number, y: number, across: number): { x: number; y: number; z: number } =>
    axis === 'z'
      ? { x: centerX + across, y, z: centerZ + along }
      : { x: centerX + along, y, z: centerZ + across }
  const putBox = (
    along: number, y: number, across: number,
    alongLen: number, h: number, acrossLen: number,
    materialIndex: number
  ): MeshData => {
    const c = toWorld(along, y, across)
    return axis === 'z'
      ? createBoxMesh(c.x, c.y, c.z, acrossLen, h, alongLen, materialIndex)
      : createBoxMesh(c.x, c.y, c.z, alongLen, h, acrossLen, materialIndex)
  }
  // Slope beam between two run/across points (world-space via toWorld).
  const putBeam = (
    a0: number, y0: number, c0: number,
    a1: number, y1: number, c1: number,
    beamH: number, beamW: number
  ): void => {
    const p0 = toWorld(a0, y0, c0)
    const p1 = toWorld(a1, y1, c1)
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const dz = p1.z - p0.z
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 0.01) return
    const ux = dx / len
    const uy = dy / len
    const uz = dz / len
    const acrossAxis = axis === 'z'
      ? { x: 1, y: 0, z: 0 }
      : { x: 0, y: 0, z: 1 }
    // Beam normal = slope x across axis, flipped to face up.
    let nx = uy * acrossAxis.z
    let ny = uz * acrossAxis.x - ux * acrossAxis.z
    let nz = -uy * acrossAxis.x
    if (ny < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    stringers.push(createOrientedBox(
      { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, z: (p0.z + p1.z) / 2 },
      { u: { x: ux, y: uy, z: uz }, v: { x: nx, y: ny, z: nz }, w: acrossAxis },
      len,
      beamH,
      beamW,
      0
    ))
  }

  const nA = Math.ceil(stepCount / 2)
  const e0 = -depth / 2 // entry end (canonical frame; mirrored by dir below)
  const runA = nA * stepDepth
  const M = (alongCanon: number) => dir * alongCanon

  // Flight A (low): entry end ascending toward +canonical-along.
  for (let i = 0; i < nA; i++) {
    const y = baseY + i * stepHeight
    const along = M(e0 + i * stepDepth)
    steps.push(putBox(along, y + stepHeight / 2, -flightW / 2, stepDepth * 1.15, stepHeight, flightW, 1))
    // No riser on the top tread: the turn landing's box face covers it.
    if (i < nA - 1) {
      risers.push(putBox(along + dir * stepDepth / 2, y + stepHeight, -flightW / 2, 0.15, stepHeight, flightW, 0))
    }
  }

  // Turn landing (full width) at A's top, flush with its top tread.
  const landY = baseY + nA * stepHeight
  const landC = M(e0 + runA + LANDING_DEPTH / 2)
  landing.push(putBox(landC, landY - FLOOR_THICKNESS / 2, 0, LANDING_DEPTH, FLOOR_THICKNESS, width, 1))

  // Flight B: back along -canonical-along from the landing to full height.
  // No riser on its top tread (0.2m lip to the upper floor, step-up-able).
  const nB = stepCount - nA
  for (let j = 0; j < nB; j++) {
    const y = landY + j * stepHeight
    const along = M(e0 + runA + LANDING_DEPTH - j * stepDepth)
    steps.push(putBox(along, y + stepHeight / 2, flightW / 2, stepDepth * 1.15, stepHeight, flightW, 1))
    if (j < nB - 1) {
      risers.push(putBox(along - dir * stepDepth / 2, y + stepHeight, flightW / 2, 0.15, stepHeight, flightW, 0))
    }
  }

  // Outer stringers following each flight.
  const beamW = 0.3
  const beamH = 0.3
  putBeam(M(e0), baseY, -flightW - beamW / 2, M(e0 + runA), landY, -flightW - beamW / 2, beamH, beamW)
  putBeam(M(e0), baseY, beamW / 2, M(e0 + runA), landY, beamW / 2, beamH, beamW)
  putBeam(M(e0 + runA + LANDING_DEPTH), landY, -beamW / 2, M(e0), landY + nB * stepHeight, -beamW / 2, beamH, beamW)
  putBeam(M(e0 + runA + LANDING_DEPTH), landY, flightW + beamW / 2, M(e0), landY + nB * stepHeight, flightW + beamW / 2, beamH, beamW)

  return { steps, risers, stringers, landing }
}

// Adjacent-floor room pairs (each once). Shared by stair generation and
// level-graph validation so both agree on what "connected" means.
export function findVerticalLinks(rooms: Room[]): VerticalLink[] {
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const processed = new Set<string>()
  const links: VerticalLink[] = []

  for (const room of rooms) {
    for (const connId of room.connections) {
      // Connections are bidirectional: handle each pair once.
      const key = [room.id, connId].sort().join('|')
      if (processed.has(key)) continue
      processed.add(key)

      const targetRoom = roomMap.get(connId)
      if (!targetRoom) continue

      const floorDiff = targetRoom.floorIndex - room.floorIndex
      if (Math.abs(floorDiff) !== 1) continue

      links.push(
        floorDiff > 0
          ? { lowerRoomId: room.id, upperRoomId: targetRoom.id }
          : { lowerRoomId: targetRoom.id, upperRoomId: room.id },
      )
    }
  }

  return links
}

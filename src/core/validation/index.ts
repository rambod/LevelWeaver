import type { Room, Corridor, DoorOpening, Boundary, Rect2D, StairsGeometry, MeshData, GeometryDescription } from '@/core/types'
import { AGENT_DEFAULTS, MIN_CLEAR_WIDTH, MIN_CLEAR_HEIGHT, SPATIAL_DEFAULTS, segSegDist2D } from '@/core/rules'
import { flightRectOf, flightHighRects, landingRectOf, type StairPlan } from '@/generator/vertical'
import type { RoomSlabHoles } from '@/generator/geometry'
import { roomFootprintInBoundary } from '@/generator/boundary'

// Single source for navigation erosion (lawbook §5, §57): the agent body
// radius, not a magic literal scattered through the grid rasterizer.
const AGENT_BODY_RADIUS = AGENT_DEFAULTS.radius // 0.30 m

// Structured validation (LAWBOOK §84, §96). Validators return issues;
// they never throw and never weaken dimensions to pass.

// Lawbook §84 error catalogue (subset implemented in V0.1).
export type IssueCode =
  | 'GRAPH_DISCONNECTED'
  | 'FLOOR_DISCONNECTED'
  | 'ROOM_OVERLAP'
  | 'ROOM_NESTED'
  | 'ROOM_OUT_OF_BOUNDS'
  | 'ROOM_TOO_SMALL'
  | 'ROOM_ASPECT'
  | 'PORTAL_TOO_NARROW'
  | 'PORTAL_TOO_LOW'
  | 'PORTAL_CORNER_VIOLATION'
  | 'PORTAL_SEPARATION'
  | 'PORTAL_WALL_OVERCROWDED'
  | 'PORTAL_NO_ENTRY'
  | 'PORTAL_NO_EXIT'
  | 'PORTAL_SEALED'
  | 'CORRIDOR_TOO_NARROW'
  | 'CORRIDOR_DEGENERATE'
  | 'CORRIDOR_SHORT_SEGMENT'
  | 'CORRIDOR_ROOM_COLLISION'
  | 'CORRIDOR_CROSSING'
  | 'CORRIDOR_TOO_LOW'
  | 'CORRIDOR_LONG_LINK'
  // Explicit paper trail for post-hoc redundant-foul drops (§87): the
  // corridor AND its graph edge are gone; this warning records why.
  // Always a warning — it never fails a level, only breaks tier ties
  // toward layouts that routed cleanly in the first place.
  | 'CORRIDOR_REDUNDANT_DROPPED'
  | 'STAIR_NO_PLACEMENT'
  | 'STAIR_BAD_RISER'
  | 'STAIR_BAD_TREAD'
  | 'STAIR_TOO_NARROW'
  | 'STAIR_NO_ARRIVAL'
  | 'STAIR_NO_HEADROOM'
  | 'STAIR_ARRIVAL_WALL'
  | 'STAIR_NO_LANDING'
  | 'STAIR_NO_SHAFT'
  | 'STAIR_CLIPS_ROOM'
  | 'SLAB_NO_OPENING'
  | 'NAV_UNREACHABLE_ROOM'
  | 'NAV_NO_SPAWN'
  | 'GEOMETRY_NONFINITE'
  | 'GEOMETRY_EMPTY_FLOOR'
  | 'GEOMETRY_INVALID_MESH'

export interface GenerationIssue {
  code: IssueCode
  severity: 'error' | 'warning'
  stage: string
  objectIds: string[]
  message: string
}

export interface ValidationReport {
  issues: GenerationIssue[]
  errors: GenerationIssue[]
  warnings: GenerationIssue[]
}

export function reportOf(issues: GenerationIssue[]): ValidationReport {
  return {
    issues,
    errors: issues.filter(i => i.severity === 'error'),
    warnings: issues.filter(i => i.severity === 'warning'),
  }
}

/**
 * Lawbook §2 Order of Authority, for repair selection: physical validity
 * outranks traversal validity outranks graph niceties. A sealed gate the
 * player bodily cannot pass (tier 1) must never trade evenly against an
 * abstract connectivity shortfall (tier 2) — otherwise retry keeps the
 * locked door and drops the side room to minimize the raw count.
 */
export function errorTier(code: IssueCode): 1 | 2 | 3 {
  switch (code) {
    case 'ROOM_OVERLAP':
    case 'ROOM_NESTED':
    case 'ROOM_OUT_OF_BOUNDS':
    case 'ROOM_TOO_SMALL':
    case 'PORTAL_TOO_NARROW':
    case 'PORTAL_TOO_LOW':
    case 'PORTAL_CORNER_VIOLATION':
    case 'PORTAL_SEALED':
    case 'CORRIDOR_TOO_NARROW':
    case 'CORRIDOR_DEGENERATE':
    case 'CORRIDOR_ROOM_COLLISION':
    case 'CORRIDOR_CROSSING':
    case 'CORRIDOR_TOO_LOW':
    case 'STAIR_BAD_RISER':
    case 'STAIR_BAD_TREAD':
    case 'STAIR_TOO_NARROW':
    case 'STAIR_NO_HEADROOM':
    case 'STAIR_NO_ARRIVAL':
    case 'STAIR_NO_PLACEMENT':
    case 'STAIR_ARRIVAL_WALL':
    case 'STAIR_NO_LANDING':
    case 'STAIR_NO_SHAFT':
    case 'STAIR_CLIPS_ROOM':
    case 'SLAB_NO_OPENING':
    case 'NAV_NO_SPAWN':
    case 'GEOMETRY_NONFINITE':
    case 'GEOMETRY_EMPTY_FLOOR':
    case 'GEOMETRY_INVALID_MESH':
      return 1
    default:
      return 2
  }
}

export interface ErrorTiers {
  t1: number
  /**
   * Tier-1 placement failures (lawbook §2 Order of Authority, §70 repair
   * order): ROOM_OVERLAP, ROOM_NESTED, ROOM_OUT_OF_BOUNDS, ROOM_TOO_SMALL.
   * No corridor, mouth, or stair repair can cure them — only a different
   * placement can — so retry selection compares them BEFORE tier-1
   * routing failures. Otherwise a layout with one unrepairable overlap
   * beats a placeable layout with two repairable mouth fouls and the
   * winnable seed ships an overlap. Clean layouts (all zero) compare
   * exactly as before.
   */
  t1p: number
  t2: number
  t3: number
}

/** Lexicographic compare: fewer placement failures wins, then fewer
 * tier-1 overall, then tier-2, then tier-3. */
export function compareTiers(a: ErrorTiers, b: ErrorTiers): number {
  if (a.t1p !== b.t1p) return a.t1p - b.t1p
  if (a.t1 !== b.t1) return a.t1 - b.t1
  if (a.t2 !== b.t2) return a.t2 - b.t2
  return a.t3 - b.t3
}

/** Placement-failure codes: truth about room bodies that no downstream
 * routing repair can change (single source; mirrors the mouth-repair
 * veto in `@/core/generation`, plus ROOM_TOO_SMALL — rooms are never
 * resized after the sizing stage). */
export function isPlacementFailure(code: IssueCode): boolean {
  return (
    code === 'ROOM_OVERLAP' ||
    code === 'ROOM_NESTED' ||
    code === 'ROOM_OUT_OF_BOUNDS' ||
    code === 'ROOM_TOO_SMALL'
  )
}

export function tiersOf(issues: GenerationIssue[]): ErrorTiers {
  const t: ErrorTiers = { t1: 0, t1p: 0, t2: 0, t3: 0 }
  for (const i of issues) {
    if (i.severity !== 'error') {
      // Warnings are soft quality signals (lawbook §80): they never fail
      // a level, but among valid candidates the cleaner map wins ties.
      t.t3++
      continue
    }
    const tier = errorTier(i.code)
    if (tier === 1) {
      t.t1++
      if (isPlacementFailure(i.code)) t.t1p++
    }
    else if (tier === 2) t.t2++
    else t.t3++
  }
  return t
}

function rectOf(r: Room) {
  return {
    minX: r.position.x - r.width / 2,
    maxX: r.position.x + r.width / 2,
    minZ: r.position.z - r.depth / 2,
    maxZ: r.position.z + r.depth / 2,
  }
}

/**
 * Lawbook §10, §62: BFS from Spawn over REALIZED traversal (corridors for
 * same-floor pairs + built stairs for cross-floor pairs). Graph intent
 * alone is not connectivity — a dropped corridor or omitted stair breaks it.
 */
export function validateRealizedConnectivity(
  rooms: Room[],
  corridors: Corridor[],
  stairPlans: StairPlan[],
  floorCount: number,
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const adj = new Map<string, Set<string>>()
  for (const r of rooms) adj.set(r.id, new Set())
  const link = (a: string, b: string) => {
    adj.get(a)?.add(b)
    adj.get(b)?.add(a)
  }
  for (const c of corridors) link(c.startRoomId, c.endRoomId)
  for (const p of stairPlans) link(p.link.lowerRoomId, p.link.upperRoomId)

  const spawn = rooms.find(r => r.type === 'spawn') ?? rooms[0]
  if (!spawn) return issues
  const seen = new Set<string>([spawn.id])
  const queue = [spawn.id]
  while (queue.length > 0) {
    const cur = queue.pop()!
    for (const nb of adj.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb)
        queue.push(nb)
      }
    }
  }
  const unreachable = rooms.filter(r => !seen.has(r.id)).map(r => r.id)
  if (unreachable.length > 0) {
    issues.push({
      code: 'GRAPH_DISCONNECTED',
      severity: 'error',
      stage: 'connectivity',
      objectIds: unreachable,
      message:
        `${unreachable.length} room(s) unreachable from Spawn via realized corridors+stairs: ` +
        `${unreachable.join(', ')}.`,
    })
  }

  // Every occupied floor must join the traversal graph (lawbook §39, §62).
  const floorsWithRooms = new Set(rooms.map(r => r.floorIndex))
  const floorAdj = new Map<number, Set<number>>()
  for (const p of stairPlans) {
    const a = rooms.find(r => r.id === p.link.lowerRoomId)?.floorIndex
    const b = rooms.find(r => r.id === p.link.upperRoomId)?.floorIndex
    if (a === undefined || b === undefined) continue
    if (!floorAdj.has(a)) floorAdj.set(a, new Set())
    if (!floorAdj.has(b)) floorAdj.set(b, new Set())
    floorAdj.get(a)!.add(b)
    floorAdj.get(b)!.add(a)
  }
  if (floorsWithRooms.size > 1) {
    const start = Math.min(...floorsWithRooms)
    const fSeen = new Set<number>([start])
    const fq = [start]
    while (fq.length > 0) {
      const cur = fq.pop()!
      for (const nb of floorAdj.get(cur) ?? []) {
        if (!fSeen.has(nb)) {
          fSeen.add(nb)
          fq.push(nb)
        }
      }
    }
    const orphanFloors = [...floorsWithRooms].filter(f => !fSeen.has(f))
    if (orphanFloors.length > 0) {
      issues.push({
        code: 'FLOOR_DISCONNECTED',
        severity: 'error',
        stage: 'connectivity',
        objectIds: rooms.filter(r => orphanFloors.includes(r.floorIndex)).map(r => r.id),
        message: `Occupied floor(s) ${orphanFloors.join(', ')} have no stair connection (need ${floorCount} floors linked).`,
      })
    }
  }
  return issues
}

/** Lawbook §19-21: overlap, nesting, bounds, minimum size. */
export function validateRoomPlacement(rooms: Room[], boundary: Boundary): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const eps = SPATIAL_DEFAULTS.epsilon
  for (const r of rooms) {
    if (r.width < SPATIAL_DEFAULTS.minRoomWidth - eps || r.depth < SPATIAL_DEFAULTS.minRoomDepth - eps) {
      issues.push({
        code: 'ROOM_TOO_SMALL',
        severity: 'error',
        stage: 'placement',
        objectIds: [r.id],
        message: `${r.id} is ${r.width.toFixed(2)}x${r.depth.toFixed(2)} m, below minimum ${SPATIAL_DEFAULTS.minRoomWidth}x${SPATIAL_DEFAULTS.minRoomDepth} m.`,
      })
    }
    // Lawbook §21 + §64-65: structural volume inside the allowed region —
    // corners, not just the center/AABB (ring hole, cross cut-outs).
    if (!roomFootprintInBoundary({ x: r.position.x, z: r.position.z }, r.width, r.depth, boundary, 0)) {
      issues.push({
        code: 'ROOM_OUT_OF_BOUNDS',
        severity: 'error',
        stage: 'placement',
        objectIds: [r.id],
        message: `${r.id} extends outside the ${boundary.shape} boundary (${boundary.width.toFixed(1)}x${boundary.depth.toFixed(1)} m).`,
      })
    }
  }
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i]
      const b = rooms[j]
      if (a.floorIndex !== b.floorIndex) continue
      const ra = rectOf(a)
      const rb = rectOf(b)
      const overlapX = Math.min(ra.maxX, rb.maxX) - Math.max(ra.minX, rb.minX)
      const overlapZ = Math.min(ra.maxZ, rb.maxZ) - Math.max(ra.minZ, rb.minZ)
      if (overlapX > eps && overlapZ > eps) {
        const aInB =
          rb.minX <= ra.minX + eps && ra.maxX <= rb.maxX + eps && rb.minZ <= ra.minZ + eps && ra.maxZ <= rb.maxZ + eps
        const bInA =
          ra.minX <= rb.minX + eps && rb.maxX <= ra.maxX + eps && ra.minZ <= rb.minZ + eps && rb.maxZ <= ra.maxZ + eps
        issues.push({
          code: aInB || bInA ? 'ROOM_NESTED' : 'ROOM_OVERLAP',
          severity: 'error',
          stage: 'placement',
          objectIds: [a.id, b.id],
          message: `${a.id} and ${b.id} ${aInB || bInA ? 'nest' : `overlap by ${overlapX.toFixed(2)}x${overlapZ.toFixed(2)} m`}.`,
        })
      }
    }
  }
  return issues
}

/** Lawbook §24-27: gate clear width/height, corner margins, separation. */
export function validateDoors(
  rooms: Room[],
  doorsByRoom: Map<string, DoorOpening[]>,
  required = { doorWidth: MIN_CLEAR_WIDTH, doorHeight: MIN_CLEAR_HEIGHT },
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const minimumWidth = Math.max(MIN_CLEAR_WIDTH, required.doorWidth)
  const minimumHeight = Math.max(MIN_CLEAR_HEIGHT, required.doorHeight)
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  for (const [roomId, doors] of doorsByRoom) {
    const room = roomMap.get(roomId)
    if (!room) continue
    const byWall = new Map<number, DoorOpening[]>()
    for (const d of doors) {
      if (d.width < minimumWidth - SPATIAL_DEFAULTS.epsilon) {
        issues.push({
          code: 'PORTAL_TOO_NARROW',
          severity: 'error',
          stage: 'doors',
          objectIds: [roomId],
          message: `Gate in ${roomId} is ${d.width.toFixed(2)} m wide, below required clear width ${minimumWidth.toFixed(2)} m.`,
        })
      } else if (d.width < SPATIAL_DEFAULTS.doorClearWidth - SPATIAL_DEFAULTS.epsilon) {
        issues.push({
          code: 'PORTAL_TOO_NARROW',
          severity: 'warning',
          stage: 'doors',
          objectIds: [roomId],
          message: `Gate in ${roomId} is ${d.width.toFixed(2)} m wide, below design default ${SPATIAL_DEFAULTS.doorClearWidth.toFixed(2)} m.`,
        })
      }
      if (d.height < minimumHeight - SPATIAL_DEFAULTS.epsilon) {
        issues.push({
          code: 'PORTAL_TOO_LOW',
          severity: 'error',
          stage: 'doors',
          objectIds: [roomId],
          message: `Gate in ${roomId} is ${d.height.toFixed(2)} m high, below required clear height ${minimumHeight.toFixed(2)} m.`,
        })
      }
      const wallLength = d.wallIndex % 2 === 0 ? room.width : room.depth
      const along =
        d.wallIndex % 2 === 0 ? d.position.x - room.position.x : d.position.z - room.position.z
      const edgeDist = Math.min(
        along + wallLength / 2 - d.width / 2,
        wallLength / 2 - along - d.width / 2,
      )
      if (edgeDist < SPATIAL_DEFAULTS.doorCornerMargin - SPATIAL_DEFAULTS.epsilon) {
        issues.push({
          code: 'PORTAL_CORNER_VIOLATION',
          severity: 'error',
          stage: 'doors',
          objectIds: [roomId],
          message: `Gate in ${roomId} starts ${edgeDist.toFixed(2)} m from the corner, below margin ${SPATIAL_DEFAULTS.doorCornerMargin} m.`,
        })
      }
      const list = byWall.get(d.wallIndex) ?? []
      list.push(d)
      byWall.set(d.wallIndex, list)
    }
    for (const [, list] of byWall) {
      const sorted = [...list].sort((p, q) => {
        const pa = p.wallIndex % 2 === 0 ? p.position.x : p.position.z
        const qa = q.wallIndex % 2 === 0 ? q.position.x : q.position.z
        return pa - qa
      })
      for (let i = 1; i < sorted.length; i++) {
        const pa = sorted[i - 1].wallIndex % 2 === 0 ? sorted[i - 1].position.x : sorted[i - 1].position.z
        const qa = sorted[i].wallIndex % 2 === 0 ? sorted[i].position.x : sorted[i].position.z
        const gap = Math.abs(qa - pa) - (sorted[i - 1].width + sorted[i].width) / 2
        if (gap < SPATIAL_DEFAULTS.doorSeparation - SPATIAL_DEFAULTS.epsilon) {
          // Overlapping gates stay a warning, not an error: the merged
          // funnel (all walls full, one shared mouth) and tower-door
          // stacking produce coincident openings BY DESIGN, and no
          // post-hoc check can tell deliberate sharing from failed
          // spreading — while a true cram also trips PORTAL_SEALED or
          // PORTAL_WALL_OVERCROWDED alongside it.
          issues.push({
            code: 'PORTAL_SEPARATION',
            severity: 'warning',
            stage: 'doors',
            objectIds: [roomId],
            message: `Two gates in ${roomId} wall ${sorted[i].wallIndex} are ${gap.toFixed(2)} m apart (min ${SPATIAL_DEFAULTS.doorSeparation} m).`,
          })
        }
      }
    }
  }
  return issues
}

/** Lawbook §18: bounded room proportions (hall/connector types that are
 * intentionally long and narrow are exempt). */
export function validateRoomAspects(rooms: Room[]): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const EXEMPT: Room['type'][] = ['hall', 'connector', 'verticalConnector']
  for (const r of rooms) {
    if (EXEMPT.includes(r.type)) continue
    const aspect = r.width / Math.max(r.depth, SPATIAL_DEFAULTS.epsilon)
    if (
      aspect < SPATIAL_DEFAULTS.minRoomAspectRatio - SPATIAL_DEFAULTS.epsilon ||
      aspect > SPATIAL_DEFAULTS.maxRoomAspectRatio + SPATIAL_DEFAULTS.epsilon
    ) {
      issues.push({
        code: 'ROOM_ASPECT',
        severity: 'warning',
        stage: 'placement',
        objectIds: [r.id],
        message:
          `${r.id} aspect ${aspect.toFixed(2)} outside ` +
          `[${SPATIAL_DEFAULTS.minRoomAspectRatio}, ${SPATIAL_DEFAULTS.maxRoomAspectRatio}].`,
      })
    }
  }
  return issues
}

/** Lawbook §17/§100: a wall's gate count must fit its usable length. */
export function validatePortalCapacity(
  rooms: Room[],
  doorsByRoom: Map<string, DoorOpening[]>,
  configuredDoorWidth: number,
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  for (const [roomId, doors] of doorsByRoom) {
    const room = roomMap.get(roomId)
    if (!room) continue
    for (let wall = 0; wall < 4; wall++) {
      const list = doors.filter(d => d.wallIndex === wall)
      if (list.length <= 1) continue
      const wallLength = wall % 2 === 0 ? room.width : room.depth
      const required =
        list.length * configuredDoorWidth +
        2 * SPATIAL_DEFAULTS.doorCornerMargin +
        (list.length - 1) * SPATIAL_DEFAULTS.doorSeparation
      if (required > wallLength + SPATIAL_DEFAULTS.epsilon) {
        issues.push({
          code: 'PORTAL_WALL_OVERCROWDED',
          severity: 'warning',
          stage: 'doors',
          objectIds: [roomId],
          message:
            `${roomId} wall ${wall} hosts ${list.length} gates needing ` +
            `${required.toFixed(2)} m of ${wallLength.toFixed(2)} m wall — gates shrink to fit.`,
        })
      }
    }
  }
  return issues
}

/** Lawbook §30/31/36: corridor width lawfulness + degenerate/micro segments. */
export function validateCorridors(corridors: Corridor[], corridorClearHeight?: number): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  for (const c of corridors) {
    if (c.width < MIN_CLEAR_WIDTH - SPATIAL_DEFAULTS.epsilon) {
      issues.push({
        code: 'CORRIDOR_TOO_NARROW',
        severity: 'error',
        stage: 'corridors',
        objectIds: [c.startRoomId, c.endRoomId],
        message: `${c.id} is ${c.width.toFixed(2)} m wide, below agent minimum ${MIN_CLEAR_WIDTH.toFixed(2)} m.`,
      })
    }
    if (
      corridorClearHeight !== undefined &&
      corridorClearHeight < MIN_CLEAR_HEIGHT - SPATIAL_DEFAULTS.epsilon
    ) {
      issues.push({
        code: 'CORRIDOR_TOO_LOW',
        severity: 'error',
        stage: 'corridors',
        objectIds: [c.startRoomId, c.endRoomId],
        message: `${c.id} clear height ${corridorClearHeight.toFixed(2)} m is below agent minimum ${MIN_CLEAR_HEIGHT.toFixed(2)} m.`,
      })
    }
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    if (pts.length < 2) {
      issues.push({
        code: 'CORRIDOR_DEGENERATE',
        severity: 'error',
        stage: 'corridors',
        objectIds: [c.startRoomId, c.endRoomId],
        message: `${c.id} has no routable path.`,
      })
      continue
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const segLen = Math.sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2)
      if (segLen < 1e-4) continue // dropped by geometry builder; harmless
      if (segLen < SPATIAL_DEFAULTS.minCorridorSegment - SPATIAL_DEFAULTS.epsilon) {
        issues.push({
          code: 'CORRIDOR_SHORT_SEGMENT',
          severity: 'warning',
          stage: 'corridors',
          objectIds: [c.startRoomId, c.endRoomId],
          message: `${c.id} has a ${segLen.toFixed(2)} m segment below ${SPATIAL_DEFAULTS.minCorridorSegment} m.`,
        })
        break // one warning per corridor is enough
      }
    }
  }
  return issues
}

/**
 * Lawbook §32 + §35 post-hoc tripwires the router cannot self-report:
 * a shipped corridor whose ribbon crosses an unrelated room interior, or
 * whose volume crosses another same-floor corridor without a junction,
 * is a spatial artifact even when the graph looks connected. The router
 * verifies candidates before shipping, but the fallback path ships the
 * grid middle with fouls for subdivision — the retry loop and the final
 * gate must see those fouls as hard errors, never as silent geometry.
 */
/** Proper segment intersection point (world XZ), or null for parallel /
misses / endpoint-only touches. Interior X-crossings only: shared mouth
regions and T-touches are not junction candidates. */
export function segIntersectionPoint(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): { x: number; z: number } | null {
  const d1x = bx - ax
  const d1z = bz - az
  const d2x = dx - cx
  const d2z = dz - cz
  const denom = d1x * d2z - d1z * d2x
  if (Math.abs(denom) < 1e-12) return null
  const t = ((cx - ax) * d2z - (cz - az) * d2x) / denom
  const u = ((cx - ax) * d1z - (cz - az) * d1x) / denom
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null
  return { x: ax + t * d1x, z: az + t * d1z }
}

export interface CorridorCrossing {
  a: Corridor
  b: Corridor
  /**
   * First proper X-crossing point, or null for near-miss/parallel brushes
   * (still validator errors, but not junction candidates).
   */
  point: { x: number; z: number } | null
}

/**
 * Lawbook §35: same-floor corridor pairs whose volumes intersect without
 * a shared endpoint room. Shared endpoints ARE the recorded junction
 * representation, so those pairs never report. One entry per validator
 * finding, deterministic pair order — the validator below maps these
 * 1:1 to CORRIDOR_CROSSING issues, and junction repair consumes the
 * entries with a proper crossing point.
 */
export function findCorridorCrossings(corridors: Corridor[]): CorridorCrossing[] {
  const out: CorridorCrossing[] = []
  for (let i = 0; i < corridors.length; i++) {
    for (let j = i + 1; j < corridors.length; j++) {
      const a = corridors[i]
      const b = corridors[j]
      if (a.floorIndex !== b.floorIndex) continue
      const sharesEndpoint =
        a.startRoomId === b.startRoomId || a.startRoomId === b.endRoomId ||
        a.endRoomId === b.startRoomId || a.endRoomId === b.endRoomId
      if (sharesEndpoint) continue
      const pa = a.pathPoints && a.pathPoints.length > 0 ? a.pathPoints : [a.startPos, a.endPos]
      const pb = b.pathPoints && b.pathPoints.length > 0 ? b.pathPoints : [b.startPos, b.endPos]
      // Deep volume intersection only (lawbook §35): one centerline
      // inside the other's wall face. Threshold stays LOOSER than the
      // router's own capsule separation so routing-clean parallels never
      // trip here — only true crossings / deep overlaps fail.
      const deepOverlap = Math.min(a.width, b.width) / 2 + SPATIAL_DEFAULTS.wallThickness
      let crossed = false
      let point: { x: number; z: number } | null = null
      for (let ia = 0; ia < pa.length - 1 && !point; ia++) {
        for (let ib = 0; ib < pb.length - 1 && !point; ib++) {
          const d = segSegDist2D(
            pa[ia].x, pa[ia].z, pa[ia + 1].x, pa[ia + 1].z,
            pb[ib].x, pb[ib].z, pb[ib + 1].x, pb[ib + 1].z,
          )
          if (d < deepOverlap) {
            crossed = true
            point = segIntersectionPoint(
              pa[ia].x, pa[ia].z, pa[ia + 1].x, pa[ia + 1].z,
              pb[ib].x, pb[ib].z, pb[ib + 1].x, pb[ib + 1].z,
            )
          }
        }
      }
      if (crossed) out.push({ a, b, point })
    }
  }
  return out
}

export function validateCorridorIntrusions(rooms: Room[], corridors: Corridor[]): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const erode = SPATIAL_DEFAULTS.wallThickness + 0.05
  const inRoom = (x: number, z: number, r: Room): boolean =>
    x > r.position.x - r.width / 2 + erode &&
    x < r.position.x + r.width / 2 - erode &&
    z > r.position.z - r.depth / 2 + erode &&
    z < r.position.z + r.depth / 2 - erode
  for (const c of corridors) {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    const edge = c.width / 2 + SPATIAL_DEFAULTS.wallThickness + 0.05
    for (let k = 0; k < pts.length - 1; k++) {
      const p = pts[k]
      const q = pts[k + 1]
      const segLen = Math.sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2)
      if (segLen < 1e-9) continue
      const ux = (q.x - p.x) / segLen
      const uz = (q.z - p.z) / segLen
      const steps = Math.max(1, Math.ceil(segLen / 0.25))
      for (let s = 0; s <= steps; s++) {
        const cx = p.x + ux * ((s / steps) * segLen)
        const cz = p.z + uz * ((s / steps) * segLen)
        for (const lateral of [0, edge, -edge]) {
          const ex = cx + -uz * lateral
          const ez = cz + ux * lateral
          for (const r of rooms) {
            if (r.floorIndex !== c.floorIndex) continue
            if (!inRoom(ex, ez, r)) continue
            if (r.id === c.startRoomId || r.id === c.endRoomId) {
              // Endpoint interiors are legal only at the doorway traverse.
              const door = r.id === c.startRoomId ? c.startPos : c.endPos
              if (Math.sqrt((ex - door.x) ** 2 + (ez - door.z) ** 2) < 0.7) continue
              issues.push({
                code: 'CORRIDOR_ROOM_COLLISION',
                severity: 'error',
                stage: 'corridors',
                objectIds: [c.id, r.id],
                message: `${c.id} ribbon re-enters endpoint ${r.id} away from its doorway (mouth foul).`,
              })
              k = pts.length // break all segment loops for this corridor
              s = steps + 1
              break
            }
            issues.push({
              code: 'CORRIDOR_ROOM_COLLISION',
              severity: 'error',
              stage: 'corridors',
              objectIds: [c.id, r.id],
              message: `${c.id} passes through unrelated room ${r.id} (lawbook §32).`,
            })
            k = pts.length
            s = steps + 1
            break
          }
          if (k >= pts.length) break
        }
        if (k >= pts.length) break
      }
      if (k >= pts.length) break
    }
  }
  // Same-floor corridor-vs-corridor crossings without a junction (§35).
  // Junctions are explicit shared endpoints; any other volume crossing is
  // either a topological junction that was never recorded or a reroute
  // failure. Both are hard errors.
  for (const { a, b } of findCorridorCrossings(corridors)) {
    issues.push({
      code: 'CORRIDOR_CROSSING',
      severity: 'error',
      stage: 'corridors',
      objectIds: [a.id, b.id],
      message: `${a.id} crosses ${b.id} on floor ${a.floorIndex} without a recorded junction (lawbook §35).`,
    })
  }
  // Silence unused-var warnings for the shared map (kept for symmetry
  // with the router's verifier, which needs it for door-exempt checks).
  void roomMap
  return issues
}

/**
 * Lawbook §82 corridor efficiency as retry steering: same-floor intent
 * links stretched past LONG_LINK_OVER (backbone bridges the monster
 * prune had to keep) are legal but undesirable — 60 m indoor corridors
 * collect seals and crossings. A WARNING (never an error): legitimately
 * sparse multi-floor maps keep working, while retry prefers the compact
 * placement among otherwise-equal candidates (warnings break tier ties).
 */
export function validateLinkLengths(rooms: Room[]): GenerationIssue[] {
  const LONG_LINK_OVER = 60
  const issues: GenerationIssue[] = []
  const byId = new Map(rooms.map(r => [r.id, r]))
  const seen = new Set<string>()
  for (const room of rooms) {
    for (const connId of room.connections) {
      const key = [room.id, connId].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const other = byId.get(connId)
      if (!other || other.floorIndex !== room.floorIndex) continue
      const d = Math.sqrt(
        (room.position.x - other.position.x) ** 2 +
        (room.position.z - other.position.z) ** 2,
      )
      if (d > LONG_LINK_OVER) {
        issues.push({
          code: 'CORRIDOR_LONG_LINK',
          severity: 'warning',
          stage: 'topology',
          objectIds: [room.id, other.id],
          message:
            `${room.id} links ${other.id} across ${d.toFixed(0)} m of open floor ` +
            `(over ${LONG_LINK_OVER} m): legal but fragile — prefer compact placements.`,
        })
      }
    }
  }
  return issues
}

/** Lawbook §41-48: riser/tread/width lawfulness of every built stair. */
export function validateStairs(plans: StairPlan[]): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const { minRiser, maxRiser, minTread, clearWidth } = SPATIAL_DEFAULTS.stair
  for (const p of plans) {
    const id = `stairs_${p.link.lowerRoomId}_${p.link.upperRoomId}`
    if (p.stepHeight < minRiser - SPATIAL_DEFAULTS.epsilon || p.stepHeight > maxRiser + SPATIAL_DEFAULTS.epsilon) {
      issues.push({
        code: 'STAIR_BAD_RISER',
        severity: 'error',
        stage: 'stairs',
        objectIds: [id],
        message: `${id} riser ${p.stepHeight.toFixed(4)} m outside [${minRiser}, ${maxRiser}].`,
      })
    }
    if (p.stepDepth < minTread - SPATIAL_DEFAULTS.epsilon) {
      issues.push({
        code: 'STAIR_BAD_TREAD',
        severity: 'error',
        stage: 'stairs',
        objectIds: [id],
        message: `${id} tread ${p.stepDepth.toFixed(3)} m below minimum ${minTread} m.`,
      })
    }
    const flightW = p.switchback ? p.width / 2 : p.width
    if (flightW < MIN_CLEAR_WIDTH - SPATIAL_DEFAULTS.epsilon) {
      issues.push({
        code: 'STAIR_TOO_NARROW',
        severity: 'error',
        stage: 'stairs',
        objectIds: [id],
        message: `${id} flight ${flightW.toFixed(2)} m wide, below agent minimum ${MIN_CLEAR_WIDTH.toFixed(2)} m.`,
      })
    } else if (flightW < clearWidth - SPATIAL_DEFAULTS.epsilon) {
      issues.push({
        code: 'STAIR_TOO_NARROW',
        severity: 'warning',
        stage: 'stairs',
        objectIds: [id],
        message: `${id} flight ${flightW.toFixed(2)} m below design default ${clearWidth.toFixed(2)} m.`,
      })
    }
  }
  return issues
}

const PORTAL_NORMALS = [
  { x: 0, z: -1 }, // wall 0 (-Z)
  { x: 1, z: 0 }, // wall 1 (+X)
  { x: 0, z: 1 }, // wall 2 (+Z)
  { x: -1, z: 0 }, // wall 3 (-X)
];

/** Shared corridor slab footprints per floor (raw centerline ± half width —
 * callers add their own tolerance so planner and validators never disagree
 * through hidden double-padding). */
export function corridorSlabsByFloor(
  corridors: Corridor[],
): Map<number, { minX: number; maxX: number; minZ: number; maxZ: number }[]> {
  const slabs = new Map<number, { minX: number; maxX: number; minZ: number; maxZ: number }[]>()
  for (const c of corridors) {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    let list = slabs.get(c.floorIndex)
    if (!list) {
      list = []
      slabs.set(c.floorIndex, list)
    }
    for (let i = 0; i < pts.length - 1; i++) {
      list.push({
        minX: Math.min(pts[i].x, pts[i + 1].x) - c.width / 2,
        maxX: Math.max(pts[i].x, pts[i + 1].x) + c.width / 2,
        minZ: Math.min(pts[i].z, pts[i + 1].z) - c.width / 2,
        maxZ: Math.max(pts[i].z, pts[i + 1].z) + c.width / 2,
      })
    }
  }
  return slabs
}

/** Lawbook §61: every portal has reachable sample space on both sides. */
export function validatePortalSampling(
  rooms: Room[],
  doorsByRoom: Map<string, DoorOpening[]>,
  corridors: Corridor[],
  stairPlans: StairPlan[],
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const inRect = (
    x: number, z: number,
    rect: { minX: number; maxX: number; minZ: number; maxZ: number },
  ): boolean => x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ

  // Corridor slabs per floor (walkable approach outside corridor mouths).
  // Sampling tolerance applied at check time (raw slabs, no double pad).
  const slabs = corridorSlabsByFloor(corridors)
  const SLAB_TOL = SPATIAL_DEFAULTS.wallThickness

  // Stair volumes: flights (host floor) + tower shafts (full height).
  const flights = new Map<number, { minX: number; maxX: number; minZ: number; maxZ: number }[]>()
  const towers: { minX: number; maxX: number; minZ: number; maxZ: number }[] = []
  for (const p of stairPlans) {
    const host = roomMap.get(p.hostRoomId)
    if (host) {
      const f = flightRectOf(p.x, p.z, p.width, p.depth, p.axis)
      const pad = 0.2
      let list = flights.get(host.floorIndex)
      if (!list) {
        list = []
        flights.set(host.floorIndex, list)
      }
      list.push({ minX: f.minX - pad, maxX: f.maxX + pad, minZ: f.minZ - pad, maxZ: f.maxZ + pad })
    }
    if (p.towerRect) towers.push(p.towerRect)
  }

  for (const [roomId, doors] of doorsByRoom) {
    const room = roomMap.get(roomId)
    if (!room) continue
    const eroded = 0.05
    const interior = {
      minX: room.position.x - room.width / 2 + eroded,
      maxX: room.position.x + room.width / 2 - eroded,
      minZ: room.position.z - room.depth / 2 + eroded,
      maxZ: room.position.z + room.depth / 2 - eroded,
    }
    for (const d of doors) {
      const n = PORTAL_NORMALS[d.wallIndex] ?? PORTAL_NORMALS[0]
      const ix = d.position.x - n.x * 0.6
      const iz = d.position.z - n.z * 0.6
      if (!inRect(ix, iz, interior)) {
        issues.push({
          code: 'PORTAL_NO_ENTRY',
          severity: 'error',
          stage: 'doors',
          objectIds: [roomId],
          message: `Gate in ${roomId} wall ${d.wallIndex} has no walkable space inside (sample lands outside the room).`,
        })
        continue
      }
      const ox = d.position.x + n.x * 0.6
      const oz = d.position.z + n.z * 0.6
      const onSlab = (slabs.get(room.floorIndex) ?? []).some(
        s =>
          ox > s.minX - SLAB_TOL && ox < s.maxX + SLAB_TOL &&
          oz > s.minZ - SLAB_TOL && oz < s.maxZ + SLAB_TOL,
      )
      const onFlight = (flights.get(room.floorIndex) ?? []).some(s => inRect(ox, oz, s))
      const inTower = towers.some(s => inRect(ox, oz, s))
      if (!onSlab && !onFlight && !inTower) {
        issues.push({
          code: 'PORTAL_NO_EXIT',
          severity: 'error',
          stage: 'doors',
          objectIds: [roomId],
          message: `Gate in ${roomId} wall ${d.wallIndex} opens into no walkable region (no corridor, stair, or shaft outside).`,
        })
      }
    }
  }
  return issues
}

/** Lawbook §45: no upper-floor slab may cross the stair headroom volume.
 * Mirrors the planner's slab rule as an independent tripwire: the flight
 * footprint on the upper floor must stay clear of corridor slabs. */
export function validateStairHeadroom(
  rooms: Room[],
  stairPlans: StairPlan[],
  corridors: Corridor[],
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const slabs = corridorSlabsByFloor(corridors)
  const overlaps = (
    a: { minX: number; maxX: number; minZ: number; maxZ: number },
    b: { minX: number; maxX: number; minZ: number; maxZ: number },
    pad: number,
  ): boolean =>
    a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad
  for (const p of stairPlans) {
    const upper = roomMap.get(p.link.upperRoomId)
    if (!upper) continue
    const id = `stairs_${p.link.lowerRoomId}_${p.link.upperRoomId}`
    const flight = flightRectOf(p.x, p.z, p.width, p.depth, p.axis)
    for (const s of slabs.get(upper.floorIndex) ?? []) {
      if (overlaps(flight, s, 0.2)) {
        issues.push({
          code: 'STAIR_NO_HEADROOM',
          severity: 'error',
          stage: 'stairs',
          objectIds: [id],
          message: `${id} flight passes under an upper-floor corridor slab (headroom violation).`,
        })
        break
      }
    }
  }
  return issues
}

/**
 * Lawbook §40/§49 tripwire: a stair flight must not pierce a NON-target
 * upper room's floor, and an in-room flight must stay inside its host.
 * The planner rejects these placements, but a shipped violation means the
 * reservation logic was bypassed — fail here rather than exporting a
 * stair to nowhere / through a neighbor's floor.
 */
export function validateStairClipping(rooms: Room[], stairPlans: StairPlan[]): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const rectOf = (r: Room) => ({
    minX: r.position.x - r.width / 2,
    maxX: r.position.x + r.width / 2,
    minZ: r.position.z - r.depth / 2,
    maxZ: r.position.z + r.depth / 2,
  })
  const overlaps = (
    a: { minX: number; maxX: number; minZ: number; maxZ: number },
    b: { minX: number; maxX: number; minZ: number; maxZ: number },
    pad: number,
  ): boolean =>
    a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad
  for (const p of stairPlans) {
    const id = `stairs_${p.link.lowerRoomId}_${p.link.upperRoomId}`
    const host = roomMap.get(p.hostRoomId)
    const upper = roomMap.get(p.link.upperRoomId)
    if (!host || !upper) continue
    const flight = flightRectOf(p.x, p.z, p.width, p.depth, p.axis)
    if (p.kind === 'inroom') {
      const hr = rectOf(host)
      if (
        flight.minX < hr.minX - SPATIAL_DEFAULTS.epsilon ||
        flight.maxX > hr.maxX + SPATIAL_DEFAULTS.epsilon ||
        flight.minZ < hr.minZ - SPATIAL_DEFAULTS.epsilon ||
        flight.maxZ > hr.maxZ + SPATIAL_DEFAULTS.epsilon
      ) {
        issues.push({
          code: 'STAIR_CLIPS_ROOM',
          severity: 'error',
          stage: 'stairs',
          objectIds: [id, host.id],
          message: `${id} in-room flight escapes its host ${host.id} (missing reservation).`,
        })
      }
    }
    for (const r of rooms) {
      if (r.floorIndex !== upper.floorIndex || r.id === upper.id) continue
      if (overlaps(flight, rectOf(r), 0.2)) {
        issues.push({
          code: 'STAIR_CLIPS_ROOM',
          severity: 'error',
          stage: 'stairs',
          objectIds: [id, r.id],
          message: `${id} flight pierces non-target upper room ${r.id} (stair to nowhere).`,
        })
        break
      }
    }
  }
  return issues
}

/** Lawbook §46: every stair penetration reserves and cuts its slab opening.
 * Per-plan coverage, not mere existence: each flight's own rect must sit
 * inside one of the room's holes. Existence checks false-passed hubs
 * hosting several stairs (one hole present, other flights piercing
 * intact slab around it). */
export function validateSlabOpenings(
  rooms: Room[],
  stairPlans: StairPlan[],
  slabHoles: Map<string, RoomSlabHoles>,
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  // Room-local rect covered by at least one hole (2 cm tolerance for the
  // world→local translation rounding at hole-cut time).
  const covered = (holes: Rect2D[] | undefined, rect: Rect2D): boolean => {
    if (!holes) return false
    const t = 0.02
    return holes.some(
      h =>
        rect.minX >= h.minX - t && rect.maxX <= h.maxX + t &&
        rect.minZ >= h.minZ - t && rect.maxZ <= h.maxZ + t,
    )
  }
  for (const p of stairPlans) {
    const id = `stairs_${p.link.lowerRoomId}_${p.link.upperRoomId}`
    const host = roomMap.get(p.hostRoomId)
    const upper = roomMap.get(p.link.upperRoomId)
    if (!upper) continue
    const flight = flightRectOf(p.x, p.z, p.width, p.depth, p.axis)
    if (p.kind === 'inroom' && host) {
      const local: Rect2D = {
        minX: flight.minX - host.position.x,
        maxX: flight.maxX - host.position.x,
        minZ: flight.minZ - host.position.z,
        maxZ: flight.maxZ - host.position.z,
      }
      if (!covered(slabHoles.get(p.hostRoomId)?.ceiling, local)) {
        issues.push({
          code: 'SLAB_NO_OPENING',
          severity: 'error',
          stage: 'geometry',
          objectIds: [id, p.hostRoomId],
          message: `${id} rises through an intact ${p.hostRoomId} ceiling (its flight has no stairwell hole).`,
        })
      }
    }
    const overlap: Rect2D = {
      minX: Math.max(flight.minX, upper.position.x - upper.width / 2) - upper.position.x,
      maxX: Math.min(flight.maxX, upper.position.x + upper.width / 2) - upper.position.x,
      minZ: Math.max(flight.minZ, upper.position.z - upper.depth / 2) - upper.position.z,
      maxZ: Math.min(flight.maxZ, upper.position.z + upper.depth / 2) - upper.position.z,
    }
    if (!covered(slabHoles.get(upper.id)?.floor, overlap)) {
      issues.push({
        code: 'SLAB_NO_OPENING',
        severity: 'error',
        stage: 'geometry',
        objectIds: [id, upper.id],
        message: `${id} arrives through an intact ${upper.id} floor (its arrival has no stairwell hole).`,
      })
    }
  }
  return issues
}

/**
 * Lawbook §45 arrival wall-band tripwire (mirrors the planner's
 * checkUpperArrival high-zone rule with identical shapes): the HIGH part
 * of a flight must not cross the upper room's boundary walls. Below, the
 * flight ducks under the wall bottom legally; up high the climber's head
 * is inside the wall band and no step-up clears a full-height wall.
 * Independent fence — a shipped violation means reservation bypass.
 */
export function validateStairArrivalWalls(rooms: Room[], stairPlans: StairPlan[]): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const overlaps = (
    a: { minX: number; maxX: number; minZ: number; maxZ: number },
    b: { minX: number; maxX: number; minZ: number; maxZ: number },
    pad: number,
  ): boolean =>
    a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad
  for (const p of stairPlans) {
    const id = `stairs_${p.link.lowerRoomId}_${p.link.upperRoomId}`
    const upper = roomMap.get(p.link.upperRoomId)
    if (!upper) continue
    const wallT = SPATIAL_DEFAULTS.wallThickness
    const bands = [
      { minX: upper.position.x - upper.width / 2, maxX: upper.position.x + upper.width / 2, minZ: upper.position.z + upper.depth / 2 - wallT, maxZ: upper.position.z + upper.depth / 2 },
      { minX: upper.position.x - upper.width / 2, maxX: upper.position.x + upper.width / 2, minZ: upper.position.z - upper.depth / 2, maxZ: upper.position.z - upper.depth / 2 + wallT },
      { minX: upper.position.x - upper.width / 2, maxX: upper.position.x - upper.width / 2 + wallT, minZ: upper.position.z - upper.depth / 2, maxZ: upper.position.z + upper.depth / 2 },
      { minX: upper.position.x + upper.width / 2 - wallT, maxX: upper.position.x + upper.width / 2, minZ: upper.position.z - upper.depth / 2, maxZ: upper.position.z + upper.depth / 2 },
    ]
    for (const high of flightHighRects(p)) {
      let hit = false
      for (const band of bands) {
        // Same 0.45 body-diameter pad as the planner: tread-center rects
        // must clear walls by the agent radius, not merely avoid touch.
        if (overlaps(high, band, 0.45)) {
          hit = true
          break
        }
      }
      if (hit) {
        issues.push({
          code: 'STAIR_ARRIVAL_WALL',
          severity: 'error',
          stage: 'stairs',
          objectIds: [id, upper.id],
          message: `${id} high flight crosses ${upper.id}'s boundary wall below its top — the arrival traps heads in solid wall.`,
        })
        break
      }
    }
  }
  return issues
}

/** Lawbook §47: every built stair carries landing (and shaft) geometry. */
export function validateStairsGeometry(stairs: StairsGeometry[]): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  for (const s of stairs) {
    if (s.landing.length === 0 || s.landing.every(m => m.vertices.length === 0)) {
      issues.push({
        code: 'STAIR_NO_LANDING',
        severity: 'error',
        stage: 'geometry',
        objectIds: [s.id],
        message: `${s.id} has no landing geometry (lawbook §47: every stair needs top/bottom landing space).`,
      })
    }
    if (s.kind === 'tower' && (!s.tower || s.tower.floor.vertices.length === 0 || s.tower.walls.length === 0)) {
      issues.push({
        code: 'STAIR_NO_SHAFT',
        severity: 'error',
        stage: 'geometry',
        objectIds: [s.id],
        message: `${s.id} tower shaft is missing floor or walls.`,
      })
    }
  }
  return issues
}

/** Lawbook §79: canonical geometry must be finite and well-formed. */
export function validateExportModel(level: {
  roomGeometry: GeometryDescription['rooms']
  corridorGeometry: GeometryDescription['corridors']
  stairs: StairsGeometry[]
}): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const finite = (v: Float32Array): boolean => {
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) return false
    }
    return true
  }
  const check = (id: string, part: string, mesh: MeshData) => {
    if (!finite(mesh.vertices) || !finite(mesh.normals) || !finite(mesh.uvs)) {
      issues.push({
        code: 'GEOMETRY_NONFINITE',
        severity: 'error',
        stage: 'geometry',
        objectIds: [id],
        message: `${id} ${part} contains NaN/Infinity mesh attributes.`,
      })
    }
    const count = mesh.vertices.length / 3
    if (!Number.isInteger(count) || mesh.normals.length !== count * 3 ||
        mesh.uvs.length !== count * 2 || mesh.indices.length % 3 !== 0 ||
        (count > 0 && mesh.indices.length === 0) ||
        mesh.indices.some(i => i >= count)) {
      issues.push({ code: 'GEOMETRY_INVALID_MESH', severity: 'error', stage: 'geometry',
        objectIds: [id], message: `${id} ${part} has inconsistent attributes or invalid triangle indices.` })
      return
    }
    const v = mesh.vertices, n = mesh.normals
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i] * 3, b = mesh.indices[i + 1] * 3, c = mesh.indices[i + 2] * 3
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2]
      const vx = v[c] - v[a], vy = v[c + 1] - v[a + 1], vz = v[c + 2] - v[a + 2]
      const dot = (uy * vz - uz * vy) * n[a] + (uz * vx - ux * vz) * n[a + 1] +
        (ux * vy - uy * vx) * n[a + 2]
      if (dot < -SPATIAL_DEFAULTS.epsilon) {
        issues.push({ code: 'GEOMETRY_INVALID_MESH', severity: 'error', stage: 'geometry',
          objectIds: [id], message: `${id} ${part} triangle ${i / 3} winding opposes its normal.` })
        break
      }
    }
  }
  for (const r of level.roomGeometry) {
    if (r.floor.length === 0 || r.floor.every(f => f.vertices.length === 0)) {
      issues.push({
        code: 'GEOMETRY_EMPTY_FLOOR',
        severity: 'error',
        stage: 'geometry',
        objectIds: [r.id],
        message: `${r.id} exists in the graph but has no floor surface (lawbook §75).`,
      })
    }
    r.floor.forEach((f, i) => check(r.id, `floor_${i}`, f))
    r.walls.forEach((w, i) => check(r.id, `wall_${i}`, w))
    r.ceiling.forEach((c, i) => check(r.id, `ceiling_${i}`, c))
  }
  for (const c of level.corridorGeometry) {
    check(c.id, 'floor', c.floor)
    c.walls.forEach((w, i) => check(c.id, `wall_${i}`, w))
    check(c.id, 'ceiling', c.ceiling)
  }
  for (const s of level.stairs) {
    for (const part of ['steps', 'risers', 'stringers', 'landing'] as const) {
      s[part].forEach((mesh, i) => check(s.id, `${part}_${i}`, mesh))
    }
    if (s.tower) {
      check(s.id, 'tower_floor', s.tower.floor)
      s.tower.walls.forEach((mesh, i) => check(s.id, `tower_wall_${i}`, mesh))
    }
  }
  return issues
}

/**
 * Lawbook §59-60: spatial traversal validation. Graph reachability is
 * necessary but not sufficient — this rasterizes per-floor walkability
 * (room interiors + corridor slabs + stair volumes + door throats) at a
 * 0.25 m cell size, links floors through stair arrivals, flood-fills from
 * Spawn, and requires every playable room to own reached cells.
 *
 * Cell size history: 0.5 m cells could not represent the narrowest legal
 * corridors (1.2 m clear width eroded to a 0.5 m walkable strip — exactly
 * one cell wide, so any centerline falling between cell centers rasterized
 * to zero walkable cells and valid levels failed as NAV_UNREACHABLE).
 * 0.25 m cells keep at least two walkable columns for every legal width.
 */
export function validateNavigationGrid(
  rooms: Room[],
  doorsByRoom: Map<string, DoorOpening[]>,
  corridors: Corridor[],
  stairPlans: StairPlan[],
  floorHeight: number,
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  if (rooms.length === 0) return issues
  // Lawbook §94: validation cost bounded. Huge maps (>1M cells at the
  // 0.25 m proof resolution) validate at 0.5 m instead: rooms keep ≥3
  // cells across their smallest legal interior, and corridors/doors/
  // stairs keep explicit centerline links (below), so reachability stays
  // exact while memory/time stay flat. Small maps are untouched.
  let CELL = 0.25
  const roomMap = new Map(rooms.map(r => [r.id, r]))

  // Bounds over everything placeable.
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  const grow = (x: number, z: number) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  for (const r of rooms) {
    grow(r.position.x - r.width / 2, r.position.z - r.depth / 2)
    grow(r.position.x + r.width / 2, r.position.z + r.depth / 2)
  }
  for (const c of corridors) {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    for (const p of pts) {
      grow(p.x - c.width, p.z - c.width)
      grow(p.x + c.width, p.z + c.width)
    }
  }
  if (Math.ceil(Math.max(1, maxX - minX) / CELL) * Math.ceil(Math.max(1, maxZ - minZ) / CELL) > 1000000) {
    CELL = 0.5
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL))
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL))
  const floors = [...new Set(rooms.map(r => r.floorIndex))].sort((a, b) => a - b)
  const at = (ix: number, iz: number): { x: number; z: number } => ({
    x: minX + (ix + 0.5) * CELL,
    z: minZ + (iz + 0.5) * CELL,
  })
  const walk: boolean[][][] = floors.map(() =>
    Array.from({ length: nx }, () => new Array<boolean>(nz).fill(false)),
  )
  // Centerline-link cells (see corridor loop below): cells a validated
  // corridor centerline passes through. The flood may step diagonally
  // between two link cells without the corner-cut guard — the underlying
  // centerline samples (CELL/2 apart) chain them, and reachability along
  // the chain is transitive, so the exemption is exact at any resolution.
  const link: boolean[][][] = floors.map(() =>
    Array.from({ length: nx }, () => new Array<boolean>(nz).fill(false)),
  )
  const fi = (f: number): number => floors.indexOf(f)
  const open = (f: number, ix: number, iz: number): void => {
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return
    walk[fi(f)][ix][iz] = true
  }
  // Cell index range covering an XZ rect (lawbook §94: validation cost
  // bounded). The old code scanned the WHOLE map grid per room/stair —
  // 80 M cell tests per attempt at UI-max area. Ranges are padded by one
  // cell so float boundaries cannot exclude a passing center; every
  // predicate below is a pure function of the center, so results are
  // identical, only the skipped cells (which always failed) are gone.
  const cellsIn = (
    loX: number, hiX: number, loZ: number, hiZ: number,
  ): { ix0: number; ix1: number; iz0: number; iz1: number } => ({
    ix0: Math.max(0, Math.floor((loX - minX) / CELL) - 1),
    ix1: Math.min(nx - 1, Math.floor((hiX - minX) / CELL) + 1),
    iz0: Math.max(0, Math.floor((loZ - minZ) / CELL) - 1),
    iz1: Math.min(nz - 1, Math.floor((hiZ - minZ) / CELL) + 1),
  })
  const inRoomInterior = (r: Room, x: number, z: number, erode: number): boolean =>
    x > r.position.x - r.width / 2 + erode &&
    x < r.position.x + r.width / 2 - erode &&
    z > r.position.z - r.depth / 2 + erode &&
    z < r.position.z + r.depth / 2 - erode

  // 1. Room interiors (eroded by wall + agent margin).
  for (const r of rooms) {
    const er = 0.45
    const { ix0, ix1, iz0, iz1 } = cellsIn(
      r.position.x - r.width / 2 + er, r.position.x + r.width / 2 - er,
      r.position.z - r.depth / 2 + er, r.position.z + r.depth / 2 - er,
    )
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const p = at(ix, iz)
        if (inRoomInterior(r, p.x, p.z, er)) open(r.floorIndex, ix, iz)
      }
    }
  }
  // 2. Corridor slabs (eroded by the agent body radius: the walkable
  // strip is what the 0.3 m-radius agent can occupy, not the wall face).
  // Plus an explicit centerline link per sample: narrow-but-legal
  // corridors (0.8 m → 0.1 m strip) rasterize to zero strip cells when the
  // line falls between cell centers, disconnecting what the agent fits
  // through. The centerline is traversable by construction (geometric
  // validators passed), so its cells open directly — same honesty class
  // as the door-throat bridges below. Corridors below agent diameter
  // stay dark (CORRIDOR_TOO_NARROW reports them elsewhere).
  for (const c of corridors) {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    const half = c.width / 2 - AGENT_BODY_RADIUS
    if (half <= 0) continue
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      const segLen = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2)
      const steps = Math.max(1, Math.ceil(segLen / (CELL / 2)))
      for (let s = 0; s <= steps; s++) {
        const cx = a.x + ((b.x - a.x) * s) / steps
        const cz = a.z + ((b.z - a.z) * s) / steps
        const gx = Math.floor((cx - minX) / CELL)
        const gz = Math.floor((cz - minZ) / CELL)
        open(c.floorIndex, gx, gz)
        if (gx >= 0 && gz >= 0 && gx < nx && gz < nz) link[fi(c.floorIndex)][gx][gz] = true
        const r = Math.ceil(half / CELL) + 1
        for (let ix = gx - r; ix <= gx + r; ix++) {
          for (let iz = gz - r; iz <= gz + r; iz++) {
            if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue
            const p = at(ix, iz)
            // Distance point-to-segment.
            const abx = b.x - a.x
            const abz = b.z - a.z
            const denom = abx * abx + abz * abz
            const t = denom < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / denom))
            const dist = Math.sqrt((p.x - (a.x + t * abx)) ** 2 + (p.z - (a.z + t * abz)) ** 2)
            if (dist <= half) open(c.floorIndex, ix, iz)
          }
        }
      }
    }
  }
  // 3. Door throats bridge room and corridor across the wall band.
  for (const [roomId, doors] of doorsByRoom) {
    const room = roomMap.get(roomId)
    if (!room) continue
    for (const d of doors) {
      const n = PORTAL_NORMALS[d.wallIndex] ?? PORTAL_NORMALS[0]
      const along = d.wallIndex % 2 === 0 ? { x: 1, z: 0 } : { x: 0, z: 1 }
      const halfSpan = Math.max(0.2, d.width / 2 - 0.15)
      for (let t = -0.7; t <= 0.7001; t += CELL / 2) {
        for (let s = -halfSpan; s <= halfSpan + 1e-6; s += CELL / 2) {
          const x = d.position.x + n.x * t + along.x * s
          const z = d.position.z + n.z * t + along.z * s
          const ix = Math.floor((x - minX) / CELL)
          const iz = Math.floor((z - minZ) / CELL)
          open(room.floorIndex, ix, iz)
        }
      }
    }
  }
  // 4. Stair volumes walkable on the host floor (+ tower shafts).
  // Lawbook §60 step 3 + §45: cells under a LOW stair section are NOT
  // walkable (the flight underside is solid — crossing under it clips).
  // Open only the entry approach (bottom 1.5 m), sections whose walking
  // surface already clears stair headroom, and the vertical-edge cells
  // (standing ON the steps is valid). Tower shaft floors stay fully open.
  const HEADROOM_WALK = SPATIAL_DEFAULTS.stair.minHeadroom // 2.05 m of surface height
  const verticalEdges: { f: [number, number, number]; t: [number, number, number] }[] = []
  for (const p of stairPlans) {
    const host = roomMap.get(p.hostRoomId)
    const upper = roomMap.get(p.link.upperRoomId)
    if (!host || !upper) continue
    const f = flightRectOf(p.x, p.z, p.width, p.depth, p.axis)
    // Entry end (low end) in world coords; d = distance along ascent.
    const ex = p.axis === 'z' ? p.x : p.x - p.dir * (p.depth / 2)
    const ez = p.axis === 'z' ? p.z - p.dir * (p.depth / 2) : p.z
    const dxn = p.axis === 'z' ? 0 : p.dir
    const dzn = p.axis === 'z' ? p.dir : 0
    const fr = cellsIn(f.minX, f.maxX, f.minZ, f.maxZ)
    for (let ix = fr.ix0; ix <= fr.ix1; ix++) {
      for (let iz = fr.iz0; iz <= fr.iz1; iz++) {
        const c = at(ix, iz)
        if (!(c.x > f.minX && c.x < f.maxX && c.z > f.minZ && c.z < f.maxZ)) continue
        const d = Math.max(0, Math.min(p.depth, (c.x - ex) * dxn + (c.z - ez) * dzn))
        const surface = (d / Math.max(p.depth, SPATIAL_DEFAULTS.epsilon)) * floorHeight
        if (d <= 1.5 || surface >= HEADROOM_WALK) {
          open(host.floorIndex, ix, iz)
        }
      }
    }
    // Vertical edge: flight center below <-> landing center above.
    const landing = landingRectOf({
      x: p.x, z: p.z, width: p.width, depth: p.depth,
      axis: p.axis, dir: p.dir, switchback: p.switchback,
      stepCount: p.stepCount, stepDepth: p.stepDepth, stepHeight: p.stepHeight,
    })
    const fx = Math.floor((p.x - minX) / CELL)
    const fz = Math.floor((p.z - minZ) / CELL)
    const lx = Math.floor(((landing.minX + landing.maxX) / 2 - minX) / CELL)
    const lz = Math.floor(((landing.minZ + landing.maxZ) / 2 - minZ) / CELL)
    open(host.floorIndex, fx, fz)
    open(upper.floorIndex, lx, lz)
    verticalEdges.push({ f: [host.floorIndex, fx, fz], t: [upper.floorIndex, lx, lz] })
    if (p.towerRect) {
      const t = p.towerRect
      const tr = cellsIn(t.minX, t.maxX, t.minZ, t.maxZ)
      for (let ix = tr.ix0; ix <= tr.ix1; ix++) {
        for (let iz = tr.iz0; iz <= tr.iz1; iz++) {
          const c = at(ix, iz)
          if (c.x > t.minX && c.x < t.maxX && c.z > t.minZ && c.z < t.maxZ) {
            open(host.floorIndex, ix, iz)
          }
        }
      }
    }
  }

  // 5. Flood fill from Spawn. 8-neighbourhood (diagonal corridors
  // rasterize as corner-touching chains) with no-corner-cutting: a
  // diagonal step is allowed only when at least one orthogonal side
  // cell is walkable, so the fill cannot squeeze through zero-width
  // wall corners.
  const spawn = rooms.find(r => r.type === 'spawn') ?? rooms[0]
  const si = fi(spawn.floorIndex)
  const reached: boolean[][][] = floors.map(() =>
    Array.from({ length: nx }, () => new Array<boolean>(nz).fill(false)),
  )
  const queue: [number, number, number][] = []
  // Seed: all walkable cells of the spawn room.
  {
    const er = 0.45
    const sr = cellsIn(
      spawn.position.x - spawn.width / 2 + er, spawn.position.x + spawn.width / 2 - er,
      spawn.position.z - spawn.depth / 2 + er, spawn.position.z + spawn.depth / 2 - er,
    )
    for (let ix = sr.ix0; ix <= sr.ix1; ix++) {
      for (let iz = sr.iz0; iz <= sr.iz1; iz++) {
        const p = at(ix, iz)
        if (walk[si][ix][iz] && inRoomInterior(spawn, p.x, p.z, er)) {
          reached[si][ix][iz] = true
          queue.push([si, ix, iz])
        }
      }
    }
  }
  const vEdgeTo = new Map<string, [number, number, number][]>()
  const vKey = (f: number, x: number, z: number): string => `${f}|${x}|${z}`
  for (const e of verticalEdges) {
    const k1 = vKey(e.f[0], e.f[1], e.f[2])
    const k2 = vKey(e.t[0], e.t[1], e.t[2])
    if (!vEdgeTo.has(k1)) vEdgeTo.set(k1, [])
    if (!vEdgeTo.has(k2)) vEdgeTo.set(k2, [])
    vEdgeTo.get(k1)!.push(e.t)
    vEdgeTo.get(k2)!.push(e.f)
  }
  while (queue.length > 0) {
    const [f, ix, iz] = queue.pop()!
    const next: [number, number, number][] = [
      [f, ix + 1, iz], [f, ix - 1, iz], [f, ix, iz + 1], [f, ix, iz - 1],
      ...(vEdgeTo.get(vKey(floors[f], ix, iz)) ?? []).map(
        ([ff, xx, zz]) => [fi(ff), xx, zz] as [number, number, number],
      ),
    ]
    // Diagonals with corner-cut guard (link-to-link centerline steps are
    // exempt: chained by construction, see above).
    const diagonals: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
    for (const [ax, az] of diagonals) {
      const jx = ix + ax
      const jz = iz + az
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue
      if (!walk[f][jx][jz] || reached[f][jx][jz]) continue
      if (!walk[f][ix + ax][iz] && !walk[f][ix][iz + az] && !(link[f][ix][iz] && link[f][jx][jz])) continue
      next.push([f, jx, jz])
    }
    for (const [nf, nx2, nz2] of next) {
      if (nf < 0 || nx2 < 0 || nz2 < 0 || nf >= floors.length || nx2 >= nx || nz2 >= nz) continue
      if (!walk[nf][nx2][nz2] || reached[nf][nx2][nz2]) continue
      reached[nf][nx2][nz2] = true
      queue.push([nf, nx2, nz2])
    }
  }

  // 6. Every playable room owns reached cells.
  for (const r of rooms) {
    const rfi = fi(r.floorIndex)
    let walkable = 0
    let hit = 0
    const er = 0.45
    const rr = cellsIn(
      r.position.x - r.width / 2 + er, r.position.x + r.width / 2 - er,
      r.position.z - r.depth / 2 + er, r.position.z + r.depth / 2 - er,
    )
    for (let ix = rr.ix0; ix <= rr.ix1; ix++) {
      for (let iz = rr.iz0; iz <= rr.iz1; iz++) {
        const p = at(ix, iz)
        if (walk[rfi][ix][iz] && inRoomInterior(r, p.x, p.z, er)) {
          walkable++
          if (reached[rfi][ix][iz]) hit++
        }
      }
    }
    if (walkable === 0) {
      issues.push({
        code: 'NAV_NO_SPAWN',
        severity: 'error',
        stage: 'navigation',
        objectIds: [r.id],
        message: `${r.id} has no walkable navigation cells (sealed interior).`,
      })
    } else if (hit === 0) {
      issues.push({
        code: 'NAV_UNREACHABLE_ROOM',
        severity: 'error',
        stage: 'navigation',
        objectIds: [r.id],
        message: `${r.id} is graph-connected but physically unreachable from Spawn on the navigation grid.`,
      })
    }
  }
  return issues
}

/**
 * Corridor side-wall capsules as plain data (same math as the walk-mode
 * analytic colliders, engine-independent): two wall-center capsules per
 * straight path segment. AABB rects cannot represent diagonal walls —
 * their bounds cover empty triangles and fake seals.
 */
export interface WallCapsuleRect {
  ax: number
  az: number
  bx: number
  bz: number
  half: number
}

export function corridorWallCapsules(
  points: { x: number; z: number }[],
  width: number,
  wallThickness: number,
): WallCapsuleRect[] {
  const capsules: WallCapsuleRect[] = []
  const center = width / 2 + wallThickness / 2
  const half = wallThickness / 2
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]
    const q = points[i + 1]
    const dx = q.x - p.x
    const dz = q.z - p.z
    const len = Math.sqrt(dx * dx + dz * dz)
    if (len < 1e-6) continue
    const ux = dx / len
    const uz = dz / len
    for (const side of [1, -1]) {
      const nx = -uz * side
      const nz = ux * side
      capsules.push({
        ax: p.x + nx * center,
        az: p.z + nz * center,
        bx: q.x + nx * center,
        bz: q.z + nz * center,
        half,
      })
    }
  }
  return capsules
}

/** Exact 2D segment-to-segment distance: canonical implementation lives
 * in `@/core/rules` (re-exported here for backwards compatibility). */
export { segSegDist2D }

/**
 * Lawbook §28/§52 runtime-faithful gate check: the player thread — the
 * doorway centerline ±0.6 m along the normal — must stay a full body
 * radius clear of every corridor wall volume. This is exactly what
 * walk-mode collision samples (centerline probes), so a passing gate is
 * a passable gate. Own-throat walls legally flank the thread (they run
 * parallel outside it) and never come within radius — no exclusions or
 * throat surgery needed.
 */
export function validatePortalSeals(
  rooms: Room[],
  doorsByRoom: Map<string, DoorOpening[]>,
  corridors: Corridor[],
  // Tower shaft walls seal gates exactly like corridor walls (walk-mode
  // collides with both), but towers plan AFTER corridors — a shaft parked
  // across a gate thread is invisible without this. Shaft walls run full
  // height (ground to parapet), so they threaten both the host floor and
  // the arrival floor above.
  stairPlans: StairPlan[] = [],
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const RADIUS = 0.4 // player body radius, mirroring walk collision
  const REACH = 0.6 // thread extent each way along the normal (probe range)
  const wallT = SPATIAL_DEFAULTS.wallThickness

  // Corridor wall capsules per floor.
  const corrWalls = new Map<number, WallCapsuleRect[]>()
  for (const c of corridors) {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    let list = corrWalls.get(c.floorIndex)
    if (!list) {
      list = []
      corrWalls.set(c.floorIndex, list)
    }
    list.push(...corridorWallCapsules(pts, c.width, wallT))
  }
  // Tower shaft walls: two sides + far end, on host AND arrival floors.
  const towerWalls = new Map<number, WallCapsuleRect[]>()
  const pushTower = (floor: number, w: WallCapsuleRect): void => {
    let list = towerWalls.get(floor)
    if (!list) {
      list = []
      towerWalls.set(floor, list)
    }
    list.push(w)
  }
  const tHalf = wallT / 2
  for (const p of stairPlans) {
    if (!p.towerRect) continue
    const host = roomMap.get(p.hostRoomId)
    const upper = roomMap.get(p.link.upperRoomId)
    if (!host || !upper) continue
    const t = p.towerRect
    const sideA = p.axis === 'x'
      ? { ax: t.minX, az: t.minZ + tHalf, bx: t.maxX, bz: t.minZ + tHalf }
      : { ax: t.minX + tHalf, az: t.minZ, bx: t.minX + tHalf, bz: t.maxZ }
    const sideB = p.axis === 'x'
      ? { ax: t.minX, az: t.maxZ - tHalf, bx: t.maxX, bz: t.maxZ - tHalf }
      : { ax: t.maxX - tHalf, az: t.minZ, bx: t.maxX - tHalf, bz: t.maxZ }
    // Far end (near end is the open mouth): +dir side of the rect.
    const far = p.axis === 'x'
      ? (p.dir > 0
        ? { ax: t.maxX - tHalf, az: t.minZ, bx: t.maxX - tHalf, bz: t.maxZ }
        : { ax: t.minX + tHalf, az: t.minZ, bx: t.minX + tHalf, bz: t.maxZ })
      : (p.dir > 0
        ? { ax: t.minX, az: t.maxZ - tHalf, bx: t.maxX, bz: t.maxZ - tHalf }
        : { ax: t.minX, az: t.minZ + tHalf, bx: t.maxX, bz: t.minZ + tHalf })
    for (const s of [sideA, sideB, far]) {
      const cap: WallCapsuleRect = { ...s, half: tHalf }
      pushTower(host.floorIndex, cap)
      pushTower(upper.floorIndex, cap)
    }
  }

  const threadBlocked = (ax: number, az: number, bx: number, bz: number, walls: WallCapsuleRect[]): boolean => {
    for (const w of walls) {
      // Capsule-to-thread: wall half thickness + body radius clearance.
      if (segSegDist2D(ax, az, bx, bz, w.ax, w.az, w.bx, w.bz) < w.half + RADIUS - 1e-9) return true
    }
    return false
  }

  for (const [roomId, doors] of doorsByRoom) {
    const room = roomMap.get(roomId)
    if (!room) continue
    for (const d of doors) {
      const n = PORTAL_NORMALS[d.wallIndex] ?? PORTAL_NORMALS[0]
      const ax = d.position.x - n.x * REACH
      const az = d.position.z - n.z * REACH
      const bx = d.position.x + n.x * REACH
      const bz = d.position.z + n.z * REACH
      const byCorridor = threadBlocked(ax, az, bx, bz, corrWalls.get(room.floorIndex) ?? [])
      const byTower = !byCorridor && threadBlocked(ax, az, bx, bz, towerWalls.get(room.floorIndex) ?? [])
      if (byCorridor || byTower) {
        issues.push({
          code: 'PORTAL_SEALED',
          severity: 'error',
          stage: 'doors',
          objectIds: [roomId],
          message: byTower
            ? `Gate in ${roomId} wall ${d.wallIndex} is sealed by a stair-tower wall crossing its doorway thread.`
            : `Gate in ${roomId} wall ${d.wallIndex} is sealed by a corridor wall crossing its doorway thread.`,
        })
      }
    }
  }
  return issues
}


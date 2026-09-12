import type { Room, Corridor, DoorOpening, Boundary, StairsGeometry } from '@/core/types'
import { MIN_CLEAR_WIDTH, MIN_CLEAR_HEIGHT, SPATIAL_DEFAULTS } from '@/core/rules'
import { flightRectOf, landingRectOf, type StairPlan } from '@/generator/vertical'
import { roomFootprintInBoundary } from '@/generator/boundary'

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
  | 'CORRIDOR_TOO_NARROW'
  | 'CORRIDOR_DEGENERATE'
  | 'CORRIDOR_SHORT_SEGMENT'
  | 'STAIR_NO_PLACEMENT'
  | 'STAIR_BAD_RISER'
  | 'STAIR_BAD_TREAD'
  | 'STAIR_TOO_NARROW'
  | 'STAIR_NO_ARRIVAL'
  | 'STAIR_NO_HEADROOM'
  | 'STAIR_NO_LANDING'
  | 'STAIR_NO_SHAFT'
  | 'SLAB_NO_OPENING'
  | 'NAV_UNREACHABLE_ROOM'
  | 'NAV_NO_SPAWN'
  | 'GEOMETRY_NONFINITE'
  | 'GEOMETRY_EMPTY_FLOOR'

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
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  for (const [roomId, doors] of doorsByRoom) {
    const room = roomMap.get(roomId)
    if (!room) continue
    const byWall = new Map<number, DoorOpening[]>()
    for (const d of doors) {
      if (d.width < MIN_CLEAR_WIDTH - SPATIAL_DEFAULTS.epsilon) {
        issues.push({
          code: 'PORTAL_TOO_NARROW',
          severity: 'error',
          stage: 'doors',
          objectIds: [roomId],
          message: `Gate in ${roomId} is ${d.width.toFixed(2)} m wide, below agent minimum ${MIN_CLEAR_WIDTH.toFixed(2)} m — the player cannot pass.`,
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
      if (d.height < MIN_CLEAR_HEIGHT - SPATIAL_DEFAULTS.epsilon) {
        issues.push({
          code: 'PORTAL_TOO_LOW',
          severity: 'error',
          stage: 'doors',
          objectIds: [roomId],
          message: `Gate in ${roomId} is ${d.height.toFixed(2)} m high, below agent minimum ${MIN_CLEAR_HEIGHT.toFixed(2)} m — the player cannot pass.`,
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
export function validateCorridors(corridors: Corridor[]): GenerationIssue[] {
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
}/** Lawbook §41-48: riser/tread/width lawfulness of every built stair. */
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

/** Lawbook §46: every stair penetration reserves and cuts its slab opening. */
export function validateSlabOpenings(
  rooms: Room[],
  stairPlans: StairPlan[],
  slabHoles: Map<string, { floor?: { minX: number; maxX: number; minZ: number; maxZ: number } | null; ceiling?: { minX: number; maxX: number; minZ: number; maxZ: number } | null }>,
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  for (const p of stairPlans) {
    const id = `stairs_${p.link.lowerRoomId}_${p.link.upperRoomId}`
    const upper = roomMap.get(p.link.upperRoomId)
    if (!upper) continue
    if (p.kind === 'inroom' && !slabHoles.get(p.hostRoomId)?.ceiling) {
      issues.push({
        code: 'SLAB_NO_OPENING',
        severity: 'error',
        stage: 'geometry',
        objectIds: [id, p.hostRoomId],
        message: `${id} rises through an intact ${p.hostRoomId} ceiling (missing stairwell hole).`,
      })
    }
    if (!slabHoles.get(upper.id)?.floor) {
      issues.push({
        code: 'SLAB_NO_OPENING',
        severity: 'error',
        stage: 'geometry',
        objectIds: [id, upper.id],
        message: `${id} arrives through an intact ${upper.id} floor (missing stairwell hole).`,
      })
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
  roomGeometry: { id: string; floor: { vertices: Float32Array }; walls: { vertices: Float32Array }[]; ceiling: { vertices: Float32Array } }[]
  corridorGeometry: { id: string; floor: { vertices: Float32Array }; walls: { vertices: Float32Array }[]; ceiling: { vertices: Float32Array } }[]
  stairs: { id: string; steps: { vertices: Float32Array }[] }[]
}): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const finite = (v: Float32Array): boolean => {
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) return false
    }
    return true
  }
  const check = (id: string, part: string, v: Float32Array) => {
    if (!finite(v)) {
      issues.push({
        code: 'GEOMETRY_NONFINITE',
        severity: 'error',
        stage: 'geometry',
        objectIds: [id],
        message: `${id} ${part} contains NaN/Infinity coordinates.`,
      })
    }
  }
  for (const r of level.roomGeometry) {
    if (r.floor.vertices.length === 0) {
      issues.push({
        code: 'GEOMETRY_EMPTY_FLOOR',
        severity: 'error',
        stage: 'geometry',
        objectIds: [r.id],
        message: `${r.id} exists in the graph but has no floor surface (lawbook §75).`,
      })
    }
    check(r.id, 'floor', r.floor.vertices)
    r.walls.forEach((w, i) => check(r.id, `wall_${i}`, w.vertices))
    check(r.id, 'ceiling', r.ceiling.vertices)
  }
  for (const c of level.corridorGeometry) {
    check(c.id, 'floor', c.floor.vertices)
    c.walls.forEach((w, i) => check(c.id, `wall_${i}`, w.vertices))
    check(c.id, 'ceiling', c.ceiling.vertices)
  }
  for (const s of level.stairs) {
    s.steps.forEach((st, i) => check(s.id, `step_${i}`, st.vertices))
  }
  return issues
}

/**
 * Lawbook §59-60: spatial traversal validation. Graph reachability is
 * necessary but not sufficient — this rasterizes per-floor walkability
 * (room interiors + corridor slabs + stair volumes + door throats) at a
 * 0.5 m cell size, links floors through stair arrivals, flood-fills from
 * Spawn, and requires every playable room to own reached cells.
 */
export function validateNavigationGrid(
  rooms: Room[],
  doorsByRoom: Map<string, DoorOpening[]>,
  corridors: Corridor[],
  stairPlans: StairPlan[],
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  if (rooms.length === 0) return issues
  const CELL = 0.5
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
  const fi = (f: number): number => floors.indexOf(f)
  const open = (f: number, ix: number, iz: number): void => {
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return
    walk[fi(f)][ix][iz] = true
  }
  const inRoomInterior = (r: Room, x: number, z: number, erode: number): boolean =>
    x > r.position.x - r.width / 2 + erode &&
    x < r.position.x + r.width / 2 - erode &&
    z > r.position.z - r.depth / 2 + erode &&
    z < r.position.z + r.depth / 2 - erode

  // 1. Room interiors (eroded by wall + agent margin).
  for (const r of rooms) {
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const p = at(ix, iz)
        if (inRoomInterior(r, p.x, p.z, 0.45)) open(r.floorIndex, ix, iz)
      }
    }
  }
  // 2. Corridor slabs (eroded by wall + margin).
  for (const c of corridors) {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    const half = c.width / 2 - 0.35
    if (half <= 0) continue
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      const segLen = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2)
      const steps = Math.max(1, Math.ceil(segLen / (CELL / 2)))
      for (let s = 0; s <= steps; s++) {
        const cx = a.x + ((b.x - a.x) * s) / steps
        const cz = a.z + ((b.z - a.z) * s) / steps
        const r = Math.ceil(half / CELL) + 1
        const gx = Math.floor((cx - minX) / CELL)
        const gz = Math.floor((cz - minZ) / CELL)
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
  const verticalEdges: { f: [number, number, number]; t: [number, number, number] }[] = []
  for (const p of stairPlans) {
    const host = roomMap.get(p.hostRoomId)
    const upper = roomMap.get(p.link.upperRoomId)
    if (!host || !upper) continue
    const f = flightRectOf(p.x, p.z, p.width, p.depth, p.axis)
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const c = at(ix, iz)
        if (c.x > f.minX && c.x < f.maxX && c.z > f.minZ && c.z < f.maxZ) {
          open(host.floorIndex, ix, iz)
        }
      }
    }
    // Vertical edge: flight center below <-> landing center above.
    const landing = landingRectOf({
      x: p.x, z: p.z, width: p.width, depth: p.depth,
      axis: p.axis, dir: p.dir, switchback: p.switchback,
      stepCount: p.stepCount, stepDepth: p.stepDepth,
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
      for (let ix = 0; ix < nx; ix++) {
        for (let iz = 0; iz < nz; iz++) {
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
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const p = at(ix, iz)
      if (walk[si][ix][iz] && inRoomInterior(spawn, p.x, p.z, 0.45)) {
        reached[si][ix][iz] = true
        queue.push([si, ix, iz])
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
    // Diagonals with corner-cut guard.
    const diagonals: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
    for (const [ax, az] of diagonals) {
      const jx = ix + ax
      const jz = iz + az
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue
      if (!walk[f][jx][jz] || reached[f][jx][jz]) continue
      if (!walk[f][ix + ax][iz] && !walk[f][ix][iz + az]) continue
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
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const p = at(ix, iz)
        if (walk[rfi][ix][iz] && inRoomInterior(r, p.x, p.z, 0.45)) {
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


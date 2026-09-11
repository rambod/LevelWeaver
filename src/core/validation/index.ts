import type { Room, Corridor, DoorOpening, Boundary } from '@/core/types'
import { MIN_CLEAR_WIDTH, MIN_CLEAR_HEIGHT, SPATIAL_DEFAULTS } from '@/core/rules'
import type { StairPlan } from '@/generator/vertical'

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
  | 'PORTAL_TOO_NARROW'
  | 'PORTAL_TOO_LOW'
  | 'PORTAL_CORNER_VIOLATION'
  | 'PORTAL_SEPARATION'
  | 'STAIR_NO_PLACEMENT'
  | 'STAIR_BAD_RISER'
  | 'STAIR_BAD_TREAD'
  | 'STAIR_TOO_NARROW'
  | 'STAIR_NO_ARRIVAL'

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
    const rect = rectOf(r)
    if (
      rect.minX < -boundary.width / 2 - eps ||
      rect.maxX > boundary.width / 2 + eps ||
      rect.minZ < -boundary.depth / 2 - eps ||
      rect.maxZ > boundary.depth / 2 + eps
    ) {
      issues.push({
        code: 'ROOM_OUT_OF_BOUNDS',
        severity: 'error',
        stage: 'placement',
        objectIds: [r.id],
        message: `${r.id} extends outside the ${boundary.width.toFixed(1)}x${boundary.depth.toFixed(1)} m boundary.`,
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

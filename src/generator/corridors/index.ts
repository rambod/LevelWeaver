import type { Room, Corridor, LevelConfig, Vec3 } from '@/core/types'
import { gateWidthFor, SPATIAL_DEFAULTS } from '@/core/rules'

interface Obstacle {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  floorIndex: number
}

// A built corridor segment as a capsule (segment + radius). Corridors must
// avoid each other, but fattening diagonal segments into AABBs blocks huge
// areas and sends later routes on wild detours; capsules follow the true
// shape instead.
interface CorridorCapsule {
  ax: number
  az: number
  bx: number
  bz: number
  halfWidth: number
  floorIndex: number
}

function distPointToSegment(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number
): number {
  const dx = bx - ax
  const dz = bz - az
  const lenSq = dx * dx + dz * dz
  if (lenSq < 1e-12) return Math.sqrt((px - ax) ** 2 + (pz - az) ** 2)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq))
  return Math.sqrt((px - (ax + t * dx)) ** 2 + (pz - (az + t * dz)) ** 2)
}

function orientation(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
}

function segmentsIntersect(
  a: Vec3, b: Vec3,
  c: { x: number; z: number }, d: { x: number; z: number }
): boolean {
  const o1 = orientation(a.x, a.z, b.x, b.z, c.x, c.z)
  const o2 = orientation(a.x, a.z, b.x, b.z, d.x, d.z)
  const o3 = orientation(c.x, c.z, d.x, d.z, a.x, a.z)
  const o4 = orientation(c.x, c.z, d.x, d.z, b.x, b.z)
  return o1 * o2 < 0 && o3 * o4 < 0
}

// Minimum clearance between segment a-b and capsule c (centerline c-d).
function segmentCapsuleClearance(
  a: Vec3, b: Vec3,
  c: CorridorCapsule
): number {
  if (segmentsIntersect(a, b, { x: c.ax, z: c.az }, { x: c.bx, z: c.bz })) return 0
  return Math.min(
    distPointToSegment(a.x, a.z, c.ax, c.az, c.bx, c.bz),
    distPointToSegment(b.x, b.z, c.ax, c.az, c.bx, c.bz),
    distPointToSegment(c.ax, c.az, a.x, a.z, b.x, b.z),
    distPointToSegment(c.bx, c.bz, a.x, a.z, b.x, b.z)
  )
}

// Corridor leaves each room perpendicular to the wall (straight stub) so
// the doorway tunnel is clean; only the middle part is routed.
const DOOR_STUB_LENGTH = 1.2

export function generateCorridors(
  rooms: Room[],
  config: LevelConfig
): Corridor[] {
  const corridors: Corridor[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const processed = new Set<string>()

  // Room obstacles, inflated so the corridor CENTERLINE keeps enough
  // clearance for its walls (width/2 + slab + slack).
  const roomBounds: (Obstacle & { roomId: string })[] = rooms.map(r => ({
    roomId: r.id,
    minX: r.position.x - r.width / 2 - config.corridorWidth / 2 - 0.5,
    maxX: r.position.x + r.width / 2 + config.corridorWidth / 2 + 0.5,
    minZ: r.position.z - r.depth / 2 - config.corridorWidth / 2 - 0.5,
    maxZ: r.position.z + r.depth / 2 + config.corridorWidth / 2 + 0.5,
    floorIndex: r.floorIndex,
  }))

  // True (uninflated) room rects for path smoothing.
  const roomRects: (Obstacle & { roomId: string })[] = rooms.map(r => ({
    roomId: r.id,
    minX: r.position.x - r.width / 2,
    maxX: r.position.x + r.width / 2,
    minZ: r.position.z - r.depth / 2,
    maxZ: r.position.z + r.depth / 2,
    floorIndex: r.floorIndex,
  }))

  interface PendingPair { a: Room; b: Room; dist: number; depth: number }
  const pairs: PendingPair[] = []

  for (const room of rooms) {
    for (const connId of room.connections) {
      const key = [room.id, connId].sort().join('-')
      if (processed.has(key)) continue
      processed.add(key)

      const targetRoom = roomMap.get(connId)
      if (!targetRoom) continue

      // Only connect rooms on same floor
      if (room.floorIndex !== targetRoom.floorIndex) continue

      pairs.push({
        a: room,
        b: targetRoom,
        dist: Math.sqrt(
          (room.position.x - targetRoom.position.x) ** 2 +
          (room.position.z - targetRoom.position.z) ** 2
        ),
        depth: 0,
      })
    }
  }

  // Route short connections first so stubs claim their space; long
  // corridors then route around what's already built instead of through it.
  pairs.sort((p, q) => p.dist - q.dist)

  // Already-built corridors act as capsules (per floor) so later routes
  // stay clear of them without blocking whole rectangles.
  const corridorObstacles: CorridorCapsule[] = []

  // Keys that actually produced a corridor (dedupes halves against direct
  // pairs and against each other).
  const realized = new Set<string>()
  for (const pair of pairs) {
    routePair(pair.a, pair.b, 0, new Set<string>())
  }

  return corridors

  // Route one topology edge, subdividing long arteries depth-first through
  // midpoint rooms. Depth-first (not queued) so an edge is never dropped
  // without its replacement hops realized in hand — queued designs allowed
  // circular coverage (A-B via A-M, A-M via A-B) that isolated rooms.
  // Ancestor endpoints are banned as midpoints so triangles can't
  // ping-pong subdivisions back into the grandparent edge.
  function routePair(a: Room, b: Room, depth: number, banned: Set<string>): void {
    const key = pairKey(a.id, b.id)
    if (realized.has(key)) return
    const dist = Math.sqrt(
      (a.position.x - b.position.x) ** 2 + (a.position.z - b.position.z) ** 2
    )
    if (depth < 2 && dist > SUBDIVIDE_LINK_OVER) {
      const mid = findMidpointRoom(a, b, rooms, banned)
      if (mid) {
        const nextBanned = new Set(banned)
        nextBanned.add(a.id)
        nextBanned.add(b.id)
        routePair(a, mid, depth + 1, nextBanned)
        routePair(mid, b, depth + 1, nextBanned)
        return
      }
    }
    const corridor = createCorridor(a, b, config, roomBounds, roomRects, corridorObstacles)
    // Intruding routes are re-realized as hops when possible: a corridor
    // through another room reads as a bug, two clean hops read as design.
    // Gets one extra depth level over length subdivision (cycles are still
    // impossible: banned ancestors accumulate every level).
    if (
      corridor &&
      depth < 3 &&
      middleIntrudesRooms(
        corridor.pathPoints && corridor.pathPoints.length > 0 ? corridor.pathPoints : [corridor.startPos, corridor.endPos],
        roomRects,
        corridor.width,
        corridor.floorIndex,
        corridor.startPos,
        corridor.endPos
      )
    ) {
      const mid = findMidpointRoom(a, b, rooms, new Set([...banned, a.id, b.id]))
      if (mid && mid.id !== a.id && mid.id !== b.id) {
        const nextBanned = new Set(banned)
        nextBanned.add(a.id)
        nextBanned.add(b.id)
        routePair(a, mid, depth + 1, nextBanned)
        routePair(mid, b, depth + 1, nextBanned)
        return
      }
    }
    if (corridor) {
      corridors.push(corridor)
      realized.add(key)
      addCorridorObstacles(corridorObstacles, corridor)
    }
  }
}

function pairKey(aId: string, bId: string): string {
  return [aId, bId].sort().join('-')
}

// Same-floor room (not an endpoint, not banned) near the link's midpoint
// that a long link can hop through. Nearest to the midpoint wins.
function findMidpointRoom(a: Room, b: Room, rooms: Room[], banned: Set<string>): Room | null {
  const midX = (a.position.x + b.position.x) / 2
  const midZ = (a.position.z + b.position.z) / 2
  let best: Room | null = null
  let bestScore = Infinity
  for (const r of rooms) {
    if (r.id === a.id || r.id === b.id) continue
    if (banned.has(r.id)) continue
    if (r.floorIndex !== a.floorIndex) continue
    const toSeg = distPointToSegment(r.position.x, r.position.z, a.position.x, a.position.z, b.position.x, b.position.z)
    if (toSeg > 12) continue
    const toMid = Math.sqrt((r.position.x - midX) ** 2 + (r.position.z - midZ) ** 2)
    if (toMid < bestScore || (toMid === bestScore && best !== null && r.id < best.id)) {
      best = r
      bestScore = toMid
    }
  }
  return best
}

// Links longer than this (room-center distance) are realized as hops.
// Set so links that must cross other rooms subdivide instead of failing
// into straight lines through them.
const SUBDIVIDE_LINK_OVER = 24

function addCorridorObstacles(list: CorridorCapsule[], corridor: Corridor): void {
  const pts = corridor.pathPoints && corridor.pathPoints.length > 0
    ? corridor.pathPoints
    : [corridor.startPos, corridor.endPos]
  // Generous radius: parallel corridors must read as separate spaces,
  // not one tangled bundle.
  const halfWidth = corridor.width / 2 + 0.8
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x
    const dz = pts[i + 1].z - pts[i].z
    if (dx * dx + dz * dz < 1e-8) continue
    list.push({
      ax: pts[i].x,
      az: pts[i].z,
      bx: pts[i + 1].x,
      bz: pts[i + 1].z,
      halfWidth,
      floorIndex: corridor.floorIndex,
    })
  }
}

function createCorridor(
  roomA: Room,
  roomB: Room,
  config: LevelConfig,
  roomBounds: Obstacle[],
  roomRects: Obstacle[],
  corridorObstacles: CorridorCapsule[]
): Corridor | null {
  // Door points on the room walls facing each other. The clamp matches
  // core/generation's door computation exactly so the corridor mouth and
  // the wall opening land on the same center with the same width.
  const startDoor = findDoorPosition(roomA, roomB.position, config.corridorWidth, config)
  const endDoor = findDoorPosition(roomB, roomA.position, config.corridorWidth, config)

  if (!startDoor || !endDoor) return null

  const startPos: Vec3 = { x: startDoor.x, y: roomA.position.y, z: startDoor.z }
  const endPos: Vec3 = { x: endDoor.x, y: roomB.position.y, z: endDoor.z }

  const distance = Math.sqrt(
    (endPos.x - startPos.x) ** 2 + (endPos.z - startPos.z) ** 2
  )

  // Only skip nearly-coincident rooms. Short corridors between close rooms
  // are legitimate; skipping them would leave door openings with no
  // connecting geometry behind them.
  if (distance < 0.5) return null

  // Perpendicular stubs out of each doorway; the routed middle part stays
  // clear of both endpoint rooms.
  const stubA: Vec3 = {
    x: startPos.x + startDoor.nx * DOOR_STUB_LENGTH,
    y: startPos.y,
    z: startPos.z + startDoor.nz * DOOR_STUB_LENGTH,
  }
  const stubB: Vec3 = {
    x: endPos.x + endDoor.nx * DOOR_STUB_LENGTH,
    y: endPos.y,
    z: endPos.z + endDoor.nz * DOOR_STUB_LENGTH,
  }

  // Find path avoiding other rooms (and built corridors) using A*.
  // Endpoint rooms stay obstacles too: only the 2.2m door zones around the
  // stubs are exempt, so routes can't cut through the rooms they connect.
  const routed = findPathAStar(stubA, stubB, roomBounds, corridorObstacles, roomA.floorIndex)

  let middle = routed && routed.length >= 2 ? routed : [stubA, stubB]

  // Post-check: if the routed middle still cuts through rooms (search
  // budget exhausted on a long artery), retry the offset fallback
  // explicitly before accepting it.
  if (middleIntrudesRooms(middle, roomRects, config.corridorWidth, roomA.floorIndex, startPos, endPos)) {
    const retry = findPathSimple(
      stubA,
      stubB,
      roomBounds.filter(b => b.floorIndex === roomA.floorIndex),
      corridorObstacles.filter(b => b.floorIndex === roomA.floorIndex)
    )
    // Accept the retry only if it is actually clean.
    if (!middleIntrudesRooms(retry, roomRects, config.corridorWidth, roomA.floorIndex, startPos, endPos)) {
      middle = retry
    }
  }

  // String-pulling: greedily skip waypoints while the straight shortcut
  // stays clear. Removes the 1m-grid staircase zigzag that used to turn
  // into ribbed wall artifacts.
  const smoothed = smoothPath(middle, roomRects, corridorObstacles, roomA.floorIndex, config.corridorWidth, roomA.id, roomB.id, startPos, endPos)

  // Stitch door -> stub -> routed middle -> stub -> door.
  const path = [startPos, ...smoothed, endPos]

  return {
    id: `corridor_${roomA.id}_${roomB.id}`,
    startRoomId: roomA.id,
    endRoomId: roomB.id,
    startPos,
    endPos,
    width: config.corridorWidth,
    floorIndex: roomA.floorIndex,
    pathPoints: path,
  }
}

export interface DoorSpot {
  x: number
  z: number
  /** Outward wall normal (unit, axis aligned). */
  nx: number
  nz: number
}

function findDoorPosition(room: Room, targetPos: { x: number; z: number }, corridorWidth: number, config?: LevelConfig): DoorSpot | null {
  const halfW = room.width / 2
  const halfD = room.depth / 2
  const relX = targetPos.x - room.position.x
  const relZ = targetPos.z - room.position.z
  const absX = Math.abs(relX)
  const absZ = Math.abs(relZ)

  // Opening matches the gate the wall cutter will produce (lawbook §28:
  // corridor mouth and door hole must share one center AND one width).
  // Falls back to the legacy corridor-width rule when no config is given.
  const wallLength = absX > absZ ? room.depth : room.width
  const opening = config
    ? gateWidthFor(config, wallLength, corridorWidth)
    : Math.max(1.0, Math.min(corridorWidth, wallLength - 0.6))
  if (opening <= 0.05) return null // wall far too short: no fake mouth
  const margin = SPATIAL_DEFAULTS.doorCornerMargin
  const clampRel = (v: number, half: number) =>
    Math.max(-half + opening / 2 + margin, Math.min(half - opening / 2 - margin, v))

  // Determine which wall face the target is closest to
  let doorX = room.position.x
  let doorZ = room.position.z
  let nx = 0
  let nz = 0

  if (absX > absZ) {
    // Connect to X walls (left/right)
    if (relX > 0) {
      // Right wall (+X)
      doorX = room.position.x + halfW
      doorZ = room.position.z + clampRel(relZ, halfD)
      nx = 1
    } else {
      // Left wall (-X)
      doorX = room.position.x - halfW
      doorZ = room.position.z + clampRel(relZ, halfD)
      nx = -1
    }
  } else {
    // Connect to Z walls (front/back)
    if (relZ > 0) {
      // Back wall (+Z)
      doorZ = room.position.z + halfD
      doorX = room.position.x + clampRel(relX, halfW)
      nz = 1
    } else {
      // Front wall (-Z)
      doorZ = room.position.z - halfD
      doorX = room.position.x + clampRel(relX, halfW)
      nz = -1
    }
  }

  return { x: doorX, z: doorZ, nx, nz }
}

interface GridNode {
  x: number
  z: number
  g: number // cost from start
  f: number // estimated total cost
  parent: GridNode | null
}

function findPathAStar(
  start: Vec3,
  end: Vec3,
  roomBounds: Obstacle[],
  capsules: CorridorCapsule[],
  floorIndex: number
): Vec3[] | null {
  const cellSize = 1.0 // 1m grid resolution

  // All same-floor bounds stay obstacles, INCLUDING the endpoint rooms:
  // only the door zones around the stubs are walkable, so the routed
  // middle can't cut through the very rooms it connects.
  const floorRooms = roomBounds.filter(b => b.floorIndex === floorIndex)
  const floorCaps = capsules.filter(b => b.floorIndex === floorIndex)
  const inDoorZone = (x: number, z: number): boolean => {
    const ds = Math.sqrt((x - start.x) ** 2 + (z - start.z) ** 2)
    const de = Math.sqrt((x - end.x) ** 2 + (z - end.z) ** 2)
    return ds < 2.2 || de < 2.2
  }
  const blocked = (x: number, z: number): boolean => {
    if (inDoorZone(x, z)) return false
    if (isPointBlocked({ x, y: 0, z }, floorRooms)) return true
    for (const cap of floorCaps) {
      if (distPointToSegment(x, z, cap.ax, cap.az, cap.bx, cap.bz) < cap.halfWidth) return true
    }
    return false
  }

  // Check if start or end are inside obstacles (shouldn't happen but safety).
  // Door zones are exempt: stubs begin just outside their room walls,
  // inside the inflated bounds.
  if (blocked(start.x, start.z) || blocked(end.x, end.z)) {
    // Fallback to direct path
    return [start, end]
  }

  // A* on grid
  const openSet = new Map<string, GridNode>()
  const closedSet = new Set<string>()
  
  const startNode: GridNode = {
    x: Math.round(start.x / cellSize),
    z: Math.round(start.z / cellSize),
    g: 0,
    f: heuristic(start, end),
    parent: null
  }
  
  const endNodeKey = `${Math.round(end.x / cellSize)},${Math.round(end.z / cellSize)}`
  openSet.set(`${startNode.x},${startNode.z}`, startNode)

  const directions = [
    { dx: 1, dz: 0, cost: 1 },
    { dx: -1, dz: 0, cost: 1 },
    { dx: 0, dz: 1, cost: 1 },
    { dx: 0, dz: -1, cost: 1 },
    { dx: 1, dz: 1, cost: 1.414 },
    { dx: 1, dz: -1, cost: 1.414 },
    { dx: -1, dz: 1, cost: 1.414 },
    { dx: -1, dz: -1, cost: 1.414 },
  ]

  let iterations = 0
  // Scale the search budget with route length: long arteries need it.
  const straightDist = Math.sqrt((end.x - start.x) ** 2 + (end.z - start.z) ** 2)
  const maxIterations = Math.min(20000, 4000 + Math.round(straightDist * 120))

  while (openSet.size > 0 && iterations < maxIterations) {
    iterations++

    // Find node with lowest f
    let current: GridNode | null = null
    let currentKey = ''
    for (const [key, node] of openSet) {
      if (!current || node.f < current.f) {
        current = node
        currentKey = key
      }
    }

    if (!current) break

    if (currentKey === endNodeKey) {
      // Reconstruct path
      return reconstructPath(current, start, end, cellSize)
    }

    openSet.delete(currentKey)
    closedSet.add(currentKey)

    for (const dir of directions) {
      const nx = current.x + dir.dx
      const nz = current.z + dir.dz
      const neighborKey = `${nx},${nz}`

      if (closedSet.has(neighborKey)) continue

      const worldX = nx * cellSize
      const worldZ = nz * cellSize

      // Check bounds (door zones exempt so paths can leave the stubs)
      if (blocked(worldX, worldZ)) continue

      const tentativeG = current.g + dir.cost
      const existing = openSet.get(neighborKey)

      if (!existing || tentativeG < existing.g) {
        const neighbor: GridNode = {
          x: nx,
          z: nz,
          g: tentativeG,
          f: tentativeG + heuristic({ x: worldX, y: 0, z: worldZ }, end),
          parent: current
        }
        openSet.set(neighborKey, neighbor)
      }
    }
  }

  // A* failed, try simplified approach
  return findPathSimple(start, end, floorRooms, floorCaps)
}

function heuristic(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2)
}

function isPointBlocked(point: Vec3, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }[]): boolean {
  for (const b of bounds) {
    if (point.x >= b.minX && point.x <= b.maxX &&
        point.z >= b.minZ && point.z <= b.maxZ) {
      return true
    }
  }
  return false
}

function reconstructPath(node: GridNode, start: Vec3, end: Vec3, cellSize: number): Vec3[] {
  const path: Vec3[] = []
  let current: GridNode | null = node
  
  while (current) {
    path.unshift({ x: current.x * cellSize, y: start.y, z: current.z * cellSize })
    current = current.parent
  }
  
  // Ensure exact start/end (no simplification here: the global
  // string-pulling pass smooths the stitched path instead).
  path[0] = start
  path[path.length - 1] = end

  return path
}

// String-pulling path smoothing: greedily replace waypoint runs with
// straight shortcuts while they stay clear. Turns the 1m-grid A*
// staircase into clean diagonals with few joints.
function smoothPath(
  points: Vec3[],
  roomRects: (Obstacle & { roomId?: string })[],
  corridorObstacles: CorridorCapsule[],
  floorIndex: number,
  corridorWidth: number,
  startRoomId: string,
  endRoomId: string,
  doorA: Vec3,
  doorB: Vec3
): Vec3[] {
  if (points.length <= 2) return points

  const rooms = roomRects.filter(b => b.floorIndex === floorIndex)
  const built = corridorObstacles.filter(b => b.floorIndex === floorIndex)
  const roomMargin = corridorWidth / 2 + 0.35

  const result: Vec3[] = [points[0]]
  let i = 0
  while (i < points.length - 1) {
    let j = points.length - 1
    while (j > i + 1 && !segmentClear(points[i], points[j], rooms, built, roomMargin, startRoomId, endRoomId, doorA, doorB)) {
      j--
    }
    result.push(points[j])
    i = j
  }
  return result
}

function segmentClear(
  a: Vec3,
  b: Vec3,
  rooms: (Obstacle & { roomId?: string })[],
  built: CorridorCapsule[],
  roomMargin: number,
  startRoomId: string,
  endRoomId: string,
  doorA: Vec3,
  doorB: Vec3
): boolean {
  const len = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2)
  if (len < 1e-6) return true
  const ux = (b.x - a.x) / len
  const uz = (b.z - a.z) / len

  for (const r of rooms) {
    const isEndpoint = r.roomId === startRoomId || r.roomId === endRoomId
    if (!isEndpoint) {
      // Strict: any touch of the margin-expanded rect blocks.
      if (lineIntersectsRect(a, b, {
        minX: r.minX - roomMargin,
        maxX: r.maxX + roomMargin,
        minZ: r.minZ - roomMargin,
        maxZ: r.maxZ + roomMargin,
      })) return false
      continue
    }
    // Endpoint room: strict everywhere EXCEPT within 3.5m of its own
    // doorway, where leaving the expanded zone (door exit) and arriving
    // (door approach) are legal but entering the true room is not.
    const door = r.roomId === startRoomId ? doorA : doorB
    const aAtDoor = Math.sqrt((a.x - door.x) ** 2 + (a.z - door.z) ** 2) < 3.5
    const bAtDoor = Math.sqrt((b.x - door.x) ** 2 + (b.z - door.z) ** 2) < 3.5
    let ts = 0
    let te = len
    if (aAtDoor) ts = Math.min(3.5, len / 2)
    if (bAtDoor) te = Math.max(len / 2, len - 3.5)
    if (te > ts + 0.01) {
      const m1 = { x: a.x + ux * ts, y: 0, z: a.z + uz * ts }
      const m2 = { x: a.x + ux * te, y: 0, z: a.z + uz * te }
      if (lineIntersectsRect(m1, m2, {
        minX: r.minX - roomMargin,
        maxX: r.maxX + roomMargin,
        minZ: r.minZ - roomMargin,
        maxZ: r.maxZ + roomMargin,
      })) return false
    }
    // Door-side caps: may leave the true room, never enter it.
    if (ts > 0.01) {
      const capEnd = { x: a.x + ux * ts, y: 0, z: a.z + uz * ts }
      if (segmentEntersRect(a, capEnd, r, 0.4)) return false
    }
    if (te < len - 0.01) {
      const capStart = { x: a.x + ux * te, y: 0, z: a.z + uz * te }
      if (segmentEntersRect(capStart, b, r, 0.4)) return false
    }
  }
  for (const c of built) {
    if (segmentCapsuleClearance(a, b, c) < c.halfWidth + 0.1) return false
  }
  return true
}

// True when the segment ENTERS the (margin-expanded) rect: starting inside
// and leaving is allowed (door exit), ending inside or crossing is not.
function segmentEntersRect(
  a: Vec3,
  b: Vec3,
  rect: { minX: number; maxX: number; minZ: number; maxZ: number },
  margin: number
): boolean {
  const r = {
    minX: rect.minX - margin,
    maxX: rect.maxX + margin,
    minZ: rect.minZ - margin,
    maxZ: rect.maxZ + margin,
  }
  const aIn = a.x >= r.minX && a.x <= r.maxX && a.z >= r.minZ && a.z <= r.maxZ
  const bIn = b.x >= r.minX && b.x <= r.maxX && b.z >= r.minZ && b.z <= r.maxZ
  if (aIn && bIn) return true
  if (aIn && !bIn) return false
  if (!aIn && bIn) return true
  return lineIntersectsRect(a, b, r)
}

function findPathSimple(
  start: Vec3,
  end: Vec3,
  roomBounds: Obstacle[],
  capsules: CorridorCapsule[]
): Vec3[] {
  // Door-zone-aware clearance: samples within 2.2m of either stub live in
  // the stub's own inflated doorway zone and must not poison candidates
  // (the old exact rect checks rejected EVERYTHING starting inside the
  // inflated endpoint bounds, degenerating to a direct line through rooms).
  const clear = (path: Vec3[]): boolean =>
    simplePathClear(path, roomBounds, capsules, start, end)

  // Try direct
  if (clear([start, end])) {
    return [start, end]
  }

  // Try L-shapes
  const path1 = [start, { x: end.x, y: start.y, z: start.z }, end]
  if (clear(path1)) return simplifyPath(path1)

  const path2 = [start, { x: start.x, y: start.y, z: end.z }, end]
  if (clear(path2)) return simplifyPath(path2)

  // Try offsets (wide range: long routes may need to swing far around).
  const offsets = [4, -4, 7, -7, 10, -10, 15, -15, 20, -20, 25, -25]
  for (const offset of offsets) {
    const path3 = [start, { x: start.x + offset, y: start.y, z: start.z }, { x: start.x + offset, y: start.y, z: end.z }, { x: end.x, y: start.y, z: end.z }, end]
    if (clear(path3)) return simplifyPath(path3)

    const path4 = [start, { x: start.x, y: start.y, z: start.z + offset }, { x: end.x, y: start.y, z: start.z + offset }, { x: end.x, y: start.y, z: end.z }, end]
    if (clear(path4)) return simplifyPath(path4)
  }

  return [start, end] // Last resort
}

function simplePathClear(
  path: Vec3[],
  roomBounds: Obstacle[],
  capsules: CorridorCapsule[],
  start: Vec3,
  end: Vec3
): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i]
    const q = path[i + 1]
    const segLen = Math.sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2)
    const steps = Math.max(1, Math.ceil(segLen / 0.5))
    for (let s = 0; s <= steps; s++) {
      const x = p.x + ((q.x - p.x) * s) / steps
      const z = p.z + ((q.z - p.z) * s) / steps
      // Door zones around both stubs are exempt.
      if (Math.hypot(x - start.x, z - start.z) < 2.2) continue
      if (Math.hypot(x - end.x, z - end.z) < 2.2) continue
      if (isPointBlocked({ x, y: 0, z }, roomBounds)) return false
      for (const c of capsules) {
        if (distPointToSegment(x, z, c.ax, c.az, c.bx, c.bz) < c.halfWidth) return false
      }
    }
  }
  return true
}

// Sampling intrusion test for a routed middle: does any sample come closer
// than (width/2 - tolerance) to a non-endpoint room, ignoring the stub
// zones around both doors?
function middleIntrudesRooms(
  middle: Vec3[],
  roomRects: Obstacle[],
  corridorWidth: number,
  floorIndex: number,
  startPos: Vec3,
  endPos: Vec3
): boolean {
  const rooms = roomRects.filter(b => b.floorIndex === floorIndex)
  for (let i = 0; i < middle.length - 1; i++) {
    const p = middle[i]
    const q = middle[i + 1]
    const segLen = Math.sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2)
    const steps = Math.max(1, Math.ceil(segLen / 0.5))
    for (let s = 0; s <= steps; s++) {
      const x = p.x + ((q.x - p.x) * s) / steps
      const z = p.z + ((q.z - p.z) * s) / steps
      // Stub zones around both doors are allowed to touch rooms.
      if (Math.hypot(x - startPos.x, z - startPos.z) < 2.5) continue
      if (Math.hypot(x - endPos.x, z - endPos.z) < 2.5) continue
      for (const r of rooms) {
        const dx = Math.max(r.minX - x, 0, x - r.maxX)
        const dz = Math.max(r.minZ - z, 0, z - r.maxZ)
        if (Math.sqrt(dx * dx + dz * dz) < corridorWidth / 2 - 0.5) return true
      }
    }
  }
  return false
}

function lineIntersectsRect(
  a: Vec3,
  b: Vec3,
  rect: { minX: number; maxX: number; minZ: number; maxZ: number }
): boolean {
  const dx = b.x - a.x
  const dz = b.z - a.z

  if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return false

  let t0 = 0
  let t1 = 1

  // X bounds
  if (Math.abs(dx) > 0.001) {
    const tMinX = (rect.minX - a.x) / dx
    const tMaxX = (rect.maxX - a.x) / dx
    t0 = Math.max(t0, Math.min(tMinX, tMaxX))
    t1 = Math.min(t1, Math.max(tMinX, tMaxX))
    if (t0 > t1) return false
  } else if (a.x < rect.minX || a.x > rect.maxX) {
    return false
  }

  // Z bounds
  if (Math.abs(dz) > 0.001) {
    const tMinZ = (rect.minZ - a.z) / dz
    const tMaxZ = (rect.maxZ - a.z) / dz
    t0 = Math.max(t0, Math.min(tMinZ, tMaxZ))
    t1 = Math.min(t1, Math.max(tMinZ, tMaxZ))
    if (t0 > t1) return false
  } else if (a.z < rect.minZ || a.z > rect.maxZ) {
    return false
  }

  return t0 <= 1 && t1 >= 0 && t1 > t0
}

function simplifyPath(path: Vec3[]): Vec3[] {
  if (path.length <= 2) return path
  
  const result: Vec3[] = [path[0]]
  
  for (let i = 1; i < path.length - 1; i++) {
    const prev = result[result.length - 1]
    const curr = path[i]
    const next = path[i + 1]
    
    const dx1 = curr.x - prev.x
    const dz1 = curr.z - prev.z
    const dx2 = next.x - curr.x
    const dz2 = next.z - curr.z
    
    const cross = dx1 * dz2 - dz1 * dx2
    if (Math.abs(cross) > 0.01) {
      result.push(curr)
    }
  }
  
  result.push(path[path.length - 1])
  return result
}

// NOTE: corridor mesh construction lives in one place only:
// `@/generator/geometry` (`generateCorridorGeometry`). The duplicated
// geometry builders that used to live in this file were removed so the
// two implementations cannot drift apart. Canonical types are re-exported
// here for backwards compatibility with any external importers.
export type { CorridorGeometry, MeshData } from '@/core/types'

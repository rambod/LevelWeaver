import type { Room, Corridor, LevelConfig, Vec3 } from '@/core/types'
import { gateWidthFor, segSegDist2D, SPATIAL_DEFAULTS } from '@/core/rules'

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
  config: LevelConfig,
  // Lawbook §70 repair step 2 ("choose another portal wall"), used ONLY
  // by the best-of-two variant pass: when true, edges whose preferred
  // mouths route foul retry through alternate walls before surrendering.
  // Default false = legacy facing-wall mouths, byte-identical to V0.1.0.
  allowAltMouths = false,
): Corridor[] {
  const corridors: Corridor[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const processed = new Set<string>()

  // Room obstacles, inflated so the corridor CENTERLINE keeps enough
  // clearance for its walls AND a passing player (lawbook §33/§101:
  // corridorWidth/2 + wallThickness + safetyMargin, where the margin
  // covers the player body at neighboring doorways, not just slack).
  const routePad = config.corridorWidth / 2 + SPATIAL_DEFAULTS.wallThickness + 0.45
  const roomBounds: (Obstacle & { roomId: string })[] = rooms.map(r => ({
    roomId: r.id,
    minX: r.position.x - r.width / 2 - routePad,
    maxX: r.position.x + r.width / 2 + routePad,
    minZ: r.position.z - r.depth / 2 - routePad,
    maxZ: r.position.z + r.depth / 2 + routePad,
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
  // stay clear of them without blocking whole rectangles. Door approach
  // volumes join them (lawbook §56): every realized mouth reserves its
  // thread (±0.8 m along the normal) plus ribbon + seal margin, so later
  // corridors can never squeeze past a foreign gate within sealing range.
  const corridorObstacles: CorridorCapsule[] = []
  const WALL_NORMALS = [
    { x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 },
  ]
  const claimDoorVolume = (corridor: Corridor): void => {
    const ends = [
      { pos: corridor.startPos, door: corridor.startDoor },
      { pos: corridor.endPos, door: corridor.endDoor },
    ]
    for (const end of ends) {
      if (!end.door) continue
      const n = WALL_NORMALS[end.door.wallIndex] ?? WALL_NORMALS[0]
      corridorObstacles.push({
        ax: end.pos.x - n.x * 0.8,
        az: end.pos.z - n.z * 0.8,
        bx: end.pos.x + n.x * 0.8,
        bz: end.pos.z + n.z * 0.8,
        halfWidth: corridor.width / 2 + SPATIAL_DEFAULTS.wallThickness + 0.55,
        floorIndex: corridor.floorIndex,
      })
    }
  }

  // Claimed mouths per room (wall, center, half-width): parallel corridors
  // spread along walls instead of sharing one hole (§27, §34).
  const claimedByRoom = new Map<string, ClaimedMouth[]>()
  const claimsOf = (roomId: string): ClaimedMouth[] => {
    let list = claimedByRoom.get(roomId)
    if (!list) {
      list = []
      claimedByRoom.set(roomId, list)
    }
    return list
  }

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
    const built = createCorridor(a, b, config, roomBounds, roomRects, corridorObstacles, claimsOf(a.id), claimsOf(b.id), corridors, allowAltMouths)
    // Intruding or mouth-pinched routes are re-realized as hops when
    // possible: a corridor through another room reads as a bug, a sealed
    // mouth reads as a locked door — two clean hops read as design. Gets
    // one extra depth level over length subdivision (cycles are still
    // impossible: banned ancestors accumulate every level).
    // NOTE: crossings do NOT subdivide — hops span the same region and
    // still cross, while adding mouths/walls that seal gates (measured:
    // subdividing crossings turned 1 crossing into 6 sealed/intrusion
    // errors on dense maps). Crossings ship, validators report, retry
    // re-routes the whole layout instead.
    if (built && built.corridor && depth < 3 && (built.midFoul || built.mouthFoul)) {
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
    if (built && built.corridor) {
      const corridor = built.corridor
      corridors.push(corridor)
      realized.add(key)
      addCorridorObstacles(corridorObstacles, corridor)
      // Reserve both door approach volumes for later routes (§56).
      claimDoorVolume(corridor)
      // Claim both mouths (with their exact centers/widths) so later
      // corridors on the same walls spread apart instead of stacking.
      if (corridor.startDoor) {
        claimsOf(corridor.startRoomId).push({
          wallIndex: corridor.startDoor.wallIndex,
          center: corridor.startDoor.lateral,
          half: corridor.startDoor.width / 2,
        })
      }
      if (corridor.endDoor) {
        claimsOf(corridor.endRoomId).push({
          wallIndex: corridor.endDoor.wallIndex,
          center: corridor.endDoor.lateral,
          half: corridor.endDoor.width / 2,
        })
      }
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
  corridorObstacles: CorridorCapsule[],
  claimsA: ClaimedMouth[] = [],
  claimsB: ClaimedMouth[] = [],
  builtCorridors: Corridor[] = [],
  allowAltMouths = false,
): { corridor: Corridor | null; midFoul: string | null; mouthFoul: boolean; crossFoul: boolean } {
  // Door points on the room walls facing each other. The clamp matches
  // core/generation's door computation exactly so the corridor mouth and
  // the wall opening land on the same center with the same width.
  //
  // Lawbook §70 repair step 2 ("choose another portal wall"): when
  // allowAltMouths is set (best-of-two variant pass only — never the
  // primary pass), edges whose preferred mouths route foul retry the SAME
  // edge through alternate walls before surrendering. A side-wall L-route
  // with clean gates beats a facing-wall route with a sealed gate. The
  // no-ban attempt runs first with byte-identical logic, so edges that
  // already route clean produce byte-identical corridors.
  const firstDoors = {
    start: findDoorPosition(roomA, roomB.position, config.corridorWidth, config, claimsA),
    end: findDoorPosition(roomB, roomA.position, config.corridorWidth, config, claimsB),
  }
  if (!firstDoors.start || !firstDoors.end) {
    return { corridor: null, midFoul: null, mouthFoul: false, crossFoul: false }
  }
  const banCombos: { banA: Set<number>; banB: Set<number> }[] = allowAltMouths
    ? [
        { banA: new Set(), banB: new Set() },
        { banA: new Set([firstDoors.start.wallIndex]), banB: new Set() },
        { banA: new Set(), banB: new Set([firstDoors.end.wallIndex]) },
        { banA: new Set([firstDoors.start.wallIndex]), banB: new Set([firstDoors.end.wallIndex]) },
      ]
    : [{ banA: new Set(), banB: new Set() }]
  let fallbackResult: { corridor: Corridor | null; midFoul: string | null; mouthFoul: boolean; crossFoul: boolean } | null = null
  for (const { banA, banB } of banCombos) {
    const startDoor = banA.size === 0 && banB.size === 0
      ? firstDoors.start
      : findDoorPosition(roomA, roomB.position, config.corridorWidth, config, claimsA, banA)
    const endDoor = banA.size === 0 && banB.size === 0
      ? firstDoors.end
      : findDoorPosition(roomB, roomA.position, config.corridorWidth, config, claimsB, banB)
    if (!startDoor || !endDoor) continue
    const result = routeWithDoors(startDoor, endDoor)
    if (!result.corridor) continue
    if (!result.midFoul && !result.mouthFoul && !result.crossFoul) return result
    if (!fallbackResult) fallbackResult = result
  }
  // No clean mouth combination: ship the preferred-mouth fallback (legacy
  // behavior) so validators and retry see the honest foul instead of a
  // silent drop. Subdivision (mid/mouth) still gets its signal from it.
  if (fallbackResult) return fallbackResult
  return { corridor: null, midFoul: null, mouthFoul: false, crossFoul: false }

function routeWithDoors(
  startDoor: DoorSpot,
  endDoor: DoorSpot,
): { corridor: Corridor | null; midFoul: string | null; mouthFoul: boolean; crossFoul: boolean } {
  const startPos: Vec3 = { x: startDoor.x, y: roomA.position.y, z: startDoor.z }
  const endPos: Vec3 = { x: endDoor.x, y: roomB.position.y, z: endDoor.z }

  const distance = Math.sqrt(
    (endPos.x - startPos.x) ** 2 + (endPos.z - startPos.z) ** 2
  )

  // Only skip nearly-coincident rooms. Short corridors between close rooms
  // are legitimate; skipping them would leave door openings with no
  // connecting geometry behind them.
  if (distance < 0.5) return { corridor: null, midFoul: null, mouthFoul: false, crossFoul: false }

  const finish = (path: Vec3[]): { corridor: Corridor | null; midFoul: string | null; mouthFoul: boolean; crossFoul: boolean } => {
    const corridor: Corridor = {
      id: `corridor_${roomA.id}_${roomB.id}`,
      startRoomId: roomA.id,
      endRoomId: roomB.id,
      startPos,
      endPos,
      width: config.corridorWidth,
      floorIndex: roomA.floorIndex,
      pathPoints: path,
      // Pinned mouth records: the wall cutter reuses these verbatim (§28),
      // so mouth and hole agree even after mouth spreading (§34).
      startDoor: { wallIndex: startDoor.wallIndex, lateral: startDoor.lateral, width: startDoor.opening },
      endDoor: { wallIndex: endDoor.wallIndex, lateral: endDoor.lateral, width: endDoor.opening },
    }
    // Selected paths passed the unified verifier (foul == null), so the
    // mid-room check agrees: no subdivision signal from here.
    return { corridor, midFoul: null, mouthFoul: false, crossFoul: false }
  }

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
  // Endpoint rooms stay obstacles too: only the exit cones at the doors
  // are exempt, so routes can't cut through the rooms they connect — nor
  // slide along their walls and swing the ribbon back over the mouth.
  const coneA: ExitCone = { x: startPos.x, z: startPos.z, nx: startDoor.nx, nz: startDoor.nz }
  const coneB: ExitCone = { x: endPos.x, z: endPos.z, nx: endDoor.nx, nz: endDoor.nz }
  const routed = findPathAStar(stubA, stubB, roomBounds, corridorObstacles, roomA.floorIndex, coneA, coneB)

  const middleGrid = routed && routed.length >= 2 ? routed : [stubA, stubB]

  // Straight exit legs: turns inside the door bubble swing the wide ribbon
  // back across the mouth and seal the gate. Extend the stubs to 2.4 m of
  // guaranteed-straight throat along each door normal; the verifier below
  // keeps the legs only when they are actually clear.
  const middleLegged = straightenExitLegs(
    middleGrid, stubA, stubB,
    { x: startDoor.nx, z: startDoor.nz }, { x: endDoor.nx, z: endDoor.nz },
    startPos, endPos,
  )

  // String-pulling on both variants (legged first): greedy shortcuts turn
  // the 1m-grid staircase into clean diagonals with few joints.
  const smoothedLegged = smoothPath(middleLegged, roomRects, corridorObstacles, roomA.floorIndex, config.corridorWidth, roomA.id, roomB.id, startPos, endPos)
  const smoothedGrid = smoothPath(middleGrid, roomRects, corridorObstacles, roomA.floorIndex, config.corridorWidth, roomA.id, roomB.id, startPos, endPos)

  // Stitch door -> middle -> door. Candidates ordered by preference; the
  // unified verifier picks the first whose ribbon (center + both edges)
  // stays out of every room interior (doors themselves exempt at the hole
  // traverse) AND whose mouth threads stay clear of all wall volumes.
  // Grid middle is the honest fallback: A* clearance by construction.
  const candidates: Vec3[][] = [
    [startPos, ...smoothedLegged, endPos],
    [startPos, ...smoothedGrid, endPos],
    [startPos, ...middleLegged, endPos],
    [startPos, ...middleGrid, endPos],
  ]
  for (const path of candidates) {
    const foul = corridorPathFoul(
      path, roomA, roomB, roomRects, corridorObstacles, builtCorridors, config.corridorWidth,
      roomA.floorIndex, startPos, endPos,
      { x: startDoor.nx, z: startDoor.nz }, { x: endDoor.nx, z: endDoor.nz },
    )
    // Temporary selection tracing (dev only): set LW_DEBUG_CORR=1 in a
    // node harness to see candidate verdicts. No @types/node dependency —
    // read through globalThis.
    const debugCorr = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.LW_DEBUG_CORR === '1'
    if (debugCorr) {
      console.log(`[corr-sel] ${roomA.id}-${roomB.id} cand len=${path.length} foul=${foul ?? 'CLEAN'}`)
    }
    if (!foul) return finish(path)
  }
  // All candidates foul somewhere: ship the grid middle (closest to the
  // routed guarantees) and report fouls for subdivision. Mouth fouls also
  // subdivide: a pinched direct edge becomes two hops with fresh mouth
  // angles (crossings do NOT — see routePair NOTE). Final validators +
  // retry decide survival.
  const fallback = finish([startPos, ...middleGrid, endPos])
  if (!fallback.corridor) return { corridor: null, midFoul: null, mouthFoul: false, crossFoul: false }
  const gridPath = [startPos, ...middleGrid, endPos]
  const fallbackFoul = corridorPathFoul(
    gridPath, roomA, roomB, roomRects, corridorObstacles, builtCorridors,
    config.corridorWidth, roomA.floorIndex, startPos, endPos,
    { x: startDoor.nx, z: startDoor.nz }, { x: endDoor.nx, z: endDoor.nz },
  )
  return {
    corridor: fallback.corridor,
    midFoul: corridorMidFoul(gridPath, roomA, roomB, roomRects, config.corridorWidth, roomA.floorIndex),
    mouthFoul: fallbackFoul !== null && fallbackFoul.startsWith('mouth'),
    crossFoul: fallbackFoul === 'crossing',
  }
} // end routeWithDoors
} // end createCorridor

// Straight exit legs: replace the routed points within LEG_OUT meters of
// each door with guaranteed-straight throat samples along the door
// normal (0.4 m spacing). Short corridors keep all four anchor points.
function straightenExitLegs(
  middle: Vec3[],
  stubA: Vec3, stubB: Vec3,
  normalA: { x: number; z: number }, normalB: { x: number; z: number },
  doorA: Vec3, doorB: Vec3,
): Vec3[] {
  const LEG_OUT = 2.4 // meters of straight throat measured from the door
  const distToA = (p: Vec3): number => Math.sqrt((p.x - doorA.x) ** 2 + (p.z - doorA.z) ** 2)
  const distToB = (p: Vec3): number => Math.sqrt((p.x - doorB.x) ** 2 + (p.z - doorB.z) ** 2)
  let i = 0
  while (i < middle.length && distToA(middle[i]) < LEG_OUT) i++
  let j = middle.length - 1
  while (j >= 0 && distToB(middle[j]) < LEG_OUT) j--
  const legA: Vec3[] = [stubA]
  for (let t = DOOR_STUB_LENGTH + 0.4; t < LEG_OUT - 1e-6; t += 0.4) {
    legA.push({ x: doorA.x + normalA.x * t, y: doorA.y, z: doorA.z + normalA.z * t })
  }
  const legB: Vec3[] = []
  for (let t = DOOR_STUB_LENGTH + 0.4; t < LEG_OUT - 1e-6; t += 0.4) {
    legB.unshift({ x: doorB.x + normalB.x * t, y: doorB.y, z: doorB.z + normalB.z * t })
  }
  legB.push(stubB)
  if (i > j) return [stubA, ...legA.slice(1), ...legB]
  return [stubA, ...legA.slice(1), ...middle.slice(i, j + 1), ...legB]
}

/**
 * Unified corridor verifier (lawbook §28, §32, §34): ribbon strip samples
 * (centerline + both edges at half width + wall + slack, every 0.25 m).
 * A sample inside a NON-endpoint room interior fouls. Inside an endpoint
 * interior it fouls unless within 0.7 m of that end's door (the hole
 * traverse). Mouth threads (±0.6 m along each door normal) must additionally
 * stay a body radius clear of every wall capsule — the candidate's own
 * walls and already-built corridors' walls alike (turn-in-bubble seals).
 * Built corridors keep their capsule separation. Returns the fouling room
 * id for non-endpoint intrusions (subdivision signal), or a generic marker
 * for mouth/crossing fouls (no meaningful subdivision).
 */
function corridorPathFoul(
  path: Vec3[],
  roomA: Room, roomB: Room,
  roomRects: (Obstacle & { roomId?: string })[],
  built: CorridorCapsule[],
  builtCorridors: Corridor[],
  width: number,
  floorIndex: number,
  doorA: Vec3, doorB: Vec3,
  normalA: { x: number; z: number }, normalB: { x: number; z: number },
): string | null {
  const edge = width / 2 + SPATIAL_DEFAULTS.wallThickness + 0.05
  const erode = SPATIAL_DEFAULTS.wallThickness + 0.05
  const wallT = SPATIAL_DEFAULTS.wallThickness
  const bodyR = 0.4
  const floorRooms = roomRects.filter(b => b.floorIndex === floorIndex)
  const floorBuilt = built.filter(b => b.floorIndex === floorIndex)
  const insideEroded = (x: number, z: number, r: Obstacle): boolean =>
    x > r.minX + erode && x < r.maxX - erode && z > r.minZ + erode && z < r.maxZ - erode
  // Wall capsules for the candidate's own ribbon.
  const ownWalls: { ax: number; az: number; bx: number; bz: number; half: number }[] = []
  {
    const center = width / 2 + wallT / 2
    const half = wallT / 2
    for (let k = 0; k < path.length - 1; k++) {
      const p = path[k]
      const q = path[k + 1]
      const segLen = Math.sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2)
      if (segLen < 1e-9) continue
      const ux = (q.x - p.x) / segLen
      const uz = (q.z - p.z) / segLen
      for (const side of [1, -1]) {
        const nx = -uz * side
        const nz = ux * side
        ownWalls.push({
          ax: p.x + nx * center, az: p.z + nz * center,
          bx: q.x + nx * center, bz: q.z + nz * center,
          half,
        })
      }
    }
  }
  // Built corridors' exact wall capsules (same floor).
  const otherWalls: { ax: number; az: number; bx: number; bz: number; half: number }[] = []
  for (const c of builtCorridors) {
    if (c.floorIndex !== floorIndex) continue
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    const center = c.width / 2 + wallT / 2
    const half = wallT / 2
    for (let k = 0; k < pts.length - 1; k++) {
      const p = pts[k]
      const q = pts[k + 1]
      const segLen = Math.sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2)
      if (segLen < 1e-9) continue
      const ux = (q.x - p.x) / segLen
      const uz = (q.z - p.z) / segLen
      for (const side of [1, -1]) {
        const nx = -uz * side
        const nz = ux * side
        otherWalls.push({
          ax: p.x + nx * center, az: p.z + nz * center,
          bx: q.x + nx * center, bz: q.z + nz * center,
          half,
        })
      }
    }
  }
  // Mouth threads: ±0.6 m along each door's WALL normal (the hole axis,
  // exactly like walk-mode probes) must clear all wall capsules — the
  // candidate's OWN two doors vs ALL walls, plus every already-built door
  // vs the candidate's OWN walls. Old-vs-old pairs were already proven
  // clean when those corridors shipped and involve nothing new: checking
  // them here lets one pre-existing foul veto every later candidate.
  const WALL_DIRS = [
    { x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 },
  ]
  const newThreads = [
    { door: doorA, nx: normalA.x, nz: normalA.z },
    { door: doorB, nx: normalB.x, nz: normalB.z },
  ]
  const oldThreads: { door: Vec3; nx: number; nz: number }[] = []
  for (const c of builtCorridors) {
    if (c.floorIndex !== floorIndex) continue
    const ends = [
      { pos: c.startPos, pin: c.startDoor },
      { pos: c.endPos, pin: c.endDoor },
    ]
    for (const end of ends) {
      if (!end.pin) continue
      const n = WALL_DIRS[end.pin.wallIndex] ?? WALL_DIRS[0]
      oldThreads.push({ door: end.pos, nx: n.x, nz: n.z })
    }
  }
  const threadSealed = (
    ax: number, az: number, bx: number, bz: number,
    walls: { ax: number; az: number; bx: number; bz: number; half: number }[],
  ): boolean => {
    for (const w of walls) {
      if (segSegDist2D(ax, az, bx, bz, w.ax, w.az, w.bx, w.bz) < w.half + bodyR - 1e-9) return true
    }
    return false
  }
  for (const t of newThreads) {
    const ax = t.door.x - t.nx * 0.6
    const az = t.door.z - t.nz * 0.6
    const bx = t.door.x + t.nx * 0.6
    const bz = t.door.z + t.nz * 0.6
    if (threadSealed(ax, az, bx, bz, ownWalls) || threadSealed(ax, az, bx, bz, otherWalls)) {
      return 'mouth-sealed'
    }
  }
  for (const t of oldThreads) {
    const ax = t.door.x - t.nx * 0.6
    const az = t.door.z - t.nz * 0.6
    const bx = t.door.x + t.nx * 0.6
    const bz = t.door.z + t.nz * 0.6
    if (threadSealed(ax, az, bx, bz, ownWalls)) {
      return 'mouth-sealed'
    }
  }
  for (let k = 0; k < path.length - 1; k++) {
    const p = path[k]
    const q = path[k + 1]
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
        for (const r of floorRooms) {
          const isEndpoint = r.roomId === roomA.id || r.roomId === roomB.id
          if (!insideEroded(ex, ez, r)) continue
          if (isEndpoint) {
            const door = r.roomId === roomA.id ? doorA : doorB
            if (Math.sqrt((ex - door.x) ** 2 + (ez - door.z) ** 2) < 0.7) continue
            return `mouth:${r.roomId ?? 'room'}`
          }
          return r.roomId ?? 'room'
        }
      }
    }
    // Built-corridor separation for this segment (existing strictness).
    for (const c of floorBuilt) {
      if (segmentCapsuleClearance(p, q, c) < c.halfWidth + 0.1) return 'crossing'
    }
  }
  return null
}

// Mid-room intrusion only (subdivision signal): like the verifier but
// restricted to non-endpoint rooms — mouth regions are the path
// selector's problem, not a reason to subdivide.
function corridorMidFoul(
  path: Vec3[],
  roomA: Room, roomB: Room,
  roomRects: (Obstacle & { roomId?: string })[],
  width: number,
  floorIndex: number,
): string | null {
  const edge = width / 2 + SPATIAL_DEFAULTS.wallThickness + 0.05
  const erode = SPATIAL_DEFAULTS.wallThickness + 0.05
  const floorRooms = roomRects.filter(b => b.floorIndex === floorIndex)
  for (let k = 0; k < path.length - 1; k++) {
    const p = path[k]
    const q = path[k + 1]
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
        for (const r of floorRooms) {
          if (r.roomId === roomA.id || r.roomId === roomB.id) continue
          if (
            ex > r.minX + erode && ex < r.maxX - erode &&
            ez > r.minZ + erode && ez < r.maxZ - erode
          ) {
            return r.roomId ?? 'room'
          }
        }
      }
    }
  }
  return null
}

// Doorway throat check (lawbook §28, §34): within one ribbon-width of
// either door, both ribbon edges must stay out of the rooms' interiors.
// Edges may cross the wall BAND (the funnel where a wide corridor meets
// a narrower gate is legal solid-on-solid), but never the inner face.
export interface DoorSpot {
  x: number
  z: number
  /** Outward wall normal (unit, axis aligned). */
  nx: number
  nz: number
  /** Wall side index (0:-Z, 1:+X, 2:+Z, 3:-X). */
  wallIndex: number
  /** Lateral center along the wall (meters from room center). */
  lateral: number
  /** Clear opening width (shared gate rule). */
  opening: number
}

// Claimed mouths per room, to spread parallel corridors along walls
// (lawbook §27 separation, §34 junctions): two corridors sharing one
// hole interleave their ribbons and seal the gate.
export interface ClaimedMouth {
  wallIndex: number
  center: number
  half: number
}

function findDoorPosition(
  room: Room,
  targetPos: { x: number; z: number },
  corridorWidth: number,
  config?: LevelConfig,
  claimed: ClaimedMouth[] = [],
  // Lawbook §70 repair step 2 ("choose another portal wall"): walls to
  // skip when hunting a mouth. The router bans a fouled facing wall and
  // retries the edge through a side wall (clean L-route) instead of
  // shipping a sealed gate.
  bannedWalls: Set<number> = new Set(),
): DoorSpot | null {
  const halfW = room.width / 2
  const halfD = room.depth / 2
  const relX = targetPos.x - room.position.x
  const relZ = targetPos.z - room.position.z
  const absX = Math.abs(relX)
  const absZ = Math.abs(relZ)

  // Opening matches the gate the wall cutter will produce (lawbook §28:
  // corridor mouth and door hole must share one center AND one width).
  // Falls back to the legacy corridor-width rule when no config is given.
  const margin = SPATIAL_DEFAULTS.doorCornerMargin
  const sep = SPATIAL_DEFAULTS.doorSeparation
  const facing = absX > absZ ? (relX > 0 ? 1 : 3) : (relZ > 0 ? 2 : 0)
  // Wall preference: facing wall first, then the adjacent wall on the
  // target's side, then the far adjacent, then opposite. A full facing
  // wall spills onto side walls (clean L-route) instead of cramming the
  // mouth into a corner — corner mouths pinch diagonal corridors shut.
  // Deterministic: fixed order, target-side first.
  const sidePick = facing % 2 === 0 ? (relX >= 0 ? 1 : 3) : (relZ >= 0 ? 2 : 0)
  const otherAdj = ([0, 1, 2, 3] as const).find(w => w % 2 !== facing % 2 && w !== sidePick) as number
  const opposite = (facing + 2) % 4
  const wallOrder = [facing, sidePick, otherAdj, opposite]

  const tryWall = (wallIndex: number): { lateral: number; opening: number } | null => {
    const wLen = wallIndex % 2 === 0 ? room.width : room.depth
    const op = config
      ? gateWidthFor(config, wLen, corridorWidth)
      : Math.max(1.0, Math.min(corridorWidth, wLen - 0.6))
    if (op <= 0.05) return null // wall far too short: no fake mouth
    const h = wallIndex % 2 === 0 ? halfW : halfD
    const lo = -h + op / 2 + margin
    const hi = h - op / 2 - margin
    if (hi < lo) return null
    const clampRel = (v: number): number => Math.max(lo, Math.min(hi, v))
    const relAlong = wallIndex % 2 === 0 ? relX : relZ
    let lateral = clampRel(relAlong)
    const wallClaims = claimed
      .filter(c => c.wallIndex === wallIndex)
      .sort((p, q) => p.center - q.center)
    for (let iter = 0; iter < 8; iter++) {
      const clash = wallClaims.find(
        c => Math.abs(lateral - c.center) < op / 2 + c.half + sep - 1e-9,
      )
      if (!clash) return { lateral, opening: op }
      const left = clash.center - (op / 2 + clash.half + sep)
      const right = clash.center + (op / 2 + clash.half + sep)
      const dl = Math.abs(lateral - left)
      const dr = Math.abs(lateral - right)
      lateral = Math.max(lo, Math.min(hi, dl <= dr ? left : right))
      if (Math.abs(lateral - clash.center) < op / 2 + clash.half + sep - 1e-9) {
        return null // this wall is full
      }
    }
    return { lateral, opening: op }
  }

  let picked: { wallIndex: number; lateral: number; opening: number } | null = null
  for (const w of wallOrder) {
    if (bannedWalls.has(w)) continue
    const slot = tryWall(w)
    if (slot) {
      picked = { wallIndex: w, ...slot }
      break
    }
  }
  if (!picked) {
    // Every (non-banned) wall is full: share a mouth (merged funnel).
    // Coincident throats stay parallel and walkable; a corner-crammed
    // mouth would pinch shut. Honors bans: a banned facing wall never
    // becomes the funnel — all banned means no mouth at all.
    const funnelOrder = wallOrder.filter(w => !bannedWalls.has(w))
    if (funnelOrder.length === 0) return null
    const funnelWall = funnelOrder[0]
    const wLen = funnelWall % 2 === 0 ? room.width : room.depth
    const op = config
      ? gateWidthFor(config, wLen, corridorWidth)
      : Math.max(1.0, Math.min(corridorWidth, wLen - 0.6))
    if (op <= 0.05) return null
    const h = funnelWall % 2 === 0 ? halfW : halfD
    const lo = -h + op / 2 + margin
    const hi = h - op / 2 - margin
    const relAlong = funnelWall % 2 === 0 ? relX : relZ
    picked = { wallIndex: funnelWall, lateral: Math.max(lo, Math.min(hi, relAlong)), opening: op }
  }
  const { wallIndex, lateral, opening } = picked

  // Door world position from the picked wall + lateral center.
  let doorX = room.position.x
  let doorZ = room.position.z
  let nx = 0
  let nz = 0

  if (wallIndex === 1) {
    // Right wall (+X)
    doorX = room.position.x + halfW
    doorZ = room.position.z + lateral
    nx = 1
  } else if (wallIndex === 3) {
    // Left wall (-X)
    doorX = room.position.x - halfW
    doorZ = room.position.z + lateral
    nx = -1
  } else if (wallIndex === 2) {
    // Back wall (+Z)
    doorZ = room.position.z + halfD
    doorX = room.position.x + lateral
    nz = 1
  } else {
    // Front wall (-Z)
    doorZ = room.position.z - halfD
    doorX = room.position.x + lateral
    nz = -1
  }

  return { x: doorX, z: doorZ, nx, nz, wallIndex, lateral, opening }
}

interface GridNode {
  x: number
  z: number
  g: number // cost from start
  f: number // estimated total cost
  parent: GridNode | null
  /** Insertion sequence: heap tie-break so equal-f pops earliest-first,
   * exactly matching the old linear min-scan's first-min-wins order. */
  seq: number
  /** Step direction taken from the parent (0,0 at the start). */
  dx: number
  dz: number
}

// Extra g-cost for changing direction mid-route. Pure Euclidean step
// costs make every 1 m staircase as cheap as a straight diagonal, so open
// ground routes came out as 45° zigzags with a joint (and wall miter)
// every meter. A small turn penalty (20% of an axis step) spends joints
// only where obstacles force them; the heuristic stays admissible (turns
// only add true cost), determinism is untouched, and obstacle avoidance
// still dominates (a real detour costs whole steps).
const TURN_COST = 0.2

/**
 * Minimal binary heap for A* (lawbook §94-95: validation cost bounded).
 * The old linear min-scan was O(openSet) per pop — 25M comparisons for a
 * 5000-node frontier, the 95-second hang on 40-room maps. Heap pops are
 * O(log n) with identical (f, seq) ordering, so routed paths are unchanged.
 */
class GridHeap {
  private items: GridNode[] = []
  get size(): number {
    return this.items.length
  }
  push(node: GridNode): void {
    const a = this.items
    a.push(node)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (less(a[i], a[p])) {
        ;[a[i], a[p]] = [a[p], a[i]]
        i = p
      } else break
    }
  }
  pop(): GridNode | undefined {
    const a = this.items
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < a.length && less(a[l], a[m])) m = l
        if (r < a.length && less(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

function less(a: GridNode, b: GridNode): boolean {
  if (a.f !== b.f) return a.f < b.f
  return a.seq < b.seq
}

/** Exit cone: door-plane reference point + outward normal. */
export interface ExitCone {
  x: number
  z: number
  nx: number
  nz: number
}

// Door-bubble exemption as a DIRECTIONAL cone, not a disk: routes may
// leave through the doorway cone but may not slide laterally along the
// room wall inside the bubble (that swings the wide ribbon back across
// the mouth and seals the gate). Cone: up to 2.2 m out, lateral half
// width 1.0 m at the plane widening 0.5 per meter out.
function inExitCone(x: number, z: number, cone: ExitCone): boolean {
  const dx = x - cone.x
  const dz = z - cone.z
  const along = dx * cone.nx + dz * cone.nz
  if (along < -0.3 || along > 2.2) return false
  const latX = dx - along * cone.nx
  const latZ = dz - along * cone.nz
  const lat = Math.sqrt(latX * latX + latZ * latZ)
  return lat <= 1.0 + 0.5 * Math.max(0, along)
}

function findPathAStar(
  start: Vec3,
  end: Vec3,
  roomBounds: Obstacle[],
  capsules: CorridorCapsule[],
  floorIndex: number,
  coneA: ExitCone,
  coneB: ExitCone
): Vec3[] | null {
  const cellSize = 1.0 // 1m grid resolution

  // All same-floor bounds stay obstacles, INCLUDING the endpoint rooms:
  // only the exit cones at the doors are walkable, so the routed middle
  // can't cut through the rooms it connects — nor slide along their
  // walls inside an overbroad disk exemption.
  const floorRooms = roomBounds.filter(b => b.floorIndex === floorIndex)
  const floorCaps = capsules.filter(b => b.floorIndex === floorIndex)
  const inDoorZone = (x: number, z: number): boolean =>
    inExitCone(x, z, coneA) || inExitCone(x, z, coneB)
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

  // A* on grid (binary heap: identical (f, seq) pop order to the old
  // linear scan, O(log n) instead of O(n) per pop).
  const openSet = new Map<string, GridNode>()
  const openHeap = new GridHeap()
  const closedSet = new Set<string>()
  let seq = 0

  const startNode: GridNode = {
    x: Math.round(start.x / cellSize),
    z: Math.round(start.z / cellSize),
    g: 0,
    f: heuristic(start, end),
    parent: null,
    seq: seq++,
    dx: 0,
    dz: 0,
  }

  const endNodeKey = `${Math.round(end.x / cellSize)},${Math.round(end.z / cellSize)}`
  openSet.set(`${startNode.x},${startNode.z}`, startNode)
  openHeap.push(startNode)

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

  while (openHeap.size > 0 && iterations < maxIterations) {
    iterations++

    // Lowest-f pop; stale heap entries (superseded by a better g for the
    // same cell) are skipped — the map holds the current best.
    let current: GridNode | undefined
    let currentKey = ''
    for (;;) {
      const cand = openHeap.pop()
      if (!cand) break
      const key = `${cand.x},${cand.z}`
      const best = openSet.get(key)
      if (best !== cand) continue // stale entry
      current = cand
      currentKey = key
      break
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

      const tentativeG = current.g + dir.cost +
        ((current.dx === 0 && current.dz === 0) || (current.dx === dir.dx && current.dz === dir.dz) ? 0 : TURN_COST)
      const existing = openSet.get(neighborKey)

      if (!existing || tentativeG < existing.g) {
        const neighbor: GridNode = {
          x: nx,
          z: nz,
          g: tentativeG,
          f: tentativeG + heuristic({ x: worldX, y: 0, z: worldZ }, end),
          parent: current,
          seq: seq++,
          dx: dir.dx,
          dz: dir.dz,
        }
        openSet.set(neighborKey, neighbor)
        openHeap.push(neighbor)
      }
    }
  }

  // A* failed, try simplified approach
  return findPathSimple(start, end, floorRooms, floorCaps, coneA, coneB)
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
    // Endpoint room: the ribbon (not just its centerline) must stay out
    // of the room interior. The centerline may leave through the doorway,
    // but both ribbon edges (roomMargin = half width + wall + slack) must
    // never enter past the inner wall face — a shortcut whose centerline
    // skims 1.2 m past the room still drags a 1.8 m ribbon inside and
    // seals the adjacent gate in walk mode.
    // Interior boundary = wall thickness (single source) + epsilon.
    const erode = SPATIAL_DEFAULTS.wallThickness + 0.05
    const inner = {
      minX: r.minX + erode,
      maxX: r.maxX - erode,
      minZ: r.minZ + erode,
      maxZ: r.maxZ - erode,
    }
    // Door exit/approach legs (within 3.5 m of the doorway) use the
    // interior test below; the middle keeps full expanded clearance.
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
    // Ribbon strip test over the whole segment: centerline + both edges
    // sampled every 0.25 m; any sample strictly inside the interior fouls
    // the shortcut (the door-exit point itself sits on the outer plane,
    // outside the eroded interior, so legal exits still pass).
    const px = -uz
    const pz = ux
    const steps = Math.max(1, Math.ceil(len / 0.25))
    for (let s = 0; s <= steps; s++) {
      const cx = a.x + ux * ((s / steps) * len)
      const cz = a.z + uz * ((s / steps) * len)
      for (const lateral of [0, roomMargin, -roomMargin]) {
        const ex = cx + px * lateral
        const ez = cz + pz * lateral
        if (ex > inner.minX && ex < inner.maxX && ez > inner.minZ && ez < inner.maxZ) {
          return false
        }
      }
    }
  }
  for (const c of built) {
    if (segmentCapsuleClearance(a, b, c) < c.halfWidth + 0.1) return false
  }
  return true
}

function findPathSimple(
  start: Vec3,
  end: Vec3,
  roomBounds: Obstacle[],
  capsules: CorridorCapsule[],
  coneA: ExitCone,
  coneB: ExitCone
): Vec3[] {
  // Exit-cone-aware clearance: samples inside either doorway cone live in
  // the stub's own inflated doorway zone and must not poison candidates
  // (the old exact rect checks rejected EVERYTHING starting inside the
  // inflated endpoint bounds, degenerating to a direct line through rooms).
  // Cones (not disks) so laterally sliding candidates still fail here.
  const clear = (path: Vec3[]): boolean =>
    simplePathClear(path, roomBounds, capsules, coneA, coneB)

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
  coneA: ExitCone,
  coneB: ExitCone
): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i]
    const q = path[i + 1]
    const segLen = Math.sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2)
    const steps = Math.max(1, Math.ceil(segLen / 0.5))
    for (let s = 0; s <= steps; s++) {
      const x = p.x + ((q.x - p.x) * s) / steps
      const z = p.z + ((q.z - p.z) * s) / steps
      // Exit cones at both doors are exempt.
      if (inExitCone(x, z, coneA)) continue
      if (inExitCone(x, z, coneB)) continue
      if (isPointBlocked({ x, y: 0, z }, roomBounds)) return false
      for (const c of capsules) {
        if (distPointToSegment(x, z, c.ax, c.az, c.bx, c.bz) < c.halfWidth) return false
      }
    }
  }
  return true
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

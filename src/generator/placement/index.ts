import type { Room, RoomType, LevelConfig, Boundary } from '@/core/types'
import { SeededRandom } from '@/core/random'
import { isPointInBoundary } from '@/generator/boundary'

// Spatial room placement (pipeline stage: "Place rooms spatially" +
// "Resolve overlaps"). Room SIZES live in `@/generator/rooms`; this module
// only decides WHERE sized rooms go and separates overlaps.

export function placeRooms(
  rooms: Room[],
  boundary: Boundary,
  config: LevelConfig,
  random: SeededRandom
): Room[] {
  const placedRooms: Room[] = []
  const roomMap = new Map<string, Room>()

  // Group by floor
  const roomsByFloor = new Map<number, Room[]>()
  for (const room of rooms) {
    if (!roomsByFloor.has(room.floorIndex)) {
      roomsByFloor.set(room.floorIndex, [])
    }
    roomsByFloor.get(room.floorIndex)!.push(room)
  }

  // Process floors bottom-up so upper rooms can stack over their
  // already-placed vertical partners (lawbook §40: stairs need real
  // XZ overlap between the linked rooms — independent per-floor layouts
  // can never host a legal flight).
  const allById = new Map(rooms.map(r => [r.id, r]))
  const placedById = new Map<string, Room>()
  const floorIndices = [...roomsByFloor.keys()].sort((a, b) => a - b)
  for (const floorIndex of floorIndices) {
    const floorRooms = roomsByFloor.get(floorIndex)!
    const floorPlaced = placeRoomsOnFloor(floorRooms, boundary, config, random, floorIndex, allById, placedById)
    for (const room of floorPlaced) {
      placedRooms.push(room)
      roomMap.set(room.id, room)
      placedById.set(room.id, room)
    }
  }

  return placedRooms
}


function placeRoomsOnFloor(
  rooms: Room[],
  boundary: Boundary,
  config: LevelConfig,
  random: SeededRandom,
  _floorIndex: number,
  // All rooms (for cross-floor vertical partners) + rooms already placed
  // on lower floors (stack targets with final positions).
  allById?: Map<string, Room>,
  placedById?: Map<string, Room>
): Room[] {
  const placed: Room[] = []
  const occupied: { x: number; z: number; w: number; d: number; roomId: string }[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  
  // Build adjacency for this floor
  const adjacency = new Map<string, string[]>()
  for (const room of rooms) {
    adjacency.set(room.id, room.connections.filter(c => {
      const other = roomMap.get(c)
      return other && other.floorIndex === room.floorIndex
    }))
  }

  // Sort: hubs/arenas first, then by connection count
  const sorted = [...rooms].sort((a, b) => {
    const weightA = getPlacementWeight(a.type) + a.connections.length
    const weightB = getPlacementWeight(b.type) + b.connections.length
    return weightB - weightA
  })

  // Rooms must keep wall-to-wall gaps wide enough for corridors to pass
  // between them: corridorWidth + wall slabs + slack. Tight enough that
  // attachment slots stay available (fat universal clearance scatters
  // rooms randomly and destroys adjacency); routed links use open space.
  // Each side contributes half the required gap.
  const clearance = (config.corridorWidth + 1.0) / 2

  for (const room of sorted) {
    const connections = adjacency.get(room.id) || []
    let pos: { x: number; z: number } | null = null

    // Stack over an already-placed vertical partner first: a stair flight
    // must overlap the upper room, so linked rooms share XZ volume. The
    // candidate with the most overlap wins (deterministic partner order).
    if (allById && placedById) {
      pos = tryStackOnPartner(room, allById, placedById, placed, boundary, clearance, occupied)
    }

    // Attach directly beside an already-placed connected room so the
    // corridor between them is a short straight stub, not a long route
    // across the map.
    if (!pos && connections.length > 0) {
      const placedConnections = connections.filter(c =>
        placed.some(p => p.id === c)
      )

      if (placedConnections.length > 0) {
        pos = tryAttachToConnections(room, placedConnections, placed, boundary, clearance, config, random, occupied)
      }
    }

    // First room on the floor starts near the center (all floors stack
    // near the same XZ, which also keeps stairs short).
    if (!pos && placed.length === 0) {
      pos = centerPosition(room, boundary)
      if (pos && (overlapsAny(pos, room, occupied, clearance) || !isPointInBoundary(pos, boundary, 2))) {
        pos = null
      }
    }

    // Fallback: random valid position — biased toward vertical partners
    // so linked rooms land near each other (overlap for future stairs)
    // even when exact stacking did not fit.
    if (!pos) {
      pos = findRandomPosition(room, boundary, occupied, clearance, random, verticalAttractors(room, allById, placedById))
    }

    // Last resort: force place with overlap resolution
    if (!pos) {
      pos = findAnyPosition(room, boundary, config, random)
    }

    const placedRoom = {
      ...room,
      position: { x: pos!.x, y: room.position.y, z: pos!.z }
    }
    placed.push(placedRoom)
    occupied.push({ ...pos!, w: room.width, d: room.depth, roomId: room.id })
  }

  // Post-process: resolve any remaining overlaps with force-directed relaxation
  return resolveOverlapsOnFloor(placed, boundary, _floorIndex, config.corridorWidth + 1.0)
}



function centerPosition(
  room: Room,
  boundary: Boundary
): { x: number; z: number } | null {
  const halfW = room.width / 2 + 1
  const halfD = room.depth / 2 + 1
  if (halfW * 2 > boundary.width || halfD * 2 > boundary.depth) return null
  const x = Math.max(-boundary.width / 2 + halfW, Math.min(boundary.width / 2 - halfW, boundary.center.x))
  const z = Math.max(-boundary.depth / 2 + halfD, Math.min(boundary.depth / 2 - halfD, boundary.center.y))
  return { x, z }
}


function overlapArea(
  pos: { x: number; z: number }, room: Room,
  partner: { x: number; z: number; w: number; d: number },
): number {
  const aMinX = pos.x - room.width / 2
  const aMaxX = pos.x + room.width / 2
  const aMinZ = pos.z - room.depth / 2
  const aMaxZ = pos.z + room.depth / 2
  const bMinX = partner.x - partner.w / 2
  const bMaxX = partner.x + partner.w / 2
  const bMinZ = partner.z - partner.d / 2
  const bMaxZ = partner.z + partner.d / 2
  return Math.max(0, Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX)) *
    Math.max(0, Math.min(aMaxZ, bMaxZ) - Math.max(aMinZ, bMinZ))
}

// Vertical stacking: rooms linked across floors share XZ so a legal stair
// can pierce both. Tries the partner center, then deterministic rings of
// offsets; keeps the fitting candidate with the largest overlap area.
// Same-floor rooms still keep full clearance (no cheating on overlaps).
function tryStackOnPartner(
  room: Room,
  allById: Map<string, Room>,
  placedById: Map<string, Room>,
  placed: Room[],
  boundary: Boundary,
  clearance: number,
  occupied: { x: number; z: number; w: number; d: number; roomId: string }[]
): { x: number; z: number } | null {
  const partners = room.connections
    .map(id => ({ id, ref: allById.get(id) }))
    .filter((p): p is { id: string; ref: Room } => !!p.ref && p.ref.floorIndex !== room.floorIndex)
    .map(p => placedById.get(p.id))
    .filter((p): p is Room => !!p)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (partners.length === 0) return null

  const offsets = [
    { x: 0, z: 0 },
    { x: 1.5, z: 0 }, { x: -1.5, z: 0 }, { x: 0, z: 1.5 }, { x: 0, z: -1.5 },
    { x: 3, z: 0 }, { x: -3, z: 0 }, { x: 0, z: 3 }, { x: 0, z: -3 },
    { x: 3, z: 3 }, { x: -3, z: 3 }, { x: 3, z: -3 }, { x: -3, z: -3 },
    { x: 5, z: 0 }, { x: -5, z: 0 }, { x: 0, z: 5 }, { x: 0, z: -5 },
  ]

  let best: { x: number; z: number } | null = null
  let bestScore = 0
  for (const partner of partners) {
    const target = { x: partner.position.x, z: partner.position.z, w: partner.width, d: partner.depth }
    for (const off of offsets) {
      const cand = { x: target.x + off.x, z: target.z + off.z }
      if (!fitsInBoundary(cand, room, boundary)) continue
      if (!isPointInBoundary(cand, boundary, 2)) continue
      if (overlapsAny(cand, room, occupied, clearance)) continue
      // Overlap with the partner, discounted by distance to already-placed
      // same-floor neighbors (keeps corridors short too).
      let score = overlapArea(cand, room, target)
      if (score <= 0) continue
      for (const other of placed) {
        score -= 0.02 * Math.sqrt((cand.x - other.position.x) ** 2 + (cand.z - other.position.z) ** 2)
      }
      if (score > bestScore) {
        bestScore = score
        best = cand
      }
    }
  }
  return best
}


function tryAttachToConnections(
  room: Room,
  connectionIds: string[],
  placed: Room[],
  boundary: Boundary,
  clearance: number,
  config: LevelConfig,
  random: SeededRandom,
  occupied: { x: number; z: number; w: number; d: number; roomId: string }[]
): { x: number; z: number } | null {
  const targets = random.shuffle(
    connectionIds.map(id => placed.find(p => p.id === id)!).filter(Boolean)
  )
  // Wall-to-wall gap for the corridor between the rooms. Tighter than the
  // general spacing: attached rooms only need to fit their own stub.
  const gapBase = config.corridorWidth + 1.5

  // Best-fit: topology proximity means nothing after placement moves rooms,
  // so score every fitting slot by total distance to ALL placed connections
  // and take the shortest. First-fit let multi-link rooms stretch links
  // across the map (60m+ monster corridors).
  const neighbors = targets
  let best: { x: number; z: number } | null = null
  let bestScore = Infinity

  for (const target of targets) {
    const sides = random.shuffle([0, 1, 2, 3]) // +X, -X, +Z, -Z
    for (const side of sides) {
      // Several lateral samples per side: much higher hit rate in tight maps.
      for (let sample = 0; sample < 3; sample++) {
        const gap = gapBase + random.nextFloat(0, 1.5)
        let x = target.position.x
        let z = target.position.z

        if (side === 0) x += target.width / 2 + gap + room.width / 2
        else if (side === 1) x -= target.width / 2 + gap + room.width / 2
        else if (side === 2) z += target.depth / 2 + gap + room.depth / 2
        else z -= target.depth / 2 + gap + room.depth / 2

        // Lateral jitter so rows don't grid-lock into perfect lines.
        if (side < 2) z += random.nextFloat(-2, 2)
        else x += random.nextFloat(-2, 2)

        if (!fitsInBoundary({ x, z }, room, boundary)) continue
        if (!isPointInBoundary({ x, z }, boundary, 2)) continue
        // The attach target itself is exempt: its gap is governed by gapBase
        // above, which is intentionally tighter than general spacing.
        if (overlapsAny({ x, z }, room, occupied, clearance, target.id)) continue

        let score = random.nextFloat(0, 1.5)
        for (const other of neighbors) {
          score += Math.sqrt((x - other.position.x) ** 2 + (z - other.position.z) ** 2)
        }
        if (score < bestScore) {
          bestScore = score
          best = { x, z }
        }
      }
    }
  }

  return best
}


function fitsInBoundary(
  pos: { x: number; z: number },
  room: Room,
  boundary: Boundary
): boolean {
  const halfW = room.width / 2 + 1
  const halfD = room.depth / 2 + 1
  return (
    pos.x - halfW >= -boundary.width / 2 &&
    pos.x + halfW <= boundary.width / 2 &&
    pos.z - halfD >= -boundary.depth / 2 &&
    pos.z + halfD <= boundary.depth / 2
  )
}


// Vertical partner positions to stay near: final positions for placed
// lower-floor partners, topology intent positions for not-yet-placed ones.
// Keeps stair-linked families in the same neighborhood so flights can
// overlap both rooms even when exact stacking failed.
function verticalAttractors(
  room: Room,
  allById?: Map<string, Room>,
  placedById?: Map<string, Room>,
): { x: number; z: number }[] {
  if (!allById) return []
  const out: { x: number; z: number }[] = []
  for (const id of room.connections) {
    const ref = allById.get(id)
    if (!ref || ref.floorIndex === room.floorIndex) continue
    const placed = placedById?.get(id)
    out.push(placed ? { x: placed.position.x, z: placed.position.z } : { x: ref.position.x, z: ref.position.z })
  }
  return out
}


function findRandomPosition(
  room: Room,
  boundary: Boundary,
  occupied: { x: number; z: number; w: number; d: number; roomId: string }[],
  clearance: number,
  random: SeededRandom,
  attract?: { x: number; z: number }[]
): { x: number; z: number } | null {
  const margin = 2
  const halfW = room.width / 2
  const halfD = room.depth / 2

  const maxX = boundary.width / 2 - halfW - margin
  const minX = -boundary.width / 2 + halfW + margin
  const maxZ = boundary.depth / 2 - halfD - margin
  const minZ = -boundary.depth / 2 + halfD + margin

  if (maxX < minX || maxZ < minZ) return null

  // Best-of-N: with attractors, keep the valid candidate closest to the
  // vertical family instead of a uniform far-flung pick.
  let best: { x: number; z: number } | null = null
  let bestScore = Infinity
  const attempts = 60
  for (let i = 0; i < attempts; i++) {
    const x = random.nextFloat(minX, maxX)
    const z = random.nextFloat(minZ, maxZ)
    if (!isPointInBoundary({ x, z }, boundary, margin)) continue
    if (overlapsAny({ x, z }, room, occupied, clearance)) continue
    if (!attract || attract.length === 0) return { x, z }
    let score = Infinity
    for (const a of attract) {
      score = Math.min(score, Math.sqrt((x - a.x) ** 2 + (z - a.z) ** 2) + random.nextFloat(0, 4))
    }
    if (score < bestScore) {
      bestScore = score
      best = { x, z }
    }
  }
  return best
}


function findAnyPosition(
  room: Room,
  boundary: Boundary,
  config: LevelConfig,
  random: SeededRandom
): { x: number; z: number } {
  const margin = config.corridorWidth + 1
  const halfW = room.width / 2
  const halfD = room.depth / 2

  return {
    x: random.nextFloat(-boundary.width / 2 + halfW + margin, boundary.width / 2 - halfW - margin),
    z: random.nextFloat(-boundary.depth / 2 + halfD + margin, boundary.depth / 2 - halfD - margin),
  }
}


function overlapsAny(
  pos: { x: number; z: number },
  room: Room,
  occupied: { x: number; z: number; w: number; d: number; roomId: string }[],
  clearance: number,
  excludeId?: string
): boolean {
  const halfW = room.width / 2 + clearance
  const halfD = room.depth / 2 + clearance

  for (const occ of occupied) {
    if (occ.roomId === excludeId) continue
    const occHalfW = occ.w / 2 + clearance
    const occHalfD = occ.d / 2 + clearance

    if (Math.abs(pos.x - occ.x) < halfW + occHalfW &&
        Math.abs(pos.z - occ.z) < halfD + occHalfD) {
      return true
    }
  }
  return false
}


function getPlacementWeight(type: RoomType): number {
  switch (type) {
    case 'hub': return 10
    case 'arena': return 9
    case 'spawn': return 8
    case 'exit': return 8
    case 'verticalConnector': return 7
    case 'objective': return 7
    case 'hall': return 5
    case 'storage': return 4
    case 'connector': return 3
    default: return 1
  }
}


export function resolveOverlaps(rooms: Room[], boundary: Boundary, minGap = 1.0): Room[] {
  // Group by floor and resolve each floor
  const byFloor = new Map<number, Room[]>()
  for (const room of rooms) {
    if (!byFloor.has(room.floorIndex)) byFloor.set(room.floorIndex, [])
    byFloor.get(room.floorIndex)!.push(room)
  }

  const result: Room[] = []
  for (const [floorIndex, floorRooms] of byFloor) {
    result.push(...resolveOverlapsOnFloor(floorRooms, boundary, floorIndex, minGap))
  }
  return result
}


function resolveOverlapsOnFloor(rooms: Room[], boundary: Boundary, _floorIndex: number, minGap: number): Room[] {
  // Least-penetration separation (lawbook §19): each overlapping pair is
  // resolved along its minimum-penetration axis by EXACTLY the missing
  // distance (half each). Single-axis exact pushes cannot overshoot, so
  // the loop converges instead of oscillating; boundary clamps run once
  // per sweep (a clamp can reintroduce overlap, the next sweep fixes it).
  // Bounded and deterministic. If the floor is genuinely overfull, the
  // remainder is left for the validators to report honestly.
  const result = rooms.map(r => ({ ...r, position: { ...r.position } }))
  const minSeparation = minGap // wall-to-wall gap (must fit corridors)
  const eps = 1e-4
  const maxSweeps = 300

  // Up to two rounds: separation sweeps, then grid scatter to break a
  // clamp deadlock, then sweeps again. Anything left is genuinely
  // overfull and goes to the validators honestly.
  for (let round = 0; round < 2; round++) {
    let converged = false
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      let worst = 0
      for (let i = 0; i < result.length; i++) {
        for (let j = i + 1; j < result.length; j++) {
          const a = result[i]
          const b = result[j]
          const dx = a.position.x - b.position.x
          const dz = a.position.z - b.position.z
          const minDistX = (a.width + b.width) / 2 + minSeparation
          const minDistZ = (a.depth + b.depth) / 2 + minSeparation
          const overlapX = minDistX - Math.abs(dx)
          const overlapZ = minDistZ - Math.abs(dz)
          if (overlapX > eps && overlapZ > eps) {
            worst = Math.max(worst, overlapX, overlapZ)
            // Deterministic direction: by sign, zero distance splits by id.
            const signX = dx > eps ? 1 : dx < -eps ? -1 : a.id < b.id ? 1 : -1
            const signZ = dz > eps ? 1 : dz < -eps ? -1 : a.id < b.id ? 1 : -1
            if (overlapX <= overlapZ) {
              const push = overlapX / 2 + eps
              a.position.x += push * signX
              b.position.x -= push * signX
            } else {
              const push = overlapZ / 2 + eps
              a.position.z += push * signZ
              b.position.z -= push * signZ
            }
          }
        }
      }
      for (const room of result) clampToBoundary(room, boundary)
      if (worst <= eps) {
        converged = true
        break
      }
    }
    if (converged) break
    if (round === 0) {
      const scattered = verifyAndFixOverlaps(result, boundary, minGap)
      for (let i = 0; i < result.length; i++) result[i].position = { ...scattered[i].position }
    }
  }

  return result
}


function verifyAndFixOverlaps(rooms: Room[], boundary: Boundary, minGap: number): Room[] {
  // Grid-based separation as last resort
  const cellSize = 10
  const grid = new Map<string, Room[]>()
  
  for (const room of rooms) {
    const gx = Math.floor((room.position.x + boundary.width / 2) / cellSize)
    const gz = Math.floor((room.position.z + boundary.depth / 2) / cellSize)
    const key = `${gx},${gz}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(room)
  }

  // Spread rooms in crowded cells
  for (const [, cellRooms] of grid) {
    if (cellRooms.length <= 1) continue

    // Arrange in a circle sized for the biggest room plus the gap
    const centerX = cellRooms.reduce((sum, r) => sum + r.position.x, 0) / cellRooms.length
    const centerZ = cellRooms.reduce((sum, r) => sum + r.position.z, 0) / cellRooms.length
    const biggest = Math.max(...cellRooms.map(r => Math.max(r.width, r.depth) / 2))
    const radius = biggest + minGap + 3

    for (let i = 0; i < cellRooms.length; i++) {
      const angle = (i / cellRooms.length) * Math.PI * 2
      const room = cellRooms[i]
      room.position.x = Math.max(-boundary.width / 2 + room.width / 2 + 1,
        Math.min(boundary.width / 2 - room.width / 2 - 1, centerX + Math.cos(angle) * radius))
      room.position.z = Math.max(-boundary.depth / 2 + room.depth / 2 + 1,
        Math.min(boundary.depth / 2 - room.depth / 2 - 1, centerZ + Math.sin(angle) * radius))
      pullIntoBoundary(room, boundary)
    }
  }

  return rooms
}


function clampToBoundary(room: Room, boundary: Boundary): void {
  const margin = 1
  const halfW = room.width / 2
  const halfD = room.depth / 2

  room.position.x = Math.max(-boundary.width / 2 + halfW + margin,
    Math.min(boundary.width / 2 - halfW - margin, room.position.x))
  room.position.z = Math.max(-boundary.depth / 2 + halfD + margin,
    Math.min(boundary.depth / 2 - halfD - margin, room.position.z))
  pullIntoBoundary(room, boundary)
}


// Non-rectangular shapes (ring hole, cross cut-outs): if the rect clamp
// left the room center outside the shape, walk it toward the middle until
// it is inside (or give up after a few steps and keep the rect position).
function pullIntoBoundary(room: Room, boundary: Boundary): void {
  if (isPointInBoundary({ x: room.position.x, z: room.position.z }, boundary, 1)) return
  for (let i = 0; i < 25; i++) {
    room.position.x += (boundary.center.x - room.position.x) * 0.2
    room.position.z += (boundary.center.y - room.position.z) * 0.2
    if (isPointInBoundary({ x: room.position.x, z: room.position.z }, boundary, 1)) return
  }
}

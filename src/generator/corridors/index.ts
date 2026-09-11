import type { Room, Corridor, LevelConfig, Vec3 } from '@/core/types'

export function generateCorridors(
  rooms: Room[],
  config: LevelConfig
): Corridor[] {
  const corridors: Corridor[] = []
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const processed = new Set<string>()

  // Build spatial index for obstacle avoidance - expanded by corridor width
  const roomBounds = rooms.map(r => ({
    id: r.id,
    minX: r.position.x - r.width / 2 - config.corridorWidth / 2 - 0.5,
    maxX: r.position.x + r.width / 2 + config.corridorWidth / 2 + 0.5,
    minZ: r.position.z - r.depth / 2 - config.corridorWidth / 2 - 0.5,
    maxZ: r.position.z + r.depth / 2 + config.corridorWidth / 2 + 0.5,
    floorIndex: r.floorIndex,
    roomId: r.id,
  }))

  for (const room of rooms) {
    for (const connId of room.connections) {
      const key = [room.id, connId].sort().join('-')
      if (processed.has(key)) continue
      processed.add(key)

      const targetRoom = roomMap.get(connId)
      if (!targetRoom) continue

      // Only connect rooms on same floor
      if (room.floorIndex !== targetRoom.floorIndex) continue

      const corridor = createCorridor(room, targetRoom, config, roomBounds)
      if (corridor) {
        corridors.push(corridor)
      }
    }
  }

  return corridors
}

function createCorridor(
  roomA: Room,
  roomB: Room,
  config: LevelConfig,
  roomBounds: { id: string; minX: number; maxX: number; minZ: number; maxZ: number; floorIndex: number; roomId: string }[]
): Corridor | null {
  // Calculate connection points on room boundaries (door positions)
  const startDoor = findDoorPosition(roomA, roomB.position)
  const endDoor = findDoorPosition(roomB, roomA.position)

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

  // Find path avoiding other rooms using A*
  const path = findPathAStar(startPos, endPos, roomBounds, config.corridorWidth, roomA.floorIndex, roomA.id, roomB.id)
  
  if (!path || path.length < 2) return null

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

function findDoorPosition(room: Room, targetPos: { x: number; z: number }): { x: number; z: number } | null {
  const halfW = room.width / 2
  const halfD = room.depth / 2
  const relX = targetPos.x - room.position.x
  const relZ = targetPos.z - room.position.z
  const absX = Math.abs(relX)
  const absZ = Math.abs(relZ)

  // Determine which wall face the target is closest to
  let doorX = room.position.x
  let doorZ = room.position.z
  const inset = 1.5 // distance from corners

  if (absX > absZ) {
    // Connect to X walls (left/right)
    if (relX > 0) {
      // Right wall (+X)
      doorX = room.position.x + halfW
      doorZ = room.position.z + Math.max(-halfD + inset, Math.min(halfD - inset, relZ))
    } else {
      // Left wall (-X)
      doorX = room.position.x - halfW
      doorZ = room.position.z + Math.max(-halfD + inset, Math.min(halfD - inset, relZ))
    }
  } else {
    // Connect to Z walls (front/back)
    if (relZ > 0) {
      // Back wall (+Z)
      doorZ = room.position.z + halfD
      doorX = room.position.x + Math.max(-halfW + inset, Math.min(halfW - inset, relX))
    } else {
      // Front wall (-Z)
      doorZ = room.position.z - halfD
      doorX = room.position.x + Math.max(-halfW + inset, Math.min(halfW - inset, relX))
    }
  }

  return { x: doorX, z: doorZ }
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
  roomBounds: { id: string; minX: number; maxX: number; minZ: number; maxZ: number; floorIndex: number; roomId: string }[],
  _corridorWidth: number,
  floorIndex: number,
  startRoomId: string,
  endRoomId: string
): Vec3[] | null {
  const cellSize = 1.0 // 1m grid resolution
  
  // Filter bounds for same floor, exclude start/end rooms
  const floorBounds = roomBounds.filter(b => 
    b.floorIndex === floorIndex && 
    b.roomId !== startRoomId && 
    b.roomId !== endRoomId
  )

  // Check if start or end are inside obstacles (shouldn't happen but safety)
  if (isPointBlocked(start, floorBounds) || isPointBlocked(end, floorBounds)) {
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
  const maxIterations = 2000

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

      // Check bounds
      if (isPointBlocked({ x: worldX, y: 0, z: worldZ }, floorBounds)) continue

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
  return findPathSimple(start, end, floorBounds)
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
  
  // Ensure exact start/end
  path[0] = start
  path[path.length - 1] = end
  
  // Simplify
  return simplifyPath(path)
}

function findPathSimple(
  start: Vec3,
  end: Vec3,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }[]
): Vec3[] {
  // Try direct
  if (!lineIntersectsRooms(start, end, bounds, 0)) {
    return [start, end]
  }

  // Try L-shapes
  const path1 = [start, { x: end.x, y: start.y, z: start.z }, end]
  if (!pathIntersectsRooms(path1, bounds, 0)) return simplifyPath(path1)

  const path2 = [start, { x: start.x, y: start.y, z: end.z }, end]
  if (!pathIntersectsRooms(path2, bounds, 0)) return simplifyPath(path2)

  // Try offsets
  const offsets = [4, -4, 7, -7, 10, -10]
  for (const offset of offsets) {
    const path3 = [start, { x: start.x + offset, y: start.y, z: start.z }, { x: start.x + offset, y: start.y, z: end.z }, { x: end.x, y: start.y, z: end.z }, end]
    if (!pathIntersectsRooms(path3, bounds, 0)) return simplifyPath(path3)
    
    const path4 = [start, { x: start.x, y: start.y, z: start.z + offset }, { x: end.x, y: start.y, z: start.z + offset }, { x: end.x, y: start.y, z: end.z }, end]
    if (!pathIntersectsRooms(path4, bounds, 0)) return simplifyPath(path4)
  }

  return [start, end] // Last resort
}

function lineIntersectsRooms(
  a: Vec3,
  b: Vec3,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }[],
  _margin: number
): boolean {
  for (const rect of bounds) {
    if (lineIntersectsRect(a, b, {
      minX: rect.minX,
      maxX: rect.maxX,
      minZ: rect.minZ,
      maxZ: rect.maxZ,
    })) return true
  }
  return false
}

function pathIntersectsRooms(
  path: Vec3[],
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }[],
  _margin: number
): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    if (lineIntersectsRooms(path[i], path[i + 1], bounds, 0)) return true
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

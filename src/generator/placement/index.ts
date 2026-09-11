import type { Room, RoomType, LevelConfig, Boundary } from '@/core/types'
import { SeededRandom } from '@/core/random'

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

  // Process each floor independently
  for (const [floorIndex, floorRooms] of roomsByFloor) {
    const floorPlaced = placeRoomsOnFloor(floorRooms, boundary, config, random, floorIndex)
    for (const room of floorPlaced) {
      placedRooms.push(room)
      roomMap.set(room.id, room)
    }
  }

  return placedRooms
}


function placeRoomsOnFloor(
  rooms: Room[],
  boundary: Boundary,
  config: LevelConfig,
  random: SeededRandom,
  _floorIndex: number
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

  for (const room of sorted) {
    const connections = adjacency.get(room.id) || []
    let pos: { x: number; z: number } | null = null

    // Try to place near connected rooms that are already placed
    if (connections.length > 0) {
      const placedConnections = connections.filter(c => 
        placed.some(p => p.id === c)
      )
      
      if (placedConnections.length > 0) {
        // Average position of connected rooms
        let avgX = 0, avgZ = 0
        for (const connId of placedConnections) {
          const connRoom = placed.find(p => p.id === connId)!
          avgX += connRoom.position.x
          avgZ += connRoom.position.z
        }
        avgX /= placedConnections.length
        avgZ /= placedConnections.length

        // Try positions around the average, biased toward connection direction
        pos = findPositionNearConnections(room, avgX, avgZ, placedConnections, placed, boundary, config, random, occupied)
      }
    }

    // Fallback: random valid position
    if (!pos) {
      pos = findRandomPosition(room, boundary, occupied, config, random)
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
  return resolveOverlapsOnFloor(placed, boundary, _floorIndex)
}


function findPositionNearConnections(
  room: Room,
  centerX: number,
  centerZ: number,
  connectionIds: string[],
  placed: Room[],
  boundary: Boundary,
  config: LevelConfig,
  _random: SeededRandom,
  occupied: { x: number; z: number; w: number; d: number; roomId: string }[]
): { x: number; z: number } | null {
  const roomMap = new Map(placed.map(r => [r.id, r]))
  const margin = config.corridorWidth + 1.5
  const maxDist = 15

  // Try positions in a spiral around center
  for (let radius = 4; radius <= maxDist; radius += 2) {
    const steps = Math.max(8, Math.floor(radius * 2))
    for (let step = 0; step < steps; step++) {
      const angle = (step / steps) * Math.PI * 2
      const x = centerX + Math.cos(angle) * radius
      const z = centerZ + Math.sin(angle) * radius

      // Clamp to boundary
      const halfW = room.width / 2
      const halfD = room.depth / 2
      const clampedX = Math.max(-boundary.width / 2 + halfW + margin, Math.min(boundary.width / 2 - halfW - margin, x))
      const clampedZ = Math.max(-boundary.depth / 2 + halfD + margin, Math.min(boundary.depth / 2 - halfD - margin, z))

      if (!overlapsAny({ x: clampedX, z: clampedZ }, room, occupied)) {
        // Check if this position allows reasonable corridor connections
        let valid = true
        for (const connId of connectionIds) {
          const connRoom = roomMap.get(connId)
          if (connRoom) {
            const dist = Math.sqrt((clampedX - connRoom.position.x) ** 2 + (clampedZ - connRoom.position.z) ** 2)
            if (dist > maxDist * 1.5) valid = false
          }
        }
        if (valid) return { x: clampedX, z: clampedZ }
      }
    }
  }

  return null
}


function findRandomPosition(
  room: Room,
  boundary: Boundary,
  occupied: { x: number; z: number; w: number; d: number; roomId: string }[],
  config: LevelConfig,
  random: SeededRandom
): { x: number; z: number } | null {
  const margin = config.corridorWidth + 1
  const halfW = room.width / 2
  const halfD = room.depth / 2

  const maxX = boundary.width / 2 - halfW - margin
  const minX = -boundary.width / 2 + halfW + margin
  const maxZ = boundary.depth / 2 - halfD - margin
  const minZ = -boundary.depth / 2 + halfD + margin

  if (maxX < minX || maxZ < minZ) return null

  const attempts = 50
  for (let i = 0; i < attempts; i++) {
    const x = random.nextFloat(minX, maxX)
    const z = random.nextFloat(minZ, maxZ)
    if (!overlapsAny({ x, z }, room, occupied)) {
      return { x, z }
    }
  }
  return null
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
  occupied: { x: number; z: number; w: number; d: number; roomId: string }[]
): boolean {
  const halfW = room.width / 2 + 0.5 // extra clearance
  const halfD = room.depth / 2 + 0.5

  for (const occ of occupied) {
    const occHalfW = occ.w / 2
    const occHalfD = occ.d / 2

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


export function resolveOverlaps(rooms: Room[], boundary: Boundary): Room[] {
  // Group by floor and resolve each floor
  const byFloor = new Map<number, Room[]>()
  for (const room of rooms) {
    if (!byFloor.has(room.floorIndex)) byFloor.set(room.floorIndex, [])
    byFloor.get(room.floorIndex)!.push(room)
  }

  const result: Room[] = []
  for (const [floorIndex, floorRooms] of byFloor) {
    result.push(...resolveOverlapsOnFloor(floorRooms, boundary, floorIndex))
  }
  return result
}


function resolveOverlapsOnFloor(rooms: Room[], boundary: Boundary, _floorIndex: number): Room[] {
  const result = [...rooms]
  const maxIterations = 100
  let pushForce = 0.3
  const minSeparation = 1.0 // minimum gap between rooms

  for (let iter = 0; iter < maxIterations; iter++) {
    let hasOverlap = false
    let maxOverlap = 0

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

        if (overlapX > 0 && overlapZ > 0) {
          hasOverlap = true
          maxOverlap = Math.max(maxOverlap, overlapX, overlapZ)
          
          // Push apart proportionally to overlap
          const pushFactor = pushForce * (1 + overlapX / minDistX + overlapZ / minDistZ)
          const pushX = overlapX * pushFactor * (dx >= 0 ? 1 : -1)
          const pushZ = overlapZ * pushFactor * (dz >= 0 ? 1 : -1)

          result[i] = { ...a, position: { ...a.position, x: a.position.x + pushX, z: a.position.z + pushZ } }
          result[j] = { ...b, position: { ...b.position, x: b.position.x - pushX, z: b.position.z - pushZ } }

          clampToBoundary(result[i], boundary)
          clampToBoundary(result[j], boundary)
        }
      }
    }

    if (!hasOverlap) break
    // If overlaps persist, increase push force
    if (iter > 50) pushForce *= 1.1
  }

  // Final verification - if still overlapping, spread them out
  return verifyAndFixOverlaps(result, boundary)
}


function verifyAndFixOverlaps(rooms: Room[], boundary: Boundary): Room[] {
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
    
    // Arrange in a circle
    const centerX = cellRooms.reduce((sum, r) => sum + r.position.x, 0) / cellRooms.length
    const centerZ = cellRooms.reduce((sum, r) => sum + r.position.z, 0) / cellRooms.length
    const radius = Math.max(...cellRooms.map(r => 
      Math.sqrt((r.position.x - centerX) ** 2 + (r.position.z - centerZ) ** 2)
    )) + 5

    for (let i = 0; i < cellRooms.length; i++) {
      const angle = (i / cellRooms.length) * Math.PI * 2
      const room = cellRooms[i]
      room.position.x = Math.max(-boundary.width / 2 + room.width / 2 + 1,
        Math.min(boundary.width / 2 - room.width / 2 - 1, centerX + Math.cos(angle) * radius))
      room.position.z = Math.max(-boundary.depth / 2 + room.depth / 2 + 1,
        Math.min(boundary.depth / 2 - room.depth / 2 - 1, centerZ + Math.sin(angle) * radius))
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
}

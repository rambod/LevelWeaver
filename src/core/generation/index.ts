import type { LevelConfig, Room, Corridor, Boundary, DoorOpening } from '@/core/types'
import { FLOOR_HEIGHT, DOOR_WIDTH, DOOR_HEIGHT } from '@/core/types'
import { SeededRandom } from '@/core/random'
import { buildLevelGraph, validateLevelGraph } from '@/core/levelGraph'
import { generateBoundary } from '@/generator/boundary'
import { generateTopology } from '@/generator/topology'
import { assignRoomSizes, placeRooms, resolveOverlaps } from '@/generator/rooms'
import { generateCorridors } from '@/generator/corridors'
import { generateRoomGeometry, generateCorridorGeometry, generateStairsGeometry } from '@/generator/geometry'
import { findVerticalLinks } from '@/generator/vertical'

export interface GeneratedLevel {
  config: LevelConfig
  boundary: Boundary
  rooms: Room[]
  corridors: Corridor[]
  stairs: ReturnType<typeof generateStairsGeometry>
  roomGeometry: ReturnType<typeof generateRoomGeometry>
  corridorGeometry: ReturnType<typeof generateCorridorGeometry>
  seed: number
}

export function generateLevel(config: LevelConfig): GeneratedLevel {
  const random = new SeededRandom(config.seed)

  // Stage 1: Generate boundary
  const boundary = generateBoundary(config, random)

  // Stage 2: Generate topology (room graph)
  let rooms = generateTopology(config, boundary, random)

  // Stage 3: Assign room sizes
  rooms = assignRoomSizes(rooms, config, random)

  // Stage 4: Place rooms spatially
  rooms = placeRooms(rooms, boundary, config, random)

  // Stage 5: Resolve overlaps
  rooms = resolveOverlaps(rooms, boundary)

  // Stage 6: Generate corridors
  const corridors = generateCorridors(rooms, config)

  // Stage 6b: Plan vertical links + validate the abstract level graph
  // before building geometry. Stair links count as connections: a room
  // whose only link is vertical is reachable, not isolated.
  const verticalLinks = findVerticalLinks(rooms)
  const graph = buildLevelGraph(rooms, corridors, config.floorCount, boundary)
  const validation = validateLevelGraph(graph, verticalLinks)
  if (validation.isolatedRooms.length > 0) {
    console.warn(
      `[LevelWeaver] ${validation.isolatedRooms.length} room(s) have no corridor or stair connections:`,
      validation.isolatedRooms,
    )
  }

  // Stage 7: Compute door openings from corridor connections
  const doorOpenings = computeDoorOpenings(rooms, corridors)

  // Stage 8: Generate geometry
  const roomGeometry = generateRoomGeometry(rooms, doorOpenings)
  const corridorGeometry = generateCorridorGeometry(corridors)
  const stairs = generateStairsGeometry(rooms, { floorHeight: FLOOR_HEIGHT })

  return {
    config,
    boundary,
    rooms,
    corridors,
    stairs,
    roomGeometry,
    corridorGeometry,
    seed: config.seed,
  }
}

function computeDoorOpenings(rooms: Room[], corridors: Corridor[]): Map<string, DoorOpening[]> {
  const doorMap = new Map<string, DoorOpening[]>()
  const roomMap = new Map(rooms.map(r => [r.id, r]))

  for (const corridor of corridors) {
    const startRoom = roomMap.get(corridor.startRoomId)
    const endRoom = roomMap.get(corridor.endRoomId)
    if (!startRoom || !endRoom) continue

    // Add door to start room
    const startDoor = findDoorPosition(startRoom, corridor.startPos)
    if (startDoor) {
      if (!doorMap.has(startRoom.id)) doorMap.set(startRoom.id, [])
      doorMap.get(startRoom.id)!.push(startDoor)
    }

    // Add door to end room
    const endDoor = findDoorPosition(endRoom, corridor.endPos)
    if (endDoor) {
      if (!doorMap.has(endRoom.id)) doorMap.set(endRoom.id, [])
      doorMap.get(endRoom.id)!.push(endDoor)
    }
  }

  return doorMap
}

function findDoorPosition(room: Room, corridorPos: { x: number; y: number; z: number }): DoorOpening | null {
  const halfW = room.width / 2
  const halfD = room.depth / 2
  const relX = corridorPos.x - room.position.x
  const relZ = corridorPos.z - room.position.z

  const absX = Math.abs(relX)
  const absZ = Math.abs(relZ)

  // Determine which wall the corridor connects to
  let wallIndex: number
  let doorCenter: number
  const doorWidth = DOOR_WIDTH
  const doorHeight = DOOR_HEIGHT

  if (absX > absZ) {
    // Connects to +X or -X wall
    if (relX > 0) {
      wallIndex = 1 // +X wall (right)
      doorCenter = relZ
    } else {
      wallIndex = 3 // -X wall (left)
      doorCenter = relZ
    }
  } else {
    // Connects to +Z or -Z wall
    if (relZ > 0) {
      wallIndex = 2 // +Z wall (back)
      doorCenter = relX
    } else {
      wallIndex = 0 // -Z wall (front)
      doorCenter = relX
    }
  }

  // Clamp door position to wall bounds with margin
  const wallLength = wallIndex % 2 === 0 ? room.width : room.depth
  const maxCenter = wallLength / 2 - doorWidth / 2 - 0.3
  const minCenter = -wallLength / 2 + doorWidth / 2 + 0.3
  const clampedCenter = Math.max(minCenter, Math.min(maxCenter, doorCenter))

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
  }
}

export function regenerateLevel(config: LevelConfig, newSeed?: number): GeneratedLevel {
  const newConfig = newSeed !== undefined ? { ...config, seed: newSeed } : config
  return generateLevel(newConfig)
}
import type { LevelConfig, Room, Corridor, Boundary, DoorOpening, StairsGeometry } from '@/core/types'
import { FLOOR_HEIGHT, DOOR_HEIGHT } from '@/core/types'
import { SeededRandom } from '@/core/random'
import { buildLevelGraph, validateLevelGraph } from '@/core/levelGraph'
import { generateBoundary } from '@/generator/boundary'
import { generateTopology } from '@/generator/topology'
import { assignRoomSizes, placeRooms, resolveOverlaps } from '@/generator/rooms'
import { generateCorridors } from '@/generator/corridors'
import { generateRoomGeometry, generateCorridorGeometry } from '@/generator/geometry'
import type { RoomSlabHoles } from '@/generator/geometry'
import { planStairs, buildStairsGeometry } from '@/generator/vertical'

export interface GeneratedLevel {
  config: LevelConfig
  boundary: Boundary
  rooms: Room[]
  corridors: Corridor[]
  stairs: StairsGeometry[]
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

  // Stage 5: Resolve overlaps (keep corridor-sized gaps between rooms)
  rooms = resolveOverlaps(rooms, boundary, config.corridorWidth + 1.0)

  // Stage 6: Generate corridors
  const corridors = generateCorridors(rooms, config)

  // Stage 7: Compute door openings from corridor connections
  const doorOpenings = computeDoorOpenings(rooms, corridors)

  // Stage 7b: Plan stairs inside rooms (needs doors for placement) and
  // reserve matching floor/ceiling holes for the stairwells.
  const stairPlans = planStairs(rooms, doorOpenings)
  const slabHoles = computeSlabHoles(rooms, stairPlans)

  // Stage 8: Generate geometry
  const roomGeometry = generateRoomGeometry(rooms, doorOpenings, slabHoles)
  const corridorGeometry = generateCorridorGeometry(corridors)
  const stairs = buildStairsGeometry(stairPlans, rooms, FLOOR_HEIGHT)

  // Stage 8b: Validate the abstract level graph. Stair links count as
  // connections: a room whose only link is vertical is reachable.
  const graph = buildLevelGraph(rooms, corridors, config.floorCount, boundary)
  const validation = validateLevelGraph(graph, stairPlans.map(p => p.link))
  if (validation.isolatedRooms.length > 0) {
    console.warn(
      `[LevelWeaver] ${validation.isolatedRooms.length} room(s) have no corridor or stair connections:`,
      validation.isolatedRooms,
    )
  }

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

// Stairwell holes: the host (lower) room always gets a ceiling hole above
// its stairs; the upper room gets a floor hole where the stair footprint
// overlaps it, so the landing genuinely arrives upstairs.
function computeSlabHoles(
  rooms: Room[],
  stairPlans: ReturnType<typeof planStairs>
): Map<string, RoomSlabHoles> {
  const holes = new Map<string, RoomSlabHoles>()
  const roomMap = new Map(rooms.map(r => [r.id, r]))

  const roomRect = (r: Room) => ({
    minX: r.position.x - r.width / 2,
    maxX: r.position.x + r.width / 2,
    minZ: r.position.z - r.depth / 2,
    maxZ: r.position.z + r.depth / 2,
  })
  const overlaps = (a: ReturnType<typeof roomRect>, b: ReturnType<typeof roomRect>) =>
    a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ

  const put = (roomId: string, patch: RoomSlabHoles) => {
    holes.set(roomId, { ...holes.get(roomId), ...patch })
  }

  for (const plan of stairPlans) {
    const lower = roomMap.get(plan.link.lowerRoomId)!
    const upper = roomMap.get(plan.link.upperRoomId)!
    if (!lower || !upper) continue

    const halfW = (plan.axis === 'z' ? plan.width : plan.depth) / 2
    const halfD = (plan.axis === 'z' ? plan.depth : plan.width) / 2
    const world = {
      minX: plan.x - halfW,
      maxX: plan.x + halfW,
      minZ: plan.z - halfD,
      maxZ: plan.z + halfD,
    }
    // Room-local hole for the host.
    put(plan.hostRoomId, {
      ceiling: {
        minX: world.minX - lower.position.x,
        maxX: world.maxX - lower.position.x,
        minZ: world.minZ - lower.position.z,
        maxZ: world.maxZ - lower.position.z,
      },
    })
    // Matching floor hole upstairs where the footprints overlap.
    if (overlaps(world, roomRect(upper))) {
      put(upper.id, {
        floor: {
          minX: Math.max(world.minX, upper.position.x - upper.width / 2) - upper.position.x,
          maxX: Math.min(world.maxX, upper.position.x + upper.width / 2) - upper.position.x,
          minZ: Math.max(world.minZ, upper.position.z - upper.depth / 2) - upper.position.z,
          maxZ: Math.min(world.maxZ, upper.position.z + upper.depth / 2) - upper.position.z,
        },
      })
    }
  }

  return holes
}

function computeDoorOpenings(rooms: Room[], corridors: Corridor[]): Map<string, DoorOpening[]> {
  const doorMap = new Map<string, DoorOpening[]>()
  const roomMap = new Map(rooms.map(r => [r.id, r]))

  for (const corridor of corridors) {
    const startRoom = roomMap.get(corridor.startRoomId)
    const endRoom = roomMap.get(corridor.endRoomId)
    if (!startRoom || !endRoom) continue

    // Add door to start room (opening matches the corridor mouth).
    // The wall is chosen by direction to the other room (same rule as the
    // corridor router); the center reuses the corridor's door point so the
    // hole and the mouth land on identical centers.
    const startDoor = findDoorPosition(startRoom, endRoom.position, corridor.startPos, corridor.width)
    if (startDoor) {
      if (!doorMap.has(startRoom.id)) doorMap.set(startRoom.id, [])
      doorMap.get(startRoom.id)!.push(startDoor)
    }

    // Add door to end room
    const endDoor = findDoorPosition(endRoom, startRoom.position, corridor.endPos, corridor.width)
    if (endDoor) {
      if (!doorMap.has(endRoom.id)) doorMap.set(endRoom.id, [])
      doorMap.get(endRoom.id)!.push(endDoor)
    }
  }

  return doorMap
}

function findDoorPosition(
  room: Room,
  targetPos: { x: number; z: number },
  doorPos: { x: number; y: number; z: number },
  corridorWidth: number
): DoorOpening | null {
  const halfW = room.width / 2
  const halfD = room.depth / 2
  // Wall choice follows the direction to the other room (identical rule to
  // the corridor router). The center follows the corridor's door point,
  // which is already clamped, so this clamp is idempotent.
  const relTX = targetPos.x - room.position.x
  const relTZ = targetPos.z - room.position.z
  const relDX = doorPos.x - room.position.x
  const relDZ = doorPos.z - room.position.z

  // Determine which wall the corridor connects to
  let wallIndex: number
  let doorCenter: number
  const doorHeight = DOOR_HEIGHT

  if (Math.abs(relTX) > Math.abs(relTZ)) {
    // Connects to +X or -X wall
    if (relTX > 0) {
      wallIndex = 1 // +X wall (right)
    } else {
      wallIndex = 3 // -X wall (left)
    }
    doorCenter = relDZ
  } else {
    // Connects to +Z or -Z wall
    if (relTZ > 0) {
      wallIndex = 2 // +Z wall (back)
    } else {
      wallIndex = 0 // -Z wall (front)
    }
    doorCenter = relDX
  }

  // Clamp door position to wall bounds with margin. The opening matches
  // the corridor mouth; on narrow walls it shrinks to fit.
  const wallLength = wallIndex % 2 === 0 ? room.width : room.depth
  const doorWidth = Math.max(1.0, Math.min(corridorWidth, wallLength - 0.6))
  const maxCenter = wallLength / 2 - doorWidth / 2 - 0.3
  const minCenter = -wallLength / 2 + doorWidth / 2 + 0.3
  const clampedCenter = maxCenter >= minCenter
    ? Math.max(minCenter, Math.min(maxCenter, doorCenter))
    : 0

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
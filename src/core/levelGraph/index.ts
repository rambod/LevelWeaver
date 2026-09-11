import type { Room, Corridor, LevelGraph, VerticalLink } from '@/core/types'

// Abstract level-graph helpers (LEVELWEAVER.md section 7: meaningful room
// relationships exist BEFORE geometry). The generator pipeline builds rooms
// and corridors first; these helpers assemble and validate the graph view.
export function buildLevelGraph(
  rooms: Room[],
  corridors: Corridor[],
  floorCount: number,
  boundary: LevelGraph['boundary'],
): LevelGraph {
  return {
    rooms,
    corridors,
    stairs: [],
    boundary,
    floorCount,
  }
}

export interface GraphValidation {
  isolatedRooms: string[]
  floorRoomCounts: number[]
}

// Fail-soft validation: returns problems instead of throwing so a flawed
// prototype still renders and the issue is visible in the console.
// Both corridor links and stair (vertical) links count as connections.
export function validateLevelGraph(graph: LevelGraph, stairLinks: VerticalLink[] = []): GraphValidation {
  const degree = new Map<string, number>()
  for (const room of graph.rooms) {
    degree.set(room.id, 0)
  }
  for (const corridor of graph.corridors) {
    degree.set(corridor.startRoomId, (degree.get(corridor.startRoomId) ?? 0) + 1)
    degree.set(corridor.endRoomId, (degree.get(corridor.endRoomId) ?? 0) + 1)
  }
  for (const link of stairLinks) {
    degree.set(link.lowerRoomId, (degree.get(link.lowerRoomId) ?? 0) + 1)
    degree.set(link.upperRoomId, (degree.get(link.upperRoomId) ?? 0) + 1)
  }

  const isolatedRooms = graph.rooms
    .filter(room => (degree.get(room.id) ?? 0) === 0 && graph.rooms.length > 1)
    .map(room => room.id)

  const floorRoomCounts: number[] = []
  for (let floor = 0; floor < graph.floorCount; floor++) {
    floorRoomCounts.push(graph.rooms.filter(r => r.floorIndex === floor).length)
  }

  return { isolatedRooms, floorRoomCounts }
}

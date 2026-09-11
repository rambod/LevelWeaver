import type { Room, RoomType, LevelConfig } from '@/core/types'
import { SeededRandom } from '@/core/random'

// Room sizing (pipeline stage: "Assign room sizes"). Spatial placement lives
// in `@/generator/placement` and is re-exported here for backwards compatibility.

const ROOM_BASE_SIZES: Record<RoomType, { w: number; d: number; h: number }> = {
  spawn: { w: 7, d: 7, h: 3.5 },
  exit: { w: 7, d: 7, h: 3.5 },
  standard: { w: 6, d: 6, h: 3.5 },
  hall: { w: 12, d: 5, h: 3.5 },
  hub: { w: 14, d: 14, h: 4 },
  arena: { w: 18, d: 18, h: 4 },
  objective: { w: 8, d: 8, h: 3.5 },
  storage: { w: 7, d: 10, h: 3.5 },
  connector: { w: 5, d: 5, h: 3.5 },
  verticalConnector: { w: 4, d: 4, h: 4 },
}


export function assignRoomSizes(rooms: Room[], config: LevelConfig, random: SeededRandom): Room[] {
  return rooms.map(room => {
    const base = ROOM_BASE_SIZES[room.type]
    const variation = config.roomSizeVariation
    const sizeMultiplier = 1 + random.nextFloat(-variation, variation)

    return {
      ...room,
      width: Math.max(3, base.w * sizeMultiplier),
      depth: Math.max(3, base.d * sizeMultiplier),
      height: base.h,
    }
  })
}


export { placeRooms, resolveOverlaps } from '@/generator/placement'

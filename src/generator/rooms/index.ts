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
  // Stair hall: sized to host a legal stair flight. A 4 m rise needs
  // ~6.5 m of straight run (or ~4.7 m folded) plus landings and approach
  // space — a 4x4 closet can never host stairs (lawbook §40-43), so the
  // hall reserves real circulation volume instead of forcing broken links.
  verticalConnector: { w: 7, d: 9, h: 4 },
}


export function assignRoomSizes(rooms: Room[], config: LevelConfig, random: SeededRandom): Room[] {
  return rooms.map(room => {
    const base = ROOM_BASE_SIZES[room.type]
    const variation = config.roomSizeVariation
    const sizeMultiplier = 1 + random.nextFloat(-variation, variation)

    let width = Math.max(3, base.w * sizeMultiplier)
    let depth = Math.max(3, base.d * sizeMultiplier)
    if (room.type === 'verticalConnector') {
      // Stair-hall minimum: a legal folded flight needs ~4.9 m along one
      // axis and ~2.9 m across (footprint + wall inset). Variation must
      // never shrink the hall below a hostable volume (lawbook §17: size
      // rules account for intended portals — here, the stair shaft).
      width = Math.max(5.5, width)
      depth = Math.max(6.5, depth)
    }
    return {
      ...room,
      width,
      depth,
      // Uniform wall height from properties (stays below floor spacing).
      height: config.wallHeight,
    }
  })
}


export { placeRooms, resolveOverlaps } from '@/generator/placement'

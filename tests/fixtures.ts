import type { GeneratedLevel } from '../src/core/generation'
import { getDefaultConfig } from '../src/core/presets'
import { GENERATOR_VERSION } from '../src/core/rules'
import { generateRoomGeometry } from '../src/generator/geometry'
import type { Room } from '../src/core/types'

// Small adapter fixture; generator correctness is tested separately by seed.
export function fixtureLevel(): GeneratedLevel {
  const config = getDefaultConfig()
  const rooms: Room[] = [{
    id: 'room_0', type: 'spawn', position: { x: 2, y: 0, z: 3 },
    width: 8, depth: 8, height: config.wallHeight, floorIndex: 0,
    materialTheme: config.theme, connections: [],
  }]
  return {
    config, rooms, seed: config.seed, generatorVersion: GENERATOR_VERSION,
    floorHeight: 4, boundary: { shape: 'square', width: 50, depth: 50, center: { x: 0, y: 0 } },
    corridors: [], stairs: [], roomGeometry: generateRoomGeometry(rooms, new Map()),
    corridorGeometry: [], ok: true, validation: { issues: [], errors: [], warnings: [] },
  }
}

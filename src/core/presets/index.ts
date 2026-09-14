import type { LevelConfig, MapShape, RoomType } from '@/core/types'
import { SeededRandom } from '@/core/random'

export interface Preset {
  name: string
  config: Partial<LevelConfig>
  /**
   * Room-type lottery multipliers (lawbook §89: presets shape topology
   * preference, not just counts). Multiplies the base table weight per
   * type; missing types default to 1. Pure data — the lottery lives in
   * `@/generator/topology`, validity rules are never bypassed (§88).
   */
  roomTypeWeights?: Partial<Record<RoomType, number>>
}

export const presets: Record<string, Preset> = {
  fpsArena: {
    name: 'FPS Arena',
    config: {
      shape: 'hub',
      roomCount: 16,
      floorCount: 2,
      connectivity: 0.8,
      verticality: 0.5,
      deadEnds: 0.05,
      roomSizeVariation: 0.5,
      largeRoomCount: 2,
    wallHeight: 3.5,
      corridorWidth: 3,
    },
    // Open fight spaces, few closets.
    roomTypeWeights: { arena: 2.5, hub: 2, connector: 1.5, storage: 0.4 },
  },
  dungeon: {
    name: 'Dungeon',
    config: {
      shape: 'rectangle',
      roomCount: 20,
      floorCount: 3,
      connectivity: 0.4,
      verticality: 0.7,
      deadEnds: 0.3,
      roomSizeVariation: 0.4,
      largeRoomCount: 1,
    wallHeight: 3.8,
      corridorWidth: 2.5,
    },
    // Irregular many-small-rooms sprawl.
    roomTypeWeights: { standard: 2, storage: 1.5, connector: 1.5, hub: 0.6 },
  },
  researchFacility: {
    name: 'Research Facility',
    config: {
      shape: 'rectangle',
      roomCount: 18,
      floorCount: 2,
      connectivity: 0.6,
      verticality: 0.3,
      deadEnds: 0.1,
      roomSizeVariation: 0.3,
      largeRoomCount: 2,
    wallHeight: 3.5,
      // Lawbook §106: believable circulation — wide but within the
      // 1.8-3.0 m FPS band, never above it.
      corridorWidth: 3,
    },
    roomTypeWeights: { standard: 1.8, hall: 1.5, arena: 0.6 },
  },
  office: {
    name: 'Office',
    config: {
      shape: 'rectangle',
      roomCount: 24,
      floorCount: 3,
      connectivity: 0.5,
      verticality: 0.4,
      deadEnds: 0.15,
      roomSizeVariation: 0.2,
      largeRoomCount: 1,
    wallHeight: 3.2,
      corridorWidth: 2.5,
    },
    // Low ceilings, regular bands of halls and standards.
    roomTypeWeights: { hall: 2.5, standard: 2, storage: 1.5, arena: 0.3, hub: 0.7 },
  },
  militaryBunker: {
    name: 'Military Bunker',
    config: {
      shape: 'cross',
      roomCount: 14,
      floorCount: 2,
      connectivity: 0.3,
      verticality: 0.6,
      deadEnds: 0.2,
      roomSizeVariation: 0.4,
      largeRoomCount: 2,
    wallHeight: 3.5,
      corridorWidth: 3,
    },
    roomTypeWeights: { standard: 1.8, storage: 2, hall: 1.5, arena: 0.6 },
  },
  warehouse: {
    name: 'Warehouse',
    config: {
      shape: 'rectangle',
      roomCount: 10,
      floorCount: 1,
      connectivity: 0.7,
      verticality: 0.1,
      deadEnds: 0.05,
      roomSizeVariation: 0.6,
      largeRoomCount: 3,
    wallHeight: 4.2,
      corridorWidth: 4,
    },
    // High-bay chambers, few connectors.
    roomTypeWeights: { arena: 2.5, hub: 2, storage: 1.5, hall: 0.5, connector: 0.5 },
  },
  sciFiFacility: {
    name: 'Sci-Fi Facility',
    config: {
      shape: 'radial',
      roomCount: 16,
      floorCount: 2,
      connectivity: 0.65,
      verticality: 0.4,
      deadEnds: 0.1,
      roomSizeVariation: 0.4,
      largeRoomCount: 2,
    wallHeight: 3.5,
      corridorWidth: 3,
    },
    roomTypeWeights: { hub: 1.8, hall: 1.5, standard: 1.2 },
  },
  horrorFacility: {
    name: 'Horror Facility',
    config: {
      shape: 'branching',
      roomCount: 18,
      floorCount: 2,
      connectivity: 0.35,
      verticality: 0.5,
      deadEnds: 0.4,
      roomSizeVariation: 0.5,
      largeRoomCount: 1,
    wallHeight: 3.2,
      corridorWidth: 2.5,
    },
    // Low ceilings, branchy halls and closets, few open chambers.
    roomTypeWeights: { hall: 2, storage: 2, standard: 1.5, connector: 1.5, arena: 0.5, hub: 0.6 },
  },
}

export const shapes: { value: MapShape; label: string }[] = [
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'square', label: 'Square' },
  { value: 'ring', label: 'Ring' },
  { value: 'cross', label: 'Cross' },
  { value: 'radial', label: 'Radial' },
  { value: 'hub', label: 'Hub' },
  { value: 'linear', label: 'Linear' },
  { value: 'branching', label: 'Branching' },
]

export const themes = [
  'greybox',
  'industrial',
  'sciFi',
  'dungeon',
  'office',
  'military',
  'laboratory',
]

// Base lottery weights (lawbook §89 neutral profile): the topology table
// draws from these, multiplied by the active preset's roomTypeWeights.
// Spawn/exit are mandatory placements, never lottery draws.
export const BASE_ROOM_TYPE_WEIGHTS: Record<RoomType, number> = {
  standard: 4,
  hall: 2,
  hub: 1,
  arena: 1,
  objective: 1,
  storage: 1,
  connector: 1,
  verticalConnector: 1,
  spawn: 0,
  exit: 0,
}

/**
 * Seeded weighted room-type draw. Deterministic for (random state,
 * weights); stable key order keeps streams reproducible across presets.
 */
export function pickWeightedRoomType(
  random: SeededRandom,
  weights?: Partial<Record<RoomType, number>>,
): RoomType {
  const entries = (Object.keys(BASE_ROOM_TYPE_WEIGHTS) as RoomType[])
    .map(t => ({ t, w: BASE_ROOM_TYPE_WEIGHTS[t] * (weights?.[t] ?? 1) }))
    .filter(e => e.w > 0)
  const total = entries.reduce((s, e) => s + e.w, 0)
  let roll = random.nextFloat(0, total)
  for (const e of entries) {
    roll -= e.w
    if (roll <= 0) return e.t
  }
  return entries[entries.length - 1].t
}

export function getDefaultConfig(): LevelConfig {  return {
    seed: 492817,
    preset: 'fpsArena',
    shape: 'hub',
    area: 5000,
    roomCount: 16,
    floorCount: 2,
    roomSizeVariation: 0.5,
    // Lawbook §106: comfortable middle of the 1.8-3.0 m FPS band
    // (presets override per theme; hard minimum 0.80 m is enforced).
    corridorWidth: 2.5,
    connectivity: 0.8,
    verticality: 0.5,
    deadEnds: 0.05,
    largeRoomCount: 2,
    wallHeight: 3.5,
    // Gate (door) clear opening: must admit the 1.8 m playtester
    // (lawbook §24-25: >= 0.80 m wide, >= 2.00 m high).
    doorWidth: 1.8,
    doorHeight: 2.4,
    theme: 'greybox',
  }
}

export function applyPreset(config: LevelConfig, presetKey: string): LevelConfig {
  const preset = presets[presetKey]
  if (!preset) return config
  return { ...config, ...preset.config, preset: presetKey }
}
import type { LevelConfig, MapShape } from '@/core/types'

export interface Preset {
  name: string
  config: Partial<LevelConfig>
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
    wallHeight: 3.5,
      corridorWidth: 2.5,
    },
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
      corridorWidth: 3.5,
    },
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
    wallHeight: 3.5,
      corridorWidth: 2.5,
    },
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
    wallHeight: 3.5,
      corridorWidth: 4,
    },
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
    wallHeight: 3.5,
      corridorWidth: 2.5,
    },
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

export function getDefaultConfig(): LevelConfig {
  return {
    seed: 492817,
    preset: 'fpsArena',
    shape: 'hub',
    area: 5000,
    roomCount: 16,
    floorCount: 2,
    roomSizeVariation: 0.5,
    corridorWidth: 3,
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
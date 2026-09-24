import * as THREE from 'three'
import type { MaterialTheme } from '../../core/types'

const themes: Record<string, MaterialTheme> = {
  greybox: {
    name: 'Greybox',
    // Default prototype look: lifted a stop vs pure mid-grey so walk-mode
    // interiors read under doorway-only lighting; trim stays near-white
    // so door liners and edges separate from walls at a glance.
    wall: { color: 0x999999, roughness: 0.9, metalness: 0.0 },
    floor: { color: 0x777777, roughness: 0.95, metalness: 0.0 },
    ceiling: { color: 0x555555, roughness: 1.0, metalness: 0.0 },
    trim: { color: 0xcccccc, roughness: 0.8, metalness: 0.1 },
    door: { color: 0x555555, roughness: 0.7, metalness: 0.2 },
    accent: { color: 0x00ff88, roughness: 0.5, metalness: 0.5 },
  },
  industrial: {
    name: 'Industrial',
    wall: { color: 0x5a5a5a, roughness: 0.85, metalness: 0.2 },
    floor: { color: 0x3a3a3a, roughness: 0.9, metalness: 0.1 },
    ceiling: { color: 0x2a2a2a, roughness: 0.95, metalness: 0.05 },
    trim: { color: 0x8b7355, roughness: 0.7, metalness: 0.4 },
    door: { color: 0x4a4a4a, roughness: 0.6, metalness: 0.5 },
    accent: { color: 0xff8800, roughness: 0.4, metalness: 0.6 },
  },
  sciFi: {
    name: 'Sci-Fi',
    wall: { color: 0x2a3a4a, roughness: 0.6, metalness: 0.7 },
    floor: { color: 0x1a2a3a, roughness: 0.5, metalness: 0.8 },
    ceiling: { color: 0x1a2a3a, roughness: 0.5, metalness: 0.8 },
    trim: { color: 0x00ffff, roughness: 0.2, metalness: 0.9 },
    door: { color: 0x0088ff, roughness: 0.3, metalness: 0.8 },
    accent: { color: 0xff00ff, roughness: 0.3, metalness: 0.7 },
  },
  dungeon: {
    name: 'Dungeon',
    wall: { color: 0x3a2a1a, roughness: 0.95, metalness: 0.0 },
    floor: { color: 0x2a1a10, roughness: 0.98, metalness: 0.0 },
    ceiling: { color: 0x1a1008, roughness: 1.0, metalness: 0.0 },
    trim: { color: 0x5a3a2a, roughness: 0.9, metalness: 0.05 },
    door: { color: 0x4a2a1a, roughness: 0.85, metalness: 0.1 },
    accent: { color: 0x884400, roughness: 0.8, metalness: 0.1 },
  },
  office: {
    name: 'Office',
    wall: { color: 0xd0d0d0, roughness: 0.85, metalness: 0.0 },
    floor: { color: 0x8a7a6a, roughness: 0.9, metalness: 0.0 },
    ceiling: { color: 0xf0f0f0, roughness: 0.95, metalness: 0.0 },
    trim: { color: 0xaaa090, roughness: 0.8, metalness: 0.05 },
    door: { color: 0x7a6a5a, roughness: 0.7, metalness: 0.1 },
    accent: { color: 0x0066cc, roughness: 0.4, metalness: 0.2 },
  },
  military: {
    name: 'Military',
    wall: { color: 0x4a4a3a, roughness: 0.8, metalness: 0.1 },
    floor: { color: 0x3a3a2a, roughness: 0.85, metalness: 0.05 },
    ceiling: { color: 0x2a2a20, roughness: 0.9, metalness: 0.0 },
    trim: { color: 0x5a5a4a, roughness: 0.75, metalness: 0.15 },
    door: { color: 0x3a3a2a, roughness: 0.65, metalness: 0.2 },
    accent: { color: 0x6a8a3a, roughness: 0.5, metalness: 0.3 },
  },
  laboratory: {
    name: 'Laboratory',
    wall: { color: 0xe8e8e8, roughness: 0.7, metalness: 0.1 },
    floor: { color: 0xc8c8c8, roughness: 0.6, metalness: 0.15 },
    ceiling: { color: 0xf8f8f8, roughness: 0.7, metalness: 0.1 },
    trim: { color: 0x00aaff, roughness: 0.3, metalness: 0.8 },
    door: { color: 0x888888, roughness: 0.5, metalness: 0.4 },
    accent: { color: 0x00ff88, roughness: 0.4, metalness: 0.5 },
  },
}

function createMaterial(params: { color: number; roughness: number; metalness: number }): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: params.color,
    roughness: params.roughness,
    metalness: params.metalness,
    side: THREE.DoubleSide,
  })
}

export function createMaterials(themeName = 'greybox'): Map<number, THREE.Material> {
  const theme = themes[themeName] || themes.greybox
  const materials = new Map<number, THREE.Material>()

  // 0: wall, 1: floor, 2: ceiling, 3: trim, 4: door, 5: accent
  materials.set(0, createMaterial(theme.wall))
  materials.set(1, createMaterial(theme.floor))
  materials.set(2, createMaterial(theme.ceiling))
  materials.set(3, createMaterial(theme.trim))
  materials.set(4, createMaterial(theme.door))
  materials.set(5, createMaterial(theme.accent))

  return materials
}

export function getAvailableThemes(): string[] {
  return Object.keys(themes)
}

export function getThemeName(themeKey: string): string {
  return themes[themeKey]?.name || themeKey
}
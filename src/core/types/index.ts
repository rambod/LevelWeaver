export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Vec2 {
  x: number
  y: number
}

export type RoomType =
  | 'spawn'
  | 'exit'
  | 'standard'
  | 'hall'
  | 'hub'
  | 'arena'
  | 'objective'
  | 'storage'
  | 'connector'
  | 'verticalConnector'

export interface Room {
  id: string
  type: RoomType
  position: Vec3
  width: number
  depth: number
  height: number
  floorIndex: number
  materialTheme: string
  connections: string[]
}

export interface Corridor {
  id: string
  startRoomId: string
  endRoomId: string
  startPos: Vec3
  endPos: Vec3
  width: number
  floorIndex: number
  pathPoints?: Vec3[]
}

export interface Stairs {
  id: string
  startFloor: number
  endFloor: number
  position: Vec3
  width: number
  depth: number
  direction: 'up' | 'down'
}

// Adjacent-floor room pair linked by vertical circulation (stairs).
export interface VerticalLink {
  lowerRoomId: string
  upperRoomId: string
}

export interface LevelGraph {
  rooms: Room[]
  corridors: Corridor[]
  stairs: Stairs[]
  boundary: Boundary
  floorCount: number
}

export interface Boundary {
  shape: MapShape
  width: number
  depth: number
  center: Vec2
}

export type MapShape =
  | 'rectangle'
  | 'square'
  | 'ring'
  | 'cross'
  | 'radial'
  | 'hub'
  | 'linear'
  | 'branching'

export interface LevelConfig {
  seed: number
  preset: string
  shape: MapShape
  area: number
  roomCount: number
  floorCount: number
  roomSizeVariation: number
  corridorWidth: number
  connectivity: number
  verticality: number
  deadEnds: number
  largeRoomCount: number
  theme: string
  /** Room wall height in meters (3.2 - 5.5). Drives room heights, corridor
   * height, and floor spacing together so stacked floors never intersect. */
  wallHeight: number
}

export interface GeometryDescription {
  rooms: RoomGeometry[]
  corridors: CorridorGeometry[]
  stairs: StairsGeometry[]
}

export interface RoomGeometry {
  id: string
  type: RoomType
  floorIndex: number
  floor: MeshData
  walls: MeshData[]
  ceiling: MeshData
  doorOpenings: DoorOpening[]
}

export interface CorridorGeometry {
  id: string
  floorIndex: number
  floor: MeshData
  walls: MeshData[]
  ceiling: MeshData
}

export interface StairTowerGeometry {
  /** World-space outer footprint (local Y). */
  rect: Rect2D
  /** Host-wall door center (world) cut for the shaft mouth. */
  door: Vec3
  floor: MeshData
  walls: MeshData[]
}

export interface StairsGeometry {
  id: string
  startFloor: number
  endFloor: number
  /** Host room the stair serves (tower attached to it, or containing it). */
  hostRoomId: string
  upperRoomId: string
  /** 'tower' = attached outdoor shaft; 'inroom' = flight inside host. */
  kind: 'tower' | 'inroom'
  /** Attached outdoor shaft (null for in-room stairs). */
  tower: StairTowerGeometry | null
  /** Stair run axis in room space. */
  axis: 'x' | 'z'
  /** World-space footprint center at the host floor base. */
  position: Vec3
  width: number
  depth: number
  stepCount: number
  stepHeight: number
  stepDepth: number
  steps: MeshData[]
  risers: MeshData[]
  stringers: MeshData[]
  landing: MeshData[]
}

export interface MeshData {
  vertices: Float32Array
  indices: Uint32Array
  normals: Float32Array
  uvs: Float32Array
  materialIndex: number
}

export interface DoorOpening {
  roomId: string
  wallIndex: number
  position: Vec3
  width: number
  height: number
}

export interface MaterialTheme {
  name: string
  wall: MaterialParams
  floor: MaterialParams
  ceiling: MaterialParams
  trim: MaterialParams
  door: MaterialParams
  accent: MaterialParams
}

export interface MaterialParams {
  color: number
  roughness: number
  metalness: number
}

// Axis-aligned rectangle in XZ (room-local or world depending on context).
export interface Rect2D {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

// Vertical distance between consecutive floor base levels (meters).
// Room geometry is built in local coordinates (base at y=0); the
// renderer/exporter positions each floor group at floorIndex * spacing.
// Keep room heights <= spacing so stacked floors don't interpenetrate.
export const FLOOR_HEIGHT = 4

// Floor spacing derived from the configured wall height: walls plus a
// half-meter interstitial for slabs and clearance.
export function floorHeightFor(config: LevelConfig): number {
  return config.wallHeight + 0.5
}

// Corridor clear height derived from the wall height.
export function corridorHeightFor(config: LevelConfig): number {
  return config.wallHeight - 0.5
}

export const DOOR_WIDTH = 1.8
export const DOOR_HEIGHT = 2.4
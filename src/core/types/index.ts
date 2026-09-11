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

export interface LevelConfig {  seed: number
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

export interface StairsGeometry {
  id: string
  startFloor: number
  endFloor: number
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

// Vertical distance between consecutive floor base levels (meters).
// Room geometry is built in local coordinates (base at y=0); the
// renderer/exporter places each floor group at floorIndex * FLOOR_HEIGHT.
// Keep room heights <= FLOOR_HEIGHT so stacked floors don't interpenetrate.
export const FLOOR_HEIGHT = 4

export const DOOR_WIDTH = 1.8
export const DOOR_HEIGHT = 2.4
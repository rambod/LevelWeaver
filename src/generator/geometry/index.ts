import type { Room, Corridor, RoomGeometry, CorridorGeometry, MeshData, DoorOpening, Vec3 } from '@/core/types'
import { DOOR_WIDTH, DOOR_HEIGHT } from '@/core/types'
import { createBoxMesh, createOrientedBox, combineMeshes, createEmptyMesh } from '@/core/meshdata'

const WALL_THICKNESS = 0.3


const FLOOR_THICKNESS = 0.2


const CEILING_THICKNESS = 0.2


export function generateRoomGeometry(rooms: Room[], doorOpenings: Map<string, DoorOpening[]>): RoomGeometry[] {
  return rooms.map(room => generateSingleRoomGeometry(room, doorOpenings.get(room.id) || []))
}


function generateSingleRoomGeometry(room: Room, doors: DoorOpening[]): RoomGeometry {
  const { width, depth, height } = room
  const halfW = width / 2
  const halfD = depth / 2
  // NOTE: geometry is built in LOCAL coordinates (base at y=0).
  // The renderer/exporter positions each room group at room.position,
  // so baking room.position.y into the vertices would offset floors twice.
  const y = 0

  // Door positions arrive in world coordinates; walls below are built
  // around the room-local origin, so translate them into local space.
  const localDoors = doors.map(d => ({
    ...d,
    position: {
      x: d.position.x - room.position.x,
      y: d.position.y - room.position.y,
      z: d.position.z - room.position.z,
    },
  }))

  return {
    id: room.id,
    type: room.type,
    floorIndex: room.floorIndex,
    floor: createFloorMesh(halfW, halfD, y, FLOOR_THICKNESS),
    walls: createWallMeshes(halfW, halfD, height, y, WALL_THICKNESS, localDoors),
    ceiling: createCeilingMesh(halfW, halfD, y + height, CEILING_THICKNESS),
    doorOpenings: doors,
  }
}


function createFloorMesh(halfW: number, halfD: number, y: number, thickness: number): MeshData {
  // Solid slab: top surface at y + thickness.
  return createBoxMesh(0, y + thickness / 2, 0, halfW * 2, thickness, halfD * 2, 1)
}


function createCeilingMesh(halfW: number, halfD: number, y: number, thickness: number): MeshData {
  // Solid slab: top surface at y (bottom face at y - thickness).
  return createBoxMesh(0, y - thickness / 2, 0, halfW * 2, thickness, halfD * 2, 2)
}


function createWallMeshes(
  halfW: number,
  halfD: number,
  height: number,
  baseY: number,
  thickness: number,
  doors: DoorOpening[]
): MeshData[] {
  const walls: MeshData[] = []

  // For each wall, check if there's a door opening
  const wallDoors = [0, 1, 2, 3].map(wallIndex => 
    doors.filter(d => d.wallIndex === wallIndex)
  )

  // Wall 0: -Z (front) - extends from -halfW to +halfW in X, at z = -halfD
  walls.push(createThickWallWithDoors(
    { x: -halfW, z: -halfD }, { x: halfW, z: -halfD },
    baseY, baseY + height, thickness,
    { x: 0, y: 0, z: -1 },
    wallDoors[0]
  ))

  // Wall 1: +X (right) - extends from -halfD to +halfD in Z, at x = +halfW
  walls.push(createThickWallWithDoors(
    { x: halfW, z: -halfD }, { x: halfW, z: halfD },
    baseY, baseY + height, thickness,
    { x: 1, y: 0, z: 0 },
    wallDoors[1]
  ))

  // Wall 2: +Z (back) - extends from +halfW to -halfW in X, at z = +halfD
  walls.push(createThickWallWithDoors(
    { x: halfW, z: halfD }, { x: -halfW, z: halfD },
    baseY, baseY + height, thickness,
    { x: 0, y: 0, z: 1 },
    wallDoors[2]
  ))

  // Wall 3: -X (left) - extends from +halfD to -halfD in Z, at x = -halfW
  walls.push(createThickWallWithDoors(
    { x: -halfW, z: halfD }, { x: -halfW, z: -halfD },
    baseY, baseY + height, thickness,
    { x: -1, y: 0, z: 0 },
    wallDoors[3]
  ))

  return walls
}


function createThickWallWithDoors(
  start: { x: number; z: number },
  end: { x: number; z: number },
  bottomY: number,
  topY: number,
  thickness: number,
  outwardNormal: { x: number; y: number; z: number },
  doorOpenings: DoorOpening[]
): MeshData {
  // If no doors, use simple thick wall
  if (doorOpenings.length === 0) {
    return createThickWall(start, end, bottomY, topY, thickness, outwardNormal)
  }

  const dx = end.x - start.x
  const dz = end.z - start.z
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.01) return createEmptyMesh()

  // Unit vector ALONG the wall (from start to end). Door positions must be
  // projected onto this axis. (Projecting onto the perpendicular would
  // collapse every door to ~0 and lay wall segments across the wall.)
  const ux = dx / len
  const uz = dz / len

  const segment = (a: number, b: number, segBottom: number, segTop: number): MeshData => {
    if (b - a < 0.05 || segTop - segBottom < 0.05) return createEmptyMesh()
    const segStart = { x: start.x + ux * a, z: start.z + uz * a }
    const segEnd = { x: start.x + ux * b, z: start.z + uz * b }
    return createThickWall(segStart, segEnd, segBottom, segTop, thickness, outwardNormal)
  }

  // Door spans in wall-local coordinates (distance from `start` along wall).
  const spans = doorOpenings.map(door => {
    const relX = door.position.x - start.x
    const relZ = door.position.z - start.z
    const along = relX * ux + relZ * uz
    const half = (door.width > 0 ? door.width : DOOR_WIDTH) / 2
    const top = bottomY + (door.height > 0 ? door.height : DOOR_HEIGHT)
    return {
      start: Math.max(0, along - half),
      end: Math.min(len, along + half),
      top: Math.min(top, topY),
    }
  }).filter(s => s.end > s.start).sort((a, b) => a.start - b.start)

  // Merge overlapping spans so adjacent doors share one opening.
  const merged: typeof spans = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end + 0.05) {
      last.end = Math.max(last.end, span.end)
      last.top = Math.max(last.top, span.top)
    } else {
      merged.push({ ...span })
    }
  }

  // Wall runs full-height between doors, with a header (lintel) left
  // above each opening instead of a full-height gap.
  const meshes: MeshData[] = []
  let cursor = 0
  for (const span of merged) {
    if (span.start > cursor + 0.05) {
      meshes.push(segment(cursor, span.start, bottomY, topY))
    }
    if (span.top < topY - 0.05) {
      meshes.push(segment(span.start, span.end, span.top, topY))
    }
    cursor = Math.max(cursor, span.end)
  }
  if (cursor < len - 0.05) {
    meshes.push(segment(cursor, len, bottomY, topY))
  }

  return combineMeshes(meshes, 0)
}


function createThickWall(
  start: { x: number; z: number },
  end: { x: number; z: number },
  bottomY: number,
  topY: number,
  thickness: number,
  outwardNormal: { x: number; y: number; z: number }
): MeshData {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.01 || topY - bottomY < 0.01) return createEmptyMesh()

  // Wall runs from start to end; thickness extends inward (into the room).
  const ux = dx / len
  const uz = dz / len
  const inwardNx = -outwardNormal.x
  const inwardNz = -outwardNormal.z

  const midX = (start.x + end.x) / 2 + inwardNx * (thickness / 2)
  const midZ = (start.z + end.z) / 2 + inwardNz * (thickness / 2)

  return createOrientedBox(
    { x: midX, y: (bottomY + topY) / 2, z: midZ },
    {
      u: { x: ux, y: 0, z: uz },
      v: { x: 0, y: 1, z: 0 },
      w: { x: inwardNx, y: 0, z: inwardNz },
    },
    len,
    topY - bottomY,
    thickness,
    0
  )
}


export function generateCorridorGeometry(corridors: Corridor[]): CorridorGeometry[] {
  return corridors.map(corridor => {
    // Use pathPoints if available, otherwise fall back to straight line
    const points = corridor.pathPoints && corridor.pathPoints.length > 0
      ? corridor.pathPoints
      : [corridor.startPos, corridor.endPos]

    return buildCorridorGeometry(corridor, points)
  })
}


function buildCorridorGeometry(corridor: Corridor, points: Vec3[]): CorridorGeometry {
  const width = corridor.width
  // Local coordinates: the corridor group is positioned at the floor level
  // by the renderer/exporter, so build around y=0 here (see room geometry).
  const floorY = 0
  
  // Build combined floor, walls, ceiling from path segments
  const floorMeshes: MeshData[] = []
  const wallMeshes: MeshData[] = []
  const ceilingMeshes: MeshData[] = []

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]
    const end = points[i + 1]
    
    floorMeshes.push(createCorridorSegmentFloor(start.x, start.z, end.x, end.z, width, floorY, FLOOR_THICKNESS))
    wallMeshes.push(...createCorridorSegmentWalls(start.x, start.z, end.x, end.z, width, floorY, 3, WALL_THICKNESS))
    ceilingMeshes.push(createCorridorSegmentCeiling(start.x, start.z, end.x, end.z, width, floorY + 3, CEILING_THICKNESS))
  }

  const combinedFloor = combineMeshes(floorMeshes, 1)
  const combinedCeiling = combineMeshes(ceilingMeshes, 2)

  return {
    id: corridor.id,
    floorIndex: corridor.floorIndex,
    floor: combinedFloor,
    walls: wallMeshes,
    ceiling: combinedCeiling,
  }
}


function createCorridorSegmentFloor(
  x1: number, z1: number, x2: number, z2: number, width: number, y: number, thickness: number
): MeshData {
  const dx = x2 - x1
  const dz = z2 - z1
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.01) return createEmptyMesh()

  const ux = dx / len
  const uz = dz / len
  // Extend past joints so angled segments don't leave wedge gaps.
  const extLen = len + width

  return createOrientedBox(
    { x: (x1 + x2) / 2, y: y + thickness / 2, z: (z1 + z2) / 2 },
    {
      u: { x: ux, y: 0, z: uz },
      v: { x: 0, y: 1, z: 0 },
      w: { x: -uz, y: 0, z: ux },
    },
    extLen,
    thickness,
    width,
    1
  )
}


function createCorridorSegmentWalls(
  x1: number, z1: number, x2: number, z2: number, width: number, y: number, height: number, thickness: number
): MeshData[] {
  const dx = x2 - x1
  const dz = z2 - z1
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.01) return []

  const nx = -dz / len
  const nz = dx / len
  const hw = width / 2

  // Extend past joints so angled wall segments overlap instead of gapping.
  const ext = width * 0.5
  const ux = dx / len
  const uz = dz / len
  const sx = x1 - ux * ext
  const sz = z1 - uz * ext
  const ex = x2 + ux * ext
  const ez = z2 + uz * ext

  // Left wall (relative to corridor direction)
  const leftWall = createThickWall(
    { x: sx - nx * hw, z: sz - nz * hw },
    { x: ex - nx * hw, z: ez - nz * hw },
    y, y + height, thickness,
    { x: nx, y: 0, z: nz } // outward normal points away from corridor center
  )

  // Right wall
  const rightWall = createThickWall(
    { x: ex + nx * hw, z: ez + nz * hw },
    { x: sx + nx * hw, z: sz + nz * hw },
    y, y + height, thickness,
    { x: -nx, y: 0, z: -nz }
  )

  return [leftWall, rightWall]
}


function createCorridorSegmentCeiling(
  x1: number, z1: number, x2: number, z2: number, width: number, y: number, thickness: number
): MeshData {
  const dx = x2 - x1
  const dz = z2 - z1
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.01) return createEmptyMesh()

  const ux = dx / len
  const uz = dz / len
  // Extend past joints like the floor slab. y is the TOP of the slab.
  const extLen = len + width

  return createOrientedBox(
    { x: (x1 + x2) / 2, y: y - thickness / 2, z: (z1 + z2) / 2 },
    {
      u: { x: ux, y: 0, z: uz },
      v: { x: 0, y: 1, z: 0 },
      w: { x: -uz, y: 0, z: ux },
    },
    extLen,
    thickness,
    width,
    2
  )
}

// Vertical circulation lives in `@/generator/vertical`; re-exported here
// so existing importers keep working.
export { generateStairsGeometry } from '@/generator/vertical'


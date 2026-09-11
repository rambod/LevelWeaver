import type { Room, Corridor, RoomGeometry, CorridorGeometry, MeshData, DoorOpening, Vec3, Rect2D } from '@/core/types'
import { DOOR_WIDTH, DOOR_HEIGHT } from '@/core/types'
import { createBoxMesh, createOrientedBox, combineMeshes, createEmptyMesh } from '@/core/meshdata'

const WALL_THICKNESS = 0.3


const FLOOR_THICKNESS = 0.2


const CEILING_THICKNESS = 0.2


export interface RoomSlabHoles {
  floor?: Rect2D | null
  ceiling?: Rect2D | null
}

export function generateRoomGeometry(
  rooms: Room[],
  doorOpenings: Map<string, DoorOpening[]>,
  slabHoles?: Map<string, RoomSlabHoles>
): RoomGeometry[] {
  return rooms.map(room => generateSingleRoomGeometry(room, doorOpenings.get(room.id) || [], slabHoles?.get(room.id)))
}

function generateSingleRoomGeometry(room: Room, doors: DoorOpening[], holes?: RoomSlabHoles): RoomGeometry {
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
    floor: createSlabWithHole(width, depth, y + FLOOR_THICKNESS, FLOOR_THICKNESS, holes?.floor ?? null, 1),
    walls: createWallMeshes(halfW, halfD, height, y, WALL_THICKNESS, localDoors),
    ceiling: createSlabWithHole(width, depth, y + height, CEILING_THICKNESS, holes?.ceiling ?? null, 2),
    doorOpenings: doors,
  }
}

// Solid slab with an optional axis-aligned rectangular hole (stairwells).
// The hole is in room-local coordinates (room centered at origin).
function createSlabWithHole(
  width: number,
  depth: number,
  yTop: number,
  thickness: number,
  hole: Rect2D | null,
  materialIndex: number
): MeshData {
  const yCenter = yTop - thickness / 2
  if (!hole) {
    return createBoxMesh(0, yCenter, 0, width, thickness, depth, materialIndex)
  }
  const hx0 = Math.max(-width / 2, hole.minX)
  const hx1 = Math.min(width / 2, hole.maxX)
  const hz0 = Math.max(-depth / 2, hole.minZ)
  const hz1 = Math.min(depth / 2, hole.maxZ)
  const parts: MeshData[] = []
  const push = (cx: number, cz: number, w: number, d: number) => {
    if (w > 0.05 && d > 0.05) {
      parts.push(createBoxMesh(cx, yCenter, cz, w, thickness, d, materialIndex))
    }
  }
  // Left / right of the hole (full depth).
  push((-width / 2 + hx0) / 2, 0, hx0 + width / 2, depth)
  push((hx1 + width / 2) / 2, 0, width / 2 - hx1, depth)
  // Front / back of the hole (between its X edges).
  push((hx0 + hx1) / 2, (-depth / 2 + hz0) / 2, hx1 - hx0, hz0 + depth / 2)
  push((hx0 + hx1) / 2, (hz1 + depth / 2) / 2, hx1 - hx0, depth / 2 - hz1)
  return combineMeshes(parts, materialIndex)
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

  // Merge overlapping spans so adjacent doors share one opening (merged
  // within 0.4m: paper-thin wall slivers between close doors would look
  // broken and collide badly).
  const merged: typeof spans = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end + 0.4) {
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


// ---------------------------------------------------------------------------
// Corridor ribbons.
//
// A corridor is a swept path: floor/ceiling slabs and side walls share one
// vertex loop per joint, so segments can never overlap, z-fight, or leave
// wedge gaps (the old per-segment boxes did all three at every joint).
// ---------------------------------------------------------------------------

interface FlatPoint {
  x: number
  z: number
}

interface RibbonVertex {
  x: number
  y: number
  z: number
  u: number
  v: number
}

interface Miter {
  /** Scaled offset (unit normal * miter scale) for exact joint placement. */
  mx: number
  mz: number
  /** Unit normal for lighting. */
  ux: number
  uz: number
}

function newRibbonBuilder() {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  function vert(v: RibbonVertex, n: { x: number; y: number; z: number }): number {
    positions.push(v.x, v.y, v.z)
    normals.push(n.x, n.y, n.z)
    uvs.push(v.u, v.v)
    return positions.length / 3 - 1
  }

  // Quad strip between two vertex rows (same length, uniform normal).
  function strip(rowA: RibbonVertex[], rowB: RibbonVertex[], n: { x: number; y: number; z: number }): void {
    for (let i = 0; i < rowA.length - 1; i++) {
      const a0 = vert(rowA[i], n)
      const b0 = vert(rowB[i], n)
      const b1 = vert(rowB[i + 1], n)
      const a1 = vert(rowA[i + 1], n)
      indices.push(a0, b0, b1, a0, b1, a1)
    }
  }

  // Single quad with one normal (skirts, caps, wall faces).
  function quad(a: RibbonVertex, b: RibbonVertex, c: RibbonVertex, d: RibbonVertex, n: { x: number; y: number; z: number }): void {
    const a0 = vert(a, n)
    const b0 = vert(b, n)
    const c0 = vert(c, n)
    const d0 = vert(d, n)
    indices.push(a0, b0, c0, a0, c0, d0)
  }

  function build(materialIndex: number): MeshData {
    return {
      vertices: new Float32Array(positions),
      indices: new Uint32Array(indices),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      materialIndex,
    }
  }

  return { strip, quad, build }
}

// Miter offset per path point: averaged segment normals, scaled so the
// offset edge stays exactly `offset` away from the centerline.
function computeMiters(pts: FlatPoint[]): Miter[] {
  const n = pts.length
  const segN: { x: number; z: number }[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x
    const dz = pts[i + 1].z - pts[i].z
    const len = Math.sqrt(dx * dx + dz * dz) || 1
    segN.push({ x: -dz / len, z: dx / len })
  }
  const miters: Miter[] = []
  for (let i = 0; i < n; i++) {
    let nx: number
    let nz: number
    if (i === 0) {
      nx = segN[0].x
      nz = segN[0].z
    } else if (i === n - 1) {
      nx = segN[n - 2].x
      nz = segN[n - 2].z
    } else {
      const ax = segN[i - 1].x + segN[i].x
      const az = segN[i - 1].z + segN[i].z
      const al = Math.sqrt(ax * ax + az * az)
      if (al < 1e-6) {
        // U-turn: fall back to the incoming normal.
        nx = segN[i - 1].x
        nz = segN[i - 1].z
      } else {
        const cosHalf = (ax * segN[i].x + az * segN[i].z) / al
        const scale = Math.min(2.5, 1 / Math.max(0.45, cosHalf))
        nx = (ax / al) * scale
        nz = (az / al) * scale
      }
    }
    const ul = Math.sqrt(nx * nx + nz * nz) || 1
    miters.push({ mx: nx, mz: nz, ux: nx / ul, uz: nz / ul })
  }
  return miters
}

function arclengths(pts: FlatPoint[]): number[] {
  const out = [0]
  for (let i = 1; i < pts.length; i++) {
    out.push(out[i - 1] + Math.sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2))
  }
  return out
}

function segmentDir(pts: FlatPoint[], i: number): { x: number; z: number } {
  const dx = pts[i + 1].x - pts[i].x
  const dz = pts[i + 1].z - pts[i].z
  const len = Math.sqrt(dx * dx + dz * dz) || 1
  return { x: dx / len, z: dz / len }
}

// Horizontal slab (floor or ceiling). yTop is the TOP surface; the slab is
// a hair wider than the walls' outer faces so no faces are coplanar.
function buildSlabRibbon(
  pts: FlatPoint[],
  miters: Miter[],
  arc: number[],
  half: number,
  yTop: number,
  thickness: number,
  materialIndex: number
): MeshData {
  const b = newRibbonBuilder()
  const yBot = yTop - thickness
  const topL: RibbonVertex[] = []
  const topR: RibbonVertex[] = []
  const botL: RibbonVertex[] = []
  const botR: RibbonVertex[] = []
  for (let i = 0; i < pts.length; i++) {
    const u = arc[i] / 3
    topL.push({ x: pts[i].x + miters[i].mx * half, y: yTop, z: pts[i].z + miters[i].mz * half, u, v: 0 })
    topR.push({ x: pts[i].x - miters[i].mx * half, y: yTop, z: pts[i].z - miters[i].mz * half, u, v: 1 })
    botL.push({ x: pts[i].x + miters[i].mx * half, y: yBot, z: pts[i].z + miters[i].mz * half, u, v: 0 })
    botR.push({ x: pts[i].x - miters[i].mx * half, y: yBot, z: pts[i].z - miters[i].mz * half, u, v: 1 })
  }
  b.strip(topL, topR, { x: 0, y: 1, z: 0 })
  b.strip(botL, botR, { x: 0, y: -1, z: 0 })

  for (let i = 0; i < pts.length - 1; i++) {
    const d = segmentDir(pts, i)
    const n = { x: -d.z, y: 0, z: d.x }
    // Left skirt (outward +normal).
    b.quad(topL[i], topL[i + 1], botL[i + 1], botL[i], n)
    // Right skirt (outward -normal).
    b.quad(topR[i + 1], topR[i], botR[i], botR[i + 1], { x: -n.x, y: 0, z: -n.z })
  }

  // End caps read as thresholds where the corridor meets the doorway.
  const d0 = segmentDir(pts, 0)
  b.quad(topL[0], topR[0], botR[0], botL[0], { x: -d0.x, y: 0, z: -d0.z })
  const d1 = segmentDir(pts, pts.length - 2)
  const l = pts.length - 1
  b.quad(topR[l], topL[l], botL[l], botR[l], { x: d1.x, y: 0, z: d1.z })

  return b.build(materialIndex)
}

// Vertical side wall ribbon: inner face, outer face, top cap. No end caps:
// both path ends are open doorways into rooms.
function buildWallRibbon(
  pts: FlatPoint[],
  miters: Miter[],
  arc: number[],
  side: 1 | -1,
  innerOffset: number,
  thickness: number,
  yBase: number,
  height: number,
  materialIndex: number
): MeshData {
  const b = newRibbonBuilder()
  const yTop = yBase + height
  const inBot: RibbonVertex[] = []
  const inTop: RibbonVertex[] = []
  const outBot: RibbonVertex[] = []
  const outTop: RibbonVertex[] = []
  for (let i = 0; i < pts.length; i++) {
    const u = arc[i] / 3
    const ix = pts[i].x + miters[i].mx * side * innerOffset
    const iz = pts[i].z + miters[i].mz * side * innerOffset
    const ox = pts[i].x + miters[i].mx * side * (innerOffset + thickness)
    const oz = pts[i].z + miters[i].mz * side * (innerOffset + thickness)
    inBot.push({ x: ix, y: yBase, z: iz, u, v: 0 })
    inTop.push({ x: ix, y: yTop, z: iz, u, v: 1 })
    outBot.push({ x: ox, y: yBase, z: oz, u, v: 0 })
    outTop.push({ x: ox, y: yTop, z: oz, u, v: 1 })
  }
  // Top cap is one continuous strip (uniform normal).
  b.strip(inTop, outTop, { x: 0, y: 1, z: 0 })
  // Faces get per-segment normals for crisp corners.
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segmentDir(pts, i)
    const inward = { x: -d.z * side, y: 0, z: d.x * side }
    // Inner face (toward the corridor).
    b.quad(inBot[i], inBot[i + 1], inTop[i + 1], inTop[i], { x: -inward.x, y: 0, z: -inward.z })
    // Outer face.
    b.quad(outBot[i + 1], outBot[i], outTop[i], outTop[i + 1], inward)
  }
  return b.build(materialIndex)
}

function buildCorridorGeometry(corridor: Corridor, points: Vec3[]): CorridorGeometry {
  const width = corridor.width
  // Local coordinates: the corridor group is positioned at the floor level
  // by the renderer/exporter, so build around y=0 here (see room geometry).
  const floorY = 0
  const wallH = 3

  // Drop degenerate consecutive points (zero-length segments).
  const clean: Vec3[] = []
  for (const p of points) {
    const prev = clean[clean.length - 1]
    if (!prev || Math.sqrt((p.x - prev.x) ** 2 + (p.z - prev.z) ** 2) > 1e-4) {
      clean.push(p)
    }
  }
  if (clean.length < 2) {
    return {
      id: corridor.id,
      floorIndex: corridor.floorIndex,
      floor: createEmptyMesh(),
      walls: [],
      ceiling: createEmptyMesh(),
    }
  }

  const flat: FlatPoint[] = clean.map(p => ({ x: p.x, z: p.z }))
  const miters = computeMiters(flat)
  const arc = arclengths(flat)
  const halfSlab = width / 2 + WALL_THICKNESS + 0.02

  return {
    id: corridor.id,
    floorIndex: corridor.floorIndex,
    floor: buildSlabRibbon(flat, miters, arc, halfSlab, floorY + FLOOR_THICKNESS, FLOOR_THICKNESS, 1),
    walls: [
      buildWallRibbon(flat, miters, arc, 1, width / 2, WALL_THICKNESS, floorY, wallH, 0),
      buildWallRibbon(flat, miters, arc, -1, width / 2, WALL_THICKNESS, floorY, wallH, 0),
    ],
    ceiling: buildSlabRibbon(flat, miters, arc, halfSlab, floorY + wallH, CEILING_THICKNESS, 2),
  }
}

// Vertical circulation lives in `@/generator/vertical`.


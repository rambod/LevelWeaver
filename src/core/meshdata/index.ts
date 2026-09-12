import type { MeshData } from '@/core/types'

// Engine-independent mesh assembly helpers (pure Float32Array math, no
// Three.js). Shared by the room/corridor/stair geometry builders so every
// mesh has consistent vertex/normal/uv counts.

export interface BoxBasis {
  /** Unit vector along the box's local X (length axis). */
  u: { x: number; y: number; z: number }
  /** Unit vector along the box's local Y (height axis). */
  v: { x: number; y: number; z: number }
  /** Unit vector along the box's local Z (width axis). */
  w: { x: number; y: number; z: number }
}

/**
 * Oriented box with correct per-face vertices (24 verts, 24 normals, 24 uvs).
 *
 * The hand-rolled wall/floor builders used to emit 8 shared vertices with 24
 * normals, which both broke lighting and crashed combineMeshes (buffer size
 * mismatch). All box-shaped geometry goes through here (or createBoxMesh).
 */
export function createOrientedBox(
  center: { x: number; y: number; z: number },
  basis: BoxBasis,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  materialIndex: number,
): MeshData {
  const hx = sizeX / 2
  const hy = sizeY / 2
  const hz = sizeZ / 2
  const { u, v, w } = basis

  const corner = (sx: number, sy: number, sz: number): [number, number, number] => [
    center.x + u.x * sx * hx + v.x * sy * hy + w.x * sz * hz,
    center.y + u.y * sx * hx + v.y * sy * hy + w.y * sz * hz,
    center.z + u.z * sx * hx + v.z * sy * hy + w.z * sz * hz,
  ]

  // Faces with outward normals: [+u, -u, +v, -v, +w, -w].
  const faces: { normal: [number, number, number]; pts: [number, number, number][] }[] = [
    { normal: [u.x, u.y, u.z], pts: [corner(1, -1, -1), corner(1, -1, 1), corner(1, 1, 1), corner(1, 1, -1)] },
    { normal: [-u.x, -u.y, -u.z], pts: [corner(-1, -1, 1), corner(-1, -1, -1), corner(-1, 1, -1), corner(-1, 1, 1)] },
    { normal: [v.x, v.y, v.z], pts: [corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1)] },
    { normal: [-v.x, -v.y, -v.z], pts: [corner(-1, -1, -1), corner(-1, -1, 1), corner(1, -1, 1), corner(1, -1, -1)] },
    { normal: [w.x, w.y, w.z], pts: [corner(-1, -1, 1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, -1, 1)] },
    { normal: [-w.x, -w.y, -w.z], pts: [corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1), corner(-1, -1, -1)] },
  ]

  const vertices = new Float32Array(24 * 3)
  const normals = new Float32Array(24 * 3)
  const uvs = new Float32Array(24 * 2)
  const indices = new Uint32Array(36)
  const quadUv = [0, 0, 1, 0, 1, 1, 0, 1]

  faces.forEach((face, f) => {
    face.pts.forEach((p, k) => {
      const vi = (f * 4 + k) * 3
      vertices[vi] = p[0]
      vertices[vi + 1] = p[1]
      vertices[vi + 2] = p[2]
      normals[vi] = face.normal[0]
      normals[vi + 1] = face.normal[1]
      normals[vi + 2] = face.normal[2]
      const ui = (f * 4 + k) * 2
      uvs[ui] = quadUv[k * 2]
      uvs[ui + 1] = quadUv[k * 2 + 1]
    })
    const b = f * 4
    const ii = f * 6
    // Face order must agree with the supplied outward normal. A reflected
    // basis reverses handedness, so a fixed winding is not sufficient.
    const [a, p, q] = face.pts
    const ab = p.map((value, i) => value - a[i])
    const ac = q.map((value, i) => value - a[i])
    const dot = (ab[1] * ac[2] - ab[2] * ac[1]) * face.normal[0] +
      (ab[2] * ac[0] - ab[0] * ac[2]) * face.normal[1] +
      (ab[0] * ac[1] - ab[1] * ac[0]) * face.normal[2]
    const reverse = dot < 0
    indices[ii] = b
    indices[ii + 1] = b + (reverse ? 2 : 1)
    indices[ii + 2] = b + (reverse ? 1 : 2)
    indices[ii + 3] = b
    indices[ii + 4] = b + (reverse ? 3 : 2)
    indices[ii + 5] = b + (reverse ? 2 : 3)
  })

  return { vertices, indices, normals, uvs, materialIndex }
}

export function combineMeshes(meshes: MeshData[], materialIndex: number): MeshData {
  if (meshes.length === 0) return createEmptyMesh()
  if (meshes.length === 1) return { ...meshes[0], materialIndex }

  let totalVerts = 0
  let totalIndices = 0
  for (const m of meshes) {
    totalVerts += m.vertices.length / 3
    totalIndices += m.indices.length
  }

  const vertices = new Float32Array(totalVerts * 3)
  const indices = new Uint32Array(totalIndices)
  const normals = new Float32Array(totalVerts * 3)
  const uvs = new Float32Array(totalVerts * 2)

  let vOffset = 0
  let iOffset = 0
  let vertCount = 0

  for (const m of meshes) {
    const vc = m.vertices.length / 3
    vertices.set(m.vertices, vOffset)
    normals.set(m.normals, vOffset)
    uvs.set(m.uvs, vOffset / 3 * 2)
    vOffset += m.vertices.length

    for (let i = 0; i < m.indices.length; i++) {
      indices[iOffset++] = m.indices[i] + vertCount
    }
    vertCount += vc
  }

  return { vertices, indices, normals, uvs, materialIndex }
}


export function createEmptyMesh(): MeshData {
  return {
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    materialIndex: 0,
  }
}


export function createBoxMesh(
  x: number, y: number, z: number,
  w: number, h: number, d: number,
  materialIndex: number
): MeshData {
  const hw = w / 2
  const hh = h / 2
  const hd = d / 2
  
  const vertices = new Float32Array([
    // -Z face
    -hw + x, -hh + y, -hd + z,
    hw + x, -hh + y, -hd + z,
    hw + x, hh + y, -hd + z,
    -hw + x, hh + y, -hd + z,
    // +Z face
    -hw + x, -hh + y, hd + z,
    -hw + x, hh + y, hd + z,
    hw + x, hh + y, hd + z,
    hw + x, -hh + y, hd + z,
    // -X face
    -hw + x, -hh + y, -hd + z,
    -hw + x, -hh + y, hd + z,
    -hw + x, hh + y, hd + z,
    -hw + x, hh + y, -hd + z,
    // +X face
    hw + x, -hh + y, -hd + z,
    hw + x, hh + y, -hd + z,
    hw + x, hh + y, hd + z,
    hw + x, -hh + y, hd + z,
    // -Y face (bottom)
    -hw + x, -hh + y, -hd + z,
    hw + x, -hh + y, -hd + z,
    hw + x, -hh + y, hd + z,
    -hw + x, -hh + y, hd + z,
    // +Y face (top)
    -hw + x, hh + y, -hd + z,
    -hw + x, hh + y, hd + z,
    hw + x, hh + y, hd + z,
    hw + x, hh + y, -hd + z,
  ])
  
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 6, 5, 4, 7, 6,
    8, 9, 10, 8, 10, 11,
    12, 13, 14, 12, 14, 15,
    16, 17, 18, 16, 18, 19,
    20, 21, 22, 20, 22, 23,
  ])
  
  const normals = new Float32Array([
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
  ])
  
  const uvs = new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ])
  
  return { vertices, indices, normals, uvs, materialIndex }
}

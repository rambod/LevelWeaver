import * as THREE from 'three'

// AABB collision between the player capsule (approximated as a vertical
// segment with a horizontal radius) and world-space bounding boxes.
//
// `position` is the player's EYE position; the body spans from
// `position.y - playerHeight` up to `position.y`.
//
// Lawbook §58 (epsilon law): standing contact is NOT collision. Body
// bottom exactly at a slab top must read as grounded, not as a hit —
// otherwise float32 slab tops (0.200000003) vs body bottoms
// (0.1999999999…) freeze every horizontal move and break gates.
export const PLAYER_GROUND_EPS = 0.02

// Corridor side-wall volumes, derived from the canonical path (lawbook
// §56: clearance volumes, not render artifacts). Ribbon wall MESHES must
// NOT be used as colliders: a diagonal ribbon's AABB is far fatter than
// the wall and seals nearby doorways shut. Instead each straight path
// segment contributes two thin side boxes (inner face exactly at the
// corridor clear width). Segments extend past joints by the wall
// thickness so turns stay closed; the small outer-corner overfill is
// conservative (safe) for a playtest tool.
export function corridorWallBoxes(
  points: { x: number; z: number }[],
  width: number,
  yBase: number,
  height: number,
  wallThickness = 0.3,
): THREE.Box3[] {
  const boxes: THREE.Box3[] = []
  const half = width / 2
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]
    const q = points[i + 1]
    const dx = q.x - p.x
    const dz = q.z - p.z
    const len = Math.sqrt(dx * dx + dz * dz)
    if (len < 1e-6) continue
    const ux = dx / len
    const uz = dz / len
    // Left normal (-uz, ux), right normal opposite.
    for (const side of [1, -1]) {
      const nx = -uz * side
      const nz = ux * side
      const inX = half
      const outX = half + wallThickness
      // Corners: inner/outer offsets at both ends, extended past the
      // joints by wallThickness so consecutive boxes overlap.
      const ax = p.x + nx * inX - ux * wallThickness
      const az = p.z + nz * inX - uz * wallThickness
      const bx = p.x + nx * outX - ux * wallThickness
      const bz = p.z + nz * outX - uz * wallThickness
      const cx = q.x + nx * inX + ux * wallThickness
      const cz = q.z + nz * inX + uz * wallThickness
      const dx2 = q.x + nx * outX + ux * wallThickness
      const dz2 = q.z + nz * outX + uz * wallThickness
      boxes.push(
        new THREE.Box3(
          new THREE.Vector3(
            Math.min(ax, bx, cx, dx2),
            yBase,
            Math.min(az, bz, cz, dz2),
          ),
          new THREE.Vector3(
            Math.max(ax, bx, cx, dx2),
            yBase + height,
            Math.max(az, bz, cz, dz2),
          ),
        ),
      )
    }
  }
  return boxes
}
export function checkPlayerCollision(
  position: THREE.Vector3,
  boxes: THREE.Box3[],
  playerRadius = 0.4,
  playerHeight = 1.8,
): boolean {
  const playerBottom = position.y - playerHeight
  const playerTop = position.y

  for (const box of boxes) {
    if (
      position.x > box.min.x - playerRadius &&
      position.x < box.max.x + playerRadius &&
      position.z > box.min.z - playerRadius &&
      position.z < box.max.z + playerRadius &&
      playerTop > box.min.y &&
      playerBottom < box.max.y - PLAYER_GROUND_EPS
    ) {
      return true
    }
  }
  return false
}

// Snapshot world-space boxes for a set of meshes. Call once per level
// generation (not per frame) and reuse the result in the walk loop.
export function snapshotCollisionBoxes(meshes: THREE.Mesh[]): THREE.Box3[] {
  const boxes: THREE.Box3[] = []
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox()
    }
    const box = mesh.geometry.boundingBox!.clone()
    box.applyMatrix4(mesh.matrixWorld)
    boxes.push(box)
  }
  return boxes
}

import * as THREE from 'three'

// AABB collision between the player capsule (approximated as a vertical
// segment with a horizontal radius) and world-space bounding boxes.
//
// `position` is the player's EYE position; the body spans from
// `position.y - playerHeight` up to `position.y`.
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
      playerBottom < box.max.y
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

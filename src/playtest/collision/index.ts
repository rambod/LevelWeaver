import * as THREE from 'three'
import { SPATIAL_DEFAULTS } from '@/core/rules'

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

/** Everything walk mode collides against: mesh boxes (rooms, stairs,
 * floors) plus exact corridor wall capsules. Snapshotted once per
 * generation and reused every frame. */
export interface CollisionWorld {
  boxes: THREE.Box3[]
  capsules: WallCapsule[]
}

export function emptyCollisionWorld(): CollisionWorld {
  return { boxes: [], capsules: [] }
}

/**
 * Corridor wall collider (lawbook §56): an axis-free capsule — straight
 * wall centerline segment + half thickness. AABB boxes cannot represent
 * diagonal walls (their bounds cover empty triangles and seal nearby
 * doorways); capsules hug the true ribbon instead. Shared endpoints
 * close the joints; the slight outer-corner overfill is conservative.
 */
export interface WallCapsule {
  ax: number
  az: number
  bx: number
  bz: number
  half: number
  yBase: number
  yTop: number
}

export function distPointToSegment2D(  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const lenSq = dx * dx + dz * dz
  if (lenSq < 1e-12) return Math.sqrt((px - ax) ** 2 + (pz - az) ** 2)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq))
  return Math.sqrt((px - (ax + t * dx)) ** 2 + (pz - (az + t * dz)) ** 2)
}

// Corridor side-wall volumes, derived from the canonical path (lawbook
// §56: clearance volumes, not render artifacts). Ribbon wall MESHES must
// NOT be used as colliders: a diagonal ribbon's AABB covers empty
// triangles and seals nearby doorways. Instead each straight path segment
// contributes two wall-center capsules (inner face exactly at the
// corridor clear width). Shared endpoints close the joints; the slight
// outer-corner overfill is conservative (safe) for a playtest tool.
export function corridorWallCapsules(
  points: { x: number; z: number }[],
  width: number,
  yBase: number,
  height: number,
  // Single source of truth (lawbook §7, §55).
  wallThickness = SPATIAL_DEFAULTS.wallThickness,
): WallCapsule[] {
  const capsules: WallCapsule[] = []
  const center = width / 2 + wallThickness / 2
  const half = wallThickness / 2
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]
    const q = points[i + 1]
    const dx = q.x - p.x
    const dz = q.z - p.z
    const len = Math.sqrt(dx * dx + dz * dz)
    if (len < 1e-6) continue
    const ux = dx / len
    const uz = dz / len
    for (const side of [1, -1]) {
      const nx = -uz * side
      const nz = ux * side
      capsules.push({
        ax: p.x + nx * center,
        az: p.z + nz * center,
        bx: q.x + nx * center,
        bz: q.z + nz * center,
        half,
        yBase,
        yTop: yBase + height,
      })
    }
  }
  return capsules
}
export function checkPlayerCollision(
  position: THREE.Vector3,
  boxes: THREE.Box3[],
  playerRadius = 0.4,
  playerHeight = 1.8,
  capsules: WallCapsule[] = [],
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
  for (const cap of capsules) {
    if (playerTop <= cap.yBase || playerBottom >= cap.yTop - PLAYER_GROUND_EPS) continue
    if (distPointToSegment2D(position.x, position.z, cap.ax, cap.az, cap.bx, cap.bz) < cap.half + playerRadius) {
      return true
    }
  }
  return false
}

// Boxes engaged by a body column (the exact box half of the predicate
// above, factored out for step-up analysis). Identity-stable: same array,
// same refs, so set differences across two probes are meaningful.
export function engagedBoxes(
  position: THREE.Vector3,
  boxes: THREE.Box3[],
  playerRadius = 0.4,
  playerHeight = 1.8,
): THREE.Box3[] {
  const playerBottom = position.y - playerHeight
  const playerTop = position.y
  const out: THREE.Box3[] = []
  for (const box of boxes) {
    if (
      position.x > box.min.x - playerRadius &&
      position.x < box.max.x + playerRadius &&
      position.z > box.min.z - playerRadius &&
      position.z < box.max.z + playerRadius &&
      playerTop > box.min.y &&
      playerBottom < box.max.y - PLAYER_GROUND_EPS
    ) {
      out.push(box)
    }
  }
  return out
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

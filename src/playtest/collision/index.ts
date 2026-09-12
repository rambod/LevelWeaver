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
 *
 * Corridor FLOOR collider (same law): one TIGHT box per straight path
 * segment (centerline swept by the slab half width). The render ribbon
 * MUST NOT be used as a collider: a single merged ribbon mesh's AABB
 * spans the whole path bounding box — for a long L-shaped corridor that
 * box covers rooms and stairs far from the ribbon, and its slab then
 * head-blocks stair climbers rising into that band anywhere under the
 * box (bot-proven phantom slabs sealing lawful stairwells).
 * Per-segment boxes hug the true ribbon; the slight joint overlap is
 * conservative (safe) for a playtest tool. Corridor ceilings stay
 * non-colliders (as before): nothing walks on them, and the floor slab
 * below always engages first from underneath.
 */
export function corridorSlabBoxes(
  points: { x: number; z: number }[],
  width: number,
  yBase: number,
  // Single source of truth (lawbook §7, §55).
  wallThickness = SPATIAL_DEFAULTS.wallThickness,
): THREE.Box3[] {
  // Mirror the ribbon builder: slab half width + 0.02 hair, ends extended
  // into the rooms (SEAM_OVERLAP), top 4 mm below room-slab level.
  const halfSlab = width / 2 + wallThickness + 0.02
  const SEAM = wallThickness / 2
  const SEAM_DROP = 0.004
  const THICKNESS = SPATIAL_DEFAULTS.floorThickness
  const yTop = yBase + THICKNESS - SEAM_DROP
  const yBot = yTop - THICKNESS
  // Drop degenerate consecutive points (same as the geometry builder).
  const clean: { x: number; z: number }[] = []
  for (const p of points) {
    const prev = clean[clean.length - 1]
    if (!prev || Math.sqrt((p.x - prev.x) ** 2 + (p.z - prev.z) ** 2) > 1e-4) {
      clean.push(p)
    }
  }
  if (clean.length < 2) return []
  const flat = clean.map(p => ({ ...p }))
  const d0x = flat[1].x - flat[0].x
  const d0z = flat[1].z - flat[0].z
  const l0 = Math.sqrt(d0x * d0x + d0z * d0z)
  if (l0 > 1e-6) {
    flat[0] = { x: flat[0].x - (d0x / l0) * SEAM, z: flat[0].z - (d0z / l0) * SEAM }
  }
  const n = flat.length
  const d1x = flat[n - 1].x - flat[n - 2].x
  const d1z = flat[n - 1].z - flat[n - 2].z
  const l1 = Math.sqrt(d1x * d1x + d1z * d1z)
  if (l1 > 1e-6) {
    flat[n - 1] = { x: flat[n - 1].x + (d1x / l1) * SEAM, z: flat[n - 1].z + (d1z / l1) * SEAM }
  }
  const out: THREE.Box3[] = []
  for (let i = 0; i < flat.length - 1; i++) {
    const p = flat[i]
    const q = flat[i + 1]
    const dx = q.x - p.x
    const dz = q.z - p.z
    const len = Math.sqrt(dx * dx + dz * dz)
    if (len < 1e-6) continue
    // Unit normal × half slab: the swept ribbon's extreme corners.
    const nx = -dz / len
    const nz = dx / len
    const xs = [p.x + nx * halfSlab, p.x - nx * halfSlab, q.x + nx * halfSlab, q.x - nx * halfSlab]
    const zs = [p.z + nz * halfSlab, p.z - nz * halfSlab, q.z + nz * halfSlab, q.z - nz * halfSlab]
    out.push(new THREE.Box3(
      new THREE.Vector3(Math.min(...xs), yBot, Math.min(...zs)),
      new THREE.Vector3(Math.max(...xs), yTop, Math.max(...zs)),
    ))
  }
  return out
}
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

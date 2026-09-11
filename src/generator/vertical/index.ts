import type { Room, MeshData, StairsGeometry, VerticalLink, DoorOpening } from '@/core/types'
import { createBoxMesh, createOrientedBox } from '@/core/meshdata'

// Vertical circulation (pipeline stage: "Add stairs or vertical connectors").
//
// Stairs always live INSIDE the larger of the two linked rooms (never
// floating at midpoints in empty space): StairPlan fixes the footprint,
// planStairs() also reserves matching floor/ceiling holes, and the builders
// below emit LOCAL geometry (base at y=0); the renderer/exporter offsets
// each group by floor level.

const FLOOR_THICKNESS = 0.2
const STAIR_WIDTH = 2.5
const STAIR_DEPTH = 5.0
const LANDING_DEPTH = 1.2

export interface StairPlan {
  link: VerticalLink
  /** Room containing the stairs (the larger of the two). */
  hostRoomId: string
  /** True when the host is the lower room (stairs ascend from it). */
  ascending: boolean
  /** Run axis in room space. */
  axis: 'x' | 'z'
  /** World-space footprint center. */
  x: number
  z: number
  width: number
  depth: number
}

// Wall index per facing side (matches core/generation door walls).
function sideToWallIndex(side: 'px' | 'nx' | 'pz' | 'nz'): number {
  switch (side) {
    case 'px': return 1
    case 'nx': return 3
    case 'pz': return 2
    case 'nz': return 0
  }
}

export function planStairs(
  rooms: Room[],
  doorsByRoom: Map<string, DoorOpening[]>
): StairPlan[] {
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const plans: StairPlan[] = []

  for (const link of findVerticalLinks(rooms)) {
    const lower = roomMap.get(link.lowerRoomId)!
    const upper = roomMap.get(link.upperRoomId)!
    if (!lower || !upper) continue

    // Host = the lower room, always: stairs ascend from its floor to the
    // next floor level, so the top landing always meets the upper level
    // exactly (upper floor top == landing top).
    const host = lower
    const other = upper
    const ascending = true

    // Face the other room: run the stairs toward that wall.
    const dx = other.position.x - host.position.x
    const dz = other.position.z - host.position.z
    const side: 'px' | 'nx' | 'pz' | 'nz' =
      Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'px' : 'nx') : (dz > 0 ? 'pz' : 'nz')
    const axis: 'x' | 'z' = side === 'px' || side === 'nx' ? 'x' : 'z'

    // Clamp the footprint to the host room.
    const hostAlong = axis === 'z' ? host.depth : host.width
    const hostAcross = axis === 'z' ? host.width : host.depth
    const width = Math.min(STAIR_WIDTH, Math.max(1.4, hostAcross - 1.2))
    const depth = Math.min(STAIR_DEPTH, Math.max(2.4, hostAlong - 1.2))

    // Push the footprint against the facing wall.
    const alongSign = side === 'px' || side === 'pz' ? 1 : -1
    const hostHalfAlong = hostAlong / 2
    const alongCenter = alongSign * (hostHalfAlong - depth / 2 - 0.35)

    // Lateral placement: bias toward the other room, then shift away from
    // doors on the facing wall so stairs never block a doorway.
    const otherLat = axis === 'z' ? other.position.z - host.position.z : other.position.x - host.position.x
    const maxLat = Math.max(0, hostAcross / 2 - width / 2 - 0.35)
    const clampLat = (v: number) => Math.max(-maxLat, Math.min(maxLat, v))
    const wallIndex = sideToWallIndex(side)
    const doorLats = (doorsByRoom.get(host.id) ?? [])
      .filter(d => d.wallIndex === wallIndex)
      .map(d => (axis === 'z' ? d.position.z - host.position.z : d.position.x - host.position.x))

    let lateral = clampLat(otherLat)
    if (doorLats.length > 0) {
      let best = lateral
      let bestScore = -Infinity
      for (let c = -maxLat; c <= maxLat + 1e-6; c += 0.5) {
        const score = Math.min(...doorLats.map(d => Math.abs(c - d)))
        const tiebreak = -Math.abs(c - clampLat(otherLat)) * 0.01
        if (score + tiebreak > bestScore) {
          bestScore = score + tiebreak
          best = c
        }
      }
      lateral = best
    }

    const hx = host.position.x
    const hz = host.position.z
    plans.push({
      link,
      hostRoomId: host.id,
      ascending,
      axis,
      x: axis === 'z' ? hx + lateral : hx + alongCenter,
      z: axis === 'z' ? hz + alongCenter : hz + lateral,
      width,
      depth,
    })
  }

  return plans
}

export function generateStairsGeometry(rooms: Room[], config: { floorHeight: number }): StairsGeometry[] {
  return buildStairsGeometry(planStairs(rooms, new Map()), rooms, config.floorHeight)
}

export function buildStairsGeometry(plans: StairPlan[], rooms: Room[], floorHeight: number): StairsGeometry[] {
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const stairs: StairsGeometry[] = []

  for (const plan of plans) {
    const lower = roomMap.get(plan.link.lowerRoomId)!
    const upper = roomMap.get(plan.link.upperRoomId)!
    if (!lower || !upper) continue

    const stepCount = Math.max(8, Math.min(16, Math.floor(floorHeight / 0.18)))
    const stepHeight = floorHeight / stepCount
    const stepDepth = (plan.depth - LANDING_DEPTH) / (stepCount - 1)

    const built = createStairsMesh(
      plan.x,
      plan.z,
      plan.width,
      plan.depth,
      floorHeight,
      plan.axis,
      0,
      stepCount,
      stepHeight,
      stepDepth
    )

    stairs.push({
      id: `stairs_${plan.link.lowerRoomId}_${plan.link.upperRoomId}`,
      startFloor: lower.floorIndex,
      endFloor: upper.floorIndex,
      hostRoomId: plan.hostRoomId,
      axis: plan.axis,
      position: { x: plan.x, y: lower.floorIndex * floorHeight, z: plan.z },
      width: plan.width,
      depth: plan.depth,
      steps: built.steps,
      risers: built.risers,
      stringers: built.stringers,
      landing: built.landing,
    })
  }

  return stairs
}

function createStairsMesh(
  centerX: number, centerZ: number,
  width: number, depth: number,
  totalHeight: number,
  axis: 'x' | 'z',
  baseY: number,
  stepCount: number,
  stepHeight: number,
  stepDepth: number
): { steps: MeshData[]; risers: MeshData[]; stringers: MeshData[]; landing: MeshData[] } {
  const steps: MeshData[] = []
  const risers: MeshData[] = []
  const stringers: MeshData[] = []
  const landing: MeshData[] = []

  // Stairs ascend toward +axis (toward the facing wall). Map run/across
  // coordinates to world XZ.
  const toWorld = (along: number, y: number, across: number): { x: number; y: number; z: number } =>
    axis === 'z'
      ? { x: centerX + across, y, z: centerZ + along }
      : { x: centerX + along, y, z: centerZ + across }
  const putBox = (
    along: number, y: number, across: number,
    alongLen: number, h: number, acrossLen: number,
    materialIndex: number
  ): MeshData => {
    const c = toWorld(along, y, across)
    return axis === 'z'
      ? createBoxMesh(c.x, c.y, c.z, acrossLen, h, alongLen, materialIndex)
      : createBoxMesh(c.x, c.y, c.z, alongLen, h, acrossLen, materialIndex)
  }

  // Landing platform at the top (+along end).
  const landingY = baseY + totalHeight
  const landingCenter = depth / 2 - LANDING_DEPTH / 2
  landing.push(putBox(landingCenter, landingY + FLOOR_THICKNESS / 2, 0, LANDING_DEPTH, FLOOR_THICKNESS, width, 1))

  // Stringers: sloped side beams. Slope basis: u along the slope,
  // v its normal, w across the run.
  const run = depth - LANDING_DEPTH
  const stringerLength = Math.sqrt(totalHeight * totalHeight + run * run)
  const cosA = run / stringerLength
  const sinA = totalHeight / stringerLength
  const halfW = width / 2
  const stringerDepth = 0.3
  const stringerHeight = 0.3
  for (const s of [-1, 1]) {
    const across = s * (halfW + stringerDepth / 2)
    // Beam center: halfway up the slope, starting at the low end.
    const lowAlong = -depth / 2 + LANDING_DEPTH
    const midAlong = lowAlong + (run / stringerLength) * (stringerLength / 2)
    const midY = baseY + totalHeight / 2
    const c = toWorld(midAlong, midY, across)
    // Slope direction in world space (ascending toward +along).
    const slope = axis === 'z'
      ? { x: 0, y: sinA, z: cosA }
      : { x: cosA, y: sinA, z: 0 }
    const normal = axis === 'z'
      ? { x: 0, y: cosA, z: -sinA }
      : { x: -sinA, y: cosA, z: 0 }
    const acrossAxis = axis === 'z'
      ? { x: 1, y: 0, z: 0 }
      : { x: 0, y: 0, z: 1 }
    stringers.push(createOrientedBox(
      c,
      { u: slope, v: normal, w: acrossAxis },
      stringerLength,
      stringerHeight,
      stringerDepth,
      0
    ))
  }

  for (let i = 0; i < stepCount; i++) {
    const y = baseY + i * stepHeight
    const along = -depth / 2 + LANDING_DEPTH + i * stepDepth

    // Step tread (slight overlap avoids hairline gaps).
    steps.push(putBox(along, y + stepHeight / 2, 0, stepDepth * 1.15, stepHeight, width, 1))

    // Riser (vertical face toward the ascending side).
    if (i < stepCount - 1) {
      risers.push(putBox(along + stepDepth / 2, y + stepHeight, 0, 0.15, stepHeight, width, 0))
    }
  }

  return { steps, risers, stringers, landing }
}

// Adjacent-floor room pairs (each once). Shared by stair generation and
// level-graph validation so both agree on what "connected" means.
export function findVerticalLinks(rooms: Room[]): VerticalLink[] {
  const roomMap = new Map(rooms.map(r => [r.id, r]))
  const processed = new Set<string>()
  const links: VerticalLink[] = []

  for (const room of rooms) {
    for (const connId of room.connections) {
      // Connections are bidirectional: handle each pair once.
      const key = [room.id, connId].sort().join('|')
      if (processed.has(key)) continue
      processed.add(key)

      const targetRoom = roomMap.get(connId)
      if (!targetRoom) continue

      const floorDiff = targetRoom.floorIndex - room.floorIndex
      if (Math.abs(floorDiff) !== 1) continue

      links.push(
        floorDiff > 0
          ? { lowerRoomId: room.id, upperRoomId: targetRoom.id }
          : { lowerRoomId: targetRoom.id, upperRoomId: room.id },
      )
    }
  }

  return links
}

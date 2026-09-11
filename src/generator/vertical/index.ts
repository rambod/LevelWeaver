import type { Room, MeshData, StairsGeometry, VerticalLink } from '@/core/types'
import { createBoxMesh, createOrientedBox } from '@/core/meshdata'

// Vertical circulation (pipeline stage: "Add stairs or vertical connectors").
// Builds stair geometry between rooms on adjacent floors in LOCAL coordinates
// (base at y=0); the renderer/exporter offsets each group by floor level.

const FLOOR_THICKNESS = 0.2

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

export function generateStairsGeometry(rooms: Room[], config: { floorHeight: number }): StairsGeometry[] {
  const stairs: StairsGeometry[] = []
  const floorHeight = config.floorHeight
  const roomMap = new Map(rooms.map(r => [r.id, r]))

  for (const link of findVerticalLinks(rooms)) {
    const lowerRoom = roomMap.get(link.lowerRoomId)!
    const upperRoom = roomMap.get(link.upperRoomId)!

      // Use vertical connector room position if available, otherwise midpoint
      const isVerticalConnector = lowerRoom.type === 'verticalConnector' || upperRoom.type === 'verticalConnector'
      const stairX = isVerticalConnector
        ? (lowerRoom.type === 'verticalConnector' ? lowerRoom.position.x : upperRoom.position.x)
        : (lowerRoom.position.x + upperRoom.position.x) / 2
      const stairZ = isVerticalConnector
        ? (lowerRoom.type === 'verticalConnector' ? lowerRoom.position.z : upperRoom.position.z)
        : (lowerRoom.position.z + upperRoom.position.z) / 2
        
        const stairWidth = 2.5
        const stairDepth = 4.5 // Deeper for landing
        const stepCount = Math.max(8, Math.min(16, Math.floor(floorHeight / 0.18)))
        const stepHeight = floorHeight / stepCount
        const stepDepth = (stairDepth - 1.5) / (stepCount - 1) // Leave space for landing

        const stairsGeo = createStairsMesh(
          stairX,
          stairZ,
          stairWidth,
          stairDepth,
          floorHeight,
          true,
          0,
          stepCount,
          stepHeight,
          stepDepth
        )

        stairs.push({
          id: `stairs_${lowerRoom.id}_${upperRoom.id}`,
          startFloor: lowerRoom.floorIndex,
          endFloor: upperRoom.floorIndex,
          steps: stairsGeo.steps,
          risers: stairsGeo.risers,
          stringers: stairsGeo.stringers,
          landing: stairsGeo.landing,
        })
  }

  return stairs
}


function createStairsMesh(
  centerX: number, centerZ: number,
  width: number, depth: number,
  totalHeight: number,
  goingUp: boolean,
  baseY: number,
  stepCount: number,
  stepHeight: number,
  stepDepth: number
): { steps: MeshData[]; risers: MeshData[]; stringers: MeshData[]; landing: MeshData[] } {
  const steps: MeshData[] = []
  const risers: MeshData[] = []
  const stringers: MeshData[] = []
  const landing: MeshData[] = []
  const halfW = width / 2
  const stringerDepth = 0.3
  const stringerHeight = 0.3
  
  // Landing platform at top
  const landingDepth = 1.5
  const landingY = baseY + totalHeight
  landing.push(createBoxMesh(
    centerX, landingY + FLOOR_THICKNESS / 2, centerZ + (goingUp ? depth/2 - landingDepth/2 : -depth/2 + landingDepth/2),
    width, FLOOR_THICKNESS, landingDepth,
    1
  ))
  
  // Stringers (structural supports on sides)
  const stringerLength = Math.sqrt(totalHeight * totalHeight + (depth - landingDepth) * (depth - landingDepth))
  const stringerAngle = Math.atan2(totalHeight, depth - landingDepth)
  
  // Left stringer
  stringers.push(createStringerMesh(
    centerX - halfW - stringerDepth/2,
    centerZ + (goingUp ? -depth/2 + landingDepth/2 : depth/2 - landingDepth/2),
    stringerLength,
    stringerDepth,
    stringerHeight,
    stringerAngle,
    baseY + stepHeight/2,
    goingUp
  ))
  
  // Right stringer
  stringers.push(createStringerMesh(
    centerX + halfW + stringerDepth/2,
    centerZ + (goingUp ? -depth/2 + landingDepth/2 : depth/2 - landingDepth/2),
    stringerLength,
    stringerDepth,
    stringerHeight,
    stringerAngle,
    baseY + stepHeight/2,
    goingUp
  ))
  
  for (let i = 0; i < stepCount; i++) {
    const y = baseY + i * stepHeight
    const zOffset = goingUp 
      ? -depth/2 + landingDepth + i * stepDepth
      : depth/2 - landingDepth - i * stepDepth
    
    // Step tread
    steps.push(createBoxMesh(
      centerX, y + stepHeight/2, centerZ + zOffset,
      width, stepHeight, stepDepth,
      1 // floor material
    ))
    
    // Riser (vertical face)
    if (i < stepCount - 1) {
      risers.push(createBoxMesh(
        centerX, y + stepHeight, centerZ + zOffset + (goingUp ? stepDepth/2 : -stepDepth/2),
        width, stepHeight, 0.15,
        0 // wall material
      ))
    }
  }
  
  return { steps, risers, stringers, landing }
}


function createStringerMesh(
  x: number, z: number,
  length: number, width: number, height: number,
  angle: number,
  baseY: number,
  goingUp: boolean
): MeshData {
  // Sloped side beam: the slope rises along +Z when goingUp, -Z otherwise.
  // Built as an oriented box so vertex/normal/uv counts stay consistent.
  const dirZ = goingUp ? 1 : -1
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const slope = { x: 0, y: sin, z: dirZ * cos }
  const normal = { x: 0, y: cos, z: -dirZ * sin }

  return createOrientedBox(
    {
      x,
      y: baseY + (sin * length) / 2,
      z: z + dirZ * (cos * length) / 2,
    },
    {
      u: slope,
      v: normal,
      w: { x: 1, y: 0, z: 0 },
    },
    length,
    height,
    width,
    0
  )
}


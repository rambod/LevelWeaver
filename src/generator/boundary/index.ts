import type { Boundary, LevelConfig } from '@/core/types'
import { SeededRandom } from '@/core/random'

export function generateBoundary(config: LevelConfig, random: SeededRandom): Boundary {
  const area = config.area
  let width: number
  let depth: number

  switch (config.shape) {
    case 'square': {
      const size = Math.sqrt(area)
      width = size
      depth = size
      break
    }
    case 'rectangle': {
      const aspectRatio = 1.5 + random.nextFloat(0, 0.5)
      width = Math.sqrt(area * aspectRatio)
      depth = Math.sqrt(area / aspectRatio)
      break
    }
    case 'ring': {
      const outerRadius = Math.sqrt(area / Math.PI)
      width = outerRadius * 2
      depth = outerRadius * 2
      break
    }
    case 'cross': {
      const armLength = Math.sqrt(area / 5)
      width = armLength * 3
      depth = armLength * 3
      break
    }
    case 'radial': {
      const radius = Math.sqrt(area / Math.PI)
      width = radius * 2
      depth = radius * 2
      break
    }
    case 'hub': {
      const hubRadius = Math.sqrt(area / (Math.PI + 4))
      width = hubRadius * 4
      depth = hubRadius * 4
      break
    }
    case 'linear': {
      const segmentLength = Math.sqrt(area / config.roomCount) * 1.2
      width = segmentLength * config.roomCount * 0.6
      depth = segmentLength * 1.5
      break
    }
    case 'branching': {
      const baseSize = Math.sqrt(area / 3)
      width = baseSize * 2.5
      depth = baseSize * 2.5
      break
    }
    default: {
      const size = Math.sqrt(area)
      width = size
      depth = size
    }
  }

  return {
    shape: config.shape,
    width,
    depth,
    center: { x: 0, y: 0 },
  }
}

export function isPointInBoundary(point: { x: number; z: number }, boundary: Boundary, margin = 0): boolean {
  const halfW = boundary.width / 2 - margin
  const halfD = boundary.depth / 2 - margin

  switch (boundary.shape) {
    case 'rectangle':
    case 'square':
    case 'hub':
    case 'linear':
    case 'branching':
      return Math.abs(point.x - boundary.center.x) <= halfW &&
             Math.abs(point.z - boundary.center.y) <= halfD

    case 'ring': {
      const dist = Math.sqrt(
        (point.x - boundary.center.x) ** 2 + (point.z - boundary.center.y) ** 2
      )
      const outerRadius = boundary.width / 2 - margin
      const innerRadius = outerRadius * 0.4
      return dist <= outerRadius && dist >= innerRadius
    }

    case 'cross': {
      const armHalfW = boundary.width / 6
      const centerHalf = boundary.width / 2
      const inHorizontal = Math.abs(point.x) <= centerHalf && Math.abs(point.z) <= armHalfW
      const inVertical = Math.abs(point.z) <= centerHalf && Math.abs(point.x) <= armHalfW
      return inHorizontal || inVertical
    }

    case 'radial': {
      const dist = Math.sqrt(
        (point.x - boundary.center.x) ** 2 + (point.z - boundary.center.y) ** 2
      )
      return dist <= boundary.width / 2 - margin
    }

    default:
      return Math.abs(point.x - boundary.center.x) <= halfW &&
             Math.abs(point.z - boundary.center.y) <= halfD
  }
}

export function getBoundarySpawnPoints(boundary: Boundary, count: number, random: SeededRandom): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = []
  const margin = 2

  for (let i = 0; i < count * 3; i++) {
    const x = random.nextFloat(-boundary.width / 2 + margin, boundary.width / 2 - margin)
    const z = random.nextFloat(-boundary.depth / 2 + margin, boundary.depth / 2 - margin)
    if (isPointInBoundary({ x, z }, boundary, margin)) {
      points.push({ x, z })
      if (points.length >= count) break
    }
  }

  return points
}
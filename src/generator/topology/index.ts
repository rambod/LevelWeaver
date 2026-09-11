import type { Room, RoomType, LevelConfig, Boundary } from '@/core/types'
import { FLOOR_HEIGHT } from '@/core/types'
import { SeededRandom } from '@/core/random'
import { isPointInBoundary } from '@/generator/boundary'

interface TopologyNode {
  id: string
  type: RoomType
  connections: Set<string>
  position: { x: number; z: number }
  floorIndex: number
  weight: number
}

export function generateTopology(config: LevelConfig, boundary: Boundary, random: SeededRandom): Room[] {
  const nodes = new Map<string, TopologyNode>()
  const roomCount = config.roomCount
  const floorCount = config.floorCount

  // Create mandatory rooms: spawn and exit
  const spawnId = 'room_0'
  const exitId = `room_${roomCount - 1}`

  const spawnFloor = 0
  const exitFloor = floorCount - 1

  nodes.set(spawnId, {
    id: spawnId,
    type: 'spawn',
    connections: new Set(),
    position: getSpawnPosition(boundary, random),
    floorIndex: spawnFloor,
    weight: 1.0,
  })

  nodes.set(exitId, {
    id: exitId,
    type: 'exit',
    connections: new Set(),
    position: getExitPosition(boundary, random),
    floorIndex: exitFloor,
    weight: 1.0,
  })

  // Create remaining rooms
  const roomTypes: RoomType[] = [
    'standard', 'standard', 'standard', 'standard',
    'hall', 'hall',
    'hub',
    'arena',
    'objective',
    'storage',
    'connector',
    'verticalConnector',
  ]

  const largeRoomCount = Math.min(config.largeRoomCount, roomCount - 2)
  let largeRoomsCreated = 0

  for (let i = 1; i < roomCount - 1; i++) {
    const floorIndex = random.nextInt(0, floorCount - 1)
    let type: RoomType

    if (largeRoomsCreated < largeRoomCount && random.nextBool(0.3)) {
      type = random.pick(['hub', 'arena'])
      largeRoomsCreated++
    } else {
      type = random.pick(roomTypes)
    }

    // Vertical connectors only on floors that aren't top/bottom
    if (type === 'verticalConnector' && floorCount <= 1) {
      type = 'connector'
    }

    nodes.set(`room_${i}`, {
      id: `room_${i}`,
      type,
      connections: new Set(),
      position: getRoomPosition(boundary, floorIndex, floorCount, random),
      floorIndex,
      weight: getRoomWeight(type),
    })
  }

  // Build connections based on topology shape
  buildConnections(nodes, config, boundary, random)

  // Convert to Room array
  const rooms: Room[] = []
  nodes.forEach((node) => {
    rooms.push({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.floorIndex * FLOOR_HEIGHT, z: node.position.z },
      width: 0, // Will be set in room sizing
      depth: 0,
      height: 4,
      floorIndex: node.floorIndex,
      materialTheme: config.theme,
      connections: Array.from(node.connections),
    })
  })

  return rooms
}

function getSpawnPosition(boundary: Boundary, random: SeededRandom): { x: number; z: number } {
  const margin = 3
  switch (boundary.shape) {
    case 'hub':
    case 'radial':
      return { x: 0, z: 0 }
    case 'linear':
      return { x: -boundary.width / 2 + margin, z: 0 }
    case 'branching':
      return { x: -boundary.width / 2 + margin, z: -boundary.depth / 2 + margin }
    default:
      return {
        x: random.nextFloat(-boundary.width / 2 + margin, boundary.width / 2 - margin),
        z: random.nextFloat(-boundary.depth / 2 + margin, boundary.depth / 2 - margin),
      }
  }
}

function getExitPosition(boundary: Boundary, random: SeededRandom): { x: number; z: number } {
  const margin = 3
  switch (boundary.shape) {
    case 'hub':
    case 'radial': {
      const angle = random.nextFloat(0, Math.PI * 2)
      const radius = boundary.width / 2 * 0.8
      return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius }
    }
    case 'linear':
      return { x: boundary.width / 2 - margin, z: 0 }
    case 'branching':
      return { x: boundary.width / 2 - margin, z: boundary.depth / 2 - margin }
    default:
      return {
        x: random.nextFloat(-boundary.width / 2 + margin, boundary.width / 2 - margin),
        z: random.nextFloat(-boundary.depth / 2 + margin, boundary.depth / 2 - margin),
      }
  }
}

function getRoomPosition(
  boundary: Boundary,
  _floorIndex: number,
  _floorCount: number,
  random: SeededRandom
): { x: number; z: number } {
  const margin = 2
  const maxAttempts = 50

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = random.nextFloat(-boundary.width / 2 + margin, boundary.width / 2 - margin)
    const z = random.nextFloat(-boundary.depth / 2 + margin, boundary.depth / 2 - margin)
    // Respect non-rectangular boundaries (ring, cross, radial, ...).
    // Fall back to the center only if no valid point was found.
    if (isPointInBoundary({ x, z }, boundary, margin)) {
      return { x, z }
    }
  }

  return { x: 0, z: 0 }
}

function getRoomWeight(type: RoomType): number {
  switch (type) {
    case 'hub': return 1.5
    case 'arena': return 1.3
    case 'hall': return 1.1
    case 'verticalConnector': return 1.2
    case 'spawn':
    case 'exit': return 1.0
    default: return 1.0
  }
}

// Stair-host preference for vertical links: a walkable 4m rise needs ~7m
// of run, which only large lower rooms fit. Bonus steers links there.
function lowerRoomBonus(type: RoomType): number {
  switch (type) {
    case 'hub':
    case 'arena': return 9
    case 'hall':
    case 'objective': return 4
    case 'storage':
    case 'spawn':
    case 'exit': return 1
    default: return 0.5
  }
}

function buildConnections(
  nodes: Map<string, TopologyNode>,
  config: LevelConfig,
  _boundary: Boundary,
  random: SeededRandom
): void {
  const nodeArray = Array.from(nodes.values())
  const connectivity = config.connectivity
  const targetConnections = Math.max(1, Math.round(nodeArray.length * connectivity * 0.5))

  // Sort by floor, then by distance from spawn
  const spawnNode = nodes.get('room_0')!
  nodeArray.sort((a, b) => {
    if (a.floorIndex !== b.floorIndex) return a.floorIndex - b.floorIndex
    const distA = distance(a.position, spawnNode.position)
    const distB = distance(b.position, spawnNode.position)
    return distA - distB
  })

  // Connect each node to previous nodes (tree-like base). Partners are
  // chosen NEAR-first (seeded): uniform random picks produced far-flung
  // links that became 60m+ corridors dominating the map. Links beyond
  // TREE_LINK_MAX are only used when nothing nearer exists (connectivity
  // beats looks; ensureConnected is the final backstop).
  const TREE_LINK_MAX = 45
  for (let i = 1; i < nodeArray.length; i++) {
    const node = nodeArray[i]
    const candidates = nodeArray.slice(0, i).filter(n =>
      n.floorIndex === node.floorIndex || Math.abs(n.floorIndex - node.floorIndex) === 1
    )

    if (candidates.length > 0) {
      const near = candidates.filter(n => distance(node.position, n.position) <= TREE_LINK_MAX)
      const target = pickNear(node, near.length > 0 ? near : candidates, random)
      addConnection(nodes, node.id, target.id)
    }
  }

  // Add extra connections for loops/alternate paths (near-biased too, and
  // capped: long alternates are allowed only when short ones run out).
  const EXTRA_LINK_MAX = 40
  const extraConnections = Math.round(targetConnections * connectivity)
  for (let i = 0; i < extraConnections; i++) {
    const a = random.pick(nodeArray)
    const inRange = (n: TopologyNode) =>
      n.id !== a.id &&
      !a.connections.has(n.id) &&
      (n.floorIndex === a.floorIndex || Math.abs(n.floorIndex - a.floorIndex) === 1)
    const candidates = nodeArray.filter(inRange)
    if (candidates.length === 0) continue
    const near = candidates.filter(n => distance(a.position, n.position) <= EXTRA_LINK_MAX)
    const pool = near.length > 0 ? near : candidates
    // Mostly near, occasionally far (keeps long alternate routes possible
    // without letting them dominate).
    const b = random.nextBool(0.85) ? pickNear(a, pool, random) : random.pick(pool)
    addConnection(nodes, a.id, b.id)
  }

  // Handle vertical connectors
  handleVerticalConnections(nodes, config, random)

  // Apply dead ends
  applyDeadEnds(nodes, config, random)

  // Final guarantee: attach any still-orphaned room to its nearest
  // SAME-floor neighbor (a same-floor link always yields a walkable
  // corridor; a cross-floor link would strand the room behind stairs
  // placed far away). Falls back to adjacent floors only for single-room
  // floors. Deterministic: nearest distance, lowest id breaks ties.
  ensureConnected(nodes)

  // Same-floor guarantee: every room on a multi-room floor needs at least
  // one same-floor link. Stairs can be dropped by placement rules, but
  // corridors never drop — so a room whose links are all vertical can be
  // stranded by dropped shafts. Single-room floors keep cross-floor links.
  ensureSameFloorLink(nodes)
}

function addConnection(nodes: Map<string, TopologyNode>, aId: string, bId: string): void {
  const a = nodes.get(aId)
  const b = nodes.get(bId)
  if (a && b) {
    a.connections.add(bId)
    b.connections.add(aId)
  }
}

// Seeded near-first pick: sort candidates by distance with a small random
// jitter for variety, then take one of the closest few.
function pickNear(from: TopologyNode, candidates: TopologyNode[], random: SeededRandom): TopologyNode {
  const ranked = candidates
    .map(c => ({ c, score: distance(from.position, c.position) - random.nextFloat(0, 8) }))
    .sort((p, q) => p.score - q.score)
  const shortlist = ranked.slice(0, Math.min(3, ranked.length))
  return random.pick(shortlist).c
}

function handleVerticalConnections(
  nodes: Map<string, TopologyNode>,
  config: LevelConfig,
  random: SeededRandom
): void {
  if (config.floorCount <= 1) return

  // const verticalNodes = Array.from(nodes.values()).filter(n => n.type === 'verticalConnector')

  for (let floor = 0; floor < config.floorCount - 1; floor++) {
    const lowerRooms = Array.from(nodes.values()).filter(n => n.floorIndex === floor)
    const upperRooms = Array.from(nodes.values()).filter(n => n.floorIndex === floor + 1)

    if (lowerRooms.length === 0 || upperRooms.length === 0) continue

    // Score every cross-floor pair by XZ distance (plus a little seeded
    // jitter for variety), preferring LARGE lower rooms as stair hosts: a
    // walkable 4m rise needs ~7m of run, which only big rooms fit. Stairs
    // are built at/near the linked rooms, so close pairs also keep
    // vertical circulation reachable instead of floating at the midpoint
    // of two distant rooms.
    const pairs = []
    for (const lower of lowerRooms) {
      for (const upper of upperRooms) {
        pairs.push({
          lower,
          upper,
          score: distance(lower.position, upper.position) - lowerRoomBonus(lower.type) - random.nextFloat(0, 10),
        })
      }
    }
    pairs.sort((p1, p2) => p1.score - p2.score)

    // Connect at least one room per floor transition (closest pair).
    addConnection(nodes, pairs[0].lower.id, pairs[0].upper.id)

    // Add more vertical connections based on verticality, closest first.
    const extraVertical = Math.round((lowerRooms.length + upperRooms.length) * config.verticality * 0.3)
    let added = 0
    for (const pair of pairs) {
      if (added >= extraVertical) break
      if (!pair.lower.connections.has(pair.upper.id)) {
        addConnection(nodes, pair.lower.id, pair.upper.id)
        added++
      }
    }
  }
}

function applyDeadEnds(
  nodes: Map<string, TopologyNode>,
  config: LevelConfig,
  random: SeededRandom
): void {
  if (config.deadEnds <= 0) return

  const nodeArray = Array.from(nodes.values())
  const targetDeadEnds = Math.round(nodeArray.length * config.deadEnds)

  // Dead ends should be leaf rooms that stay connected to the graph.
  // Never disconnect a room's last connection: that would isolate rooms
  // and produce unreachable geometry. Only prune redundant connections
  // (nodes with degree >= 2) so every room keeps at least one link.
  const candidates = nodeArray.filter(n =>
    n.connections.size >= 2 && n.type !== 'spawn' && n.type !== 'exit'
  )

  for (let i = 0; i < targetDeadEnds && candidates.length > 0; i++) {
    const node = random.pick(candidates)
    if (node.connections.size < 2) continue
    const connectedId = random.pick(Array.from(node.connections))
    const neighbor = nodes.get(connectedId)
    // Keep the graph connected: never strand a neighbor with 1 link.
    if (!neighbor || neighbor.connections.size < 2) continue
    node.connections.delete(connectedId)
    neighbor.connections.delete(node.id)
  }
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2)
}

function ensureConnected(nodes: Map<string, TopologyNode>): void {
  for (const node of nodes.values()) {
    if (node.connections.size > 0) continue
    // Prefer same floor; adjacent floors only as a last resort.
    const best =
      nearestOnFloors(nodes, node, [node.floorIndex]) ??
      nearestOnFloors(nodes, node, [node.floorIndex - 1, node.floorIndex + 1])
    if (best) addConnection(nodes, node.id, best.id)
  }
}

function nearestOnFloors(
  nodes: Map<string, TopologyNode>,
  node: TopologyNode,
  floors: number[]
): TopologyNode | null {
  let best: TopologyNode | null = null
  let bestDist = Infinity
  for (const other of nodes.values()) {
    if (other.id === node.id) continue
    if (!floors.includes(other.floorIndex)) continue
    const d = distance(node.position, other.position)
    if (d < bestDist || (d === bestDist && best !== null && other.id < best.id)) {
      best = other
      bestDist = d
    }
  }
  return best
}

function ensureSameFloorLink(nodes: Map<string, TopologyNode>): void {
  const floorCounts = new Map<number, number>()
  for (const node of nodes.values()) {
    floorCounts.set(node.floorIndex, (floorCounts.get(node.floorIndex) ?? 0) + 1)
  }
  for (const node of nodes.values()) {
    if ((floorCounts.get(node.floorIndex) ?? 0) < 2) continue
    const hasSameFloor = [...node.connections].some(id => {
      const other = nodes.get(id)
      return other !== undefined && other.floorIndex === node.floorIndex
    })
    if (hasSameFloor) continue
    const best = nearestOnFloors(nodes, node, [node.floorIndex])
    if (best) addConnection(nodes, node.id, best.id)
  }
}
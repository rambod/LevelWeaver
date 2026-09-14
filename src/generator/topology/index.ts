import type { Room, RoomType, MapShape, LevelConfig, Boundary } from '@/core/types'
import { floorHeightFor } from '@/core/types'
import { SeededRandom } from '@/core/random'
import { SPATIAL_DEFAULTS } from '@/core/rules'
import { presets, pickWeightedRoomType } from '@/core/presets'
import { ROOM_BASE_SIZES } from '@/generator/rooms'
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

  // Create remaining rooms. Types come from the weighted lottery (base
  // table × active preset profile, lawbook §89); the large-room quota is
  // a deterministic reservation (seeded shuffle), not a per-room coin
  // flip, so configured large-room counts actually materialize.
  const typeWeights = presets[config.preset]?.roomTypeWeights

  const largeRoomCount = Math.min(config.largeRoomCount, roomCount - 2)
  const middleIds: number[] = []
  for (let i = 1; i < roomCount - 1; i++) middleIds.push(i)
  const largeSet = new Set(random.shuffle(middleIds).slice(0, largeRoomCount))

  for (let i = 1; i < roomCount - 1; i++) {
    const floorIndex = random.nextInt(0, floorCount - 1)
    let type: RoomType

    if (largeSet.has(i)) {
      type = random.pick(['hub', 'arena'])
    } else {
      type = pickWeightedRoomType(random, typeWeights)
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

  // Lawbook §39 + §62: every floor must be occupied (a gap floor breaks
  // all stairs past it — vertical links only span adjacent floors), and
  // every floor in a multi-floor level needs a stair-hostable room (a
  // floor of only 4 m closets cannot host a legal flight or a tower in a
  // dense map). Both repairs run BEFORE connections so all graph
  // guarantees apply to the final assignment.
  ensureEveryFloorOccupied(nodes, config)
  ensureStairHallPerFloor(nodes, config)

  // Build connections based on topology shape
  buildConnections(nodes, config, boundary, random)

  // Convert to Room array
  const rooms: Room[] = []
  nodes.forEach((node) => {
    rooms.push({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.floorIndex * floorHeightFor(config), z: node.position.z },
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

// Every floor in [0, floorCount) holds at least one room. Relocates the
// lowest-id convertible room from the most-populated floor (never
// spawn/exit); deterministic.
function ensureEveryFloorOccupied(nodes: Map<string, TopologyNode>, config: LevelConfig): void {
  if (config.floorCount <= 1) return
  for (let floor = 0; floor < config.floorCount; floor++) {
    let occupied = false
    for (const n of nodes.values()) {
      if (n.floorIndex === floor) {
        occupied = true
        break
      }
    }
    if (occupied) continue
    const counts = new Map<number, number>()
    for (const n of nodes.values()) {
      counts.set(n.floorIndex, (counts.get(n.floorIndex) ?? 0) + 1)
    }
    let donorFloor = 0
    let donorCount = -1
    for (const [f, c] of counts) {
      if (c > donorCount) {
        donorCount = c
        donorFloor = f
      }
    }
    const candidate = [...nodes.values()]
      .filter(n => n.floorIndex === donorFloor && n.type !== 'spawn' && n.type !== 'exit')
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0]
    if (candidate) candidate.floorIndex = floor
  }
}

// Stair-hall law: in a multi-floor level, every floor that hosts stairs
// (all but the top) needs at least one room whose TYPE can host a flight
// (hub/arena/hall/objective/verticalConnector). Small types (standard,
// storage, connector) become a verticalConnector stair hall; spawn/exit
// are never converted. Deterministic: lowest id wins.
function ensureStairHallPerFloor(nodes: Map<string, TopologyNode>, config: LevelConfig): void {
  if (config.floorCount <= 1) return
  const HOSTABLE: RoomType[] = ['hub', 'arena', 'hall', 'objective', 'verticalConnector']
  const CONVERTIBLE: RoomType[] = ['standard', 'storage', 'connector']
  for (let floor = 0; floor < config.floorCount - 1; floor++) {
    const onFloor = [...nodes.values()].filter(n => n.floorIndex === floor)
    if (onFloor.some(n => HOSTABLE.includes(n.type))) continue
    const candidate = onFloor
      .filter(n => CONVERTIBLE.includes(n.type))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0]
    if (candidate) candidate.type = 'verticalConnector'
  }
}

function getRoomWeight(type: RoomType): number {  switch (type) {
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
    // Capacity guard (lawbook §100): loop edges are optional, so skip pairs
    // whose walls cannot host another gate — the funnel fallback would seal
    // them. Tree and guarantee links stay exempt (connectivity beats looks).
    if (!wallFitsDegree(a.type, a.connections.size + 1, config.doorWidth)) continue
    if (!wallFitsDegree(b.type, b.connections.size + 1, config.doorWidth)) continue
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

  // Same-floor guarantee: every room on a multi-room floor must reach
  // every other room on that floor via same-floor links (see above).
  // Semantic degree top-up runs later on placed rooms (`topUpDegrees`,
  // in the layout attempt): wall capacity needs real footprints and the
  // short-link cap needs real positions, and post-placement repair cannot
  // distort placement.
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

    // Cross-floor links already created by the tree phase count: a tiny
    // room with three stair shafts is over-linked (no room has three clean
    // shaft sites), so no room gets more than VERTICAL_CAP intent links.
    // The floor pair's first link always lands (connectivity beats caps).
    const VERTICAL_CAP = 2
    const verticalDegree = (id: string): number => {
      const node = nodes.get(id)!
      let n = 0
      for (const c of node.connections) {
        const other = nodes.get(c)
        if (other && other.floorIndex !== node.floorIndex) n++
      }
      return n
    }

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

    // Add more vertical connections based on verticality, closest first,
    // skipping pairs whose endpoint already hosts enough shafts.
    const extraVertical = Math.round((lowerRooms.length + upperRooms.length) * config.verticality * 0.3)
    let added = 0
    for (const pair of pairs) {
      if (added >= extraVertical) break
      if (!pair.lower.connections.has(pair.upper.id)) {
        if (verticalDegree(pair.lower.id) >= VERTICAL_CAP || verticalDegree(pair.upper.id) >= VERTICAL_CAP) {
          continue
        }
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
    // Keep the graph connected: never strand a neighbor with 1 link, and
    // never cut a bridge (lawbook §10: the playable graph is one component).
    // Degree >= 2 on both ends is NOT enough — the edge can still be the
    // only bridge between two clusters. Small graphs: BFS check is cheap.
    if (!neighbor || neighbor.connections.size < 2) continue
    // Dead-end shaping (lawbook §13-14): never cut vertical links (stairs
    // are scarce realizations — cutting intent strands floors behind
    // shafts that may omit), never touch spawn/exit incident edges (no
    // accidental dead-end starts), and respect semantic degree minimums.
    if (neighbor.floorIndex !== node.floorIndex) continue
    if (
      node.type === 'spawn' || node.type === 'exit' ||
      neighbor.type === 'spawn' || neighbor.type === 'exit'
    ) continue
    if (node.connections.size - 1 < minDegreeFor(node.type, config.shape)) continue
    if (neighbor.connections.size - 1 < minDegreeFor(neighbor.type, config.shape)) continue
    node.connections.delete(connectedId)
    neighbor.connections.delete(node.id)
    if (
      !isFullyConnected(nodes) ||
      leafChainLength(nodes, node.id) > MAX_DEAD_END_DEPTH ||
      leafChainLength(nodes, neighbor.id) > MAX_DEAD_END_DEPTH
    ) {
      node.connections.add(connectedId)
      neighbor.connections.add(node.id)
    }
  }
}

// Lawbook §14 semantic degree minimums (soft goals, enforced as repair).
// Hubs trunk ≥3 links; halls/arenas/connectors/stair-halls ≥2; spawn/exit
// ≥2 so neither is an accidental dead end (§13) — except linear maps,
// where end stations are degree 1 by design. All other types accept leaves.
const DEGREE_MIN: Partial<Record<RoomType, number>> = {
  hub: 3,
  hall: 2,
  arena: 2,
  connector: 2,
  verticalConnector: 2,
  spawn: 2,
  exit: 2,
}

/** Lawbook §13: dead-end branches stay shallow (rooms beyond the branch). */
const MAX_DEAD_END_DEPTH = 2

function minDegreeFor(type: RoomType, shape: MapShape): number {
  if ((type === 'spawn' || type === 'exit') && shape === 'linear') return 1
  return DEGREE_MIN[type] ?? 1
}

// Leaf-chain length from a node: 0 unless it is a leaf, then 1 plus every
// degree-2 follower until a branch (or cycle guard). Used to cap dead-end
// depth after pruning.
function leafChainLength(nodes: Map<string, TopologyNode>, startId: string): number {
  const start = nodes.get(startId)
  if (!start || start.connections.size !== 1) return 0
  let len = 1
  const seen = new Set<string>([startId])
  let prev = startId
  let cur = [...start.connections][0]
  for (;;) {
    if (seen.has(cur)) break
    seen.add(cur)
    const node = nodes.get(cur)
    if (!node || node.connections.size !== 2) break
    const next = [...node.connections].find(id => id !== prev)
    if (!next) break
    prev = cur
    cur = next
    len++
  }
  return len
}

// Lawbook §100 wall capacity estimated from base footprints (nominal —
// sizing variation averages out; placement and validators catch true
// overcrowding). Used ONLY as a pre-filter for optional loop edges;
// guarantees (tree, vertical-first, same-floor merges) stay exempt.
function wallFitsDegree(type: RoomType, degree: number, doorW: number): boolean {
  const base = ROOM_BASE_SIZES[type]
  const wall = Math.min(base.w, base.d)
  const required =
    degree * doorW +
    2 * SPATIAL_DEFAULTS.doorCornerMargin +
    Math.max(0, degree - 1) * SPATIAL_DEFAULTS.doorSeparation
  return required <= wall + 1e-9
}

// Repair links must be short (lawbook §12 loop feasibility: reasonable
// geometric distance). A long repair edge would drag room placement across
// the map toward its partner and ship as subdivided hops anyway — worse
// than an honest leaf. Same scale as corridor subdivision.
const TOPUP_LINK_MAX = 24

// Semantic degree repair (lawbook §14, soft): hubs want ≥3 trunk links,
// halls/arenas/connectors/stair-halls ≥2, spawn/exit ≥2 (except linear
// maps, where end stations are degree 1 by design). Runs on PLACED rooms
// (real footprints for the §100 capacity check, real positions for the
// short-link cap), only ADDS edges, and is idempotent. Bounded: each pass
// links at least one room or stops.
export function topUpDegrees(rooms: Room[], config: LevelConfig): void {
  const VERTICAL_CAP = 2
  const byId = new Map(rooms.map(r => [r.id, r]))
  const crossDegree = (r: Room): number => {
    let count = 0
    for (const c of r.connections) {
      const other = byId.get(c)
      if (other && other.floorIndex !== r.floorIndex) count++
    }
    return count
  }
  const fits = (r: Room, degree: number): boolean => {
    const wall = Math.min(r.width, r.depth)
    if (!(wall > 0)) return false
    const required =
      degree * config.doorWidth +
      2 * SPATIAL_DEFAULTS.doorCornerMargin +
      Math.max(0, degree - 1) * SPATIAL_DEFAULTS.doorSeparation
    return required <= wall + 1e-9
  }
  for (let guard = 0; guard < 256; guard++) {
    let changed = false
    for (const id of [...byId.keys()].sort()) {
      const node = byId.get(id)!
      if (node.connections.length >= minDegreeFor(node.type, config.shape)) continue
      if (!fits(node, node.connections.length + 1)) continue
      let best: Room | null = null
      let bestDist = Infinity
      for (const other of byId.values()) {
        if (other.id === id || node.connections.includes(other.id)) continue
        if (Math.abs(other.floorIndex - node.floorIndex) > 1) continue
        if (!fits(other, other.connections.length + 1)) continue
        if (other.floorIndex !== node.floorIndex && (crossDegree(node) >= VERTICAL_CAP || crossDegree(other) >= VERTICAL_CAP)) continue
        const d = Math.sqrt(
          (node.position.x - other.position.x) ** 2 +
          (node.position.z - other.position.z) ** 2,
        )
        if (d > TOPUP_LINK_MAX) continue
        if (d < bestDist || (d === bestDist && best !== null && other.id < best.id)) {
          best = other
          bestDist = d
        }
      }
      if (best) {
        node.connections.push(best.id)
        best.connections.push(node.id)
        changed = true
      }
    }
    if (!changed) break
  }
}

// BFS over intent edges: the playable topology must be one component
// (lawbook §10). Used to guard dead-end pruning.
function isFullyConnected(nodes: Map<string, TopologyNode>): boolean {
  const ids = [...nodes.keys()]
  if (ids.length === 0) return true
  const seen = new Set<string>([ids[0]])
  const queue = [ids[0]]
  while (queue.length > 0) {
    const cur = queue.pop()!
    for (const nb of nodes.get(cur)!.connections) {
      if (!seen.has(nb)) {
        seen.add(nb)
        queue.push(nb)
      }
    }
  }
  return seen.size === ids.length
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
  // Lawbook §10 (applied per floor): every room on a multi-room floor must
  // reach every other room on that floor via same-floor links. One link
  // per room is NOT enough — two separate pairs would each satisfy a
  // degree check while stranding one pair away from the floor's stairs.
  // Merges same-floor components with nearest-pair links (deterministic).
  const floors = new Set<number>()
  for (const node of nodes.values()) floors.add(node.floorIndex)
  for (const floor of floors) {
    // Bounded by rooms-per-floor (each merge removes one component).
    for (let guard = 0; guard < 256; guard++) {
      const components = sameFloorComponents(nodes, floor)
      if (components.length <= 1) break
      // Nearest room pair across the first two components (ids break ties).
      const a = [...components[0]].sort()
      const b = [...components[1]].sort()
      let bestA = a[0]
      let bestB = b[0]
      let bestDist = Infinity
      for (const idA of a) {
        for (const idB of b) {
          const d = distance(nodes.get(idA)!.position, nodes.get(idB)!.position)
          const key = idA + '|' + idB
          const bestKey = bestA + '|' + bestB
          if (d < bestDist || (d === bestDist && key < bestKey)) {
            bestDist = d
            bestA = idA
            bestB = idB
          }
        }
      }
      addConnection(nodes, bestA, bestB)
    }
  }
}

function sameFloorComponents(nodes: Map<string, TopologyNode>, floor: number): Set<string>[] {
  const ids = [...nodes.values()].filter(n => n.floorIndex === floor).map(n => n.id)
  const seen = new Set<string>()
  const components: Set<string>[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const comp = new Set<string>([id])
    seen.add(id)
    const queue = [id]
    while (queue.length > 0) {
      const cur = queue.pop()!
      for (const nb of nodes.get(cur)!.connections) {
        const other = nodes.get(nb)
        if (!other || other.floorIndex !== floor || seen.has(nb)) continue
        seen.add(nb)
        comp.add(nb)
        queue.push(nb)
      }
    }
    components.push(comp)
  }
  // Stable order: sort by smallest id so merges are deterministic.
  components.sort((p, q) => {
    const a = [...p].sort()[0]
    const b = [...q].sort()[0]
    return a < b ? -1 : 1
  })
  return components
}

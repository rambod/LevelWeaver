import type { LevelConfig } from '@/core/types'
import { presets, shapes, themes } from '@/core/presets'

// Centralized dimensional rules (LAWBOOK §7, §106).
//
// FORBIDDEN: hard-coding 1.0 / 2.4 / 0.3 etc. in scattered generator
// functions. Every minimum/default below is the single source of truth;
// generator stages derive their geometry from here, never from literals.

// Lawbook §8 + §92: determinism key includes the generator version.
// Same seed + preset + params on a DIFFERENT version may legitimately
// produce a different level. The version travels with every generated
// level so stale regression seeds are detectable instead of silently
// "passing" against new geometry.
export const GENERATOR_VERSION = '0.1.6'

// Bound browser workloads before allocating grids or entering search loops.
export const CONFIG_LIMITS = {
  minRooms: 2, maxRooms: 100, minArea: 100, maxArea: 50000, maxFloors: 5,
  maxSeed: 0xffffffff,
} as const

export const EPSILON = 0.0001

// Routing safety margin beside a corridor ribbon (meters): covers the
// player body at neighboring doorways, not just slack. Single source for
// the router's obstacle inflation (§33/§101) and the placement gap below.
export const ROUTING_MARGIN = 0.45

export const AGENT_DEFAULTS = {
  height: 1.8,
  radius: 0.3,
  shoulderClearance: 0.1,
  headClearance: 0.2,
  maxStepHeight: 0.2,
  maxWalkSlopeDeg: 45,
} as const

/** Lawbook §5.1: minimumClearWidth = 2*radius + 2*shoulder. */
export const MIN_CLEAR_WIDTH =
  2 * AGENT_DEFAULTS.radius + 2 * AGENT_DEFAULTS.shoulderClearance // 0.80 m

/** Lawbook §5.1: minimumClearHeight = height + headClearance. */
export const MIN_CLEAR_HEIGHT =
  AGENT_DEFAULTS.height + AGENT_DEFAULTS.headClearance // 2.00 m

export const SPATIAL_DEFAULTS = {
  epsilon: EPSILON,
  // Single source of truth for wall thickness (lawbook §7, §55: 0.15-0.25
  // recommended; 0.30 chosen for chunky greybox readability and kept
  // everywhere — room walls, corridor ribbons, tower shafts — by import,
  // never by literal). Interior-boundary erosion derives from it.
  wallThickness: 0.3,
  floorThickness: 0.2,
  ceilingThickness: 0.2,

  minRoomWidth: 2.4,
  minRoomDepth: 2.4,
  minRoomArea: 6.0,
  minRoomAspectRatio: 0.5,
  maxRoomAspectRatio: 2.0,
  roomBuffer: 0.25,

  // Lawbook §106 strict V0.1 defaults.
  doorClearWidth: 1.0,
  doorClearHeight: 2.1,
  doorCornerMargin: 0.25,
  doorSeparation: 0.25,

  corridorWidth: 1.2,
  corridorClearHeight: 2.4,
  minCorridorSegment: 0.5,

  floorToFloorHeight: 3.2,
  clearCeilingHeight: 2.7,

  stair: {
    clearWidth: 1.2,
    minRiser: 0.1,
    maxRiser: 0.178,
    targetRiser: 0.17,
    minTread: 0.28,
    preferredTread: 0.3,
    minHeadroom: 2.05,
    landingDepth: 1.2,
  },
} as const

export interface StairMath {
  stepCount: number
  stepHeight: number
  stepDepth: number
  run: number
}

/**
 * Lawbook §41-43: N = ceil(H / rMax), riser = H / N, run = N * tread.
 * Throws when the rise cannot be bridged within [minRiser, maxRiser].
 */
export function stairMathFor(
  rise: number,
  treadDepth: number = SPATIAL_DEFAULTS.stair.preferredTread,
): StairMath {
  const { minRiser, maxRiser } = SPATIAL_DEFAULTS.stair
  if (!(rise > 0) || !Number.isFinite(rise)) {
    throw new Error(`[LevelWeaver] invalid stair rise ${rise}.`)
  }
  const stepCount = Math.max(2, Math.ceil(rise / maxRiser))
  const stepHeight = rise / stepCount
  if (stepHeight < minRiser - EPSILON || stepHeight > maxRiser + EPSILON) {
    throw new Error(
      `[LevelWeaver] stair rise ${rise.toFixed(2)} m needs riser ${stepHeight.toFixed(4)} m, ` +
        `outside [${minRiser}, ${maxRiser}]. Adjust wall height / floor spacing.`,
    )
  }
  if (!Number.isFinite(treadDepth) || treadDepth < SPATIAL_DEFAULTS.stair.minTread - EPSILON) {
    throw new Error(
      `[LevelWeaver] stair tread ${treadDepth} m below minimum ${SPATIAL_DEFAULTS.stair.minTread} m.`,
    )
  }
  // Lawbook §50: gameplay walk slope. Uniform riser/tread keeps every
  // flight below the agent maximum by construction; assert it anyway so a
  // future tread/riser change trips here instead of shipping ramps.
  const slopeDeg = (Math.atan(stepHeight / treadDepth) * 180) / Math.PI
  if (slopeDeg > AGENT_DEFAULTS.maxWalkSlopeDeg + 1e-6) {
    throw new Error(
      `[LevelWeaver] stair slope ${slopeDeg.toFixed(1)}° exceeds agent maximum ${AGENT_DEFAULTS.maxWalkSlopeDeg}°.`,
    )
  }
  return { stepCount, stepHeight, stepDepth: treadDepth, run: stepCount * treadDepth }
}

export interface ConfigIssue {
  code: string
  message: string
}

/** Exact 2D segment-to-segment distance (0 when crossing/touching). Pure
 * math shared by corridor routing and validators (single source). */
export function segSegDist2D(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number {
  const orient = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number =>
    (qx - px) * (rz - pz) - (qz - pz) * (rx - px)
  const onSeg = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): boolean =>
    Math.min(px, rx) <= qx && qx <= Math.max(px, rx) && Math.min(pz, rz) <= qz && qz <= Math.max(pz, rz)
  const o1 = orient(ax, az, bx, bz, cx, cz)
  const o2 = orient(ax, az, bx, bz, dx, dz)
  const o3 = orient(cx, cz, dx, dz, ax, az)
  const o4 = orient(cx, cz, dx, dz, bx, bz)
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0
  if (o1 === 0 && onSeg(ax, az, cx, cz, bx, bz)) return 0
  if (o2 === 0 && onSeg(ax, az, dx, dz, bx, bz)) return 0
  if (o3 === 0 && onSeg(cx, cz, ax, az, dx, dz)) return 0
  if (o4 === 0 && onSeg(cx, cz, bx, bz, dx, dz)) return 0
  const ptSeg = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number => {
    const ddx = qx - px
    const ddz = qz - pz
    const lenSq = ddx * ddx + ddz * ddz
    if (lenSq < 1e-12) return Math.sqrt((rx - px) ** 2 + (rz - pz) ** 2)
    const t = Math.max(0, Math.min(1, ((rx - px) * ddx + (rz - pz) * ddz) / lenSq))
    return Math.sqrt((rx - (px + t * ddx)) ** 2 + (rz - (pz + t * ddz)) ** 2)
  }
  return Math.min(
    ptSeg(ax, az, bx, bz, cx, cz),
    ptSeg(ax, az, bx, bz, dx, dz),
    ptSeg(cx, cz, dx, dz, ax, az),
    ptSeg(cx, cz, dx, dz, bx, bz),
  )
}

/**
 * Gate (door) opening width for a wall of usable length `wallLength`.
 * Single source of truth shared by the corridor router and the door
 * cutter so the corridor mouth and the wall hole always agree (§28).
 *
 * The gate never exceeds the configured gate width or the corridor mouth;
 * on short walls it shrinks to fit (corner margins kept). It is NOT
 * clamped back up to the minimum: a wall too short for a legal gate is a
 * placement failure the validators must report, not a dimension to fake.
 * Final door validation also enforces the requested width: a shortened gate
 * is a diagnostic candidate, never an accepted silent relaxation (§71).
 */
export function gateWidthFor(
  config: LevelConfig,
  wallLength: number,
  corridorWidth?: number,
): number {
  const mouth = Math.min(config.doorWidth, corridorWidth ?? config.corridorWidth)
  const fit = wallLength - 2 * SPATIAL_DEFAULTS.doorCornerMargin - 0.1
  return Math.min(mouth, fit)
}

/**
 * Lawbook §22: wall-to-wall circulation gap between same-floor rooms.
 * Exactly twice the router's per-side clearance (corridor half-width +
 * wall slab + routing margin), floored at 3.5 m so even the narrowest
 * corridors keep turn clearance near mouths (a 1.5 m corridor in a 2.5 m
 * gap cannot turn without sealing gates). Placement, density
 * feasibility, and routing derive from this one formula (§7).
 */
export function circulationGap(config: LevelConfig): number {
  const perSide = config.corridorWidth / 2 + SPATIAL_DEFAULTS.wallThickness + ROUTING_MARGIN
  return Math.max(perSide * 2, 3.5)
}

/**
 * Lawbook §73: coarse feasibility before generation. Returns hard errors;
 * the caller must refuse to generate (never silently shrink dimensions).
 */
export function validateConfigFeasibility(config: LevelConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const numericFields = [
    'seed', 'area', 'roomCount', 'floorCount', 'roomSizeVariation', 'corridorWidth',
    'connectivity', 'verticality', 'deadEnds', 'largeRoomCount', 'wallHeight', 'doorWidth', 'doorHeight',
  ] as const
  for (const field of numericFields) {
    if (!Number.isFinite(config[field])) {
      issues.push({ code: 'CONFIG_NONFINITE', message: `${field} must be a finite number.` })
    }
  }
  if (!shapes.some(s => s.value === config.shape)) {
    issues.push({ code: 'CONFIG_SHAPE', message: `Unknown shape: ${config.shape}.` })
  }
  if (!themes.includes(config.theme)) {
    issues.push({ code: 'CONFIG_THEME', message: `Unknown theme: ${config.theme}.` })
  }
  if (!Object.prototype.hasOwnProperty.call(presets, config.preset)) {
    issues.push({ code: 'CONFIG_PRESET', message: `Unknown preset: ${config.preset}.` })
  }
  // Do not call toFixed, perform spatial arithmetic, or allocate from bad input.
  if (issues.length) return issues
  const range = (field: typeof numericFields[number], min: number, max: number, integer = false) => {
    const value = config[field]
    if (value < min || value > max || (integer && !Number.isInteger(value))) {
      issues.push({ code: `CONFIG_${field.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`,
        message: `${field} must be ${integer ? 'an integer ' : ''}in [${min}, ${max}].` })
    }
  }
  range('seed', 0, CONFIG_LIMITS.maxSeed, true)
  range('roomCount', CONFIG_LIMITS.minRooms, CONFIG_LIMITS.maxRooms, true)
  range('floorCount', 1, CONFIG_LIMITS.maxFloors, true)
  range('area', CONFIG_LIMITS.minArea, CONFIG_LIMITS.maxArea)
  range('largeRoomCount', 0, Math.max(0, config.roomCount - 2), true)
  for (const field of ['roomSizeVariation', 'connectivity', 'verticality', 'deadEnds'] as const) {
    range(field, 0, 1)
  }
  if (issues.length) return issues
  const wall = config.wallHeight
  const doorW = config.doorWidth
  const doorH = config.doorHeight

  if (doorW > config.corridorWidth + EPSILON) {
    issues.push({ code: 'CONFIG_DOOR_CORRIDOR_WIDTH',
      message: `doorWidth ${doorW} m exceeds corridorWidth ${config.corridorWidth} m. Widen the corridor or reduce the requested gate width.` })
  }

  if (!(wall >= 3.2 - EPSILON && wall <= 5.5 + EPSILON)) {
    issues.push({
      code: 'CONFIG_WALL_HEIGHT',
      message: `wallHeight ${wall} m outside [3.2, 5.5].`,
    })
  }
  if (!(doorW >= MIN_CLEAR_WIDTH - EPSILON)) {
    issues.push({
      code: 'CONFIG_DOOR_WIDTH',
      message:
        `doorWidth ${doorW} m below agent minimum clear width ${MIN_CLEAR_WIDTH.toFixed(2)} m. ` +
        `The 1.8 m player cannot pass.`,
    })
  }
  if (!(doorH >= MIN_CLEAR_HEIGHT - EPSILON)) {
    issues.push({
      code: 'CONFIG_DOOR_HEIGHT',
      message:
        `doorHeight ${doorH} m below agent minimum clear height ${MIN_CLEAR_HEIGHT.toFixed(2)} m. ` +
        `The 1.8 m player cannot pass.`,
    })
  }
  // Header above the gate must fit inside the wall.
  if (doorH > wall - 0.3 + EPSILON) {
    issues.push({
      code: 'CONFIG_DOOR_TALLER_THAN_WALL',
      message:
        `doorHeight ${doorH} m does not fit in wallHeight ${wall} m ` +
        `(needs 0.30 m header). Lower the gate or raise the wall.`,
    })
  }
  // Corridor must admit the agent.
  if (!(config.corridorWidth >= MIN_CLEAR_WIDTH - EPSILON)) {
    issues.push({
      code: 'CONFIG_CORRIDOR_WIDTH',
      message:
        `corridorWidth ${config.corridorWidth} m below agent minimum ${MIN_CLEAR_WIDTH.toFixed(2)} m.`,
    })
  }
  // Floor spacing must leave headroom: wall + slab allowance.
  const floorSpacing = wall + 0.5
  if (!(floorSpacing >= SPATIAL_DEFAULTS.clearCeilingHeight + SPATIAL_DEFAULTS.floorThickness - EPSILON)) {
    issues.push({
      code: 'CONFIG_FLOOR_SPACING',
      message: `floor spacing ${floorSpacing.toFixed(2)} m leaves no legal ceiling/headroom.`,
    })
  }
  // Stair riser feasibility for this floor height (lawbook §41).
  try {
    stairMathFor(floorSpacing)
  } catch (err) {
    issues.push({
      code: 'CONFIG_STAIR_RISE',
      message: err instanceof Error ? err.message : String(err),
    })
  }
  // Every floor needs at least one room (lawbook §39): fewer rooms than
  // floors leaves a gap no stair can bridge.
  if (config.roomCount < config.floorCount) {
    issues.push({
      code: 'CONFIG_FLOOR_ROOMS',
      message:
        `roomCount ${config.roomCount} < floorCount ${config.floorCount}: ` +
        `a floor would stay empty and disconnect the level.`,
    })
  }
  // Total minimum room area must fit the map (lawbook §73).
  const minTotal = config.roomCount * SPATIAL_DEFAULTS.minRoomArea
  if (minTotal > config.area + EPSILON) {
    issues.push({
      code: 'CONFIG_AREA_ROOMS',
      message:
        `${config.roomCount} rooms need at least ${minTotal.toFixed(0)} m² ` +
        `(minimum ${SPATIAL_DEFAULTS.minRoomArea} m² each) but area is ${config.area} m².`,
    })
  }
  // Realistic footprint with circulation gaps (lawbook §22, §73): rooms
  // cannot share walls — every room needs its footprint PLUS the
  // wall-to-wall circulation gap on each side, plus corridor overhead.
  // The old check (rooms * 6 m² <= area) admitted grossly overfull maps
  // (e.g. 10 rooms + 4 m corridors on 500 m²) that placement could never
  // separate, producing ROOM_OVERLAP artifacts on random seeds. Reject
  // them here with a clear message instead of shipping overlaps.
  // Sized from a realistic average room (~45 m² incl. hubs/arenas), not
  // the 6 m² closet minimum: the minimum check above stays as the
  // absolute floor, this one guards packability.
  {
    const gap = circulationGap(config)
    const cellSide = Math.sqrt(45) + gap
    const usable = usableMapArea(config.shape, config.area)
    const needed = config.roomCount * cellSide * cellSide
    if (needed > usable * 1.2 + EPSILON) {
      issues.push({
        code: 'CONFIG_AREA_DENSITY',
        message:
          `${config.roomCount} rooms with ${config.corridorWidth.toFixed(1)} m corridors ` +
          `need ~${needed.toFixed(0)} m² incl. ${gap.toFixed(1)} m circulation gaps, ` +
          `but ${config.shape} at ${config.area} m² offers ~${usable.toFixed(0)} m² usable. ` +
          `Reduce rooms, narrow corridors, or enlarge the area.`,
      })
    }
  }
  // Corridor must fit the shape's narrowest passage (lawbook §73).
  // Closed-form lower bounds matching the boundary formulas: rectangle at
  // maximum aspect, cross arms, ring band, linear strips.
  const narrowest = narrowestPassage(config.shape, config.area, config.roomCount)
  if (config.corridorWidth > narrowest + EPSILON) {
    issues.push({
      code: 'CONFIG_CORRIDOR_FIT',
      message:
        `corridorWidth ${config.corridorWidth} m cannot fit the ${config.shape} ` +
        `shape's narrowest passage (~${narrowest.toFixed(1)} m at ${config.area} m²).`,
    })
  }
  return issues
}

// Usable map area for density feasibility (§73): the ring's courtyard
// hole is not placeable (inner = 0.4 * outer -> 16% of the disc).
export function usableMapArea(shape: LevelConfig['shape'], area: number): number {
  // Ring loses its courtyard hole (inner = 0.4 * outer -> 16% of disc).
  if (shape === 'ring') return area * 0.84
  return area
}

// Conservative narrow-passage width (meters) for a shape/area. Mirrors
// `@/generator/boundary` dimensions with worst-case parameters. Shared by
// config feasibility (§73) and room sizing (soft sizes yield to hard
// containment, §3).
export function narrowestPassage(shape: LevelConfig['shape'], area: number, roomCount: number): number {
  switch (shape) {
    case 'rectangle': {
      // Maximum aspect 2.0: depth = sqrt(area / 2).
      return Math.sqrt(area / 2)
    }
    case 'cross': {
      // Arm width = total width / 3, total = 3 * sqrt(area / 5).
      return Math.sqrt(area / 5)
    }
    case 'ring': {
      // Walkable band = outer - inner radius (inner = 0.4 * outer).
      return Math.sqrt(area / Math.PI) * 0.6
    }
    case 'linear': {
      const segLen = Math.sqrt(area / Math.max(1, roomCount)) * 1.2
      return segLen * 1.5
    }
    case 'square':
    case 'hub':
    case 'radial':
    case 'branching':
    default: {
      // Roughly square bounds; narrowest dimension ≈ sqrt(area) / 2.
      return Math.sqrt(area) / 2
    }
  }
}

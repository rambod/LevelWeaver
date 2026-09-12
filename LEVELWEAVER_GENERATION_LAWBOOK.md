# LevelWeaver Procedural Generation Lawbook

**Document type:** Normative generator specification / invariant bible / forbidden-state catalog  
**Project:** LevelWeaver  
**Status:** Validity requirements with an explicit V0.1 implementation contract; not a claim of full compliance
**Primary purpose:** Give coding agents and human contributors a strict, reusable contract for generating spatially valid, traversable, deterministic prototype levels.

---

## 0. How to Use This Document

This is not a mood board, suggestion list, or collection of tips. It is a **normative specification**.

The procedural generator should treat the rules in this document as a hierarchy of laws:

- **MUST / SHALL** = hard invariant. Generation is invalid if violated.
- **MUST NOT / SHALL NOT / FORBIDDEN** = impossible state. Reject or repair before advancing.
- **SHOULD** = strong design preference. May be violated only when a preset or explicit setting requires it.
- **MAY** = optional behavior.

The generator must never knowingly export a level that violates a hard invariant.

A seed that cannot satisfy the requested parameter set within bounded attempts is allowed to fail gracefully. It is **not** allowed to produce broken geometry just to return something.

This specification follows LevelWeaver's existing architecture principle: topology first, geometry later, engine-independent core data, deterministic seed behavior, and Three.js only as a rendering representation.

### V0.1 implementation contract and document maintenance

The numbered laws define required validity and target architecture. Example APIs,
defaults, and future features are illustrative, not declarations that those APIs
or features exist. This subsection defines the current public contract; it does
not waive physical, traversal, or export requirements.

- `generateLevel(config)` rejects invalid configuration by throwing a descriptive
  error before spatial work. All numeric fields must be finite. Counts are integers;
  the supported envelope is 2-100 rooms, 1-5 floors, 100-50000 m², and unsigned
  32-bit integer seeds. Fractions for variation/connectivity/verticality/dead ends
  are in [0, 1]. Large-room count is in [0, roomCount - 2]. Shape, theme, and preset
  must be recognized. Existing dimensional feasibility checks also apply.
- Missing legacy door dimensions normalize to 1.8 × 2.4 m. Other invalid values
  are rejected, not silently coerced. A configuration inside these ranges can
  still fail layout feasibility.
- Requested gate width must not exceed corridor width. Realized door width and
  height must meet both the agent minimum and the requested dimensions (§71).
- Search is bounded and deterministic. After exhausted repair attempts, the API
  may return a **diagnostic candidate** with `ok: false` and structured errors.
  It may be inspected only with visible failure status. It cannot export or be
  described as valid. Diagnostic construction is distinct from acceptance under
  §68; recommended result unions in §97 remain a future API design.
- Export requires `ok: true`, a validation report without hard errors, and a fresh
  structural mesh check. Every exported mesh part must have finite positions,
  normals and UVs, consistent attribute lengths, valid triangle indices, and
  triangle winding consistent with surface normals.
  Empty optional cut fragments are permitted; playable floors cannot be empty.
- Editable parameters are pending inputs. Failed generation preserves the previous
  artifact. Export names and metadata use that artifact's seed/config/version.
  Theme changes are material-only and must remain consistent in preview/export.
- `src/core/rules` owns runtime dimensions; `src/core/presets` owns product defaults.
  For example, runtime walls are 0.30 m and default floor spacing is wall height
  plus 0.50 m. The 0.20 m walls and 3.20 m spacing below are reference profiles.
- Changes to output or validation acceptance increment `GENERATOR_VERSION` and
  include reproducible tests. See `AGENTS.md` for required commands. Record gaps
  in `docs/AUDIT.md`; do not weaken laws to hide missing implementation.

The priority order in §2 guides repair selection; **all** hard constraints must
hold at acceptance. Recommended scoring or a lower error count cannot excuse a
remaining violation. External research links are background, not executable rules
or substitutes for tests; verify a source before relying on a new external claim.

---

# PART I - THE CONSTITUTION

## 1. Prime Directive

LevelWeaver SHALL generate a level that is:

1. **Deterministic** for the same seed + preset + parameters + generator version.
2. **Connected** according to the configured traversal rules.
3. **Spatially non-overlapping** except for explicitly allowed shared boundaries and connector intersections.
4. **Traversable** by the configured gameplay agent.
5. **Geometrically coherent**, with valid floors, walls, ceilings, doors, corridors, stairs, ramps, and slab openings.
6. **Bounded** inside the configured map boundary unless explicitly configured otherwise.
7. **Exportable** as a structurally understandable level, not merely a visual soup of triangles.
8. **Validated** before rendering/export.
9. **Debuggable**, with explicit validation errors rather than silent corruption.
10. **Constraint-driven**, not random-geometry-driven.

A map that looks interesting but is not traversable is a failed generation.

A map that is traversable only because the preview camera clips through geometry is a failed generation.

A map where one room cannot be reached from Spawn is a failed generation unless that room is explicitly tagged as non-playable/decorative.

---

## 2. Order of Authority

When rules conflict, use this priority order:

1. **Physical validity**
2. **Traversal validity**
3. **Graph connectivity**
4. **Boundary compliance**
5. **Hard user constraints**
6. **Preset semantics**
7. **Spatial quality**
8. **Aesthetic variation**
9. **Decoration**

Randomness has the lowest authority.

Randomness SHALL NEVER override a hard geometric or traversal rule.

---

## 3. Hard Constraints vs Soft Goals

The generator SHALL separate rules into two classes.

### 3.1 Hard constraints

Examples:

- rooms may not overlap,
- every playable room must be reachable,
- a stair must fit its reserved volume,
- a doorway must have enough width and headroom for the agent,
- a corridor must not terminate into solid wall,
- a room must not be completely contained inside another room,
- upper-floor slabs must be opened where stairs pass through,
- no wall may cut through the interior of a door opening,
- all geometry must remain inside valid bounds,
- no floor may exist without a valid support/elevation definition,
- every connection in the topology graph must have a spatial realization or be removed from the graph.

### 3.2 Soft goals

Examples:

- prefer compact layouts,
- prefer short corridors,
- prefer visual variety,
- prefer a given room aspect ratio,
- prefer loops,
- prefer symmetry/asymmetry,
- prefer large rooms far from Spawn,
- prefer certain semantic room ordering,
- prefer natural stair locations,
- prefer less wasted space.

Soft goals may be represented by a score or penalty function.

Hard constraints SHALL NOT be represented only as score penalties. A violation must fail validation.

---

# PART II - CANONICAL UNITS AND CONFIGURATION

## 4. World Units

LevelWeaver SHALL use **meters** as the canonical procedural unit.

Three.js scene units SHOULD also be interpreted as meters unless an adapter explicitly converts units.

Export metadata SHOULD record the assumed unit system.

All spatial configuration SHALL be stored in real-world units, not arbitrary tile counts, unless a generator stage internally rasterizes to a grid.

---

## 5. Canonical Agent Profile

The generator SHALL define traversal relative to an explicit agent profile.

Recommended default prototype profile:

```ts
interface AgentProfile {
  height: number;            // default 1.80 m
  radius: number;            // default 0.30 m
  shoulderClearance: number; // default 0.10 m each side
  headClearance: number;     // default 0.20 m
  maxStepHeight: number;     // default 0.20 m
  maxWalkSlopeDeg: number;   // default 45 deg for game traversal, not architectural accessibility
  maxJumpGap?: number;       // disabled in V0.1 unless jumping traversal is explicitly enabled
  maxDropHeight?: number;    // disabled in V0.1 unless one-way drops are explicitly enabled
}
```

The existing LevelWeaver brief uses approximately 1.8 m player height for first-person walk mode. This lawbook keeps that as the default gameplay height.

### 5.1 Derived minimum clearances

The generator SHALL derive geometry from the agent, not the reverse.

```text
minimumClearWidth = 2 * agent.radius + 2 * agent.shoulderClearance
minimumClearHeight = agent.height + agent.headClearance
```

With the default agent:

```text
minimumClearWidth = 0.80 m
minimumClearHeight = 2.00 m
```

However, LevelWeaver SHOULD use larger design defaults for readability and comfortable prototype movement.

Recommended practical defaults:

```text
door clear width:       1.00 m
standard corridor:      1.20 m
wide corridor:          1.80 m
standard room height:   2.70 m
minimum prototype room height: 2.40 m
```

These are LevelWeaver design defaults, not claims of universal building-code compliance.

---

## 6. Architectural Reference Profile

Real building codes are useful as conservative references for believable human-scale geometry, but LevelWeaver is a game prototype generator and SHALL NOT claim code compliance.

Useful reference values from current public standards include:

- ADA accessible walking surfaces: 0.915 m minimum clear width in the general case.
- ADA door clear opening: 0.815 m minimum.
- ADA accessible ramp slope: typically no steeper than 1:12.
- IBC 2024 stair risers: 0.102 m to 0.178 m.
- IBC 2024 rectangular stair tread depth: at least 0.279 m.
- IBC stair headroom: at least 2.032 m.

LevelWeaver SHOULD therefore use the following **believable-architecture preset defaults**:

```ts
const believableArchitecture = {
  doorClearWidth: 1.00,
  corridorWidth: 1.20,
  floorToFloorHeight: 3.20,
  clearCeilingHeight: 2.70,
  stairTargetRiser: 0.17,
  stairMinRiser: 0.10,
  stairMaxRiser: 0.178,
  stairMinTread: 0.28,
  stairPreferredTread: 0.30,
  stairMinHeadroom: 2.05,
  accessibleRampMaxSlopeRatio: 1 / 12,
};
```

Again, these values are design references, not legal certification.

---

## 7. One Source of Truth for Dimensional Rules

All minimums and defaults SHALL live in centralized typed configuration.

FORBIDDEN:

- hard-coding `1.0`, `2.4`, `0.3`, etc. in scattered generator functions,
- renderer-specific hidden scaling,
- different corridor widths used by topology, geometry, collision, and export without an explicit reason.

Recommended:

```ts
interface SpatialRules {
  epsilon: number;
  wallThickness: number;
  floorThickness: number;
  ceilingThickness: number;

  minRoomWidth: number;
  minRoomDepth: number;
  minRoomArea: number;
  minRoomAspectRatio: number;
  maxRoomAspectRatio: number;

  corridorWidth: number;
  corridorJunctionClearance: number;

  doorClearWidth: number;
  doorClearHeight: number;
  doorCornerMargin: number;

  floorToFloorHeight: number;
  clearCeilingHeight: number;

  stair: StairRules;
  ramp: RampRules;
  agent: AgentProfile;
}
```

---

# PART III - DETERMINISM AND RANDOMNESS

## 8. Deterministic Seed Law

Same:

```text
seed + preset + normalized parameters + generator version
```

MUST produce the same abstract level and geometry.

Do not call `Math.random()` anywhere inside generation code.

### 8.1 Stage-specific random streams

The recommended design is **hierarchical deterministic RNG**.

Instead of one fragile global random stream, derive sub-seeds:

```text
root seed
  -> topology seed
  -> room sizing seed
  -> room placement seed
  -> corridor seed
  -> vertical connector seed
  -> theme seed
  -> decoration seed
```

Example concept:

```ts
const topologyRng = rng.derive("topology");
const placementRng = rng.derive("placement");
const verticalRng = rng.derive("vertical");
```

This prevents a harmless change to decoration RNG consumption from completely changing room topology.

### 8.2 Stable ordering

Any collection that affects deterministic output SHALL have stable ordering before RNG selection.

FORBIDDEN:

- relying on nondeterministic object-key iteration from external structures,
- depending on timing,
- depending on Three.js scene traversal order,
- depending on unordered Set/Map contents when serialization or platform differences could alter order.

Sort by stable IDs before deterministic selection when needed.

---

# PART IV - ABSTRACT LEVEL GRAPH LAW

## 9. Topology Comes Before Geometry

The generator SHALL create a logical graph before final spatial geometry.

Each playable room is a node.

Each intended traversal connection is an edge.

```ts
interface LevelNode {
  id: string;
  type: RoomType;
  floorPreference?: number;
  degreeMin: number;
  degreeMax: number;
  tags: string[];
}

interface LevelEdge {
  id: string;
  a: string;
  b: string;
  kind: "door" | "corridor" | "stair" | "ramp" | "vertical";
  required: boolean;
}
```

The spatial generator SHALL realize this graph.

Geometry SHALL NOT invent arbitrary connections that are absent from the canonical topology unless it also updates the topology graph.

---

## 10. Global Connectivity Invariant

For every playable room `R`:

```text
pathExists(Spawn, R) == true
```

At minimum, the playable topology graph SHALL be one connected component.

If an Exit exists:

```text
pathExists(Spawn, Exit) == true
```

If an Objective is mandatory:

```text
pathExists(Spawn, Objective) == true
pathExists(Objective, Exit) == true
```

Disconnected playable islands are FORBIDDEN.

---

## 11. Minimum Spanning Backbone

A robust general strategy is:

1. create plausible candidate edges between rooms,
2. build a connected backbone using a spanning tree,
3. add selected non-tree edges to create loops.

A Delaunay candidate graph + minimum spanning tree is a common procedural-level technique because the MST guarantees graph connectivity while optional extra edges restore loops and alternate routes.

LevelWeaver MAY use another algorithm, but whatever algorithm is used SHALL provide the same invariant: **all playable nodes connected before geometry generation continues**.

---

## 12. Loop Law

`connectivity` SHALL control additional edges beyond the minimum connected backbone.

Suggested interpretation:

```text
0.0 = tree-like, minimal connectivity
1.0 = high loop density within spatial feasibility
```

Do not blindly add random edges.

Every added loop edge SHALL pass feasibility checks:

- reasonable geometric distance,
- routable corridor or valid doorway adjacency,
- no forbidden room crossing,
- no impossible vertical transition,
- no degenerate micro-loop.

---

## 13. Dead-End Law

A dead end is a node or branch whose only exit is backtracking.

Dead ends MAY exist if allowed by preset/parameter.

Hard restrictions:

- Spawn SHALL NOT be an accidental dead end unless the design intentionally begins in a one-exit room.
- Exit SHALL NOT be unreachable from any mandatory objective chain.
- Mandatory hubs SHOULD have degree >= 3.
- A dead-end branch SHALL have a maximum graph depth configurable by preset.
- A generated dead-end corridor with no room, purpose, portal, or endpoint is FORBIDDEN.

Recommended:

```ts
maxDeadEndDepth: 2 // rooms beyond branch point
```

for general prototypes.

---

## 14. Room Degree Rules

Recommended semantic defaults:

```text
Spawn:       degree >= 1
Exit:        degree >= 1
Standard:    degree 1..4
Hall:        degree 2..4
Hub:         degree 3..6
Arena:       degree 2..4
Objective:   degree 1..3
Storage:     degree 1..2
Connector:   degree 2..4
Vertical:    degree 2..4
```

These are semantic preferences, not universal hard laws.

However, degree constraints declared by a room type SHALL be validated.

---

## 15. Critical Path Law

The generator SHOULD explicitly identify a critical path:

```text
Spawn -> ... -> primary Objective/Boss -> ... -> Exit
```

This path SHALL be valid in graph space and spatial traversal space.

The generator MAY use BFS/Dijkstra depending on edge weights.

If a preset needs exploration, optional branches should generally hang from or reconnect to this critical path.

---

# PART V - ROOM PLACEMENT LAW

## 16. Room as a Reserved Volume

A room is not only floor area.

A room SHALL reserve a 3D spatial volume containing:

- interior floor footprint,
- wall thickness,
- ceiling/floor thickness where relevant,
- portal margins,
- required agent clearance,
- optional service buffer used during placement.

Represent both:

```text
interior bounds
structural bounds
placement exclusion bounds
```

Do not use one rectangle for all three concepts.

---

## 17. Minimum Room Size

For a playable rectangular room:

```text
room.width  >= minRoomWidth
room.depth  >= minRoomDepth
room.area   >= minRoomArea
```

Recommended general defaults:

```text
minRoomWidth = 2.4 m
minRoomDepth = 2.4 m
minRoomArea  = 6.0 m²
```

For FPS presets, larger minimums are usually better.

Room size rules SHALL account for intended portals. A tiny room with four large doorways may be mathematically valid but physically meaningless.

Therefore:

```text
usableWallLength >= sum(openingWidths + separationMargins)
```

for every wall that hosts portals.

---

## 18. Aspect Ratio Law

Random room sampling SHALL be bounded.

FORBIDDEN by default:

- extremely thin accidental rooms,
- corridor-like rooms unintentionally classified as standard rooms,
- near-zero width/depth.

Recommended standard room aspect range:

```text
0.5 <= width/depth <= 2.0
```

Presets MAY widen this range.

If a room is intentionally long and narrow, classify it as `Hall`, `Gallery`, `Connector`, etc., rather than pretending it is a standard room.

---

## 19. No Room Overlap Law

Two distinct solid rooms on the same floor SHALL NOT have overlapping interior or structural volumes.

Touching walls MAY be allowed if the system intentionally supports shared partitions.

Otherwise maintain a placement buffer.

Use epsilon-aware intersection tests.

```ts
intersects(expand(roomA.bounds, roomBuffer), roomB.bounds)
```

shall be false unless the relation is explicitly permitted.

---

## 20. No Nesting Law

A room SHALL NOT be fully contained inside another room's interior, structural volume, or placement exclusion volume unless the containing relationship is explicitly modeled as a special feature.

For V0.1, nested rooms are FORBIDDEN.

Examples of invalid states:

- Room B entirely inside Room A.
- A corridor-room represented as a room inside a larger room.
- A stair room inserted into another room without explicit subdivision.

Containment test:

```text
contains(roomA.bounds, roomB.bounds) == false
contains(roomB.bounds, roomA.bounds) == false
```

for distinct ordinary rooms.

---

## 21. Room Boundary Law

Every room SHALL remain inside the allowed map footprint after accounting for structural thickness.

```text
room.structuralBounds subsetOf mapBoundary
```

A room touching the map boundary is allowed only if exterior wall construction still fits.

---

## 22. Room Separation and Corridor Space

The placer SHALL reserve space for circulation.

Do not pack rooms so tightly that the graph says two rooms should be connected but no corridor can physically fit.

A placement feasibility check SHOULD evaluate candidate connection channels before locking placement.

At minimum:

```text
spaceBetweenObstacles >= corridorWidth + 2 * placementSafetyMargin
```

for a corridor intended to pass through that gap.

---

# PART VI - PORTALS, DOORS, AND OPENINGS

## 23. Portal First, Hole Second

A connection through a wall SHALL first be represented as a logical **portal**.

```ts
interface Portal {
  id: string;
  roomId: string;
  wallSide: "north" | "south" | "east" | "west";
  center: Vec3;
  clearWidth: number;
  clearHeight: number;
  targetConnectionId: string;
}
```

Only after portal validation should geometry cut a door opening.

---

## 24. Door Clear Width Law

Every traversable door SHALL satisfy:

```text
door.clearWidth >= minimumClearWidth(agent)
```

Recommended default:

```text
door.clearWidth >= 1.0 m
```

Do not confuse mesh width with clear opening width. Wall trim, frames, and thickness SHALL NOT reduce the passage below the required clear width.

---

## 25. Door Clear Height Law

Every traversable opening SHALL satisfy:

```text
door.clearHeight >= minimumClearHeight(agent)
```

Recommended default:

```text
2.1 m door clear height
```

---

## 26. Door Corner Margin Law

A doorway SHALL NOT begin directly at a room corner.

Required:

```text
distance(doorEdge, nearestWallCorner) >= doorCornerMargin
```

Recommended default:

```text
doorCornerMargin >= 0.25 m
```

Larger values may be required when wall thickness, trim, or doorway routing needs it.

---

## 27. Door Separation Law

Two openings on the same wall SHALL NOT overlap.

Recommended:

```text
separationBetweenDoorOpenings >= 0.25 m
```

or a configurable structural/visual pier width.

If the required openings cannot fit, the room/portal assignment must be changed. Do not squeeze invalid doors together.

---

## 28. Door-to-Corridor Alignment Law

A corridor connection SHALL terminate at a valid portal.

FORBIDDEN:

- corridor hitting a solid wall with no opening,
- corridor entering room through a corner,
- corridor centerline missing doorway,
- doorway generated but no corridor/floor beyond it,
- corridor surface at different elevation from doorway floor without a valid transition.

---

# PART VII - CORRIDOR LAW

## 29. Corridor Is Traversal Space, Not a Line

A graph edge or centerline is not a corridor.

A valid corridor SHALL have:

- a centerline/path,
- clear width,
- clear height,
- floor surface,
- side boundaries/walls where required,
- start and end portals,
- junction geometry when branching,
- collision/traversal clearance.

---

## 30. Corridor Width Law

```text
corridor.clearWidth >= minimumClearWidth(agent)
```

Recommended default:

```text
1.20 m
```

FPS Arena presets SHOULD generally use wider values such as 1.8-3.0 m.

---

## 31. Corridor Height Law

```text
corridor.clearHeight >= minimumClearHeight(agent)
```

Recommended prototype minimum:

```text
2.4 m
```

---

## 32. Corridor Routing Law

A routed corridor SHALL NOT pass through the interior of an unrelated room.

Allowed cases:

1. It terminates at that room through a portal.
2. The room is explicitly used as a pass-through node in topology.
3. The corridor is intentionally merged into an existing corridor network.

Otherwise crossing an unrelated room is FORBIDDEN.

---

## 33. Corridor Obstacle Clearance

Routing SHALL use the corridor's full width, not only its centerline.

When testing path feasibility, expand obstacles by approximately:

```text
corridorWidth / 2 + wallThickness + safetyMargin
```

This converts centerline routing into volume-aware routing.

---

## 34. Corridor Junction Law

When multiple corridors meet, create a junction region large enough that all clear widths survive the intersection.

FORBIDDEN:

- T-junction whose walls pinch the turn below agent width,
- crossing corridors that geometrically overlap but are not topologically connected,
- Z-fighting coplanar floor patches at intersections,
- microscopic triangular slivers from careless boolean-like assembly.

The junction SHOULD be represented explicitly in the abstract geometry description.

---

## 35. Corridor Crossing Law

On the same floor and elevation, two corridors whose volumes cross SHALL either:

1. form a topological junction, or
2. be rerouted.

They SHALL NOT visually pass through each other while remaining disconnected.

At different elevations they MAY cross if vertical clearances and structural thickness are valid.

---

## 36. Corridor Length Law

Avoid useless micro-corridors.

Recommended:

```text
minStraightCorridorSegment >= 0.5 m
```

after simplification.

If a corridor between adjacent rooms is shorter than a practical threshold, prefer a direct shared-wall doorway.

---

# PART VIII - FLOOR AND VERTICAL LAYER LAW

## 37. Discrete Floor Elevations

Each floor SHALL have a canonical elevation.

```text
floorElevation(i) = baseElevation + i * floorToFloorHeight
```

unless a preset explicitly supports split levels.

V0.1 SHOULD avoid arbitrary room elevations within a floor.

This keeps stair logic and export understandable.

---

## 38. Floor-to-Floor Height Consistency

For standard multi-floor layouts:

```text
floorToFloorHeight >= clearCeilingHeight + floorStructureThickness
```

Recommended:

```text
floorToFloorHeight = 3.2 m
clearCeilingHeight = 2.7 m
floor/ceiling structure allowance ~= 0.5 m combined as modeled
```

The exact decomposition can be simplified in greybox mode, but the free headroom and stair geometry SHALL remain valid.

---

## 39. Every Occupied Floor Must Join the Traversal Graph

If a floor contains playable rooms, there SHALL be at least one valid vertical connection to the connected level graph unless that floor is the only floor.

No orphan upper floors.

No floating playable floor that exists only visually.

---

# PART IX - STAIR LAW

## 40. Stairs Are Reserved Before Final Geometry

A staircase is not something to squeeze into leftover space after rooms and corridors are finished.

The generator SHALL reserve its complete 3D volume before finalizing surrounding geometry.

A stair reservation includes:

- flight footprint,
- bottom landing,
- top landing,
- intermediate landing when applicable,
- stair width,
- stair headroom volume,
- upper slab opening,
- approach corridors/portals,
- wall clearance.

---

## 41. Stair Rise Calculation

Given vertical rise `H` and maximum allowed riser `rMax`:

```text
riserCount = ceil(H / rMax)
actualRiser = H / riserCount
```

Then validate:

```text
stairMinRiser <= actualRiser <= stairMaxRiser
```

Recommended believable values:

```text
stairMinRiser = 0.10 m
stairMaxRiser = 0.178 m
stairTargetRiser ~= 0.17 m
```

Do not randomize each individual riser.

All risers in one flight SHALL be equal within floating-point epsilon.

---

## 42. Stair Tread Law

Recommended:

```text
stairTreadDepth >= 0.28 m
preferred ~= 0.30 m
```

All treads in one flight SHALL have equal depth within epsilon unless a specialized stair type is explicitly implemented.

V0.1 SHOULD use straight stairs and optionally L/U stairs built from straight flights.

Winders and spiral stairs SHOULD be postponed.

---

## 43. Stair Horizontal Run

Conservatively reserve:

```text
flightRun >= riserCount * treadDepth
```

This intentionally over-reserves slightly compared with some detailed construction conventions and is safer for procedural placement.

For example, with:

```text
H = 3.2 m
riserMax = 0.178 m
riserCount = 18
actualRiser = 0.1778 m
treadDepth = 0.30 m
reservedRun ~= 5.4 m
```

This is why vertical connectors must be planned early.

---

## 44. Stair Width Law

```text
stair.clearWidth >= minimumClearWidth(agent)
```

Recommended LevelWeaver default:

```text
1.20 m
```

Architectural references often use 0.914 m or 1.118 m minimums depending on occupancy. LevelWeaver's 1.2 m default is spacious and easy to traverse in first person.

---

## 45. Stair Headroom Law

At every traversable point along the stair path:

```text
verticalClearance >= max(agentMinimumClearHeight, stairMinHeadroom)
```

Recommended:

```text
stairMinHeadroom = 2.05 m
```

The clearance SHALL be tested from the walking surface / nosing line upward into all overhead geometry.

FORBIDDEN:

- stair rising into the underside of an upper floor slab,
- ceiling intersecting the agent capsule,
- upper landing placed under too-low geometry.

---

## 46. Slab Opening Law

Every stair that penetrates an upper floor SHALL reserve and cut a valid slab opening.

The opening SHALL include sufficient horizontal extent for headroom, not merely the exact stair mesh footprint.

This is critical.

A common procedural failure is to generate correct-looking steps and then place an intact upper floor over them.

That state is FORBIDDEN.

---

## 47. Stair Landing Law

Every stair SHALL have usable approach/landing space at both ends.

Recommended LevelWeaver default:

```text
landing depth >= stair clear width
```

Landings SHALL be free of walls and door swings/portal obstructions in the active traversal zone.

Do not terminate a stair directly into a wall.

---

## 48. Stair-to-Floor Alignment

Bottom stair elevation SHALL equal lower floor elevation.

Top stair elevation SHALL equal upper floor elevation.

```text
abs(stair.topY - upperFloorY) <= epsilon
abs(stair.bottomY - lowerFloorY) <= epsilon
```

No final half-step.

No floating top tread.

No sunken stair start.

---

## 49. Stair Connectivity Law

A stair SHALL connect two traversable regions.

The topology graph SHALL contain the corresponding edge.

FORBIDDEN:

- decorative stair to nowhere,
- stair ending in sealed room wall,
- stair whose upper exit has no floor,
- stair whose lower entrance cannot be reached.

Unless a future preset intentionally supports ruins or broken stairs, these are invalid generation states.

---

# PART X - RAMP AND SLOPE LAW

## 50. Walking Slope vs Accessible Ramp

LevelWeaver SHALL distinguish:

- `gameplayWalkSlope`: what the configured movement system can traverse,
- `architecturalRampSlope`: believable/accessibility-oriented geometry.

Game navigation systems such as Recast/Unreal/Godot explicitly model maximum walkable slope and agent climb. That is not the same concept as an accessibility standard.

Recommended defaults:

```text
gameplay max walk slope: 45 degrees
believable accessible ramp: <= 1:12 rise/run (~4.76 degrees)
```

A preset MAY intentionally use steeper game ramps, but they SHALL still respect configured agent slope.

---

## 51. Ramp Length Law

Given rise `H` and maximum slope ratio `s = rise/run`:

```text
requiredRun = H / s
```

At 1:12:

```text
requiredRun = 12 * H
```

Therefore a 3.2 m full-floor ramp would require approximately 38.4 m horizontal run and is usually inappropriate for compact procedural interiors.

This is another reason full-floor vertical circulation should generally use stairs in V0.1.

---

# PART XI - CEILING, WALL, FLOOR, AND STRUCTURAL COHERENCE

## 52. Wall Continuity Law

Every room/corridor boundary edge that is not an opening SHALL receive appropriate wall geometry.

Every opening SHALL remove wall geometry from its clear opening region.

FORBIDDEN:

- duplicate overlapping walls,
- walls across doors,
- gaps between wall segments larger than epsilon unless intentionally open,
- zero-thickness accidental gaps due to rounding.

---

## 53. Floor Continuity Law

Every traversable region SHALL have continuous supporting floor geometry.

FORBIDDEN:

- micro-gaps between corridor and room floors,
- doorway threshold gaps larger than traversal tolerance,
- floor triangles with reversed winding causing missing surface in single-sided rendering,
- overlapping coplanar floors causing severe Z-fighting.

---

## 54. Ceiling Law

Ceilings MAY be omitted from preview if a debug mode wants visibility, but the canonical geometry description SHALL know whether the room is enclosed.

In normal enclosed generation:

```text
clearCeilingHeight >= minimumClearHeight(agent)
```

Ceilings SHALL account for stairs, shafts, atria, and slab openings.

---

## 55. Wall Thickness Law

Use non-zero wall thickness in canonical rules even if V0.1 preview sometimes renders simplified planes.

Recommended:

```text
wallThickness = 0.15-0.25 m
```

A default of 0.20 m is reasonable for greybox spatial planning.

Portal and corridor routing SHALL use clear dimensions, not center-to-center dimensions.

---

# PART XII - SPATIAL COLLISION AND RESERVED-VOLUME LAW

## 56. Everything Important Gets a Clearance Volume

The generator SHALL model clearance volumes for:

- player traversal,
- corridors,
- doorways,
- stair flights,
- stair headroom,
- landings,
- vertical shafts,
- future elevators if added.

Geometry intersection tests alone are not enough because two meshes can technically not intersect while leaving unusably small space.

---

## 57. Expanded-Obstacle Principle

For path and placement checks, a common robust method is to expand obstacles by the radius/half-width of the moving object or circulation space.

Examples:

```text
agent path: expand obstacles by agent.radius
corridor centerline: expand obstacles by corridorWidth / 2 + wallThickness
stair placement: use full stair reservation prism
```

This matches the general principle used by navigation-mesh systems where walkable space is eroded away from obstacles by the agent radius.

---

## 58. Epsilon Law

All spatial comparisons SHALL use a centralized epsilon.

Recommended:

```text
epsilon = 1e-4 m
```

or an empirically chosen value appropriate to geometry generation.

FORBIDDEN:

```ts
if (a === b) // for world-space floating point geometry
```

when tolerance is required.

---

# PART XIII - NAVIGATION VALIDATION LAW

## 59. Graph Reachability Is Necessary but Not Sufficient

A connected room graph does not guarantee the actual 3D level is traversable.

LevelWeaver SHALL perform a **spatial traversal validation** after geometry description is generated.

At minimum, validate a conservative navigation representation.

Possible implementation options:

1. rasterized 2D/2.5D walkability grid per floor + explicit vertical links,
2. voxel navigation grid,
3. simplified polygon navigation graph,
4. future Recast-compatible bake in a worker/WASM if ever justified.

V0.1 can use a grid validator.

---

## 60. Navigation Grid Validation

Suggested process:

1. Rasterize walkable floor surfaces at a validation cell size.
2. Inflate obstacles by agent radius.
3. Remove cells lacking headroom.
4. Remove transitions exceeding max step/climb.
5. Remove slopes exceeding max walk slope.
6. Add stair/ramp links.
7. Flood fill/BFS from Spawn.
8. Assert every mandatory room has reachable sample cells.
9. Assert Exit/Objectives are reachable.

This turns "looks connected" into a testable invariant.

---

## 61. Door Reachability Sampling

Every portal SHALL have reachable sample space on both sides.

For a portal center `P`, sample points slightly inward/outward along wall normal.

Both samples SHALL lie in traversable regions connected through the opening.

This catches:

- door blocked by nearby wall,
- opening cut in wrong wall,
- corridor offset from door,
- door floating above floor.

---

# PART XIV - MULTI-FLOOR CONNECTIVITY LAW

## 62. Vertical Graph Invariant

Construct a floor connectivity graph where nodes are floor indices and edges are usable vertical connectors.

If multiple playable floors exist, the occupied-floor subgraph SHALL be connected.

Example:

```text
Floor 0 -- Stair A -- Floor 1 -- Stair B -- Floor 2
```

is valid.

```text
Floor 0 -- Floor 1    Floor 2
```

with Floor 2 containing playable rooms and no connector is invalid.

---

## 63. Connector Redundancy

High-connectivity or FPS arena presets SHOULD support multiple vertical connectors where area allows.

This is a soft gameplay goal, not a universal hard rule.

A configuration may define:

```text
minVerticalConnectorsPerFloorPair
maxVerticalConnectorsPerFloorPair
```

Do not create redundant connectors that cannot physically fit.

---

# PART XV - BOUNDARY AND SHAPE LAW

## 64. Main Shape Is a Feasible Region, Not Decoration

Rectangle, square, ring, cross, radial, hub, linear, and branching presets SHALL influence the allowed placement region and topology bias.

The generator SHALL NOT first make an arbitrary rectangular map and then merely draw a ring/cross outline around it.

---

## 65. Boundary Containment

Every structural volume SHALL fit within the allowed boundary polygon/region unless tagged as an allowed exterior feature.

For non-rectangular boundaries, containment tests SHALL use polygon/shape logic rather than only global AABB checks.

---

## 66. Boundary Margin

Reserve a configurable margin between playable interior geometry and outer map limits when needed.

This margin can support:

- exterior wall thickness,
- camera/debug visibility,
- export padding,
- future facade generation.

---

# PART XVI - GENERATION PIPELINE LAW

## 67. Required Stages

Recommended canonical pipeline:

```text
0. Normalize parameters
1. Validate configuration feasibility
2. Derive deterministic RNG streams
3. Generate boundary
4. Generate semantic topology graph
5. Validate graph connectivity/degree rules
6. Assign room dimensions
7. Place rooms with exclusion volumes
8. Validate room overlap/containment/boundary
9. Select and reserve vertical connectors
10. Create portals
11. Route corridors
12. Resolve/construct corridor junctions
13. Build floors / walls / ceilings / openings
14. Cut stair/slab/shaft openings
15. Build stair/ramp geometry
16. Construct traversal validation representation
17. Validate full reachability and clearance
18. Generate theme/material assignment
19. Generate optional props
20. Build render geometry
21. Validate render/export structure
22. Export/preview
```

The exact implementation may differ, but critical reservations and validations SHALL happen before later stages can hide structural problems.

---

## 68. Stage Gate Law

Every major stage SHALL have a validator.

A stage may advance only if its required invariants pass.

Example:

```ts
const topology = generateTopology(ctx);
assertValidTopology(topology, ctx.rules);

const layout = placeRooms(topology, ctx);
assertValidRoomPlacement(layout, ctx.rules);

const circulation = routeConnections(layout, ctx);
assertValidCirculation(circulation, ctx.rules);
```

Do not wait until GLB export to discover broken topology.

---

# PART XVII - FAILURE, REPAIR, AND BACKTRACKING LAW

## 69. Bounded Attempts

Every randomized search stage SHALL have a deterministic bounded attempt count.

FORBIDDEN:

- infinite retry loops,
- "keep trying until it works",
- frame-dependent timeouts that make deterministic output differ by machine speed.

Example:

```text
maxRoomPlacementAttemptsPerRoom = 64
maxGlobalLayoutAttempts = 32
maxCorridorRoutingAttempts = 16
maxVerticalPlacementAttempts = 32
```

Exact values require profiling.

---

## 70. Repair Priority

When a hard constraint fails, prefer local repair before global regeneration.

Suggested order:

1. move/resize offending room within allowed tolerance,
2. choose another portal wall,
3. reroute corridor,
4. choose another vertical connector candidate,
5. swap room placements,
6. retry current layout stage with derived attempt seed,
7. regenerate spatial layout while preserving topology,
8. regenerate topology only as last resort.

This keeps generation stable and debug-friendly.

---

## 71. No Silent Constraint Relaxation

The generator SHALL NOT secretly shrink corridor width, door width, room size, stair headroom, or agent clearance to force a seed to succeed.

If constraint relaxation is supported, it must be explicit and categorized as a soft-rule fallback.

Hard dimensions SHALL remain hard.

---

## 72. Deterministic Retry Seeds

Each retry SHOULD derive a stable seed:

```text
attemptSeed = hash(rootSeed, stageName, attemptIndex)
```

This keeps failed/repaired generations reproducible.

---

## 73. Impossible Parameter Detection

Before generation, run coarse feasibility checks.

Examples:

- requested total minimum room area > available usable map area,
- room count impossible within boundary after buffers,
- floor-to-floor height too small for configured ceiling/headroom,
- stair rules cannot bridge floor height,
- corridor width larger than boundary narrowest dimension,
- doorway width larger than room wall length after corner margins,
- too many required hubs for maximum feasible connections.

Reject impossible configuration early with a clear message.

---

# PART XVIII - FORBIDDEN BOOK

## 74. Forbidden Topology States

The following SHALL invalidate generation:

- playable disconnected room,
- disconnected floor containing playable rooms,
- edge referencing missing node,
- self-edge unless a future special mechanic explicitly uses it,
- duplicate identical mandatory edge without semantics,
- mandatory objective not reachable from Spawn,
- Exit not reachable when Exit is required,
- room degree outside hard semantic constraint,
- vertical edge between floors with no vertical connector.

---

## 75. Forbidden Room States

- room width <= 0,
- room depth <= 0,
- room height <= 0,
- room below configured minimum,
- room outside map boundary,
- two ordinary rooms overlapping,
- one ordinary room fully nested in another,
- portal count exceeding available wall capacity,
- room interior blocked by corridor/wall artifacts,
- room exists in graph but no usable floor surface is generated.

---

## 76. Forbidden Corridor States

- corridor width below agent minimum,
- corridor ceiling below headroom minimum,
- corridor intersects unrelated room interior,
- corridor crosses another corridor without joining or vertical separation,
- corridor terminates in solid wall,
- corridor stops short of doorway,
- corridor floor does not meet room floor elevation,
- unreachable corridor island,
- zero-length corridor,
- corridor whose expanded clearance volume intersects solid geometry.

---

## 77. Forbidden Door States

- door opening narrower than configured clear width,
- door opening shorter than configured clear height,
- door overlaps room corner margin,
- two door openings overlap,
- doorway has floor discontinuity,
- door opens into no walkable region,
- corridor connects to wall but opening is missing,
- opening exists with no graph connection unless explicitly decorative.

---

## 78. Forbidden Stair States

- inconsistent riser heights within a flight,
- riser above configured max,
- tread below configured minimum,
- stair too narrow,
- stair clips a room/wall not intended to contain it,
- headroom violation,
- intact slab intersects stair path,
- missing bottom landing,
- missing top landing,
- top elevation does not match destination floor,
- bottom elevation does not match source floor,
- stair begins/ends in wall,
- stair connects to inaccessible region,
- stair generated after space is already occupied with no reservation.

---

## 79. Forbidden Mesh/Geometry States

- NaN or Infinity coordinates,
- degenerate triangles where avoidable,
- severe coplanar duplicates causing Z-fighting,
- inverted floor normals in canonical geometry,
- non-finite transforms,
- missing IDs/names for exported structural pieces,
- renderer geometry diverging from canonical procedural description,
- geometry built directly as canonical Three.js objects with no engine-independent source data.

---

# PART XIX - QUALITY SCORING AFTER VALIDITY

## 80. Validity First, Score Second

Only valid candidates should be scored for quality.

Suggested weighted soft score:

```text
score =
  compactnessWeight          * compactnessScore
+ corridorLengthWeight       * corridorEfficiencyScore
+ topologyMatchWeight        * requestedConnectivityScore
+ roomVariationWeight        * roomVarietyScore
+ verticalityWeight          * requestedVerticalityScore
+ deadEndWeight              * requestedDeadEndScore
+ semanticPlacementWeight    * semanticScore
+ symmetryWeight             * presetSymmetryScore
- wastedSpacePenalty
- awkwardAspectPenalty
- excessiveTurnPenalty
```

Never let a high score excuse a hard invariant violation.

---

## 81. Compactness Metric

Possible metrics:

```text
usedArea / boundaryArea
```

and/or

```text
sum(roomArea + corridorArea) / boundingEnvelopeArea
```

Do not maximize compactness to 100%. Some circulation and spacing is desirable.

---

## 82. Corridor Efficiency

Penalize:

- extremely long corridors relative to room spacing,
- excessive zig-zags,
- unnecessary parallel corridors,
- tiny segments after turns,
- routes that nearly reach target then detour absurdly.

A* cost SHOULD account for:

- route length,
- turn cost,
- proximity to unrelated rooms,
- reuse of existing corridor network when desired,
- boundary clearance,
- stair/vertical cost.

---

# PART XX - DEBUGGABILITY LAW

## 83. Every Generated Object Gets Stable Identity

Required IDs:

```text
Room_001
Connection_003
Portal_014
Corridor_007
Stair_002
Floor_01
```

IDs SHALL remain stable within a generation.

Validation errors SHALL reference IDs.

---

## 84. Validation Error Format

Recommended:

```ts
interface GenerationIssue {
  code: string;
  severity: "error" | "warning";
  stage: string;
  objectIds: string[];
  message: string;
  data?: Record<string, unknown>;
}
```

Examples:

```text
ROOM_OVERLAP
ROOM_NESTED
ROOM_OUT_OF_BOUNDS
GRAPH_DISCONNECTED
PORTAL_TOO_NARROW
PORTAL_CORNER_VIOLATION
CORRIDOR_UNROUTABLE
CORRIDOR_ROOM_COLLISION
STAIR_NO_HEADROOM
STAIR_SLAB_COLLISION
STAIR_BAD_RISER
FLOOR_DISCONNECTED
NAV_UNREACHABLE_ROOM
GEOMETRY_NONFINITE
```

---

## 85. Debug Views

LevelWeaver SHOULD provide optional debug overlays for:

- topology graph,
- room structural bounds,
- placement exclusion bounds,
- portals,
- corridor centerlines,
- corridor clear-width volume,
- stair reservation volume,
- stair headroom volume,
- slab openings,
- navigation walkable grid,
- unreachable navigation cells,
- boundary margin,
- validation error markers.

A procedural generator without debug visualization becomes nearly impossible to maintain.

---

# PART XXI - DATA MODEL LAW

## 86. Canonical Geometry Description Must Be Engine-Independent

Recommended conceptual structure:

```ts
interface GeneratedLevel {
  metadata: LevelMetadata;
  rulesSnapshot: SpatialRules;
  topology: LevelGraph;
  floors: GeneratedFloor[];
  rooms: GeneratedRoom[];
  portals: Portal[];
  corridors: GeneratedCorridor[];
  verticalConnectors: VerticalConnector[];
  validation: ValidationReport;
}
```

Three.js meshes are generated from this description.

Three.js objects are not the canonical source of truth.

---

## 87. Separate Intent From Realization

Keep both:

```text
ConnectionIntent
```

and

```text
Corridor/Stair realization
```

This makes it possible to detect an intended edge that failed spatial realization.

Do not silently drop a graph edge because routing failed.

---

# PART XXII - PRESET LAW

## 88. Presets Configure Rules; They Do Not Bypass Them

A preset may change:

- room counts,
- room size distributions,
- preferred topology,
- corridor width,
- verticality,
- loop density,
- floor height,
- semantic room placement,
- dead-end tolerance.

A preset SHALL NOT disable core validity checks.

---

## 89. Example Preset Differences

### FPS Arena

Prefer:

- wider corridors,
- multiple loops,
- multiple vertical routes,
- larger rooms,
- fewer long dead ends,
- sightline variety.

### Horror Facility

Prefer:

- narrower but still valid corridors,
- more controlled branching,
- some dead ends,
- smaller rooms,
- lower loop density.

### Office

Prefer:

- more orthogonal regularity,
- repeated room bands,
- believable circulation,
- lower verticality.

### Dungeon

Prefer:

- stronger irregularity,
- more branch variation,
- occasional larger chambers,
- topology not tied to modern architectural realism.

All still obey hard traversal geometry.

---

# PART XXIII - TESTING LAW

## 90. Unit Tests for Every Geometric Rule

At minimum test:

- AABB overlap,
- containment,
- polygon boundary containment,
- portal wall placement,
- door corner margins,
- corridor clearance,
- stair riser calculation,
- stair headroom sampling,
- floor elevation alignment,
- slab opening containment,
- graph connectivity,
- floor connectivity,
- deterministic RNG streams.

---

## 91. Property-Based Seed Testing

Procedural systems need more than hand-picked examples.

Run automated seed sweeps.

Example:

```text
for preset in presets:
  for parameterProfile in testProfiles:
    for seed in 0..9999:
      generate
      assert no hard violations
```

Capture failing seeds permanently as regression cases.

A seed that once broke a stair should become a test forever.

---

## 92. Determinism Tests

For the same generator version and normalized inputs:

```text
hash(generate(seed, config)) == hash(generate(seed, config))
```

Test across repeated runs.

Where possible, test in Chromium and Firefox because LevelWeaver is browser-first.

Avoid relying on platform-sensitive floating-point chaos in iterative physics-style relaxation without stable stopping/rounding rules.

---

## 93. Fuzz the Configuration, Not Only the Seed

Test extremes:

- minimum room count,
- maximum room count,
- 1 floor,
- 5 floors,
- narrow boundary,
- huge corridor width,
- high connectivity,
- zero dead ends,
- high dead ends,
- minimum floor height,
- maximum room variation.

The validator should reject impossible configurations intentionally rather than crash.

---

# PART XXIV - PERFORMANCE LAW

## 94. Correctness Before Mesh Optimization

The project brief correctly states that generation should remain clean and testable before premature optimization.

However, validation cost must remain bounded.

Recommended separation:

```text
abstract graph tests -> cheap
AABB/volume tests -> cheap
routing grid -> moderate
full mesh creation -> later
render optimization -> last
```

Reject impossible layouts before expensive mesh generation.

---

## 95. Spatial Indexing

As map size grows, use spatial indexing for collision candidates rather than O(n²) checks everywhere.

Possible structures:

- uniform spatial hash,
- quadtree for 2D placement,
- R-tree,
- BVH for final geometry queries.

V0.1 MAY start with simpler checks if profiling shows acceptable performance.

---

# PART XXV - IMPLEMENTATION BLUEPRINT

## 96. Recommended Validation API

```ts
interface Validator<T> {
  validate(value: T, context: GenerationContext): GenerationIssue[];
}
```

Suggested validators:

```text
ConfigValidator
TopologyValidator
RoomPlacementValidator
PortalValidator
CorridorValidator
VerticalConnectorValidator
GeometryValidator
NavigationValidator
ExportValidator
```

And an aggregate:

```ts
function validateGeneratedLevel(level: GeneratedLevel): ValidationReport;
```

Export SHALL refuse levels with hard errors.

---

## 97. Recommended Generation Result Type

```ts
type GenerationResult =
  | {
      ok: true;
      level: GeneratedLevel;
      warnings: GenerationIssue[];
    }
  | {
      ok: false;
      errors: GenerationIssue[];
      attemptedSeed: string;
      stage: string;
    };
```

Do not return partially broken levels as if they succeeded.

---

## 98. Constraint Checkpoints

### After topology

MUST verify:

- node IDs unique,
- edge IDs unique,
- no dangling references,
- connectivity,
- semantic degree constraints,
- Spawn/Exit/Objectives valid.

### After room placement

MUST verify:

- dimensions,
- boundary,
- non-overlap,
- no nesting,
- floor assignment,
- feasible circulation opportunities.

### After vertical reservation

MUST verify:

- complete stair/ramp volumes fit,
- headroom possible,
- slab opening possible,
- destination/source landing space exists.

### After corridor routing

MUST verify:

- every required graph edge realized,
- corridor clearances,
- no forbidden room crossings,
- junction logic.

### After geometry

MUST verify:

- openings match portals,
- floors continuous,
- walls not blocking connections,
- stairs aligned,
- no non-finite geometry.

### After navigation validation

MUST verify:

- Spawn reachable region exists,
- every mandatory room reachable,
- mandatory objectives reachable,
- Exit reachable,
- vertical traversals connected.

---

# PART XXVI - RECOMMENDED CORE FORMULAS

## 99. Room Exclusion Bounds

```text
exclusionBounds = expand(structuralBounds, roomBuffer)
```

Two rooms are placeable only if:

```text
!intersects(exclusionA, exclusionB)
```

unless shared-wall adjacency is explicitly supported.

---

## 100. Portal Wall Capacity

For a wall of usable length `L` with `n` doors:

```text
required = sum(doorWidths)
         + 2 * doorCornerMargin
         + (n - 1) * doorSeparation
```

Require:

```text
required <= L
```

If not, redistribute portals or resize/reposition the room.

---

## 101. Corridor Clearance Radius

For centerline routing:

```text
routingRadius = corridorClearWidth / 2
              + wallThickness
              + routingSafetyMargin
```

Expand obstacles by `routingRadius`.

---

## 102. Stair Step Count

```text
N = ceil(verticalRise / stairMaxRiser)
riser = verticalRise / N
```

Require:

```text
stairMinRiser <= riser <= stairMaxRiser
```

Reserve:

```text
run >= N * treadDepth
```

plus landing volumes.

---

## 103. Stair Slope Check

For uniform stair approximation:

```text
stairAngle = atan(riser / treadDepth)
```

This is useful for collision/traversal approximation, though discrete steps still need step-height logic.

---

## 104. Ramp Run

```text
run = rise / slopeRatio
```

For 1:12:

```text
run = rise * 12
```

---

# PART XXVII - DESIGN DECISIONS FOR LEVELWEAVER V0.1

## 105. Deliberately Keep These Simple

To keep the generator reliable, V0.1 SHOULD use:

- rectangular rooms,
- orthogonal walls,
- mostly orthogonal corridors,
- discrete floors,
- straight stairs,
- L/U stairs only if implemented with full reservation logic,
- no spiral stairs,
- no arbitrary sloped ceilings,
- no nested rooms,
- no freeform polygons as rooms,
- no elevators required,
- no one-way jumps required,
- no crouch-only passages,
- no ladders required,
- no moving platforms.

Complexity should be earned after the invariant system is proven.

---

## 106. V0.1 Recommended Strict Defaults

```ts
const strictV01Defaults = {
  epsilon: 0.0001,

  agent: {
    height: 1.8,
    radius: 0.30,
    shoulderClearance: 0.10,
    headClearance: 0.20,
    maxStepHeight: 0.20,
    maxWalkSlopeDeg: 45,
  },

  wallThickness: 0.20,
  floorThickness: 0.20,

  minRoomWidth: 2.4,
  minRoomDepth: 2.4,
  minRoomArea: 6.0,
  minRoomAspectRatio: 0.5,
  maxRoomAspectRatio: 2.0,
  roomBuffer: 0.25,

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
    minRiser: 0.10,
    maxRiser: 0.178,
    targetRiser: 0.17,
    minTread: 0.28,
    preferredTread: 0.30,
    minHeadroom: 2.05,
    landingDepth: 1.2,
  },
};
```

These values should be user-configurable only through validated settings or preset profiles. Changing a value SHALL trigger configuration feasibility validation.

---

# PART XXVIII - THE AI CODING CONTRACT

## 107. Rules for Any AI Modifying the Generator

Any coding AI working on LevelWeaver SHALL follow these instructions:

1. Read the LevelWeaver project brief first.
2. Read this lawbook before editing generator logic.
3. Do not bypass validators to make a seed pass.
4. Do not add direct `Math.random()` calls.
5. Do not create geometry before topology intent exists.
6. Do not create a connection without a portal/traversal realization.
7. Do not place stairs in leftover space without prior volume reservation.
8. Do not relax minimum widths/heights silently.
9. Do not allow rooms to overlap or nest.
10. Do not permit disconnected playable rooms.
11. Do not couple canonical generation state to Three.js classes.
12. Add or update regression tests whenever fixing a generation failure.
13. Preserve deterministic output unless intentionally changing generator version/behavior.
14. When introducing a new feature, specify its hard invariants before implementing it.
15. When uncertain whether a geometry case is valid, reject it rather than export corrupted structure.

---

## 108. Required Reasoning Pattern Before Adding a Feature

For any new feature, the implementation plan SHALL answer:

```text
What is the canonical data representation?
What space/volume does it reserve?
What can it intersect?
What must it never intersect?
How is it connected to topology?
How is it traversed by the agent?
What are its minimum dimensions?
What is its headroom/clearance requirement?
How is it validated?
How can generation retry/repair if placement fails?
How is it represented in GLB export?
What regression tests prove it works?
```

If these questions are unanswered, the feature is not ready for procedural generation.

---

# PART XXIX - RESEARCH BASIS AND WHY THESE LAWS EXIST

## 109. Graph-First Procedural Layout

Graph-first generation is strongly supported by procedural level-generation practice and architectural layout research.

A useful recurring pattern is:

```text
candidate spatial relationships
-> connected graph backbone
-> optional loops
-> spatial realization
-> traversal validation
```

Delaunay triangulation plus an MST is not mandatory, but it is a practical way to create plausible candidate connections while guaranteeing connectivity. Multiple public procedural dungeon implementations use the sequence of Delaunay candidate edges -> minimum spanning tree -> re-add selected edges -> A* corridor routing.

Architectural research likewise models room adjacency as a graph and solves layout subject to adjacency, size, orientation, aspect, and non-overlap constraints.

---

## 110. Why Agent Clearance Must Be First-Class

Modern navigation systems explicitly define an agent by parameters such as radius, height, maximum climb/step, and maximum walkable slope.

Navigation baking then removes or erodes spaces the agent cannot fit through.

LevelWeaver should adopt the same conceptual discipline even though its core generator is engine-independent.

A corridor is valid only if the agent volume fits, not because two wall centerlines are far apart.

---

## 111. Why Vertical Connectors Need Reserved 3D Volumes

Stairs consume much more space than a top-down line suggests.

They require:

- long horizontal run,
- headroom,
- landings,
- upper-floor openings,
- approach space.

Procedural dungeon implementations that support real 3D stairs explicitly reserve stair transition volume and headroom and cut the upper slab opening before routing approaches.

This lawbook makes that behavior mandatory because "add stairs later" is one of the fastest ways to create impossible multi-floor layouts.

---

# PART XXX - SOURCES

The following references informed the hard/soft rule separation, graph connectivity strategy, human-scale dimensional references, and navigation-agent model.

## 112. LevelWeaver Project Source

- [LEVELWEAVER.md](LEVELWEAVER.md), the project brief. Key existing principles include staged generation, deterministic seed behavior, graph before spatial layout, rectangular rooms for V0.1, engine-independent core structures, and 1.8 m first-person player scale.

## 113. Accessibility and Human-Scale Geometry References

- U.S. Department of Justice, **2010 ADA Standards for Accessible Design**  
  https://www.ada.gov/law-and-regs/design-standards/2010-stds/

- U.S. Department of Justice, **2010 ADA Standards PDF**  
  https://www.ada.gov/assets/pdfs/2010-design-standards.pdf

Useful reference concepts:

- walking surface clear width,
- door clear opening width,
- ramp slope,
- ramp landing behavior.

## 114. Stair Geometry Reference

- International Code Council, **2024 International Building Code, Chapter 10**  
  https://codes.iccsafe.org/content/IBC2024V2.0/chapter-10-means-of-egress

Useful reference concepts:

- stair riser range,
- minimum rectangular tread depth,
- stair width references,
- stair headroom.

## 115. Navigation-Agent References

- Epic Games, **Unreal Engine Navigation Mesh Settings**  
  https://dev.epicgames.com/documentation/unreal-engine/navigation-mesh-settings-in-the-unreal-engine-project-settings

- Recast Navigation, **rcConfig**  
  https://recastnav.com/structrcConfig.html

- Godot Engine, **NavigationMesh**  
  https://docs.godotengine.org/en/stable/classes/class_navigationmesh.html

These references support treating agent radius, height, climb/step, and maximum slope as first-class traversal constraints.

## 116. Procedural Connectivity / Layout References

- DPLAN: **Minimal Connectivity to Floorplan Generation** (2026)  
  https://arxiv.org/abs/2606.21159

- Wang & Zhang, **Generating layout designs from high-level specifications**, Automation in Construction 119 (2020), DOI: 10.1016/j.autcon.2020.103288  
  https://doi.org/10.1016/j.autcon.2020.103288

- Example public procedural dungeon implementation demonstrating Delaunay -> MST -> loops -> BFS semantics -> carving:  
  https://github.com/majidmanzarpour/threejs-procedural-dungeon

- Example 3D procedural dungeon implementation using reserved stair/headroom space and A* approaches:  
  https://github.com/woodyFang/xd-fangyu-pcg-dungeon

These implementation examples are not standards. They are useful corroborating engineering patterns.

---

# PART XXXI - FINAL GENERATOR OATH

Before LevelWeaver accepts a generated map, all of the following SHALL be true:

```text
[ ] Same seed/config can reproduce it.
[ ] Every playable room has valid dimensions.
[ ] No ordinary rooms overlap.
[ ] No ordinary room is nested inside another.
[ ] Every playable room is graph-reachable from Spawn.
[ ] Every required graph edge has a spatial realization.
[ ] Every doorway meets configured clear width and height.
[ ] Every corridor meets configured width, height, and collision clearance.
[ ] Same-level corridor crossings are either junctions or do not intersect.
[ ] Every occupied floor is connected to the level traversal graph.
[ ] Every stair fits its reserved horizontal volume.
[ ] Every stair has valid risers and treads.
[ ] Every stair has valid headroom.
[ ] Every stair has valid top and bottom landings.
[ ] Every stair penetration has a valid slab opening.
[ ] All traversal transitions align in elevation.
[ ] Navigation validation reaches every mandatory room.
[ ] Exit/objectives are reachable when required.
[ ] No non-finite/NaN geometry exists.
[ ] Renderer output is derived from canonical engine-independent data.
[ ] Export contains useful stable object names.
[ ] No hard validation error remains.
```

If even one required box is false, the generation is not finished.

**The generator's job is not to create random geometry. Its job is to create random variation inside a rigorously valid spatial system.**

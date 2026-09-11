# LevelWeaver - Project Brief

## 1. Product Summary

LevelWeaver is a browser-based procedural 3D level prototype generator for game developers.

The goal is simple:

A developer should be able to open LevelWeaver, choose a few parameters, generate a playable prototype map in seconds, preview it in 3D, walk through it, and export it as GLB for use in Unreal Engine or other 3D software.

Think of it as:

**Mixamo for prototype maps.**

LevelWeaver is NOT a replacement for Unreal Engine, Unity, Godot, Blender, or a professional level editor.

It exists to help developers create throwaway or early-stage level blockouts quickly so they can test gameplay systems without manually creating a map first.

---

## 2. Core Product Philosophy

Keep the software simple.

The workflow should be:

1. Open LevelWeaver.
2. Select a level preset.
3. Adjust a few generation parameters.
4. Click Generate.
5. Preview the generated map.
6. Optionally walk through it in first person.
7. Change parameters or seed and regenerate.
8. Export the generated level as GLB.

The procedural generator is the product.

The 3D renderer is only the preview layer.

Do not turn LevelWeaver into Blender or a traditional level editor.

---

## 3. Technology Stack

Use:

- Vue 3
- TypeScript
- Vite
- Three.js
- Three.js GLTFExporter
- Browser APIs only

Initial version must be browser-only.

Do NOT add:

- Tauri
- Electron
- backend services
- databases
- authentication
- accounts
- cloud storage
- Rust
- WebAssembly
- multiplayer
- server-side generation

Everything should run locally inside the user's browser.

The architecture should make it possible to add a desktop wrapper later without rewriting the procedural core.

---

## 4. Architecture

Keep the procedural level engine separate from Three.js.

Preferred structure:

```text
src/
  core/
    types/
    presets/
    random/
    levelGraph/
    generation/

  generator/
    boundary/
    topology/
    rooms/
    placement/
    corridors/
    vertical/
    geometry/

  renderer/
    scene/
    camera/
    materials/
    meshes/

  playtest/
    controller/
    collision/

  export/
    gltf/

  ui/
    components/
    panels/
    controls/

  stores/
```

The dependency flow should be:

```text
User Parameters
      |
      v
Level Configuration
      |
      v
Procedural Level Generator
      |
      v
Abstract Level Graph
      |
      v
Spatial Layout
      |
      v
Geometry Description
      |
      v
Three.js Preview
      |
      v
GLB Export
```

The procedural generator must not depend directly on UI components.

Where practical, the procedural generator should also avoid depending directly on Three.js classes.

Prefer plain TypeScript data structures for the generated level description.

---

## 5. Level Generation Model

Do NOT generate random geometry directly.

Generate the level in stages.

Suggested pipeline:

1. Generate map boundary.
2. Generate gameplay topology.
3. Create rooms.
4. Assign room sizes.
5. Place rooms spatially.
6. Resolve overlaps.
7. Connect rooms.
8. Generate corridors.
9. Assign floors.
10. Add stairs or vertical connectors.
11. Generate walls, floors, ceilings, and openings.
12. Assign materials.
13. Add optional simple prototype props.
14. Build Three.js geometry.
15. Export.

The generator must be deterministic.

The same:

- seed
- preset
- parameters

must generate the same level.

---

## 6. Main User Parameters

Initial parameters should include:

### Preset

Examples:

- FPS Arena
- Dungeon
- Research Facility
- Office
- Military Bunker
- Warehouse
- Sci-Fi Facility
- Horror Facility

Presets are configuration values, not separate generators.

### Main Shape

Start with:

- Rectangle
- Square
- Ring
- Cross
- Radial
- Hub
- Linear
- Branching

More shapes can be added later.

### Size

Allow the user to define approximate level area in square meters.

Example:

```text
5000 m²
```

The generator decides how to distribute that area.

### Number of Rooms

Example:

```text
18 rooms
```

### Number of Floors

Start with:

```text
1 to 5
```

### Room Size Variation

Controls how different room sizes are from each other.

### Corridor Width

Controls standard corridor width.

### Connectivity

Controls how interconnected the rooms are.

Low connectivity produces more linear layouts.

High connectivity produces more alternate paths and loops.

### Verticality

Controls how much the generator uses multiple floors, stairs, balconies, elevated areas, and vertical connections.

### Dead Ends

Controls how many dead-end paths are allowed.

### Large Rooms

Controls the number of larger arena or hub rooms.

### Seed

Allow:

- manual seed entry
- random seed button

Seed must always be visible and reproducible.

---

## 7. Gameplay Topology

LevelWeaver should generate meaningful room relationships before generating geometry.

Example:

```text
Spawn
  |
Hall
  |
Hub
 /  \
Room Arena
       |
   Objective
       |
      Exit
```

Room types should exist internally.

Suggested initial room types:

- Spawn
- Exit
- Standard
- Hall
- Hub
- Arena
- Objective
- Storage
- Connector
- Vertical Connector

These types can influence size, connection count, and placement.

The tool is not trying to automatically create perfect game design.

It should create useful prototype spatial layouts.

---

## 8. Geometry Rules

V1 should keep geometry intentionally simple.

Start with rectangular rooms.

Each room can contain:

```ts
interface Room {
  id: string;
  type: RoomType;
  position: Vec3;
  width: number;
  depth: number;
  height: number;
  floorIndex: number;
  materialTheme: string;
  connections: string[];
}
```

Generate:

- floor
- walls
- ceiling
- door openings
- corridors
- stairs

Do not begin with complex architectural modeling.

Avoid:

- sculpting
- arbitrary polygon editing
- boolean editing UI
- vertex editing
- UV editing
- architectural CAD features

LevelWeaver should remain procedural.

---

## 9. Themes and Materials

Topology and visual theme should be separate systems.

The same generated layout should be able to switch between themes.

Initial themes can include:

- Greybox
- Industrial
- Sci-Fi
- Dungeon
- Office
- Military
- Laboratory

Themes should initially define simple materials for:

- walls
- floors
- ceilings
- trim
- doors
- accent surfaces

Do not spend excessive effort on photorealistic textures.

This is a prototype generator.

Visual readability is more important than realism.

---

## 10. 3D Preview

Use Three.js for the viewport.

The viewport should support:

- orbit camera
- pan
- zoom
- reset camera
- responsive resizing
- basic lighting
- shadows where reasonable
- grid
- level bounds visualization if useful

Performance matters.

Avoid creating unnecessary individual meshes when geometry can be combined efficiently.

However, keep generated room sections logically identifiable where practical.

---

## 11. First-Person Walk Mode

Include a simple first-person prototype mode.

User can click:

```text
Walk
```

Controls:

- WASD
- mouse look
- jump
- sprint

Use a simple player height around:

```text
1.8 meters
```

The purpose is only to help the developer understand:

- room scale
- corridor width
- vertical scale
- movement distances
- general flow

Do not build a full gameplay system.

---

## 12. Export

Primary export format:

```text
GLB
```

Use Three.js GLTFExporter.

Export should preserve useful structure where possible.

Suggested hierarchy:

```text
Level
  Floor_00
    Room_001
    Room_002
    Corridor_001
  Floor_01
    Room_003
    Corridor_002
```

Export useful names rather than anonymous mesh names.

Include:

- geometry
- materials
- transforms

Initial export should be optimized for easy import into Unreal Engine, Blender, Godot, Unity, and other glTF-compatible software.

Do not implement FBX export.

Do not implement an Unreal plugin in V1.

---

## 13. Initial UI

Keep the UI extremely simple.

Suggested layout:

```text
+--------------------------------------------------+
| LevelWeaver                  Generate | Export   |
+----------------+---------------------------------+
| PRESET         |                                 |
| FPS Arena      |                                 |
|                |                                 |
| Shape          |                                 |
| Rectangle      |                                 |
|                |          3D VIEWPORT            |
| Area           |                                 |
| 5000 m²        |                                 |
|                |                                 |
| Rooms          |                                 |
| 18             |                                 |
|                |                                 |
| Floors         |                                 |
| 2              |                                 |
|                |                                 |
| Verticality    |                                 |
| [------*---]   |                                 |
|                |                                 |
| Theme          |                                 |
| Industrial     |                                 |
|                |                                 |
| Seed 492817    |                                 |
|                |                                 |
| [ GENERATE ]   |                                 |
+----------------+---------------------------------+
| Walk                               Export GLB    |
+--------------------------------------------------+
```

Advanced settings can be collapsed.

The generated map should be the visual focus.

---

## 14. Preset System

Presets should simply provide default generation parameters.

Example:

```ts
const fpsArenaPreset = {
  shape: "hub",
  roomCount: 16,
  floorCount: 2,
  connectivity: 0.8,
  verticality: 0.5,
  deadEnds: 0.05,
  roomSizeVariation: 0.5,
  largeRoomCount: 2,
};
```

Users can modify preset values after selecting them.

Do not create separate hard-coded generation logic for every preset unless absolutely necessary.

---

## 15. Non-Goals

Do NOT build these in the initial project:

- full manual level editor
- Blender-style modeling
- Unreal-style level design tools
- vertex editing
- face editing
- sculpting
- UV editing
- texture painting
- material node editor
- terrain editor
- character generation
- animation editor
- timeline
- multiplayer
- cloud collaboration
- account system
- marketplace
- plugins
- backend
- AI chat interface
- prompt-to-level generation
- procedural city generator
- realistic asset generation

If a feature does not directly improve rapid procedural prototype-map generation, leave it out.

---

## 16. Coding Guidelines

Use strict TypeScript.

Prefer:

- small focused modules
- clear types
- deterministic functions
- pure procedural algorithms where practical
- engine-independent level data
- clear naming
- reusable generation stages
- testable logic

Avoid:

- giant classes
- giant Vue components
- tightly coupling generation with rendering
- storing Three.js objects as the canonical level model
- premature optimization
- unnecessary abstractions
- unnecessary dependencies
- backend architecture
- native code

Three.js objects are a rendering representation.

They are not the source of truth.

---

## 17. Performance Strategy

Do not optimize before profiling.

For V1:

- generate levels on the main thread if generation remains fast
- reuse geometry and materials where practical
- merge static geometry when useful
- use instancing for repeated prototype props
- properly dispose Three.js resources when regenerating

If generation later becomes expensive:

1. profile it
2. move expensive pure computation into Web Workers
3. consider WASM only if profiling proves it is necessary

Do not introduce complexity without evidence.

---

## 18. V0.1 Scope

V0.1 should include only:

- browser application
- Vue 3 UI
- Three.js viewport
- deterministic seeds
- presets
- basic map shapes
- configurable area
- configurable room count
- configurable floor count
- rectangular rooms
- corridors
- stairs
- simple room types
- simple materials/themes
- Generate
- Regenerate
- Random Seed
- orbit preview
- first-person walk mode
- GLB export

A successful V0.1 means:

**A developer can open LevelWeaver, generate a prototype level, walk through it, export it, import it into Unreal Engine, and start testing gameplay without manually blocking out the map.**

---

## 19. Future Ideas

These are explicitly NOT required for V0.1.

Possible future additions:

- more sophisticated room shapes
- curved corridors
- ramps
- balconies
- bridges
- pits
- procedural cover
- FPS combat-oriented presets
- custom user materials
- custom modular asset libraries
- PWA support
- local project files
- saved presets
- batch generation
- AI natural-language configuration
- Unreal integration
- desktop Tauri wrapper
- city generation
- character generation

Do not implement these until the core generator works well.

---

## 20. Product Identity

Project name:

# LevelWeaver

Working description:

**A browser-based procedural level prototype generator for game developers.**

Short concept:

**Mixamo for prototype maps.**

The product should feel:

- fast
- lightweight
- experimental
- developer-focused
- predictable
- simple
- fun to regenerate

The user should spend more time testing generated maps than configuring LevelWeaver.

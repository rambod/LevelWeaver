import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type { GeneratedLevel } from '../../core/generation'
import { createMaterials } from '../../renderer/materials'
import { createBufferGeometry, isEmptyMesh } from '../../renderer/meshes'
import { validateExportModel } from '../../core/validation'

export function canExportLevel(level: GeneratedLevel | null): boolean {
  return !!level && level.ok === true && !!level.validation &&
    Array.isArray(level.validation.errors) && level.validation.errors.length === 0
}

export function levelFilename(level: GeneratedLevel): string {
  return `level_${level.seed}.glb`
}

function floorGroupName(floorIndex: number): string {
  return `Floor_${floorIndex.toString().padStart(2, '0')}`
}

export async function exportGLB(level: GeneratedLevel): Promise<Blob> {
  // Lawbook §96: export SHALL refuse levels with hard errors. Shipping a
  // GLB with known overlaps, sealed gates, or missing stairs exports the
  // artifact as if it were a valid level.
  if (!canExportLevel(level)) {
    throw new Error(
      '[LevelWeaver] export refused: a successful generation and a clean validation report are required.',
    )
  }
  // Recheck structural data: the report describes generation time, but the
  // artifact may have been modified since then. Never feed corrupt buffers to Three.js.
  const geometryErrors = validateExportModel(level)
  const finitePosition = (p: { x: number; y: number; z: number }) =>
    Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
  const validFloor = (floor: number) => Number.isInteger(floor) && floor >= 0 && floor < level.config.floorCount
  if (geometryErrors.length || !Number.isFinite(level.floorHeight) || level.floorHeight <= 0 ||
      level.rooms.some(r => !finitePosition(r.position) || !validFloor(r.floorIndex)) ||
      level.roomGeometry.some(g => !level.rooms.some(r => r.id === g.id)) ||
      level.corridorGeometry.some(c => !validFloor(c.floorIndex)) ||
      level.stairs.some(s => !validFloor(s.startFloor) || !validFloor(s.endFloor))) {
    throw new Error('[LevelWeaver] export refused: invalid geometry or transforms. ' +
      geometryErrors.slice(0, 3).map(e => `[${e.code}] ${e.message}`).join(' | '))
  }
  const exporter = new GLTFExporter()

  // Create export scene with proper hierarchy. Transforms are preserved
  // exactly as previewed (no recentering): Unreal/Blender/Godot import the
  // level at the same coordinates shown in the viewport.
  const exportScene = new THREE.Scene()
  exportScene.name = 'Level'
  exportScene.userData = {
    units: 'meters', seed: level.seed, generatorVersion: level.generatorVersion,
    config: { ...level.config },
  }

  // Themed materials so the GLB keeps the preview's visual identity
  // instead of exporting blank white placeholder materials.
  const materials = createMaterials(level.config.theme)
  try {
    const materialFor = (index: number, fallback: number): THREE.Material => {
      return materials.get(index) ?? materials.get(fallback) ?? materials.get(0)!
    }

    // Group by floor
    const floorGroups = new Map<number, THREE.Group>()
    const getFloorGroup = (floorIndex: number): THREE.Group => {
      let floorGroup = floorGroups.get(floorIndex)
      if (!floorGroup) {
        floorGroup = new THREE.Group()
        floorGroup.name = floorGroupName(floorIndex)
        exportScene.add(floorGroup)
        floorGroups.set(floorIndex, floorGroup)
      }
      return floorGroup
    }

    // Add rooms
    for (const roomGeo of level.roomGeometry) {
      const room = level.rooms.find(r => r.id === roomGeo.id)
      if (!room) continue

      const floorGroup = getFloorGroup(room.floorIndex)

      const roomGroup = new THREE.Group()
      roomGroup.name = `Room_${roomGeo.id.replace('room_', '')}`
      roomGroup.userData = { roomType: roomGeo.type, floorIndex: roomGeo.floorIndex }

      // Position at room location
      roomGroup.position.set(room.position.x, room.position.y, room.position.z)

      // Add geometry (slab parts stay separate meshes, like walls).
      roomGeo.floor.forEach((floor, i) => addGeometryToGroup(roomGroup, floor, `Floor_${i}`, 1, materialFor))
      roomGeo.walls.forEach((wall, i) => addGeometryToGroup(roomGroup, wall, `Wall_${i}`, 0, materialFor))
      roomGeo.ceiling.forEach((ceiling, i) => addGeometryToGroup(roomGroup, ceiling, `Ceiling_${i}`, 2, materialFor))

      floorGroup.add(roomGroup)
    }

    // Add corridors
    for (const corrGeo of level.corridorGeometry) {
      const floorGroup = getFloorGroup(corrGeo.floorIndex)

      const corrGroup = new THREE.Group()
      corrGroup.name = `Corridor_${corrGeo.id.replace('corridor_', '')}`

      addGeometryToGroup(corrGroup, corrGeo.floor, 'Floor', 1, materialFor)
      corrGeo.walls.forEach((wall, i) => addGeometryToGroup(corrGroup, wall, `Wall_${i}`, 0, materialFor))
      addGeometryToGroup(corrGroup, corrGeo.ceiling, 'Ceiling', 2, materialFor)

      corrGroup.position.y = corrGeo.floorIndex * level.floorHeight
      floorGroup.add(corrGroup)
    }

    // Add stairs
    for (const stairGeo of level.stairs) {
      const floorGroup = getFloorGroup(stairGeo.startFloor)

      const stairGroup = new THREE.Group()
      stairGroup.name = `Stairs_${stairGeo.id.replace('stairs_', '')}`
      stairGroup.userData = { startFloor: stairGeo.startFloor, endFloor: stairGeo.endFloor }

      stairGeo.steps.forEach((step, i) => addGeometryToGroup(stairGroup, step, `Step_${i}`, 1, materialFor))
      stairGeo.risers.forEach((riser, i) => addGeometryToGroup(stairGroup, riser, `Riser_${i}`, 0, materialFor))
      stairGeo.stringers.forEach((stringer, i) => addGeometryToGroup(stairGroup, stringer, `Stringer_${i}`, 0, materialFor))
      stairGeo.landing.forEach((landing, i) => addGeometryToGroup(stairGroup, landing, `Landing_${i}`, 1, materialFor))
      if (stairGeo.tower) {
        addGeometryToGroup(stairGroup, stairGeo.tower.floor, 'TowerFloor', 1, materialFor)
        stairGeo.tower.walls.forEach((wall, i) => addGeometryToGroup(stairGroup, wall, `TowerWall_${i}`, 0, materialFor))
      }

      stairGroup.position.y = stairGeo.startFloor * level.floorHeight
      floorGroup.add(stairGroup)
    }

    // Export as GLB
    return await new Promise<Blob>((resolve, reject) => {
      try {
        exporter.parse(
          exportScene,
          (gltf) => {
            if (gltf instanceof ArrayBuffer) {
              resolve(new Blob([gltf], { type: 'model/gltf-binary' }))
            } else {
              reject(new Error('GLTFExporter returned unexpected format'))
            }
          },
          (error) => {
            // @types/three declares this callback as ErrorEvent, but the
            // runtime rejects with an Error. Preserve the original error
            // when possible; fall back to its message before String().
            if (error instanceof Error) reject(error)
            else if (error && typeof (error as ErrorEvent).message === 'string' && (error as ErrorEvent).message)
              reject(new Error((error as ErrorEvent).message))
            else reject(new Error(String(error)))
          },
          { binary: true },
        )
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  } finally {
    exportScene.traverse(obj => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose()
    })
    materials.forEach(material => material.dispose())
    exportScene.clear()
  }
}

function addGeometryToGroup(
  group: THREE.Group,
  geo: { vertices: Float32Array; indices: Uint32Array; normals: Float32Array; uvs: Float32Array; materialIndex: number },
  name: string,
  defaultMaterialIndex: number,
  materialFor: (index: number, fallback: number) => THREE.Material,
): void {
  if (isEmptyMesh(geo)) return

  const geometry = createBufferGeometry(geo)

  const material = materialFor(geo.materialIndex >= 0 ? geo.materialIndex : defaultMaterialIndex, defaultMaterialIndex)
  // Share the themed material instances: the GLB then contains one material
  // per theme slot (wall/floor/ceiling/...) instead of hundreds of clones.
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name
  mesh.userData = { materialIndex: geo.materialIndex >= 0 ? geo.materialIndex : defaultMaterialIndex }
  group.add(mesh)
}

export function downloadGLB(blob: Blob, filename = 'level.glb'): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  try {
    a.click()
  } finally {
    a.remove()
    // Let the browser consume the navigation before releasing its Blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

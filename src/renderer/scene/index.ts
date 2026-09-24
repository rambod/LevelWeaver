import * as THREE from 'three'
import type { GeneratedLevel } from '@/core/generation'
import { FLOOR_HEIGHT } from '@/core/types'
import { createMaterials } from '@/renderer/materials'
import { createBufferGeometry, resolveMaterialIndex } from '@/renderer/meshes'

export class LevelScene {
  public scene: THREE.Scene
  public levelGroup: THREE.Group
  public gridHelper: THREE.GridHelper
  public boundsHelper: THREE.Box3Helper
  private materials: Map<number, THREE.Material>
  private themeName = 'greybox'
  private floorHeight: number = FLOOR_HEIGHT

  constructor() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1a1a2e)

    this.levelGroup = new THREE.Group()
    this.scene.add(this.levelGroup)

    // Grid
    this.gridHelper = new THREE.GridHelper(100, 100, 0x444466, 0x2a2a4a)
    this.scene.add(this.gridHelper)

    // Bounds visualization
    this.boundsHelper = new THREE.Box3Helper(new THREE.Box3(), 0x00ff88)
    this.boundsHelper.visible = false
    this.scene.add(this.boundsHelper)

    // Lighting
    this.setupLighting()

    // Materials
    this.materials = createMaterials()
  }

  private setupLighting(): void {
    // Ambient base so enclosed interiors never fall to black: most rooms
    // are lit only through their doorways, and walk mode spends all its
    // time inside. Hemisphere adds a neutral sky/ground gradient on top
    // (interior-friendly fill that costs one light, no shadow pass).
    const ambient = new THREE.AmbientLight(0xffffff, 0.55)
    this.scene.add(ambient)

    const hemisphere = new THREE.HemisphereLight(0xbdd0ff, 0x3a3f4a, 0.5)
    this.scene.add(hemisphere)

    // Main directional light (sun-like)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(20, 40, 20)
    dirLight.castShadow = true
    dirLight.shadow.mapSize.width = 2048
    dirLight.shadow.mapSize.height = 2048
    dirLight.shadow.camera.near = 1
    dirLight.shadow.camera.far = 100
    dirLight.shadow.camera.left = -50
    dirLight.shadow.camera.right = 50
    dirLight.shadow.camera.top = 50
    dirLight.shadow.camera.bottom = -50
    dirLight.shadow.bias = -0.001
    this.scene.add(dirLight)

    // Fill light
    const fillLight = new THREE.DirectionalLight(0x88aaff, 0.3)
    fillLight.position.set(-20, 20, -20)
    this.scene.add(fillLight)

    // Rim light
    const rimLight = new THREE.DirectionalLight(0xffaa88, 0.2)
    rimLight.position.set(0, -10, 0)
    this.scene.add(rimLight)
  }

  updateLevel(level: GeneratedLevel): void {
    this.floorHeight = level.floorHeight
    this.clearLevel()
    this.setTheme(level.config.theme)
    this.buildLevelGeometry(level)
    this.updateBoundsHelper(level)
  }

  private clearLevel(): void {
    while (this.levelGroup.children.length > 0) {
      const child = this.levelGroup.children[0]
      this.disposeObject(child)
      this.levelGroup.remove(child)
    }
  }

  private disposeObject(obj: THREE.Object3D): void {
    if (obj instanceof THREE.Mesh) {
      // Dispose geometries only. Materials are shared from this.materials
      // (one instance per theme slot) and must NOT be disposed here, or the
      // next level build would render with disposed materials.
      if (obj.geometry) obj.geometry.dispose()
    }
    // Dispose children first, then detach.
    const children = [...obj.children]
    children.forEach(child => {
      this.disposeObject(child)
      obj.remove(child)
    })
  }

  private buildLevelGeometry(level: GeneratedLevel): void {
    // Build room geometry
    for (const roomGeo of level.roomGeometry) {
      const roomGroup = new THREE.Group()
      roomGroup.name = roomGeo.id
      roomGroup.userData = { type: 'room', roomType: roomGeo.type, floorIndex: roomGeo.floorIndex }

      // Floor (separate part meshes so stairwell holes stay holes in
      // collision as well as render — never one combined slab).
      roomGeo.floor.forEach((floorGeo, i) => {
        if (floorGeo.vertices.length > 0) {
          const mesh = this.createMesh(floorGeo, 1)
          mesh.name = `floor_${i}`
          mesh.receiveShadow = true
          roomGroup.add(mesh)
        }
      })

      // Walls
      roomGeo.walls.forEach((wallGeo, i) => {
        if (wallGeo.vertices.length > 0) {
          const mesh = this.createMesh(wallGeo, 0)
          mesh.name = `wall_${i}`
          mesh.castShadow = true
          mesh.receiveShadow = true
          roomGroup.add(mesh)
        }
      })

      // Ceiling (same separate-parts rule as floors).
      roomGeo.ceiling.forEach((ceilGeo, i) => {
        if (ceilGeo.vertices.length > 0) {
          const mesh = this.createMesh(ceilGeo, 2)
          mesh.name = `ceiling_${i}`
          mesh.receiveShadow = true
          roomGroup.add(mesh)
        }
      })

      // Position the room group
      const room = level.rooms.find(r => r.id === roomGeo.id)
      if (room) {
        roomGroup.position.set(room.position.x, room.position.y, room.position.z)
      }

      this.levelGroup.add(roomGroup)
    }

    // Build corridor geometry
    for (const corrGeo of level.corridorGeometry) {
      const corrGroup = new THREE.Group()
      corrGroup.name = corrGeo.id
      corrGroup.userData = { type: 'corridor', floorIndex: corrGeo.floorIndex }

      // Floor
      if (corrGeo.floor.vertices.length > 0) {
        const mesh = this.createMesh(corrGeo.floor, 1)
        mesh.name = 'floor'
        mesh.receiveShadow = true
        corrGroup.add(mesh)
      }

      // Walls
      corrGeo.walls.forEach((wallGeo, i) => {
        if (wallGeo.vertices.length > 0) {
          const mesh = this.createMesh(wallGeo, 0)
          mesh.name = `wall_${i}`
          mesh.castShadow = true
          mesh.receiveShadow = true
          corrGroup.add(mesh)
        }
      })

      // Ceiling
      if (corrGeo.ceiling.vertices.length > 0) {
        const mesh = this.createMesh(corrGeo.ceiling, 2)
        mesh.name = 'ceiling'
        mesh.receiveShadow = true
        corrGroup.add(mesh)
      }

      corrGroup.position.y = corrGeo.floorIndex * this.floorHeight
      this.levelGroup.add(corrGroup)
    }

    // Build stair geometry
    if (level.stairs) {
      for (const stairGeo of level.stairs) {
        const stairGroup = new THREE.Group()
        stairGroup.name = stairGeo.id
        stairGroup.userData = { type: 'stairs', startFloor: stairGeo.startFloor, endFloor: stairGeo.endFloor }

        // Steps
        stairGeo.steps.forEach((stepGeo, i) => {
          if (stepGeo.vertices.length > 0) {
            const mesh = this.createMesh(stepGeo, 1)
            mesh.name = `step_${i}`
            mesh.receiveShadow = true
            stairGroup.add(mesh)
          }
        })

        // Risers
        stairGeo.risers.forEach((riserGeo, i) => {
          if (riserGeo.vertices.length > 0) {
            const mesh = this.createMesh(riserGeo, 0)
            mesh.name = `riser_${i}`
            mesh.castShadow = true
            mesh.receiveShadow = true
            stairGroup.add(mesh)
          }
        })

        // Stringers
        if (stairGeo.stringers) {
          stairGeo.stringers.forEach((stringerGeo, i) => {
            if (stringerGeo.vertices.length > 0) {
              const mesh = this.createMesh(stringerGeo, 0)
              mesh.name = `stringer_${i}`
              mesh.castShadow = true
              mesh.receiveShadow = true
              stairGroup.add(mesh)
            }
          })
        }

        // Landing
        if (stairGeo.landing) {
          stairGeo.landing.forEach((landingGeo, i) => {
            if (landingGeo.vertices.length > 0) {
              const mesh = this.createMesh(landingGeo, 1)
              mesh.name = `landing_${i}`
              mesh.receiveShadow = true
              stairGroup.add(mesh)
            }
          })
        }

        // Attached shaft (tower stairs): floor + walls.
        if (stairGeo.tower) {
          if (stairGeo.tower.floor.vertices.length > 0) {
            const mesh = this.createMesh(stairGeo.tower.floor, 1)
            mesh.name = 'floor'
            mesh.receiveShadow = true
            stairGroup.add(mesh)
          }
          stairGeo.tower.walls.forEach((wallGeo, i) => {
            if (wallGeo.vertices.length > 0) {
              const mesh = this.createMesh(wallGeo, 0)
              mesh.name = `wall_tower_${i}`
              mesh.castShadow = true
              mesh.receiveShadow = true
              stairGroup.add(mesh)
            }
          })
        }

        stairGroup.position.y = stairGeo.startFloor * this.floorHeight
        this.levelGroup.add(stairGroup)
      }
    }
  }

  private createMesh(geo: { vertices: Float32Array; indices: Uint32Array; normals: Float32Array; uvs: Float32Array; materialIndex: number }, defaultMatIndex: number): THREE.Mesh {
    const geometry = createBufferGeometry(geo)

    const matIndex = resolveMaterialIndex(geo, defaultMatIndex)
    const material = this.materials.get(matIndex) || this.materials.get(0)!

    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData.materialIndex = matIndex
    return mesh
  }

  private updateBoundsHelper(level: GeneratedLevel): void {
    const box = new THREE.Box3()
    let hasGeometry = false

    for (const roomGeo of level.roomGeometry) {
      const room = level.rooms.find(r => r.id === roomGeo.id)
      if (!room) continue

      const halfW = room.width / 2
      const halfD = room.depth / 2
      const y = room.position.y

      box.expandByPoint(new THREE.Vector3(room.position.x - halfW, y, room.position.z - halfD))
      box.expandByPoint(new THREE.Vector3(room.position.x + halfW, y + room.height, room.position.z + halfD))
      hasGeometry = true
    }

    for (const corr of level.corridors) {
      box.expandByPoint(new THREE.Vector3(corr.startPos.x, corr.startPos.y, corr.startPos.z))
      box.expandByPoint(new THREE.Vector3(corr.endPos.x, corr.endPos.y, corr.endPos.z))
      hasGeometry = true
    }

    // Include stairs in bounds (derived from built stair meshes)
    if (level.stairs) {
      for (const stair of level.stairs) {
        const stairGroup = this.levelGroup.children.find(c => c.name === stair.id)
        if (!stairGroup) continue
        const stairBox = new THREE.Box3()
        stairGroup.traverse(obj => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.computeBoundingBox()
            const meshBox = obj.geometry.boundingBox!.clone()
            // Mesh matrices are local to the stair group; the group adds
            // the floor-level Y offset, so apply both.
            meshBox.applyMatrix4(obj.matrix)
            meshBox.min.y += stair.startFloor * this.floorHeight
            meshBox.max.y += stair.startFloor * this.floorHeight
            stairBox.union(meshBox)
          }
        })
        if (!stairBox.isEmpty()) {
          box.union(stairBox)
          hasGeometry = true
        }
      }
    }

    if (hasGeometry) {
      this.boundsHelper.box.copy(box)
      this.boundsHelper.visible = true

      // Update grid size
      const size = box.getSize(new THREE.Vector3())
      this.gridHelper.scale.setScalar(Math.max(size.x, size.z) / 50)
    }
  }

  getMaterials(): Map<number, THREE.Material> {
    return this.materials
  }

  setTheme(themeName: string): void {
    if (this.themeName === themeName) return
    const previous = this.materials
    this.materials = createMaterials(themeName)
    this.themeName = themeName
    this.levelGroup.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.material = this.materials.get(obj.userData.materialIndex) ?? this.materials.get(0)!
      }
    })
    previous.forEach(material => material.dispose())
  }

  dispose(): void {
    this.clearLevel()
    this.materials.forEach(m => m.dispose())
    this.gridHelper.dispose()
    this.boundsHelper.dispose()
  }
}

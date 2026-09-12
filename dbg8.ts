import * as THREE from 'three'
const g = globalThis as any
g.window = { addEventListener() {}, removeEventListener() {} }
g.document = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null, exitPointerLock() {}, activeElement: null }
g.HTMLElement = class { blur() {} }
import { generateLevel } from './src/core/generation/index.ts'
import { getDefaultConfig, presets } from './src/core/presets/index.ts'
import { LevelScene } from './src/renderer/scene/index.ts'
import { snapshotCollisionBoxes, engagedBoxes } from './src/playtest/collision/index.ts'
const _warn = console.warn
console.warn = () => {}
const base = getDefaultConfig()
const lvl = generateLevel({ ...base, ...presets.dungeon.config, preset: 'dungeon', seed: 42 })
const scene = new LevelScene()
scene.updateLevel(lvl)
scene.scene.updateMatrixWorld(true)
const walkMeshes: THREE.Mesh[] = []
scene.levelGroup.traverse((obj: any) => {
  if (!(obj instanceof THREE.Mesh)) return
  const inCorridor = obj.parent?.userData?.type === 'corridor'
  if (obj.name === 'floor' || obj.name.startsWith('step') || obj.name.startsWith('landing')) walkMeshes.push(obj)
  else if (obj.name.startsWith('wall') && !inCorridor) walkMeshes.push(obj)
})
const boxes = snapshotCollisionBoxes(walkMeshes)
// stairbot stuck point for room_11_room_12: (13.9, 3.99, 4.0), Z-branch dest z=3.99->tgt... dest=(13.9,?,3.99ish), stepped risen
for (const [label, x, y, z] of [['dest', 13.9, 3.99 - 0.0056, 4.0], ['stepped+0.1', 13.9, 4.09, 3.99]] as const) {
  console.log(`${label} (${x},${y.toFixed(2)},${z}) engaged:`)
  for (const b of engagedBoxes(new THREE.Vector3(x, y, z), boxes, 0.4, 1.8)) {
    // find owner mesh
    let owner = '?/?'
    for (const m of walkMeshes) {
      m.geometry.computeBoundingBox()
      const bb = m.geometry.boundingBox!.clone()
      bb.applyMatrix4(m.matrixWorld)
      if (Math.abs(bb.min.x - b.min.x) < 1e-4 && Math.abs(bb.max.y - b.max.y) < 1e-4 && Math.abs(bb.min.z - b.min.z) < 1e-4) {
        owner = `${(m.parent as any)?.name}/${m.name}`
        break
      }
    }
    console.log(`  ${owner} x[${b.min.x.toFixed(2)},${b.max.x.toFixed(2)}] y[${b.min.y.toFixed(2)},${b.max.y.toFixed(2)}] z[${b.min.z.toFixed(2)},${b.max.z.toFixed(2)}]`)
  }
}
// upper hole for room_12?
const s: any = lvl.stairs.find(x => x.id === 'stairs_room_11_room_12')!
console.log('stair kind:', s.kind, 'upper:', s.upperRoomId)
// slab holes are internal; infer from room geometry floor parts
const rg: any = lvl.roomGeometry.find((r: any) => r.id === 'room_12')!
console.log('room_12 floor vertices:', (rg.floor.vertices as Float32Array).length / 3, 'verts')

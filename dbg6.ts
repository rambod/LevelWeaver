import * as THREE from 'three'
const g = globalThis as any
g.window = { addEventListener() {}, removeEventListener() {} }
g.document = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null, exitPointerLock() {}, activeElement: null }
g.HTMLElement = class { blur() {} }
import { generateLevel } from './src/core/generation/index.ts'
import { getDefaultConfig, presets } from './src/core/presets/index.ts'
import { LevelScene } from './src/renderer/scene/index.ts'
import { snapshotCollisionBoxes } from './src/playtest/collision/index.ts'
const _warn = console.warn
console.warn = () => {}
const base = getDefaultConfig()
const lvl = generateLevel({ ...base, ...presets.fpsArena.config, preset: 'fpsArena', seed: 1 })
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
console.log('upper rooms:')
for (const r of lvl.rooms) {
  if (r.floorIndex !== 1) continue
  console.log(` ${r.id} ${r.type} ${r.width.toFixed(1)}x${r.depth.toFixed(1)} @(${r.position.x.toFixed(1)},${r.position.y.toFixed(1)},${r.position.z.toFixed(1)})`)
}
console.log('walkMeshes:', walkMeshes.length, 'levelGroup children:', (scene.levelGroup as any).children.length)
console.log('stairs in level:', lvl.stairs.length, 'roomGeometry:', lvl.roomGeometry.length)
console.log('walk boxes overlapping column (-1.3,-7.08), eye 5.27:')
for (const m of walkMeshes) {
  m.geometry.computeBoundingBox()
  const box = m.geometry.boundingBox!.clone()
  box.applyMatrix4(m.matrixWorld)
  if (-1.3 > box.min.x - 0.4 && -1.3 < box.max.x + 0.4 && -7.08 > box.min.z - 0.4 && -7.08 < box.max.z + 0.4 &&
      5.27 > box.min.y && 5.27 - 1.8 < box.max.y - 0.02) {
    console.log(`  ${(m.parent as any)?.name}/${m.name} x[${box.min.x.toFixed(2)},${box.max.x.toFixed(2)}] y[${box.min.y.toFixed(2)},${box.max.y.toFixed(2)}] z[${box.min.z.toFixed(2)},${box.max.z.toFixed(2)}]`)
  }
}
console.log('tall boxes (top in [6.5,8.5]) within 4m XZ:')
for (const m of walkMeshes) {
  m.geometry.computeBoundingBox()
  const box = m.geometry.boundingBox!.clone()
  box.applyMatrix4(m.matrixWorld)
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2
  if (box.max.y >= 6.5 && box.max.y <= 8.5 && Math.abs(cx + 1.3) < 4 && Math.abs(cz + 7.08) < 4) {
    console.log(`  ${(m.parent as any)?.name}/${m.name} c=(${(cx).toFixed(2)},${(cz).toFixed(2)}) x[${box.min.x.toFixed(2)},${box.max.x.toFixed(2)}] y[${box.min.y.toFixed(2)},${box.max.y.toFixed(2)}] z[${box.min.z.toFixed(2)},${box.max.z.toFixed(2)}]`)
  }
}
const s: any = lvl.stairs.find(x => x.id === 'stairs_room_0_room_7')!
console.log('stair kind:', s.kind, 'upperRoom:', s.upperRoomId, 'host:', s.hostRoomId)

import * as THREE from 'three'
const g = globalThis as any
g.window = { addEventListener() {}, removeEventListener() {} }
g.document = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null, exitPointerLock() {}, activeElement: null }
g.HTMLElement = class { blur() {} }
import { generateLevel } from './src/core/generation/index.ts'
import { getDefaultConfig, presets } from './src/core/presets/index.ts'
import { LevelScene } from './src/renderer/scene/index.ts'
import { snapshotCollisionBoxes, checkPlayerCollision } from './src/playtest/collision/index.ts'
import { PLAYER_RADIUS, PLAYER_HEIGHT } from './src/playtest/controller/index.ts'
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
const s: any = lvl.stairs.find(x => x.id === 'stairs_room_11_room_12')!
console.log('kind:', s.kind, 'pos:', s.position.x.toFixed(2), s.position.y.toFixed(2), s.position.z.toFixed(2), 'w:', s.width, 'd:', s.depth, 'steps:', s.steps.length, 'landings:', s.landing.length)
const lower = lvl.rooms.find((r: any) => r.id === 'room_11')!
const upper = lvl.rooms.find((r: any) => r.id === 'room_12')!
console.log(`lower room_11 ${lower.width.toFixed(1)}x${lower.depth.toFixed(1)} @(${lower.position.x.toFixed(1)},${lower.position.y.toFixed(1)},${lower.position.z.toFixed(1)}) f=${lower.floorIndex}`)
console.log(`upper room_12 ${upper.width.toFixed(1)}x${upper.depth.toFixed(1)} @(${upper.position.x.toFixed(1)},${upper.position.y.toFixed(1)},${upper.position.z.toFixed(1)}) f=${upper.floorIndex}`)
console.log('floorHeight:', lvl.floorHeight)
// treads with world boxes
const groupY = s.startFloor * lvl.floorHeight
s.steps.forEach((st: any, i: number) => {
  const v = st.vertices as Float32Array
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9
  for (let k = 0; k < v.length; k += 3) {
    mnx = Math.min(mnx, v[k]); mxx = Math.max(mxx, v[k])
    mny = Math.min(mny, v[k + 1]); mxy = Math.max(mxy, v[k + 1])
    mnz = Math.min(mnz, v[k + 2]); mxz = Math.max(mxz, v[k + 2])
  }
  if (i % 4 === 0 || i > 10) console.log(` tread${i} x[${mnx.toFixed(2)},${mxx.toFixed(2)}] y[${(mny + groupY).toFixed(2)},${(mxy + groupY).toFixed(2)}] z[${mnz.toFixed(2)},${mxz.toFixed(2)}]`)
})
// doors of host
for (const rg of lvl.roomGeometry) {
  if (rg.id !== 'room_11') continue
  for (const d of rg.doorOpenings as any[]) {
    console.log(` host door wall${d.wallIndex} @(${d.position.x.toFixed(2)},${d.position.z.toFixed(2)}) w=${d.width} -> ${d.targetRoomId}`)
  }
}
// boxes overlapping the stuck column (13.9, 4.0) at eye 3.99
console.log('boxes at stuck column:')
for (const m of walkMeshes) {
  m.geometry.computeBoundingBox()
  const box = m.geometry.boundingBox!.clone()
  box.applyMatrix4(m.matrixWorld)
  if (13.9 > box.min.x - 0.4 && 13.9 < box.max.x + 0.4 && 4.0 > box.min.z - 0.4 && 4.0 < box.max.z + 0.4 &&
      3.99 > box.min.y && 3.99 - 1.8 < box.max.y - 0.02) {
    console.log(`  ${(m.parent as any)?.name}/${m.name} x[${box.min.x.toFixed(2)},${box.max.x.toFixed(2)}] y[${box.min.y.toFixed(2)},${box.max.y.toFixed(2)}] z[${box.min.z.toFixed(2)},${box.max.z.toFixed(2)}]`)
  }
}

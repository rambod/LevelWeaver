import * as THREE from 'three'
const g = globalThis as any
g.window = { addEventListener() {}, removeEventListener() {} }
g.document = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null, exitPointerLock() {}, activeElement: null }
g.HTMLElement = class { blur() {} }
function makeDom() {
  return {
    addEventListener() {}, removeEventListener() {},
    style: {} as any,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    requestPointerLock() {},
  } as any
}
import { generateLevel } from './src/core/generation/index.ts'
import { getDefaultConfig, presets } from './src/core/presets/index.ts'
import { LevelScene } from './src/renderer/scene/index.ts'
import { CameraController } from './src/renderer/camera/index.ts'
import { snapshotCollisionBoxes, corridorWallCapsules, checkPlayerCollision } from './src/playtest/collision/index.ts'
import { corridorHeightFor } from './src/core/types/index.ts'
import { PLAYER_RADIUS, PLAYER_HEIGHT } from './src/playtest/controller/index.ts'
const _warn = console.warn
console.warn = () => {}

const base = getDefaultConfig()
const lvl = generateLevel({ ...base, ...presets.fpsArena.config, preset: 'fpsArena', seed: 1 })
const scene = new LevelScene()
scene.updateLevel(lvl)
scene.scene.updateMatrixWorld(true)
const walkMeshes: THREE.Mesh[] = []
const meshInfo: { mesh: THREE.Mesh; box: THREE.Box3 }[] = []
scene.levelGroup.traverse((obj: any) => {
  if (!(obj instanceof THREE.Mesh)) return
  const inCorridor = obj.parent?.userData?.type === 'corridor'
  if (obj.name === 'floor' || obj.name.startsWith('step') || obj.name.startsWith('landing')) walkMeshes.push(obj)
  else if (obj.name.startsWith('wall') && !inCorridor) walkMeshes.push(obj)
})
const boxes = snapshotCollisionBoxes(walkMeshes)
for (const m of walkMeshes) {
  meshInfo.push({ mesh: m, box: new THREE.Box3().setFromObject(m) })
}
// stuck point from bot: (-2.3,-8.0) eye 3.87
const px = -2.3, py = 3.87, pz = -8.0
console.log('boxes overlapping body column at stuck point:')
for (const { mesh, box } of meshInfo) {
  if (px > box.min.x - 0.4 && px < box.max.x + 0.4 && pz > box.min.z - 0.4 && pz < box.max.z + 0.4 &&
      py > box.min.y && py - 1.8 < box.max.y - 0.02) {
    const parent = (mesh.parent as any)?.name ?? '?'
    console.log(`  ${parent}/${mesh.name} x[${box.min.x.toFixed(2)},${box.max.x.toFixed(2)}] y[${box.min.y.toFixed(2)},${box.max.y.toFixed(2)}] z[${box.min.z.toFixed(2)},${box.max.z.toFixed(2)}]`)
  }
}
// stair plan info
const s = lvl.stairs.find(x => x.id === 'stairs_room_0_room_7')!
console.log('stair kind:', s.kind, 'pos:', s.position.x.toFixed(2), s.position.z.toFixed(2), 'w:', s.width, 'd:', s.depth, 'steps:', s.steps.length, 'landings:', s.landing.length, 'axis:', (s as any).axis)
// landing mesh bounds
for (const [i, l] of s.landing.entries()) {
  const v = l.vertices as Float32Array
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9
  for (let k = 0; k < v.length; k += 3) {
    mnx = Math.min(mnx, v[k]); mxx = Math.max(mxx, v[k])
    mny = Math.min(mny, v[k + 1]); mxy = Math.max(mxy, v[k + 1])
    mnz = Math.min(mnz, v[k + 2]); mxz = Math.max(mxz, v[k + 2])
  }
  console.log(` landing[${i}] local x[${mnx.toFixed(2)},${mxx.toFixed(2)}] y[${mny.toFixed(2)},${mxy.toFixed(2)}] z[${mnz.toFixed(2)},${mxz.toFixed(2)}] groupY=${s.position.y}`)
}

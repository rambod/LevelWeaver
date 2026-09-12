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
let meshes = 0
const walkMeshes: THREE.Mesh[] = []
scene.levelGroup.traverse((obj: any) => {
  if (!(obj instanceof THREE.Mesh)) return
  meshes++
  const inCorridor = obj.parent?.userData?.type === 'corridor'
  if (obj.name === 'floor' || obj.name.startsWith('step') || obj.name.startsWith('landing')) walkMeshes.push(obj)
  else if (obj.name.startsWith('wall') && !inCorridor) walkMeshes.push(obj)
})
console.log('meshes:', meshes, 'walkMeshes:', walkMeshes.length)
const boxes = snapshotCollisionBoxes(walkMeshes)
console.log('boxes:', boxes.length)
const s = lvl.stairs.find(x => x.id === 'stairs_room_0_room_7')!
console.log('stair kind:', s.kind, 'pos:', s.position.x.toFixed(1), s.position.z.toFixed(1), 'w/d:', s.width, s.depth)
// first tread world pos
const step0 = s.steps[0]
const v = step0.vertices as Float32Array
let sx = 0, sz = 0
const n = v.length / 3
for (let i = 0; i < n; i++) { sx += v[i * 3]; sz += v[i * 3 + 2] }
const groupY = s.startFloor * lvl.floorHeight
console.log('tread0 center:', (sx / n).toFixed(2), (sz / n).toFixed(2), 'groupY:', groupY)
// collision queries
const eye = new THREE.Vector3(sx / n, groupY + 2.0, sz / n)
console.log('collide at tread0 eye:', checkPlayerCollision(eye, boxes, PLAYER_RADIUS, PLAYER_HEIGHT, []))
// which boxes contain the eye column?
let nb = 0
for (const b of boxes) {
  if (eye.x > b.min.x - 0.4 && eye.x < b.max.x + 0.4 && eye.z > b.min.z - 0.4 && eye.z < b.max.z + 0.4 && 2.0 > b.min.y && 0.2 < b.max.y - 0.02) {
    if (nb++ < 8) console.log(`  box x[${b.min.x.toFixed(2)},${b.max.x.toFixed(2)}] y[${b.min.y.toFixed(2)},${b.max.y.toFixed(2)}] z[${b.min.z.toFixed(2)},${b.max.z.toFixed(2)}]`)
  }
}
const room0 = lvl.rooms.find(r => r.id === 'room_0')!
console.log('room_0:', room0.position.x.toFixed(1), room0.position.z.toFixed(1), room0.width.toFixed(1))
const eyeRoom = new THREE.Vector3(room0.position.x, room0.position.y + 2.0, room0.position.z)
console.log('collide at room_0 center eye:', checkPlayerCollision(eyeRoom, boxes, PLAYER_RADIUS, PLAYER_HEIGHT, []))
// controller sanity: walk +X in room_0
const ctrl = new CameraController(makeDom(), 800, 600) as any
ctrl.setWalkMode(true)
ctrl.camera.position.copy(eyeRoom)
ctrl.yaw = Math.atan2(-1, 0)
ctrl.moveForward = true
for (let f = 0; f < 60; f++) ctrl.update(1 / 60, { boxes, capsules: [] })
ctrl.moveForward = false
console.log('after 60f +X:', ctrl.camera.position.x.toFixed(2), ctrl.camera.position.y.toFixed(2), ctrl.camera.position.z.toFixed(2))

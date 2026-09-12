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
const _warn = console.warn
console.warn = () => {}
process.env.LW_STEP_DEBUG = '1'

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
const world = {
  boxes: snapshotCollisionBoxes(walkMeshes),
  capsules: lvl.corridors.flatMap(c => {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    return corridorWallCapsules(pts, c.width, c.floorIndex * lvl.floorHeight, corridorHeightFor(lvl.config))
  }),
}
// replicate stuck state: pos (10.4, 7.99, -5.5), face -x-ish toward next tread.
// stair room_12_room_2 treads: find tread13 target like the bot would.
const s: any = lvl.stairs.find(x => x.id === 'stairs_room_12_room_2')!
console.log('kind:', s.kind, 'steps:', s.steps.length, 'landings:', s.landing.length)
const ctrl = new CameraController(makeDom(), 800, 600) as any
ctrl.setWalkMode(true)
ctrl.camera.position.set(10.4, 7.99, -5.5)
ctrl.velocity.set(0, 0, 0)
// face roughly -x (up-flight; will read tread layout from log)
ctrl.yaw = Math.PI / 2
ctrl.pitch = 0
for (let f = 0; f < 6; f++) {
  console.log(`--- frame ${f} pos=(${ctrl.camera.position.x.toFixed(3)},${ctrl.camera.position.y.toFixed(3)},${ctrl.camera.position.z.toFixed(3)}) vy=${ctrl.velocity.y.toFixed(3)}`)
  ctrl.moveForward = true
  ctrl.update(1 / 60, world)
  ctrl.moveForward = false
}

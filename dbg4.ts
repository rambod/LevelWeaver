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
const world = {
  boxes: snapshotCollisionBoxes(walkMeshes),
  capsules: lvl.corridors.flatMap(c => {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    return corridorWallCapsules(pts, c.width, c.floorIndex * lvl.floorHeight, corridorHeightFor(lvl.config))
  }),
}
// replicate stairbot waypoints for stairs_room_0_room_7
const s: any = lvl.stairs.find(x => x.id === 'stairs_room_0_room_7')!
const groupY = s.startFloor * lvl.floorHeight
const upper = lvl.rooms.find((r: any) => r.id === s.upperRoomId)!
const cents: { x: number; topY: number; z: number }[] = []
for (const step of s.steps) {
  const v = step.vertices as Float32Array
  let sx = 0, sy = -Infinity, sz = 0
  const n = v.length / 3
  for (let i = 0; i < n; i++) { sx += v[i * 3]; sz += v[i * 3 + 2]; sy = Math.max(sy, v[i * 3 + 1]) }
  cents.push({ x: sx / n, topY: sy + groupY, z: sz / n })
}
const first = cents[0], second = cents[1]
const dx0 = second.x - first.x, dz0 = second.z - first.z
const dl0 = Math.sqrt(dx0 * dx0 + dz0 * dz0) || 1
const wps: { x: number; z: number }[] = [{ x: first.x - (dx0 / dl0) * 0.4, z: first.z - (dz0 / dl0) * 0.4 }]
for (let i = 0; i < cents.length; i++) wps.push({ x: cents[i].x, z: cents[i].z })
console.log('waypoints:', wps.map((w, i) => `${i}(${w.x.toFixed(2)},${w.z.toFixed(2)})`).join(' '))
const ctrl = new CameraController(makeDom(), 800, 600) as any
ctrl.setWalkMode(true)
ctrl.camera.position.set(wps[0].x, groupY + 2.0, wps[0].z)
ctrl.velocity.set(0, 0, 0)
const DT = 1 / 60
let wi = 1
for (let f = 0; f < 1200 && wi < wps.length; f++) {
  const wp = wps[wi]
  const px = ctrl.camera.position.x, pz = ctrl.camera.position.z
  const ddx = wp.x - px, ddz = wp.z - pz
  const dist = Math.sqrt(ddx * ddx + ddz * ddz)
  if (dist < 0.6) { wi++; continue }
  ctrl.yaw = Math.atan2(-ddx, -ddz)
  ctrl.pitch = 0
  ctrl.moveForward = true
  const bx = px, bz = pz, by = ctrl.camera.position.y
  ctrl.update(DT, world)
  ctrl.moveForward = false
  const moved = Math.sqrt((ctrl.camera.position.x - bx) ** 2 + (ctrl.camera.position.z - bz) ** 2)
  if (f % 100 === 0 || (moved < 0.02 && f % 20 === 0)) {
    console.log(`f${f} wi=${wi} pos=(${ctrl.camera.position.x.toFixed(2)},${ctrl.camera.position.y.toFixed(2)},${ctrl.camera.position.z.toFixed(2)}) moved=${moved.toFixed(3)} dist=${dist.toFixed(2)}`)
  }
  if (f > 500 && moved < 0.02) {
    console.log(`STUCK at f${f} wi=${wi} facing wp(${wp.x.toFixed(2)},${wp.z.toFixed(2)})`)
    break
  }
}

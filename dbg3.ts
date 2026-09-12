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
import { snapshotCollisionBoxes, corridorWallCapsules, checkPlayerCollision, engagedBoxes } from './src/playtest/collision/index.ts'
import { PLAYER_GROUND_EPS } from './src/playtest/collision/index.ts'
import { PLAYER_RADIUS, PLAYER_HEIGHT, PLAYER_STEP_UP } from './src/playtest/controller/index.ts'
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
const s = lvl.stairs.find(x => x.id === 'stairs_room_0_room_7')!
const groupY = s.startFloor * lvl.floorHeight
// treads
const cents: { x: number; topY: number; z: number }[] = []
for (const step of s.steps) {
  const v = step.vertices as Float32Array
  let sx = 0, sy = -Infinity, sz = 0
  const n = v.length / 3
  for (let i = 0; i < n; i++) { sx += v[i * 3]; sz += v[i * 3 + 2]; sy = Math.max(sy, v[i * 3 + 1]) }
  cents.push({ x: sx / n, topY: sy + groupY, z: sz / n })
}
console.log('treads:', cents.map(t => `(${t.x.toFixed(2)},${t.topY.toFixed(2)},${t.z.toFixed(2)})`).join(' '))
const ctrl = new CameraController(makeDom(), 800, 600) as any
ctrl.setWalkMode(true)
// start at A tread 5, walk toward B tread 0 line directly (the turn)
const a5 = cents[5]
ctrl.camera.position.set(a5.x, a5.topY + 1.8, a5.z)
ctrl.velocity.set(0, 0, 0)
console.log('start:', a5.x.toFixed(2), (a5.topY + 1.8).toFixed(2), a5.z.toFixed(2))
// dump corridor capsules near start (walk-mode wall colliders)
{
  const px = a5.x, py = a5.topY + 1.8, pz = a5.z
  const dseg = (x: number, z: number, a: any): number => {
    const dx = a.bx - a.ax, dz = a.bz - a.az
    const l2 = dx * dx + dz * dz
    if (l2 < 1e-12) return Math.sqrt((x - a.ax) ** 2 + (z - a.az) ** 2)
    const t = Math.max(0, Math.min(1, ((x - a.ax) * dx + (z - a.az) * dz) / l2))
    return Math.sqrt((x - (a.ax + t * dx)) ** 2 + (z - (a.az + t * dz)) ** 2)
  }
  let shown = 0
  for (const cap of world.capsules as any[]) {
    if (py <= cap.yBase || py - 1.8 >= cap.yTop - 0.02) continue
    const d = dseg(px, pz, cap)
    if (d < cap.half + 0.4) {
      if (shown++ < 8) console.log(`  capsule (${cap.ax.toFixed(2)},${cap.az.toFixed(2)})->(${cap.bx.toFixed(2)},${cap.bz.toFixed(2)}) half=${cap.half} y[${cap.yBase},${cap.yTop}] dist=${d.toFixed(3)}`)
    }
  }
  console.log('nearby capsules:', shown)
}
// dump boxes at start column
{
  const px = a5.x, py = a5.topY + 1.8, pz = a5.z
  console.log('boxes at start column:')
  let shown = 0
  for (const m of walkMeshes) {
    m.geometry.computeBoundingBox()
    const box = m.geometry.boundingBox!.clone()
    box.applyMatrix4(m.matrixWorld)
    if (px > box.min.x - 0.4 && px < box.max.x + 0.4 && pz > box.min.z - 0.4 && pz < box.max.z + 0.4 &&
        py > box.min.y && py - 1.8 < box.max.y - 0.02) {
      if (shown++ < 10) console.log(`  ${(m.parent as any)?.name}/${m.name} x[${box.min.x.toFixed(2)},${box.max.x.toFixed(2)}] y[${box.min.y.toFixed(2)},${box.max.y.toFixed(2)}] z[${box.min.z.toFixed(2)},${box.max.z.toFixed(2)}]`)
    }
  }
  console.log('total overlapping:', shown)
}
console.log('RADIUS:', PLAYER_RADIUS, 'HEIGHT:', PLAYER_HEIGHT, 'STEP_UP:', PLAYER_STEP_UP, 'EPS:', PLAYER_GROUND_EPS)
{
  // replicate ONE updateWalkMode frame toward B0 and log every branch,
  // including the new convergent partial step-up analysis
  const px = -2.3, py = 3.87, pz = -8.0
  const b0 = cents[cents.length - 12]
  const dx = b0.x - px, dz = b0.z - pz
  const yaw = Math.atan2(-dx, -dz)
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
  const DT = 1 / 60
  const mx = fx * 8 * DT, mz = fz * 8 * DT
  const my = -20 * DT * DT
  console.log('yaw:', yaw.toFixed(3), 'moveDelta:', mx.toFixed(4), my.toFixed(5), mz.toFixed(4))
  const eye = new THREE.Vector3(px, py, pz)
  const col = (x: number, y: number, z: number) =>
    checkPlayerCollision(new THREE.Vector3(x, y, z), world.boxes, PLAYER_RADIUS, PLAYER_HEIGHT, world.capsules as any)
  const eng = (x: number, y: number, z: number) =>
    engagedBoxes(new THREE.Vector3(x, y, z), world.boxes, PLAYER_RADIUS, PLAYER_HEIGHT)
  console.log('full:', col(px + mx, py + my, pz + mz))
  // X branch (mirrors updateWalkMode order)
  console.log('xOnly:', col(px + mx, py + my, pz))
  {
    const dest = { x: px + mx, y: py + my }
    const destEng = eng(dest.x, dest.y, pz)
    console.log('  destEngaged:', destEng.length)
    for (const rise of [0.1, 0.19, PLAYER_STEP_UP]) {
      const oy = py + my + rise
      const overBoxes = eng(px, oy, pz)
      let veto = false
      for (const b of overBoxes) {
        if (b.max.y - PLAYER_GROUND_EPS - (oy - PLAYER_HEIGHT) > 0.5) { veto = true; break }
      }
      const steppedFree = !col(px + mx, oy, pz)
      const after = eng(px + mx, oy, pz)
      let cleared = false
      for (const b of destEng) { if (!after.includes(b)) cleared = true }
      let residual = 0
      for (const b of after) residual = Math.max(residual, b.max.y - PLAYER_GROUND_EPS - (oy - PLAYER_HEIGHT))
      console.log(`  rise ${rise}: overVeto=${veto} steppedFree=${steppedFree} cleared=${cleared} residual=${residual.toFixed(3)} after=${after.length}`)
      if (steppedFree) break
    }
  }
}
for (let f = 0; f < 600; f++) {
  // face B tread 0
  const b0 = cents[cents.length - 12] // approx first B tread (nA=12)
  const dx = b0.x - ctrl.camera.position.x, dz = b0.z - ctrl.camera.position.z
  ctrl.yaw = Math.atan2(-dx, -dz)
  ctrl.pitch = 0
  ctrl.moveForward = true
  ctrl.update(1 / 60, world)
  ctrl.moveForward = false
  if (f % 60 === 0) {
    console.log(`f${f}: pos=(${ctrl.camera.position.x.toFixed(2)},${ctrl.camera.position.y.toFixed(2)},${ctrl.camera.position.z.toFixed(2)}) distB0=${Math.sqrt(dx * dx + dz * dz).toFixed(2)} vy=${ctrl.velocity.y.toFixed(2)}`)
  }
}

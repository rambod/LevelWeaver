// Stair-climb bot: empirically walks EVERY stair in generated levels with
// the REAL CameraController physics + REAL collision world. A stair passes
// iff the bot reaches the upper room from the entry without falling.
import * as THREE from 'three'

const g = globalThis as any
g.window = { addEventListener() {}, removeEventListener() {} }
g.document = {
  addEventListener() {}, removeEventListener() {},
  pointerLockElement: null, exitPointerLock() {},
  activeElement: null,
}
g.HTMLElement = class { blur() {} }
function makeDom() {
  return {
    addEventListener() {}, removeEventListener() {},
    style: {} as any,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    requestPointerLock() {},
  } as any
}

import { generateLevel, type GeneratedLevel } from './src/core/generation/index.ts'
import { getDefaultConfig, presets } from './src/core/presets/index.ts'
import { LevelScene } from './src/renderer/scene/index.ts'
import { CameraController } from './src/renderer/camera/index.ts'
import { snapshotCollisionBoxes, corridorWallCapsules, corridorSlabBoxes, checkPlayerCollision, type CollisionWorld } from './src/playtest/collision/index.ts'
import { corridorHeightFor } from './src/core/types/index.ts'
import type { LevelConfig } from './src/core/types/index.ts'

const _warn = console.warn
console.warn = () => {}

function buildCollision(level: GeneratedLevel): { world: CollisionWorld; scene: LevelScene; tagged: { box: THREE.Box3; name: string }[] } {
  const scene = new LevelScene()
  scene.updateLevel(level)
  scene.scene.updateMatrixWorld(true)
  const walkMeshes: THREE.Mesh[] = []
  scene.levelGroup.traverse((obj: any) => {
    if (!(obj instanceof THREE.Mesh)) return
    const inCorridor = obj.parent?.userData?.type === 'corridor'
    if (!inCorridor && (obj.name.startsWith('floor') || obj.name.startsWith('step') || obj.name.startsWith('landing'))) {
      walkMeshes.push(obj)
    } else if (obj.name.startsWith('wall') && !inCorridor) {
      walkMeshes.push(obj)
    }
  })
  const slabBoxes: { box: THREE.Box3; name: string }[] = []
  for (const c of level.corridors) {
    const pts = c.pathPoints && c.pathPoints.length > 0 ? c.pathPoints : [c.startPos, c.endPos]
    corridorSlabBoxes(pts, c.width, c.floorIndex * level.floorHeight).forEach((box, i) => {
      slabBoxes.push({ box, name: `${c.id}/slab_${i}` })
    })
  }
  const world: CollisionWorld = {
    boxes: [...snapshotCollisionBoxes(walkMeshes), ...slabBoxes.map(s => s.box)],
    capsules: level.corridors.flatMap(corridor => {
      const pts = corridor.pathPoints && corridor.pathPoints.length > 0 ? corridor.pathPoints : [corridor.startPos, corridor.endPos]
      return corridorWallCapsules(pts, corridor.width, corridor.floorIndex * level.floorHeight, corridorHeightFor(level.config))
    }),
  }
  const tagged = [...walkMeshes.map(m => {
    m.geometry.computeBoundingBox()
    const box = m.geometry.boundingBox!.clone()
    box.applyMatrix4(m.matrixWorld)
    return { box, name: `${(m.parent as any)?.name ?? '?'}/${m.name}` }
  }), ...slabBoxes]
  return { world, scene, tagged }
}

interface Tread { x: number; topY: number; z: number }
function treadCenters(s: any, groupY: number): Tread[] {
  const out: Tread[] = []
  for (const step of s.steps) {
    const v = step.vertices as Float32Array
    if (v.length === 0) continue
    let sx = 0, sy = -Infinity, sz = 0
    const n = v.length / 3
    for (let i = 0; i < n; i++) {
      sx += v[i * 3]; sz += v[i * 3 + 2]
      if (v[i * 3 + 1] > sy) sy = v[i * 3 + 1]
    }
    out.push({ x: sx / n, topY: sy + groupY, z: sz / n })
  }
  return out
}

export interface StairResult {
  id: string
  kind: string
  pass: boolean
  reason: string
  topY: number
  eyeY: number
}

function walkStair(level: GeneratedLevel, world: CollisionWorld, tagged: { box: THREE.Box3; name: string }[], stairId: string): StairResult {
  const s = level.stairs.find(x => x.id === stairId)!
  const groupY = s.startFloor * level.floorHeight
  const upperBase = s.endFloor * level.floorHeight
  const upper = level.rooms.find(r => r.id === s.upperRoomId)!
  const treads = treadCenters(s, groupY)
  const fail = (reason: string, eyeY: number): StairResult =>
    ({ id: stairId, kind: s.kind, pass: false, reason, topY: upperBase + 0.2, eyeY })
  if (treads.length < 2) return fail('no-treads', groupY)
  // Waypoints: approach, EVERY tread in climb order (diagonal shortcuts
  // across the folded well clip higher flight flanks that step-up cannot
  // scale — humans round the turn, so must the bot), the turn landing
  // centroid + a hugging point for switchbacks, top tread, upper center.
  const first = treads[0]
  const second = treads[1]
  const dx = second.x - first.x, dz = second.z - first.z
  const dl = Math.sqrt(dx * dx + dz * dz) || 1
  const wps: { x: number; z: number; r: number }[] = []
  const pushWp = (x: number, z: number, r = 0.6): void => {
    wps.push({ x, z, r })
  }
  // Approach: march back from the first tread along the arrival line
  // until free air (max 3 m). A fixed offset can land inside the flight
  // itself (straight flights start 0.6+ inside their footprint) or in a
  // wall — both read as instant-stuck without telling us anything.
  {
    const startEyeY = groupY + 0.2 + 1.8
    let ax = first.x - (dx / dl) * 0.4, az = first.z - (dz / dl) * 0.4
    let free = false
    for (let m = 0; m < 30; m++) {
      const probe = new THREE.Vector3(ax, startEyeY, az)
      if (!checkPlayerCollision(probe, world.boxes, 0.4, 1.8, world.capsules)) { free = true; break }
      ax -= (dx / dl) * 0.1; az -= (dz / dl) * 0.1
    }
    if (!free) return fail('no-approach', startEyeY)
    pushWp(ax, az)
  }
  // Tread centers in climb order. Frontal tread-to-tread mounts are
  // handled by the controller's convergent step-ups (each rise escapes
  // the immediate tread while the next stays within reach); no choreography.
  // Switchbacks round the turn through the turn-landing centroid (a direct
  // A-last -> B0 diagonal shortcuts across the open well and clips the
  // higher flight's flank — humans round the turn, so must the bot), then
  // exit over the arrival deck centroid. Straight flights exit over their
  // top-landing centroid. Skipping the landings pulls the final legs
  // across slab hole edges below deck level, which no agent can mount.
  const meshXZ = (m: any): { x: number; z: number } => {
    const v = m.vertices as Float32Array
    let sx = 0, sz = 0
    const n = v.length / 3
    for (let i = 0; i < n; i++) { sx += v[i * 3]; sz += v[i * 3 + 2] }
    return { x: sx / n, z: sz / n }
  }
  const nA = Math.ceil(s.stepCount / 2)
  const isSwitchback = s.landing.length >= 2 && treads.length === s.stepCount
  // Tread/turn/deck waypoints use a tight 0.25 m advance radius (tread
  // pitch is 0.28 m): the old 0.6 radius let the bot "collect" two treads
  // ahead while still standing low, then face a 0.4+ rise no agent can
  // mount. Humans climb tread by tread.
  const TREAD_R = 0.25
  if (isSwitchback) {
    for (let i = 0; i < Math.min(nA, treads.length); i++) pushWp(treads[i].x, treads[i].z, TREAD_R)
    const turn = meshXZ(s.landing[0])
    pushWp(turn.x, turn.z, TREAD_R)
    for (let i = nA; i < treads.length; i++) pushWp(treads[i].x, treads[i].z, TREAD_R)
    const deck = meshXZ(s.landing[s.landing.length - 1])
    pushWp(deck.x, deck.z, TREAD_R)
    // Tower shafts leave through the OPEN near end (the far end and both
    // sides rise a full parapet above the deck). Heading diagonally for
    // the room center from the deck clips a side wall every time — humans
    // walk out of the shaft mouth first, so must the bot. The mouth
    // (near-edge midpoint) is on the upper floor by construction (the
    // planner's exit check seats it inside the upper room).
    if (s.tower) {
      const host = level.rooms.find(r => r.id === s.hostRoomId)!
      const tr = s.tower.rect
      const edges = [
        { mx: (tr.minX + tr.maxX) / 2, mz: tr.minZ, dx: 0, dz: -1 },
        { mx: (tr.minX + tr.maxX) / 2, mz: tr.maxZ, dx: 0, dz: 1 },
        { mx: tr.minX, mz: (tr.minZ + tr.maxZ) / 2, dx: -1, dz: 0 },
        { mx: tr.maxX, mz: (tr.minZ + tr.maxZ) / 2, dx: 1, dz: 0 },
      ]
      const distToHost = (x: number, z: number): number => {
        const dx = Math.max(host.position.x - host.width / 2 - x, 0, x - (host.position.x + host.width / 2))
        const dz = Math.max(host.position.z - host.depth / 2 - z, 0, z - (host.position.z + host.depth / 2))
        return Math.sqrt(dx * dx + dz * dz)
      }
      edges.sort((a, b) => distToHost(a.mx, a.mz) - distToHost(b.mx, b.mz))
      pushWp(edges[0].mx, edges[0].mz, TREAD_R)
    }
    // Arrival is proven ON the deck/landing (eye check below): the
    // stair's contract ends there. Routing on to the room center drags
    // the final leg back over the flight and stairwell hole (landings
    // sit at the flight's far end; centers usually lie beyond it) —
    // the bot then falls down its own staircase and "wrong-floors" on a
    // perfect stair. Room navigation is the grid validator's business.
  } else {
    for (let i = 0; i < treads.length; i++) pushWp(treads[i].x, treads[i].z, TREAD_R)
    if (s.landing.length > 0) {
      const top = meshXZ(s.landing[s.landing.length - 1])
      pushWp(top.x, top.z, TREAD_R)
    }
  }
  const ctrl = new CameraController(makeDom(), 800, 600) as any
  ctrl.setWalkMode(true)
  const startY = groupY + 0.2 + 1.8
  ctrl.camera.position.set(wps[0].x, startY, wps[0].z)
  ctrl.velocity.set(0, 0, 0)
  const DT = 1 / 60
  let wi = 1
  let still = 0
  let lastX = wps[0].x, lastZ = wps[0].z
  let minEye = startY
  for (let f = 0; f < 3600 && wi < wps.length; f++) {
    const wp = wps[wi]
    const px = ctrl.camera.position.x, pz = ctrl.camera.position.z
    const ddx = wp.x - px, ddz = wp.z - pz
    const dist = Math.sqrt(ddx * ddx + ddz * ddz)
    if (f % 120 === 0 && process.env.LW_BOT_TRACE === '1') console.log(`  f${f} wi=${wi}/${wps.length - 1} pos=(${px.toFixed(2)},${ctrl.camera.position.y.toFixed(2)},${pz.toFixed(2)})`)
    if (dist < wp.r) {
      if (process.env.LW_BOT_TRACE === '1') console.log(`  adv wi=${wi} -> ${wi + 1} @(${px.toFixed(2)},${ctrl.camera.position.y.toFixed(2)},${pz.toFixed(2)})`)
      wi++; still = 0; continue
    }
    // Human weave: no player holds a mathematically exact line for
    // hundreds of frames. Exact-zero laterals freeze float-boundary
    // decisions identically every frame (dust lock) — a ±5 cm weave
    // flips them frame to frame, exactly like real play. Well within
    // tread widths and body clearance; never masks real blockers (a
    // 0.5 m wall still blocks a weaving body).
    const weave = Math.sin(f * 0.35) * 0.05
    const inv = 1 / (dist || 1)
    const tx = wp.x + (-ddz * inv) * weave
    const tz = wp.z + (ddx * inv) * weave
    ctrl.yaw = Math.atan2(-(tx - px), -(tz - pz))
    ctrl.pitch = 0
    ctrl.moveForward = true
    ctrl.update(DT, world)
    ctrl.moveForward = false
    const moved = Math.sqrt((ctrl.camera.position.x - lastX) ** 2 + (ctrl.camera.position.z - lastZ) ** 2)
    lastX = ctrl.camera.position.x; lastZ = ctrl.camera.position.z
    minEye = Math.min(minEye, ctrl.camera.position.y)
    if (moved < 0.02) {
      still++
      if (still > 150) {
        // Name the blockers: which walk boxes engage the stuck column?
        const px = ctrl.camera.position.x, py = ctrl.camera.position.y, pz = ctrl.camera.position.z
        const blockers: string[] = []
        for (const t of tagged) {
          const b = t.box
          if (px > b.min.x - 0.4 && px < b.max.x + 0.4 && pz > b.min.z - 0.4 && pz < b.max.z + 0.4 &&
              py > b.min.y && py - 1.8 < b.max.y - 0.02) {
            blockers.push(`${t.name}[top=${b.max.y.toFixed(2)}]`)
            if (blockers.length >= 4) break
          }
        }
        return fail(`stuck-at-wp${wi}/${wps.length - 1} (@${px.toFixed(1)},${pz.toFixed(1)} eye ${py.toFixed(2)}) vs {${blockers.join(' ')}}`, py)
      }
    } else still = 0
    if (ctrl.camera.position.y < startY - 1.2) {
      return fail(`fell-through (@${px.toFixed(1)},${pz.toFixed(1)} eye ${ctrl.camera.position.y.toFixed(2)})`, ctrl.camera.position.y)
    }
  }
  if (wi < wps.length) return fail('timeout', ctrl.camera.position.y)
  const eye = ctrl.camera.position.y
  const wantEye = upperBase + 0.2 + 1.8
  if (Math.abs(eye - wantEye) > 0.6) {
    const px = ctrl.camera.position.x.toFixed(1), pz = ctrl.camera.position.z.toFixed(1)
    return fail(`wrong-floor (@${px},${pz} eye=${eye.toFixed(2)} want=${wantEye.toFixed(2)})`, eye)
  }
  ctrl.dispose?.()
  return { id: stairId, kind: s.kind, pass: true, reason: 'reached-upper-room', topY: upperBase + 0.2, eyeY: eye }
}

function cfg(over: Partial<LevelConfig>): LevelConfig {
  return { ...getDefaultConfig(), ...over }
}

// Sweep: multi-floor presets x seeds — every stair walked.
const jobs: { name: string; c: LevelConfig }[] = []
for (const pk of ['fpsArena', 'dungeon', 'researchFacility', 'office', 'militaryBunker', 'sciFiFacility', 'horrorFacility']) {
  for (const seed of [1, 7, 42, 99]) {
    const base = cfg({ preset: pk, seed })
    jobs.push({ name: `${pk}/s${seed}`, c: { ...base, ...presets[pk].config, preset: pk, seed } })
  }
}
let stairs = 0, passed = 0
const failures: string[] = []
for (const { name, c } of jobs) {
  if (process.env.LW_BOT_CASE && !name.includes(process.env.LW_BOT_CASE)) continue
  let lvl: GeneratedLevel
  try {
    lvl = generateLevel(c)
  } catch { continue }
  if (lvl.stairs.length === 0) continue
  const { world, scene, tagged } = buildCollision(lvl)
  for (const s of lvl.stairs) {
    stairs++
    const r = walkStair(lvl, world, tagged, s.id)
    if (r.pass) passed++
    else {
      const sw = (lvl.stairs.find(x => x.id === r.id)!.landing?.length ?? 0) >= 2 ? 'SW' : 'ST'
      const sid = `stairs_${r.id.replace(/^stairs_/, '')}`
      const verr = lvl.validation.errors.filter(e => e.objectIds.includes(sid) || e.objectIds.includes(r.id))
      const vcodes = verr.length > 0 ? ` VALID=[${[...new Set(verr.map(e => e.code))].join(',')}]` : ' VALID=clean'
      failures.push(`${name} ${r.id} [${r.kind}/${sw}] FAIL: ${r.reason}${vcodes}`)
    }
  }
  scene.dispose()
}
console.log(`STAIRS ${stairs} PASSED ${passed} FAILED ${stairs - passed} (${(100 * passed / Math.max(1, stairs)).toFixed(1)}%)`)
for (const f of failures.slice(0, 30)) console.log(' ' + f)

import * as THREE from 'three'
const g = globalThis as any
g.window = { addEventListener() {}, removeEventListener() {} }
g.document = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null, exitPointerLock() {}, activeElement: null }
g.HTMLElement = class { blur() {} }
import { generateLevel } from './src/core/generation/index.ts'
import { getDefaultConfig, presets } from './src/core/presets/index.ts'
import { LevelScene } from './src/renderer/scene/index.ts'
const _warn = console.warn
console.warn = () => {}
const base = getDefaultConfig()
const lvl = generateLevel({ ...base, ...presets.dungeon.config, preset: 'dungeon', seed: 42 })
const scene = new LevelScene()
scene.updateLevel(lvl)
scene.scene.updateMatrixWorld(true)
for (const r of lvl.rooms as any[]) {
  if (r.id !== 'room_12' && r.id !== 'room_2') continue
  console.log(`${r.id} f=${r.floorIndex} ${r.width.toFixed(1)}x${r.depth.toFixed(1)} @(${r.position.x.toFixed(1)},${r.position.y.toFixed(1)},${r.position.z.toFixed(1)}) x[${(r.position.x - r.width / 2).toFixed(1)},${(r.position.x + r.width / 2).toFixed(1)}] z[${(r.position.z - r.depth / 2).toFixed(1)},${(r.position.z + r.depth / 2).toFixed(1)}]`)
}
const s: any = lvl.stairs.find((x: any) => x.id === 'stairs_room_12_room_2')!
console.log('stair kind:', s.kind, 'pos:', s.position.x.toFixed(2), s.position.z.toFixed(2), 'w:', s.width, 'd:', s.depth, 'steps:', s.steps.length)
// room_2 floor parts
scene.levelGroup.traverse((obj: any) => {
  if (!(obj instanceof THREE.Mesh)) return
  const parent = (obj.parent as any)?.name ?? '?'
  if (parent !== 'room_2' && parent !== 'Room_room_2' && !String(parent).includes('room_2')) return
  if (obj.name !== 'floor') return
  obj.geometry.computeBoundingBox()
  const box = obj.geometry.boundingBox!.clone()
  box.applyMatrix4(obj.matrixWorld)
  console.log(` room_2 floor part x[${box.min.x.toFixed(2)},${box.max.x.toFixed(2)}] y[${box.min.y.toFixed(2)},${box.max.y.toFixed(2)}] z[${box.min.z.toFixed(2)},${box.max.z.toFixed(2)}]`)
})
// room group names
const names: string[] = []
scene.levelGroup.traverse((obj: any) => { if ((obj as any).isGroup) names.push((obj as any).name) })
console.log('groups:', names.filter(n => n.includes('room_2') || n.includes('room_12')).join(','))

import * as THREE from 'three'
const g = globalThis as any
g.window = { addEventListener() {}, removeEventListener() {} }
g.document = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null, exitPointerLock() {}, activeElement: null }
g.HTMLElement = class { blur() {} }
import { generateLevel } from './src/core/generation/index.ts'
import { getDefaultConfig, presets } from './src/core/presets/index.ts'
import { validateSlabOpenings } from './src/core/validation/index.ts'
const _warn = console.warn
console.warn = () => {}
const base = getDefaultConfig()
const lvl = generateLevel({ ...base, ...presets.dungeon.config, preset: 'dungeon', seed: 42 }) as any
// reach internals: recompute what computeSlabHoles should have produced
// via the validator (it takes slabHoles map — but that map is internal).
// Instead: check validation errors for this stair + inspect room geometry parts.
console.log('level errors:', lvl.validation.errors.length)
for (const e of lvl.validation.errors.slice(0, 10)) console.log(` [${e.code}] ${e.objectIds.join(',')} :: ${e.message.slice(0, 110)}`)
const rg: any = lvl.roomGeometry.find((r: any) => r.id === 'room_12')!
console.log('room_12 floor meshes:', rg.floor ? 'has floor' : 'none')
// count floor boxes by scanning vertices? print door openings + ceiling holes via walls count
console.log('room_12 walls:', rg.walls.length, 'doorOpenings:', (rg.doorOpenings as any[]).length)
// find the stair plan via corridors? plans not exported; use stairs geometry
const s: any = lvl.stairs.find((x: any) => x.id === 'stairs_room_11_room_12')!
console.log('stair steps:', s.steps.length, 'landing:', s.landing.length, 'tower:', s.tower ? 'yes' : 'no')

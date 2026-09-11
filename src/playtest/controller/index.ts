import * as THREE from 'three'
import type { Room } from '@/core/types'

// First-person playtest tuning (LEVELWEAVER.md section 11). This is a
// scale-check tool, not a gameplay system: fixed eye height, simple
// arcade movement, no abilities.
export const PLAYER_HEIGHT = 1.8
export const PLAYER_RADIUS = 0.4
export const PLAYER_WALK_SPEED = 8
export const PLAYER_SPRINT_MULTIPLIER = 2
export const PLAYER_JUMP_VELOCITY = 6
export const PLAYER_GRAVITY = 20
export const MOUSE_SENSITIVITY = 0.0022

// Eye position for spawning in a room: floor-slab top + full body height.
// `position.y` is the camera (eye) location, matching the collision model
// in `@/playtest/collision` (body spans eye - height .. eye).
export function spawnEyePosition(room: Room): THREE.Vector3 {
  return new THREE.Vector3(room.position.x, room.position.y + 0.2 + PLAYER_HEIGHT, room.position.z)
}

export function findSpawnRoom(rooms: Room[]): Room | undefined {
  return rooms.find(r => r.type === 'spawn') ?? rooms[0]
}

import * as THREE from 'three'
import { checkPlayerCollision } from '@/playtest/collision'
import {
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_WALK_SPEED,
  PLAYER_SPRINT_MULTIPLIER,
  PLAYER_JUMP_VELOCITY,
  PLAYER_GRAVITY,
  PLAYER_STEP_UP,
  MOUSE_SENSITIVITY,
} from '@/playtest/controller'

export class CameraController {
  public camera: THREE.PerspectiveCamera
  private controls: OrbitControlsState
  private domElement: HTMLElement
  private isPointerLocked = false
  private walkMode = false

  // Walk mode state
  private velocity = new THREE.Vector3()
  private direction = new THREE.Vector3()
  private moveForward = false
  private moveBackward = false
  private moveLeft = false
  private moveRight = false
  private canJump = false
  private playerHeight = PLAYER_HEIGHT
  private playerSpeed = PLAYER_WALK_SPEED
  private sprintMultiplier = PLAYER_SPRINT_MULTIPLIER
  // First-person look orientation (yaw around Y, pitch around X)
  private yaw = 0
  private pitch = 0

  // Stored bound listeners so removeEventListener actually removes them.
  private boundOnMouseDown: (e: MouseEvent) => void
  private boundOnWheel: (e: WheelEvent) => void
  private boundOnKeyDown: (e: KeyboardEvent) => void
  private boundOnKeyUp: (e: KeyboardEvent) => void
  private boundOnClick: () => void
  private boundOnPointerLockChange: () => void
  private boundOnMouseMove: (e: MouseEvent) => void
  private boundOnOrbitMouseMove: (e: MouseEvent) => void
  private boundOnOrbitMouseUp: () => void
  private boundOnContextMenu: (e: Event) => void

  constructor(domElement: HTMLElement, width: number, height: number) {
    this.domElement = domElement

    this.camera = new THREE.PerspectiveCamera(70, width / height, 0.1, 1000)
    this.camera.position.set(20, 20, 20)
    this.camera.lookAt(0, 2, 0)

    this.controls = {
      target: new THREE.Vector3(0, 2, 0),
      distance: 30,
      phi: Math.PI / 4,
      theta: Math.PI / 4,
      minDistance: 5,
      maxDistance: 100,
      minPolarAngle: 0.1,
      maxPolarAngle: Math.PI - 0.1,
      enablePan: true,
      panOffset: new THREE.Vector3(),
    }

    this.boundOnMouseDown = this.onMouseDown.bind(this)
    this.boundOnWheel = this.onWheel.bind(this)
    this.boundOnKeyDown = this.onKeyDown.bind(this)
    this.boundOnKeyUp = this.onKeyUp.bind(this)
    this.boundOnClick = this.requestPointerLock.bind(this)
    this.boundOnPointerLockChange = this.onPointerLockChange.bind(this)
    this.boundOnMouseMove = this.onMouseMove.bind(this)
    this.boundOnOrbitMouseMove = this.onOrbitMouseMove.bind(this)
    this.boundOnOrbitMouseUp = this.onOrbitMouseUp.bind(this)
    this.boundOnContextMenu = (e: Event) => e.preventDefault()

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    // Orbit controls (mouse)
    this.domElement.addEventListener('mousedown', this.boundOnMouseDown)
    this.domElement.addEventListener('wheel', this.boundOnWheel, { passive: false })
    this.domElement.addEventListener('contextmenu', this.boundOnContextMenu)

    // Keyboard for walk mode
    window.addEventListener('keydown', this.boundOnKeyDown)
    window.addEventListener('keyup', this.boundOnKeyUp)

    // Pointer lock for walk mode
    this.domElement.addEventListener('click', this.boundOnClick)
    document.addEventListener('pointerlockchange', this.boundOnPointerLockChange)
    document.addEventListener('mousemove', this.boundOnMouseMove)
  }

  // Orbit Controls
  private onMouseDown(event: MouseEvent): void {
    if (this.walkMode || event.button !== 0) return

    const rect = this.domElement.getBoundingClientRect()
    this.controls.panOffset.set(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1,
      0
    )

    document.addEventListener('mousemove', this.boundOnOrbitMouseMove)
    document.addEventListener('mouseup', this.boundOnOrbitMouseUp)
  }

  private onOrbitMouseMove(event: MouseEvent): void {
    if (this.walkMode) return

    const rect = this.domElement.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width * 2 - 1
    const y = -(event.clientY - rect.top) / rect.height * 2 + 1

    const dx = x - this.controls.panOffset.x
    const dy = y - this.controls.panOffset.y

    if (event.buttons === 1) { // Left click - orbit
      this.controls.theta -= dx * 2
      this.controls.phi = THREE.MathUtils.clamp(
        this.controls.phi - dy * 2,
        this.controls.minPolarAngle,
        this.controls.maxPolarAngle
      )
    } else if (event.buttons === 4) { // Middle click - pan
      this.panCamera(dx, dy)
    }

    this.controls.panOffset.set(x, y, 0)
    this.updateCamera()
  }

  private onOrbitMouseUp(): void {
    document.removeEventListener('mousemove', this.boundOnOrbitMouseMove)
    document.removeEventListener('mouseup', this.boundOnOrbitMouseUp)
  }

  private onWheel(event: WheelEvent): void {
    if (this.walkMode) return
    event.preventDefault()

    const factor = event.deltaY > 0 ? 1.1 : 0.9
    this.controls.distance = THREE.MathUtils.clamp(
      this.controls.distance * factor,
      this.controls.minDistance,
      this.controls.maxDistance
    )
    this.updateCamera()
  }

  private panCamera(dx: number, dy: number): void {
    // Pan along the camera's local right (X) and up (Y) axes.
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1)
    right.multiplyScalar(-dx * this.controls.distance * 0.5)
    up.multiplyScalar(dy * this.controls.distance * 0.5)
    this.controls.target.add(right).add(up)
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.isPointerLocked || !this.walkMode) return

    const movementX = event.movementX || 0
    const movementY = event.movementY || 0

    // First-person look: yaw + pitch applied to the camera quaternion.
    this.yaw -= movementX * MOUSE_SENSITIVITY
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - movementY * MOUSE_SENSITIVITY,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05
    )
    this.applyLookDirection()
  }

  private applyLookDirection(): void {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
  }

  private requestPointerLock(): void {
    if (this.walkMode && !this.isPointerLocked) {
      try {
        const result = this.domElement.requestPointerLock() as unknown as Promise<void> | undefined
        if (result && typeof result.catch === 'function') {
          result.catch(() => { /* pointer lock declined; mouse-look stays off */ })
        }
      } catch {
        /* pointer lock unavailable; mouse-look stays off */
      }
    }
  }

  private onPointerLockChange(): void {
    this.isPointerLocked = document.pointerLockElement === this.domElement
  }

  // Walk mode keyboard controls
  private onKeyDown(event: KeyboardEvent): void {
    if (!this.walkMode) return

    switch (event.code) {
      case 'KeyW': this.moveForward = true; break
      case 'KeyS': this.moveBackward = true; break
      case 'KeyA': this.moveLeft = true; break
      case 'KeyD': this.moveRight = true; break
      case 'Space':
        if (this.canJump) {
          this.velocity.y = PLAYER_JUMP_VELOCITY
          this.canJump = false
        }
        break
      case 'ShiftLeft': this.playerSpeed = PLAYER_WALK_SPEED * this.sprintMultiplier; break
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (!this.walkMode) return

    switch (event.code) {
      case 'KeyW': this.moveForward = false; break
      case 'KeyS': this.moveBackward = false; break
      case 'KeyA': this.moveLeft = false; break
      case 'KeyD': this.moveRight = false; break
      case 'ShiftLeft': this.playerSpeed = PLAYER_WALK_SPEED; break
    }
  }

  public setWalkMode(enabled: boolean): void {
    this.walkMode = enabled
    if (enabled) {
      // Seed first-person orientation from the current camera direction
      // so the view doesn't snap when entering walk mode.
      const dir = new THREE.Vector3()
      this.camera.getWorldDirection(dir)
      this.yaw = Math.atan2(-dir.x, -dir.z)
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))
      this.applyLookDirection()
      this.velocity.set(0, 0, 0)
      this.domElement.style.cursor = 'none'
      this.requestPointerLock()
    } else {
      this.domElement.style.cursor = 'default'
      if (document.pointerLockElement === this.domElement) {
        document.exitPointerLock()
      }
      this.moveForward = this.moveBackward = this.moveLeft = this.moveRight = false
    }
  }

  /** Place the player at a world position (e.g. the spawn room floor). */
  public placeAt(position: THREE.Vector3, yaw?: number): void {
    this.camera.position.copy(position)
    if (yaw !== undefined) this.yaw = yaw
    this.pitch = 0
    this.velocity.set(0, 0, 0)
    this.canJump = true
    this.applyLookDirection()
    this.controls.target.copy(position)
  }

  public isWalkMode(): boolean {
    return this.walkMode
  }

  public update(deltaTime: number, collisionBoxes: THREE.Box3[] = []): void {
    // Clamp huge deltas (tab switch, first frame) for stable physics.
    const dt = Math.min(Math.max(deltaTime, 0), 0.05)
    if (this.walkMode) {
      this.updateWalkMode(dt, collisionBoxes)
    } else {
      this.updateOrbitMode()
    }
  }

  private updateWalkMode(deltaTime: number, collisionBoxes: THREE.Box3[]): void {
    // Calculate movement direction
    this.direction.set(0, 0, 0)
    if (this.moveForward) this.direction.z -= 1
    if (this.moveBackward) this.direction.z += 1
    if (this.moveLeft) this.direction.x -= 1
    if (this.moveRight) this.direction.x += 1
    this.direction.normalize()

    // Movement basis from yaw only (pitch must not affect walk speed).
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    const right = new THREE.Vector3(-forward.z, 0, forward.x)

    const moveDelta = new THREE.Vector3()
    moveDelta.addScaledVector(forward, -this.direction.z * this.playerSpeed * deltaTime)
    moveDelta.addScaledVector(right, this.direction.x * this.playerSpeed * deltaTime)

    // Gravity
    this.velocity.y -= PLAYER_GRAVITY * deltaTime
    moveDelta.y = this.velocity.y * deltaTime

    // Collision detection against precomputed world-space boxes.
    const newPosition = this.camera.position.clone().add(moveDelta)
    if (!this.checkCollision(newPosition, collisionBoxes)) {
      this.camera.position.copy(newPosition)
    } else {
      // Try X only
      const xPos = this.camera.position.clone()
      xPos.x = newPosition.x
      if (!this.checkCollision(xPos, collisionBoxes)) {
        this.camera.position.x = newPosition.x
      } else {
        // Step-up (X): rise minimally and retry X alone, so stair treads
        // and thresholds climb without diagonal pops or bobbing.
        this.tryStepUp('x', newPosition.x, collisionBoxes)
      }

      // Try Z only
      const zPos = this.camera.position.clone()
      zPos.z = newPosition.z
      if (!this.checkCollision(zPos, collisionBoxes)) {
        this.camera.position.z = newPosition.z
      } else {
        // Step-up (Z): same, axis-separated.
        this.tryStepUp('z', newPosition.z, collisionBoxes)
      }

      // Try Y only
      const yPos = this.camera.position.clone()
      yPos.y = newPosition.y
      if (!this.checkCollision(yPos, collisionBoxes)) {
        this.camera.position.y = newPosition.y
        this.canJump = this.velocity.y <= 0
      } else {
        this.velocity.y = 0
        this.canJump = true
      }
    }

    // Keep the player supported by geometry: if we somehow fell out of the
    // level (e.g. a gap in collision), stop falling instead of dropping
    // forever. No absolute height clamp here: upper floors live above y=1.8.
    if (this.camera.position.y < -10) {
      this.camera.position.y = -10
      this.velocity.y = 0
      this.canJump = true
    }

    this.controls.target.copy(this.camera.position)
    this.applyLookDirection()
  }

  private checkCollision(position: THREE.Vector3, collisionBoxes: THREE.Box3[]): boolean {
    return checkPlayerCollision(position, collisionBoxes, PLAYER_RADIUS, this.playerHeight)
  }

  // Step-up for one horizontal axis: rise by the smallest increment that
  // frees the move (0.12/0.24/0.35m), so climbing stairs settles onto each
  // tread instead of bobbing a full step-up every frame. Settles velocity
  // so gravity doesn't slam the player back down between treads.
  private tryStepUp(axis: 'x' | 'z', target: number, collisionBoxes: THREE.Box3[]): void {
    for (const rise of [0.12, 0.24, PLAYER_STEP_UP]) {
      const over = this.camera.position.clone()
      over.y += rise
      if (this.checkCollision(over, collisionBoxes)) continue
      const stepped = over.clone()
      if (axis === 'x') stepped.x = target
      else stepped.z = target
      if (!this.checkCollision(stepped, collisionBoxes)) {
        if (axis === 'x') this.camera.position.x = target
        else this.camera.position.z = target
        this.camera.position.y = over.y
        this.velocity.y = 0
        this.canJump = true
        return
      }
    }
  }

  private updateOrbitMode(): void {
    this.updateCamera()
  }

  private updateCamera(): void {
    const { target, distance, phi, theta } = this.controls

    if (this.walkMode) {
      // In walk mode, camera is first-person
      return
    }

    // Orbit camera position
    const sinPhi = Math.sin(phi)
    this.camera.position.x = target.x + distance * sinPhi * Math.sin(theta)
    this.camera.position.y = target.y + distance * Math.cos(phi)
    this.camera.position.z = target.z + distance * sinPhi * Math.cos(theta)

    this.camera.lookAt(target)
  }

  public reset(): void {
    this.controls.target.set(0, 2, 0)
    this.controls.distance = 30
    this.controls.phi = Math.PI / 4
    this.controls.theta = Math.PI / 4
    this.updateCamera()
  }

  public focusOnBounds(box: THREE.Box3): void {
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)

    this.controls.target.copy(center)
    this.controls.distance = maxDim * 1.5
    this.updateCamera()
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  public dispose(): void {
    this.domElement.removeEventListener('mousedown', this.boundOnMouseDown)
    this.domElement.removeEventListener('wheel', this.boundOnWheel)
    this.domElement.removeEventListener('contextmenu', this.boundOnContextMenu)
    window.removeEventListener('keydown', this.boundOnKeyDown)
    window.removeEventListener('keyup', this.boundOnKeyUp)
    this.domElement.removeEventListener('click', this.boundOnClick)
    document.removeEventListener('pointerlockchange', this.boundOnPointerLockChange)
    document.removeEventListener('mousemove', this.boundOnMouseMove)
    document.removeEventListener('mousemove', this.boundOnOrbitMouseMove)
    document.removeEventListener('mouseup', this.boundOnOrbitMouseUp)
  }
}

interface OrbitControlsState {
  target: THREE.Vector3
  distance: number
  phi: number
  theta: number
  minDistance: number
  maxDistance: number
  minPolarAngle: number
  maxPolarAngle: number
  enablePan: boolean
  panOffset: THREE.Vector3
}

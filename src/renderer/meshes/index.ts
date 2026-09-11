import * as THREE from 'three'
import type { MeshData } from '@/core/types'

// Single place that turns engine-independent MeshData into Three.js
// geometry. Used by both the preview scene and the GLB exporter so the
// two can't drift apart (LEVELWEAVER.md: renderer is only the preview
// layer over the same geometry description).
export function createBufferGeometry(geo: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(geo.vertices, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(geo.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(geo.uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(geo.indices, 1))
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}

export function resolveMaterialIndex(geo: MeshData, fallback: number): number {
  return geo.materialIndex >= 0 ? geo.materialIndex : fallback
}

export function isEmptyMesh(geo: MeshData): boolean {
  return geo.vertices.length === 0
}

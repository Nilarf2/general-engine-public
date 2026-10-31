import {
  BoxGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry, Group,
  Mesh, MeshPhysicalMaterial, SphereGeometry, type BufferGeometry, type Scene,
} from 'three/webgpu';
import type { World } from '../core/index.js';
import type { Visual } from '../core/types.js';

export type WorldSceneChange = 'none' | 'transforms' | 'scene';
export interface WorldSceneBridge {
  readonly group: Group;
  getObject(id: string): Mesh | undefined;
  /** Synchronize definitions and transforms; unchanged worlds preserve accumulated samples. */
  sync(): WorldSceneChange;
  dispose(): void;
}

type VisualSignature = {
  shape: Visual['shape']; sizeX: number; sizeY: number; sizeZ: number;
  color: string | undefined; roughness: number | undefined; metalness: number | undefined;
  emissive: string | undefined; emissiveIntensity: number | undefined;
  transmission: number | undefined; ior: number | undefined; batch: boolean | undefined;
  castShadow: boolean | undefined;
};

function sameVisual(a: VisualSignature, b: Visual): boolean {
  return a.shape === b.shape && a.sizeX === b.size[0] && a.sizeY === b.size[1] && a.sizeZ === b.size[2] &&
    a.color === b.color && a.roughness === b.roughness && a.metalness === b.metalness &&
    a.emissive === b.emissive && a.emissiveIntensity === b.emissiveIntensity &&
    a.transmission === b.transmission && a.ior === b.ior && a.batch === b.batch && a.castShadow === b.castShadow;
}

function visualSignature(visual: Visual): VisualSignature {
  return { shape: visual.shape, sizeX: visual.size[0], sizeY: visual.size[1], sizeZ: visual.size[2],
    color: visual.color, roughness: visual.roughness, metalness: visual.metalness, emissive: visual.emissive,
    emissiveIntensity: visual.emissiveIntensity, transmission: visual.transmission, ior: visual.ior,
    batch: visual.batch, castShadow: visual.castShadow };
}

/** Owns only the generated group, geometries and standard physical materials. */
export function createWorldSceneBridge(world: World, scene: Scene, options: { segments?: number } = {}): WorldSceneBridge {
  const segments = options.segments ?? 32;
  if (!Number.isSafeInteger(segments) || segments < 8 || segments > 256) throw new RangeError('segments must be an integer from 8 to 256');
  const group = new Group(); group.name = 'General Engine world'; scene.add(group);
  const geometries = new Map<string, BufferGeometry>();
  const materials = new Map<string, MeshPhysicalMaterial>();
  const records = new Map<string, { mesh: Mesh; signature: VisualSignature; seen: number }>();
  let syncVersion = 0;
  let disposed = false;

  function geometryFor(visual: Visual): BufferGeometry {
    const key = `${visual.shape}:${visual.size.join(',')}`;
    let geometry = geometries.get(key);
    if (!geometry) {
      const [x, y, z] = visual.size;
      switch (visual.shape) {
        case 'box': geometry = new BoxGeometry(x, y, z); break;
        case 'sphere': geometry = new SphereGeometry(x / 2, segments, Math.ceil(segments / 2)); break;
        case 'capsule': geometry = new CapsuleGeometry(x / 2, Math.max(0, y - x), Math.ceil(segments / 4), segments); break;
        case 'cylinder': geometry = new CylinderGeometry(x / 2, x / 2, y, segments); geometry.scale(1, 1, z / x); break;
        case 'cone': geometry = new ConeGeometry(x / 2, y, segments); geometry.scale(1, 1, z / x); break;
      }
      geometries.set(key, geometry);
    }
    return geometry;
  }
  function materialFor(visual: Visual): MeshPhysicalMaterial {
    const parameters = {
      color: visual.color ?? '#e7edf0', roughness: visual.roughness ?? 0.75,
      metalness: visual.metalness ?? 0, emissive: visual.emissive ?? '#000000',
      emissiveIntensity: visual.emissiveIntensity ?? 0, transmission: visual.transmission ?? 0,
      ior: visual.ior ?? 1.5, thickness: visual.transmission ? visual.size[2] : 0,
    };
    const key = JSON.stringify(parameters);
    let material = materials.get(key);
    if (!material) { material = new MeshPhysicalMaterial(parameters); materials.set(key, material); }
    return material;
  }
  function sync(): WorldSceneChange {
    if (disposed) throw new Error('World scene bridge disposed');
    let change: WorldSceneChange = 'none';
    const version = ++syncVersion;
    for (const entity of world.entities.values()) {
      if (!entity.visual) continue;
      let record = records.get(entity.id);
      if (!record || !sameVisual(record.signature, entity.visual)) {
        if (record) group.remove(record.mesh);
        const mesh = new Mesh(geometryFor(entity.visual), materialFor(entity.visual));
        mesh.name = entity.id; mesh.userData.entityId = entity.id;
        mesh.castShadow = entity.visual.castShadow !== false; mesh.visibleToShadowRays = mesh.castShadow; mesh.receiveShadow = true;
        group.add(mesh); record = { mesh, signature: visualSignature(entity.visual), seen: version }; records.set(entity.id, record); change = 'scene';
      }
      record.seen = version;
      const mesh = record.mesh;
      if (entity.position[0] !== mesh.position.x || entity.position[1] !== mesh.position.y || entity.position[2] !== mesh.position.z ||
          entity.rotation[0] !== mesh.quaternion.x || entity.rotation[1] !== mesh.quaternion.y || entity.rotation[2] !== mesh.quaternion.z || entity.rotation[3] !== mesh.quaternion.w ||
          entity.scale[0] !== mesh.scale.x || entity.scale[1] !== mesh.scale.y || entity.scale[2] !== mesh.scale.z) {
        mesh.position.fromArray(entity.position); mesh.quaternion.fromArray(entity.rotation); mesh.scale.fromArray(entity.scale);
        if (change === 'none') change = 'transforms';
      }
    }
    for (const [id, record] of records) if (record.seen !== version) { group.remove(record.mesh); records.delete(id); change = 'scene'; }
    if (change === 'scene') {
      const usedGeometry = new Set([...records.values()].map(record => record.mesh.geometry));
      const usedMaterial = new Set([...records.values()].map(record => record.mesh.material));
      for (const [key, value] of geometries) if (!usedGeometry.has(value)) { value.dispose(); geometries.delete(key); }
      for (const [key, value] of materials) if (!usedMaterial.has(value)) { value.dispose(); materials.delete(key); }
    }
    if (change !== 'none') group.updateMatrixWorld(true);
    return change;
  }
  return {
    group, sync, getObject: id => records.get(id)?.mesh,
    dispose() {
      if (disposed) return; disposed = true; group.removeFromParent(); group.clear(); records.clear();
      for (const geometry of geometries.values()) geometry.dispose();
      for (const material of materials.values()) material.dispose();
      geometries.clear(); materials.clear();
    },
  };
}

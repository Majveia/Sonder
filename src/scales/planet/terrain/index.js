// PLACEHOLDER terrain — one coarse displaced sphere. The real LOD terrain system replaces this file.
import * as THREE from 'three';
export default class Terrain {
  constructor(planet) { this.planet = planet; }
  async init() {
    const { model, R, desc, shared, scene } = this.planet;
    const geo = new THREE.IcosahedronGeometry(1, 96);
    const pos = geo.attributes.position; const col = new Float32Array(pos.count * 3);
    const pal = desc.palette; const c = (k) => new THREE.Color(pal[k] || '#888888');
    const sand = c('sand'), grass = c('grass'), rock = c('rock'), snow = c('snow'), deep = new THREE.Color(desc.ocean ? desc.ocean.deep : pal.rockDark);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i); const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
      const h = model.height(x, y, z, 150);
      const r = R + (model.hasOcean ? Math.max(h, 0) : h);
      pos.setXYZ(i, x * r, y * r, z * r);
      if (model.hasOcean && h <= 0) tmp.copy(deep);
      else if (h < 12) tmp.copy(sand);
      else if (h < 260) tmp.copy(grass);
      else if (h < 520) tmp.copy(rock);
      else tmp.copy(snow);
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, shared.patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })));
    scene.add(this.mesh);
  }
  dispose() { this.planet.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

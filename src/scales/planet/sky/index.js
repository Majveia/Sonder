// PLACEHOLDER sky — flat lighting driven by sun elevation. The real atmosphere system replaces this file.
import * as THREE from 'three';
export default class Sky {
  constructor(planet) { this.planet = planet; }
  async init() {
    const a = this.planet.desc.atmosphere;
    this.day = new THREE.Color(a ? a.sky : '#000000');
    this.horizon = new THREE.Color(a ? a.horizon : '#000000');
    this.planet.scene.background = new THREE.Color(0, 0, 0);
  }
  update() {
    const p = this.planet, e = p.env;
    const elev = p.sunDir.dot(p.player.up);
    const dayAmt = THREE.MathUtils.smoothstep(elev, -0.12, 0.25);
    e.night = 1 - dayAmt;
    e.sunIntensity = 3.2 * THREE.MathUtils.smoothstep(elev, -0.05, 0.2);
    e.ambientIntensity = 0.15 + 0.85 * dayAmt;
    e.skyColor.copy(this.day); e.fogColor.copy(this.horizon).multiplyScalar(0.15 + 0.85 * dayAmt);
    p.scene.background.copy(this.day).multiplyScalar(dayAmt * 0.9);
  }
}

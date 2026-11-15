// Placeholder scale used until the real scale lands: a soft point cloud you can orbit, tap to dive deeper.
import * as THREE from 'three';
import { Scale } from '../core/scale.js';
import { OrbitRig } from '../core/flycam.js';
import { RNG } from '../core/rng.js';

export function makePlaceholder({ name, kicker, next, back, color = [0.6, 0.75, 1.0], count = 20000, describe }) {
  return class PlaceholderScale extends Scale {
    async init(params) {
      this.params = params;
      const rng = new RNG('placeholder', name, params.galaxy ?? 0, params.star ?? 0);
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const d = rng.dir(); const r = Math.pow(rng.next(), 0.5) * 50;
        pos[i * 3] = d[0] * r; pos[i * 3 + 1] = d[1] * r * 0.35; pos[i * 3 + 2] = d[2] * r;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ size: 0.35, sizeAttenuation: true, color: new THREE.Color(...color).multiplyScalar(1.6), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
      this.points = new THREE.Points(geo, mat);
      this.scene.add(this.points);
      this.camera.near = 0.1; this.camera.far = 5000;
      this.rig = new OrbitRig(this.camera, { distance: 120, minDistance: 10, maxDistance: 600, pitch: 0.4, autoRotate: 0.05 });
      this.grade = { bloom: 0.8, bloomThreshold: 0.4 };
    }
    enter(params) {
      const { ui, input, scales } = this.ctx;
      input.setScheme({ pointerLock: false, joystick: false });
      const d = describe ? describe(this.ctx, params) : { name };
      ui.setLocation({ kicker, name: d.name, detail: d.detail || 'placeholder' });
      if (next) ui.prompt({ key: 'E', text: `Enter ${next}`, action: 'interact' });
      this._untap = input.onTap(() => { if (next) scales.go(next, { ...params }); });
    }
    exit() { this._untap?.(); }
    update(dt) {
      const { input, scales } = this.ctx;
      this.rig.update(dt, input);
      this.points.rotation.y += dt * 0.01;
      if (next && input.hit('interact')) scales.go(next, { ...this.params });
      if (back && input.hit('back_out')) scales.go(back, { ...this.params });
    }
  };
}

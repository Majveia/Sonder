// UI LAB — a private demo scale that exercises every HUD component over bright and dark backgrounds.
// Not registered in main.js; load it from the console / screenshot tool:
//   SONDER.engine.scales.register('uilab', () => import('/src/ui/lab/index.js').then(m => m.default)); SONDER.go('uilab', {}, { style: 'cut' })
// then drive it with  UILAB.demo('<name>')  — names: gate hero arrival caption prompt labels hints touch all clear
// and UILAB.look('bright' | 'dark' | 'split').
import * as THREE from 'three';
import { Scale } from '../../core/scale.js';
import { RNG } from '../../core/rng.js';

const BG_VERT = /* glsl */`
varying vec3 vDir;
void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.9999; }`;
// a day sky on one side (+x), black space with a nebula wash on the other: tests halos over both
const BG_FRAG = /* glsl */`
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float side = smoothstep(-0.25, 0.35, d.x);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 sky = mix(vec3(0.55, 0.78, 1.25), vec3(0.16, 0.36, 0.95), smoothstep(-0.05, 0.7, h));
  sky = mix(sky, vec3(1.6, 1.45, 1.2), pow(max(0.0, 1.0 - abs(h + 0.02) * 4.0), 3.0));   // bright haze at the horizon
  vec3 sunD = normalize(vec3(0.9, 0.18, -0.3));
  sky += vec3(6.0, 5.2, 4.0) * pow(max(0.0, dot(d, sunD)), 900.0) + vec3(0.6, 0.5, 0.35) * pow(max(0.0, dot(d, sunD)), 12.0);
  vec3 ground = vec3(0.10, 0.16, 0.07) * (0.6 + 0.4 * smoothstep(-0.3, 0.0, h));
  sky = mix(ground, sky, smoothstep(-0.03, 0.0, h));
  vec3 space = vec3(0.012, 0.006, 0.03) * smoothstep(0.6, 0.0, abs(d.y + 0.2 * d.z));
  gl_FragColor = vec4(mix(space, sky, side), 1.0);
}`;

export default class UILab extends Scale {
  async init() {
    const rng = new RNG('uilab');
    this.camera.near = 0.1; this.camera.far = 5000;
    const bg = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), new THREE.ShaderMaterial({ vertexShader: BG_VERT, fragmentShader: BG_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false }));
    bg.renderOrder = -10; bg.frustumCulled = false;
    this.scene.add(bg);
    const N = 6000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const d = rng.dir(); const r = 300 + rng.next() * 400;
      pos.set([d[0] * r, d[1] * r, d[2] * r], i * 3);
      const b = (0.6 + Math.pow(rng.next(), 6) * 6) * (d[0] < -0.1 ? 1 : 0);
      col.set([b * 0.9, b * 0.95, b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending })));
    // label anchors: a loose cluster (to provoke overlaps) plus a few far apart
    this.anchors = [];
    const names = ['Vesper', 'Aurelia', 'Thessaly', 'Marrow', 'Ilion', 'Cassia', 'Oriel', 'Wend', 'Halden', 'Seren', 'Kesh', 'Lumen', 'Nadir', 'Corvid'];
    for (let i = 0; i < names.length; i++) {
      const cl = i < 7;
      const d = new THREE.Vector3(cl ? -0.15 + rng.float(-0.12, 0.12) : rng.float(-0.8, 0.8), cl ? 0.05 + rng.float(-0.08, 0.08) : rng.float(-0.35, 0.35), -1).normalize().multiplyScalar(200);
      this.anchors.push({ id: 'lab' + i, p: d, text: names[i], sub: cl ? (i % 2 ? 'G2 · 5 840 K' : 'ocean world') : '', kind: i === 2 ? 'target' : i === 9 ? 'marker' : i === 12 ? 'faint' : '', priority: i === 2 ? 10 : cl ? 7 - i : 0, distance: 1200 + i * 3870 });
    }
    this.yaw = 0; this.yawTarget = 0; this.t = 0;
    this.showLabels = false; this.fakeStick = null;
    this.grade = { bloom: 0.5, bloomThreshold: 1.2, exposure: 1.0 };
    this._v = new THREE.Vector3();
  }
  enter() {
    const { ui, input } = this.ctx;
    input.setScheme({ pointerLock: false, joystick: true });
    ui.setLocation({ kicker: 'Vesper · II', name: 'Aurelia', detail: 'the white towns of the Lantern Coast' });
    window.UILAB = this;
  }
  exit() { if (window.UILAB === this) delete window.UILAB; }
  look(which) { this.yawTarget = which === 'bright' ? -Math.PI / 2 : which === 'dark' ? Math.PI / 2 : 0; this.yaw = this.yawTarget; }
  demo(name) {
    const { ui } = this.ctx;
    const all = name === 'all';
    if (name === 'clear') { ui.clearContext(); ui.caption(null); ui.hideTitle(); this.showLabels = false; this.fakeStick = null; return 'ok'; }
    if (name === 'gate') { ui.gate({}); return 'ok'; }
    if (name === 'hero') ui.title('Sonder', 'a universe, simulated', { style: 'hero', hold: 60 });
    if (name === 'arrival') ui.title('Aurelia', 'Wind in tall grass. White towns on green hills.', { style: 'arrival', kicker: 'Vesper · II', hold: 60 });
    if (name === 'caption' || all) ui.caption('Every light you see is a sun, and around some of them, someone is looking back.', { duration: 0 });
    if (name === 'prompt' || all) { ui.prompt({ key: 'E', text: 'Land on Aurelia', action: 'interact' }); ui.setReticle('ring'); }
    if (name === 'labels' || all) this.showLabels = true;
    if (name === 'hints' || all) ui.setHints([{ key: 'W A S D', text: 'move' }, { key: 'Space / C', text: 'up / down' }, { key: 'Shift', text: 'boost' }, { key: 'E', text: 'interact' }, { key: 'Esc', text: 'leave' }], { duration: 0 });
    if (name === 'touch' || all) {
      ui.setActions([{ action: 'jump', label: 'up' }, { action: 'descend', label: 'down' }, { action: 'sprint', label: 'boost' }, { action: 'view', label: 'view' }]);
      this.fakeStick = { ox: 0.16, oy: 0.72, x: 0.55, y: -0.6 };
    }
    if (name === 'toast') ui.toast('Photo saved');
    return 'ok';
  }
  update(dt) {
    const { ui, input, engine } = this.ctx;
    this.t += dt;
    this.yaw += (this.yawTarget - this.yaw) * Math.min(1, dt * 2);
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(0.02 * Math.sin(this.t * 0.2), this.yaw + 0.01 * Math.sin(this.t * 0.13), 0, 'YXZ');
    this.camera.updateMatrixWorld();
    if (this.fakeStick) {
      const s = input.stick, f = this.fakeStick, sz = engine.size;
      s.active = true; s.ox = f.ox * sz.width; s.oy = f.oy * sz.height; s.x = f.x; s.y = f.y;
    }
    if (this.showLabels) {
      const sz = engine.size;
      for (const a of this.anchors) {
        const v = this._v.copy(a.p).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw).project(this.camera);
        const vis = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        ui.label(a.id, { x: (v.x * 0.5 + 0.5) * sz.width, y: (-v.y * 0.5 + 0.5) * sz.height, text: a.text, sub: a.sub, kind: a.kind, priority: a.priority, distance: a.distance, visible: vis });
      }
    }
  }
}

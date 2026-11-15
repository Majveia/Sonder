// PLACEHOLDER player — a free-fly debug camera that respects local "up" and never sinks below ground.
// The real player system (character, hoverbike, ship, cameras) replaces this file but must keep
// writing the `planet.player` record every frame.
import * as THREE from 'three';
import { damp } from '../../../core/rng.js';

const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _m = new THREE.Vector3(), _look = new THREE.Vector3();

export default class PlayerFly {
  constructor(planet) { this.planet = planet; this.pitch = -0.12; this.speed = 30; this.vel = new THREE.Vector3(); }
  async init() {
    const p = this.planet, pl = p.player;
    pl.up.copy(p.startDir);
    p.surfacePoint(p.startDir, p.startAlt ?? 24, pl.position);
    // any tangent as initial forward
    pl.forward.set(0, 1, 0).cross(pl.up); if (pl.forward.lengthSq() < 1e-4) pl.forward.set(1, 0, 0); pl.forward.normalize();
    pl.mode = 'fly';
    this._place();
  }
  enter() {
    const { input, ui } = this.planet.ctx;
    input.setScheme({ pointerLock: true, joystick: true });
    ui.setHints([{ key: 'WASD', text: 'fly' }, { key: 'Space / C', text: 'up / down' }, { key: 'Shift', text: 'fast' }, { key: 'Esc', text: 'leave' }]);
    ui.setActions([{ action: 'jump', icon: '▲', label: 'up' }, { action: 'descend', icon: '▼', label: 'down' }, { action: 'sprint', icon: '»', label: 'fast' }]);
  }
  update(dt) {
    const p = this.planet, pl = p.player, input = p.ctx.input;
    // yaw around local up, pitch clamped
    pl.forward.applyAxisAngle(pl.up, -input.look.x);
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - input.look.y));
    if (input.zoom) this.speed = Math.max(2, Math.min(4000, this.speed * Math.exp(-input.zoom * 0.25)));
    _r.crossVectors(pl.forward, pl.up).normalize();
    _f.copy(pl.forward).multiplyScalar(Math.cos(this.pitch)).addScaledVector(pl.up, Math.sin(this.pitch));
    const sp = this.speed * (input.held('sprint') ? 8 : 1);
    _m.set(0, 0, 0).addScaledVector(_f, input.move.y).addScaledVector(_r, input.move.x)
      .addScaledVector(pl.up, (input.held('jump') ? 1 : 0) - (input.held('descend') ? 1 : 0)).multiplyScalar(sp);
    this.vel.lerp(_m, damp(6, dt));
    pl.position.addScaledVector(this.vel, dt);
    const ground = p.groundRadius(pl.position) + 1.7;
    if (pl.position.length() < ground) pl.position.setLength(ground);
    pl.up.copy(pl.position).normalize();
    pl.forward.addScaledVector(pl.up, -pl.forward.dot(pl.up)).normalize();
    pl.velocity.copy(this.vel); pl.speed = this.vel.length();
    pl.altitude = pl.position.length() - (ground - 1.7); pl.onGround = false;
    this._place();
    if (input.hit('back_out') || pl.altitude > p.R * 1.5) p.leave();
  }
  _place() {
    const p = this.planet, pl = p.player, cam = p.camera;
    cam.position.copy(pl.position);
    cam.up.copy(pl.up);
    _look.copy(pl.forward).multiplyScalar(Math.cos(this.pitch)).addScaledVector(pl.up, Math.sin(this.pitch)).add(pl.position);
    cam.lookAt(_look);
  }
}

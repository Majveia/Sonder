// Small reusable camera rigs for scales and debugging.
import * as THREE from 'three';
import { damp } from './rng.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Orbit around a target with inertia. Drag = rotate, wheel/pinch = dolly, optional WASD pans the target. */
export class OrbitRig {
  constructor(camera, { target = new THREE.Vector3(), distance = 10, minDistance = 0.1, maxDistance = 1e6, yaw = 0, pitch = 0.3, autoRotate = 0 } = {}) {
    this.camera = camera;
    this.target = target.clone();
    this.goalTarget = target.clone();
    this.distance = distance; this.goalDistance = distance;
    this.minDistance = minDistance; this.maxDistance = maxDistance;
    this.yaw = yaw; this.pitch = pitch; this.goalYaw = yaw; this.goalPitch = pitch;
    this.autoRotate = autoRotate; // radians / second when idle
    this.idle = 0;
    this.enabled = true;
    this.smooth = 6;
  }
  update(dt, input) {
    if (this.enabled && input) {
      if (input.look.x || input.look.y) {
        this.goalYaw -= input.look.x; this.goalPitch += input.look.y; this.idle = 0;
      } else this.idle += dt;
      if (input.zoom) { this.goalDistance *= Math.exp(input.zoom * 0.14); this.idle = 0; }
      this.goalPitch = Math.max(-1.52, Math.min(1.52, this.goalPitch));
      this.goalDistance = Math.max(this.minDistance, Math.min(this.maxDistance, this.goalDistance));
    }
    if (this.autoRotate && this.idle > 2.5) this.goalYaw += this.autoRotate * dt * Math.min(1, (this.idle - 2.5) / 3);
    const k = damp(this.smooth, dt);
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;
    this.distance += (this.goalDistance - this.distance) * k;
    this.target.lerp(this.goalTarget, k);
    const cp = Math.cos(this.pitch);
    _v.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).multiplyScalar(this.distance);
    this.camera.position.copy(this.target).add(_v);
    this.camera.lookAt(this.target);
  }
}

/** Free-fly camera (6DOF-lite): look + WASD, jump/descend for vertical, sprint to boost. */
export class FlyRig {
  constructor(camera, { speed = 10, up = null } = {}) {
    this.camera = camera;
    this.speed = speed;
    this.velocity = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.up = up; // optional THREE.Vector3 "up" (for planets); null = world Y
    this.enabled = true;
  }
  setFromCamera() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y; this.pitch = e.x;
  }
  update(dt, input) {
    if (!this.enabled) return;
    this.yaw -= input.look.x; this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - input.look.y));
    _q.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.quaternion.copy(_q);
    if (input.zoom) this.speed *= Math.exp(-input.zoom * 0.2);
    const sp = this.speed * (input.held('sprint') ? 6 : 1);
    _v.set(input.move.x, (input.held('jump') ? 1 : 0) - (input.held('descend') ? 1 : 0), -input.move.y).multiplyScalar(sp).applyQuaternion(_q);
    this.velocity.lerp(_v, damp(5, dt));
    this.camera.position.addScaledVector(this.velocity, dt);
  }
}

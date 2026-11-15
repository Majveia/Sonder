// Planet terrain: chunked cube-sphere quadtree, meshes built in a pool of module workers.
//
//   planet.systems.terrain.whenReady(position?) -> Promise   resolves when the ground around `position`
//        (default: the camera) is at full detail. The position is also a LOD focus until then.
//   planet.systems.terrain.meshHeight(dir) -> metres | null  height of the rendered finest mesh along a
//        unit direction (exactly what the player sees); null where no finest chunk is loaded.
//   planet.systems.terrain.stats                             { nodes, drawn, visible, triangles, pending, ms }
//   planet.physicsWavelength                                 set to the finest mesh's vertex spacing
//
// LOD: node (face, level, ix, iy); split while distance(focus, node) < K * nodeSize (hysteresis on merge),
// a parent stays drawn until all four children are built (no holes), skirts hide cracks between levels,
// frustum + horizon culling done here (three's own culling is off for chunks).
// Biome rules live in ./biome.js (biomeAt) and are baked into vertex attributes by the workers.
import * as THREE from 'three';
import { faceDir, dirToFace, nodeBounds, nodeSize } from './cube.js';
import { buildIndices } from './chunk-build.js';
import { LAYER_KINDS } from './textures.js';
import { createTerrainMaterial } from './material.js';
import { seedFrom } from '../../../core/rng.js';

const N = 32;                 // quads per chunk side
const _v = new THREE.Vector3(), _s = new THREE.Sphere(), _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4();
const _d = new Float64Array(3), _fc = {};

class TNode {
  constructor(face, level, ix, iy, parent, R) {
    this.face = face; this.level = level; this.ix = ix; this.iy = iy; this.parent = parent;
    this.key = `${face}/${level}/${ix}/${iy}`;
    this.size = nodeSize(R, level);
    const { s0, t0, d } = nodeBounds(level, ix, iy);
    faceDir(face, s0 + d / 2, t0 + d / 2, _d);
    this.dir = new THREE.Vector3(_d[0], _d[1], _d[2]);
    this.origin = this.dir.clone().multiplyScalar(R);
    this.radius = this.size * 0.75;
    this.minH = 0; this.maxH = 0;
    this.children = null; this.mesh = null; this.state = 0; // 0 none, 1 pending, 2 ready
    this.split = false; this.lastUsed = 0; this.prio = 0;
  }
}

export default class Terrain {
  constructor(planet) {
    this.planet = planet;
    this.R = planet.R;
    const q = planet.ctx.quality || {};
    this.detail = q.detail ?? 1;
    this.K = 1.7 * this.detail;
    const targetSpacing = q.tier === 'low' ? 1.6 : 0.9;
    let L = 0; while (nodeSize(this.R, L) / N > targetSpacing && L < 14) L++;
    this.maxLevel = L;
    this.finestSpacing = nodeSize(this.R, L) / N;
    // physics stands on the same octaves the finest mesh shows
    planet.physicsWavelength = this.finestSpacing;
    this.texSize = q.tier === 'low' ? 256 : 512;
    this.frame = 0;
    this.nodes = new Map();
    this.pending = new Map(); // job id -> node
    this.queue = [];
    this.waiters = [];
    this.drawn = [];
    this.stats = { nodes: 0, drawn: 0, visible: 0, triangles: 0, pending: 0, ms: 0, built: 0 };
    this._msSum = 0; this._jobId = 1;
    this.group = new THREE.Group(); this.group.name = 'terrain';
    planet.scene.add(this.group);
  }

  async init() {
    const p = this.planet;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.max(2, Math.min(4, cores - 1));
    this.workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./chunk-worker.js', import.meta.url), { type: 'module' });
      w.busy = 0;
      w.onmessage = (e) => this._onMessage(w, e.data);
      w.onerror = (e) => console.error('[terrain] worker error', e.message || e);
      w.postMessage({ type: 'init', desc: JSON.parse(JSON.stringify(p.desc)) });
      this.workers.push(w);
    }
    this.index = new THREE.BufferAttribute(buildIndices(N), 1);

    // detail texture array, synthesised in the workers
    const S = this.texSize, layers = LAYER_KINDS.length;
    this.texData = new Uint8Array(S * S * 4 * layers);
    const tex = new THREE.DataArrayTexture(this.texData, S, S, layers);
    tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(8, p.ctx.renderer.capabilities.getMaxAnisotropy());
    this.texture = tex;
    const texDone = new Promise((res) => { this._texLeft = layers; this._texResolve = res; });
    const seed = seedFrom(p.desc.seed >>> 0, 'terrain-tex');
    LAYER_KINDS.forEach((kind, layer) => {
      const w = this.workers[layer % this.workers.length];
      w.busy++;
      w.postMessage({ type: 'tex', id: 0, layer, kind, size: S, seed: seed + layer * 7919 });
    });
    this.material = createTerrainMaterial(p, tex);

    // roots
    this.roots = [];
    for (let f = 0; f < 6; f++) { const r = new TNode(f, 0, 0, 0, null, this.R); this.nodes.set(r.key, r); this.roots.push(r); }
    await texDone;
    // pump the LOD until the ground under the camera is at full detail (bounded: never hang the scale)
    const ready = this.whenReady(undefined, 40000);
    let done = false; ready.then(() => { done = true; });
    const t0 = performance.now();
    while (!done && performance.now() - t0 < 40000) {
      this._lod();
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ---- public ---------------------------------------------------------------------------------
  whenReady(position, timeout = 60000) {
    const pos = position ? position.clone() : null;
    return new Promise((resolve) => {
      this.waiters.push({ pos, resolve, t0: performance.now(), timeout });
    });
  }

  /** Height (m) of the finest rendered mesh along unit direction `dir`, or null if not loaded there. */
  meshHeight(dir) {
    const f = dirToFace(dir.x, dir.y, dir.z, _fc);
    const L = this.maxLevel, n = 1 << L;
    const fx = (f.s + 1) * 0.5 * n, fy = (f.t + 1) * 0.5 * n;
    const ix = Math.min(n - 1, Math.floor(fx)), iy = Math.min(n - 1, Math.floor(fy));
    const node = this.nodes.get(`${f.face}/${L}/${ix}/${iy}`);
    if (!node || node.state !== 2) return null;
    const u = (fx - ix) * N, v = (fy - iy) * N;
    const i = Math.min(N - 1, Math.floor(u)), j = Math.min(N - 1, Math.floor(v));
    const a = u - i, b = v - j, V = N + 1;
    const pos = node.mesh.geometry.attributes.position.array, o = node.origin;
    const P = (ii, jj, out) => { const k = (jj * V + ii) * 3; return out.set(pos[k] + o.x, pos[k + 1] + o.y, pos[k + 2] + o.z); };
    let A, B, C;
    if ((i + j) & 1) { A = P(i, j, _ta); if (a > b) { B = P(i + 1, j, _tb); C = P(i + 1, j + 1, _tc); } else { B = P(i + 1, j + 1, _tb); C = P(i, j + 1, _tc); } }
    else if (a + b < 1) { A = P(i, j, _ta); B = P(i + 1, j, _tb); C = P(i, j + 1, _tc); }
    else { A = P(i + 1, j, _ta); B = P(i + 1, j + 1, _tb); C = P(i, j + 1, _tc); }
    _e1.subVectors(B, A); _e2.subVectors(C, A); _n.crossVectors(_e1, _e2);
    const r = _n.dot(A) / _n.dot(dir);
    return r - this.R;
  }

  // ---- frame ----------------------------------------------------------------------------------
  update() { this._lod(); }

  _lod() {
    const p = this.planet, cam = p.camera;
    this.frame++;
    cam.updateMatrixWorld();
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm, cam.coordinateSystem);
    this.foci = [cam.position];
    for (const w of this.waiters) if (w.pos) this.foci.push(w.pos);
    // horizon
    const D = cam.position.length();
    this._rMin = this.R + Math.min(0, p.model.minHeight) * 0.5;
    this._camDir = _camDir.copy(cam.position).normalize();
    this._thetaC = D > this._rMin ? Math.acos(this._rMin / D) : Math.PI;
    for (const n of this.drawn) n._drawn = false;
    this.drawn.length = 0;
    this.queue.length = 0;
    for (const r of this.roots) this._visit(r);
    // visibility
    let vis = 0, tris = 0;
    for (const n of this.drawn) {
      n._drawn = true;
      const m = n.mesh;
      _s.center.copy(n.origin); _s.radius = n.radius;
      const v = n._horizon && _frustum.intersectsSphere(_s);
      m.visible = v;
      if (v) { vis++; tris += N * N * 2 + 8 * N; }
    }
    for (const m of this.group.children) if (!m.userData.node._drawn) m.visible = false;
    this._dispatch();
    this._checkWaiters();
    if ((this.frame & 63) === 0) this._gc();
    const s = this.stats;
    s.nodes = this.group.children.length; s.drawn = this.drawn.length; s.visible = vis; s.triangles = tris;
    s.pending = this.pending.size; s.queued = this.queue.length;
  }

  _distance(n) {
    let d = Infinity;
    for (const f of this.foci) { const x = f.distanceTo(n.origin) - n.size * 0.5; if (x < d) d = x; }
    return Math.max(0, d);
  }

  _horizonVisible(n) {
    const ang = Math.acos(Math.max(-1, Math.min(1, n.dir.dot(this._camDir))));
    const alpha = n.radius / this.R;
    const top = this.R + Math.max(n.maxH, 0) + 20;
    const thetaN = Math.acos(Math.min(1, this._rMin / top));
    return ang - alpha < this._thetaC + thetaN;
  }

  _visit(n) {
    n.lastUsed = this.frame;
    const d = this._distance(n);
    n._horizon = this._horizonVisible(n);
    const lim = this.K * n.size;
    let split = n.level < this.maxLevel && (n.split ? d < lim * 1.15 : d < lim);
    // nothing to gain refining ground the camera cannot see (unless a waiter focuses it)
    if (split && !n._horizon && this.foci.length === 1) split = false;
    n.split = split;
    if (split) {
      if (!n.children) this._makeChildren(n);
      let ready = true;
      for (const c of n.children) {
        c.lastUsed = this.frame;
        if (c.state !== 2) { ready = false; if (c.state === 0) this._enqueue(c, d); }
      }
      if (ready || n.state !== 2) {
        for (const c of n.children) if (c.state === 2) this._visit(c);
        if (ready) return;
      }
    }
    if (n.state === 2) this.drawn.push(n);
    else if (n.state === 0) this._enqueue(n, d);
  }

  _makeChildren(n) {
    n.children = [];
    for (let k = 0; k < 4; k++) {
      const c = new TNode(n.face, n.level + 1, n.ix * 2 + (k & 1), n.iy * 2 + (k >> 1), n, this.R);
      c.maxH = n.maxH; c.minH = n.minH;
      this.nodes.set(c.key, c); n.children.push(c);
    }
  }

  _enqueue(n, d) {
    _s.center.copy(n.origin); _s.radius = n.radius;
    const inView = _frustum.intersectsSphere(_s);
    n.prio = (d / n.size) * (inView ? 1 : 4) - (this.maxLevel - n.level) * 0.01;
    this.queue.push(n);
  }

  _dispatch() {
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a.prio - b.prio);
    let qi = 0;
    for (const w of this.workers) {
      while (w.busy < 2 && qi < this.queue.length) {
        const n = this.queue[qi++];
        if (n.state !== 0) continue;
        const id = this._jobId++;
        n.state = 1; this.pending.set(id, n); w.busy++;
        const spacing = n.size / N;
        w.postMessage({ type: 'chunk', id, job: { face: n.face, level: n.level, ix: n.ix, iy: n.iy, N, minWl: n.level === this.maxLevel ? this.planet.physicsWavelength : spacing } });
      }
    }
  }

  _onMessage(w, m) {
    w.busy = Math.max(0, w.busy - 1);
    if (m.type === 'init') { w.busy++; return; } // init does not count
    if (m.type === 'error') { console.error('[terrain] worker:', m.message); const n = this.pending.get(m.id); if (n) { n.state = 0; this.pending.delete(m.id); } return; }
    if (m.type === 'tex') {
      const S = this.texSize;
      this.texData.set(m.pixels, m.layer * S * S * 4);
      if (--this._texLeft === 0) { this.texture.needsUpdate = true; this._texResolve(); }
      this._dispatch();
      return;
    }
    if (m.type !== 'chunk') return;
    const n = this.pending.get(m.id);
    this.pending.delete(m.id);
    this._msSum += m.ms; this.stats.built++; this.stats.ms = this._msSum / this.stats.built;
    if (!n || n.disposed) { this._dispatch(); return; }
    const g = new THREE.BufferGeometry();
    g.setIndex(this.index);
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
    g.setAttribute('aW0', new THREE.BufferAttribute(m.w0, 4, true));
    g.setAttribute('aW1', new THREE.BufferAttribute(m.w1, 4, true));
    g.setAttribute('aData', new THREE.BufferAttribute(m.data, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), m.radius);
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.copy(n.origin);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.castShadow = n.level >= this.maxLevel - 4;
    mesh.visible = false;
    mesh.userData.node = n;
    n.mesh = mesh; n.state = 2; n.radius = m.radius; n.minH = m.minH; n.maxH = m.maxH;
    this.group.add(mesh);
    this._dispatch();
  }

  _checkWaiters() {
    if (!this.waiters.length) return;
    const now = performance.now();
    this.waiters = this.waiters.filter((w) => {
      const pos = w.pos || this.planet.camera.position;
      let ok = true;
      _v.copy(pos).normalize();
      if (!this._leafReady(_v)) ok = false;
      if (ok) {
        // also the ground a few tens of metres around
        const e = 30 / this.R;
        const t = _t1.set(-_v.z, 0, _v.x); if (t.lengthSq() < 1e-8) t.set(1, 0, 0); t.normalize();
        const b = _t2.crossVectors(_v, t);
        for (const [a, c] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          _t3.copy(_v).addScaledVector(t, a * e).addScaledVector(b, c * e).normalize();
          if (!this._leafReady(_t3)) { ok = false; break; }
        }
      }
      if (ok || now - w.t0 > w.timeout) {
        if (!ok) console.warn('[terrain] whenReady timed out; continuing at partial detail');
        w.resolve(ok); return false;
      }
      return true;
    });
  }

  /** The drawn node over `dir` wants no further refinement (it is the desired leaf). */
  _leafReady(dir) {
    const f = dirToFace(dir.x, dir.y, dir.z, _fc);
    let n = this.roots[f.face];
    if (n.state !== 2) return false;
    for (;;) {
      if (!n.split) return true;
      if (!n.children) return false;
      const k = 1 << (n.level + 1);
      const cx = Math.min(k - 1, Math.floor((f.s + 1) * 0.5 * k)), cy = Math.min(k - 1, Math.floor((f.t + 1) * 0.5 * k));
      const c = n.children[(cx - n.ix * 2) + (cy - n.iy * 2) * 2];
      if (!c || c.state !== 2) return false;
      n = c;
    }
  }

  /** Free meshes of nodes unused for a while (keeps parents of drawn nodes: they are the fallback). */
  _gc() {
    const old = this.frame - 240;
    for (const n of this.nodes.values()) {
      if (n.level === 0 || n.lastUsed > old) continue;
      this._freeNode(n);
    }
  }

  _freeNode(n) {
    if (n.mesh) { this.group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh = null; }
    if (n.children) for (const c of n.children) this._freeNode(c);
    n.children = null;
    n.state = n.state === 1 ? 1 : 0;
    if (n.state === 1) n.disposed = true;
    this.nodes.delete(n.key);
    if (n.parent && n.parent.children && n.parent.children.includes(n)) n.parent.children = null, this._freeSiblings(n.parent);
  }

  _freeSiblings(parent) {
    // children array was dropped as a unit; make sure every sibling is released too
    for (const [k, c] of this.nodes) if (c.parent === parent) { if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; } if (c.state === 1) c.disposed = true; this.nodes.delete(k); }
  }

  dispose() {
    for (const w of this.workers || []) w.terminate();
    for (const m of this.group.children) m.geometry.dispose();
    this.planet.scene.remove(this.group);
    this.material?.dispose(); this.texture?.dispose();
    for (const w of this.waiters) w.resolve(false);
    this.waiters = [];
  }
}

const _camDir = new THREE.Vector3(), _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tc = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n = new THREE.Vector3();
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3();

// PlanetScale — a whole walkable world. This file is the INTEGRATOR: it owns the shared world state
// (planet model, sun / time of day, lights, shared uniforms, the player record) and runs a list of
// independent systems, each living in its own folder:
//
//   player/   character, vehicles, ship, cameras          sky/     atmosphere, sun, stars, clouds, lighting
//   terrain/  LOD terrain meshes + materials              water/   ocean / lava seas
//   flora/    grass, trees, alien plants                  fauna/   creatures, flocks
//   civ/      cities, buildings, inhabitants, traffic     weather/ rain, snow, dust, aurora
//
// A system is `export default class X { constructor(planet) {}  async init() {}  update(dt, time) {}  dispose() {} }`
// (all methods optional). Systems talk to each other only through the `planet` object documented below.
//
// Debug URL parameters:  at=spawn | <siteIndex> | <latDeg>,<lonDeg>   alt=<metres above ground>
//                        tod=<local solar hour 0..24>   dayspeed=<multiplier>   cam=fly
import * as THREE from 'three';
import { Scale } from '../../core/scale.js';
import { PlanetModel } from '../../universe/planet-model.js';
import { createShared } from './shared.js';

const SYSTEMS = [
  ['player', () => import('./player/index.js')],
  ['sky', () => import('./sky/index.js')],
  ['terrain', () => import('./terrain/index.js')],
  ['water', () => import('./water/index.js')],
  ['flora', () => import('./flora/index.js')],
  ['fauna', () => import('./fauna/index.js')],
  ['civ', () => import('./civ/index.js')],
  ['weather', () => import('./weather/index.js')],
];

const _v = new THREE.Vector3();

export default class PlanetScale extends Scale {
  async init(params) {
    const { universe } = this.ctx;
    this.params = params;
    this.sysDesc = universe.system(params.galaxy ?? 0, params.star ?? 1);
    let desc = this.sysDesc.planets[params.planet ?? 2];
    if (!desc || !desc.landable) desc = this.sysDesc.planets.find((p) => p.landable);
    if (!desc) throw new Error('no landable world in this system');
    /** PlanetDesc (see universe/universe.js) */
    this.desc = desc;
    /** PlanetModel: height(), climate(), sites, spawn */
    this.model = new PlanetModel(desc);
    /** planet radius in metres; the planet centre is the world origin */
    this.R = this.model.R;
    this.gravity = desc.gravity || 9.8;

    // ---- shared world state -------------------------------------------------------------------
    /** unit vector toward the sun, world space (updated every frame from the day cycle) */
    this.sunDir = new THREE.Vector3(0.4, 0.7, 0.3).normalize();
    /** lighting environment — written by the sky system each frame, read by everyone */
    this.env = {
      sunColor: new THREE.Color(1.0, 0.95, 0.88), // colour of direct sunlight reaching the ground
      sunIntensity: 3.0,                           // DirectionalLight intensity
      skyColor: new THREE.Color(0.35, 0.5, 0.85),  // hemisphere sky colour
      groundColor: new THREE.Color(0.22, 0.2, 0.17),
      ambientIntensity: 0.9,
      fogColor: new THREE.Color(0.62, 0.74, 0.92),
      fogDensity: 0.00012,
      night: 0,                                    // 0 day .. 1 night at the player
      windDir: new THREE.Vector3(1, 0, 0), windStrength: 1,
    };
    /** the player record — written by the player system, read by everyone (LOD, spawning, audio) */
    this.player = {
      position: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), forward: new THREE.Vector3(0, 0, -1),
      velocity: new THREE.Vector3(), speed: 0, altitude: 0, onGround: false,
      mode: 'fly', // 'foot' | 'bike' | 'ship' | 'fly'
      object: null,
    };
    /**
     * Things the player can walk up to and use. Any system may add entries; the player system shows
     * the prompt for the nearest one in range and calls onInteract() on the `interact` action.
     *   { position: THREE.Vector3 (world), radius: metres, prompt: string | () => string,
     *     onInteract(player): void, kind?: 'npc' | 'vehicle' | 'object' | 'door', priority?: number }
     */
    this.interactables = new Set();
    /**
     * Solid obstacles for the player / vehicles / creatures (kept deliberately simple and cheap):
     *   { position: THREE.Vector3 (world, base centre on the ground), radius: metres, height: metres }
     * Upright cylinders along local "up". Systems add big static things (buildings, trunks, boulders).
     * Use planet.addCollider(c) / planet.removeCollider(c); query with planet.collidersNear(pos, range, out).
     */
    this.colliders = new Map(); // coarse spatial hash: cell key -> array
    this.shared = createShared(this);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.scene.add(this.sunLight, this.sunLight.target, this.hemiLight);

    this.camera.fov = 62; this.camera.near = 0.3; this.camera.far = this.R * 14;
    this.camera.updateProjectionMatrix();
    this.grade = { bloom: 0.35, bloomThreshold: 1.1, bloomKnee: 0.7, exposure: 1.0, vignette: 0.26, grain: 0.025, contrast: 1.06, saturation: 1.1, toneMap: 1 };

    // ---- time of day ----------------------------------------------------------------------------
    this.dayLength = desc.dayLength || 1440;       // seconds per rotation
    this.daySpeed = params.dayspeed !== undefined ? Number(params.dayspeed) : 1;
    this.sunDeclination = 0.16;
    this._sunAngle = 0;
    const start = this._startDir(params);
    this.startDir = start.dir; this.startAlt = start.alt;
    this.setLocalHour(params.tod !== undefined ? Number(params.tod) : 8.4, this.startDir);
    this._applySun();

    // ---- systems --------------------------------------------------------------------------------
    this.systems = {}; this._order = [];
    for (const [name, loader] of SYSTEMS) {
      try {
        const mod = await loader();
        const sys = new mod.default(this);
        if (sys.init) await sys.init();
        this.systems[name] = sys; this._order.push([name, sys]);
      } catch (err) { console.error(`[planet] system "${name}" failed to start`, err); }
    }
    this._sync();
  }

  // ---- helpers for systems ----------------------------------------------------------------------
  /** Terrain height (metres relative to R) under a world position. */
  heightAt(pos) { const l = pos.length() || 1; return this.model.height(pos.x / l, pos.y / l, pos.z / l); }
  /** Ground (or sea surface when `sea`) radius under a world position. */
  groundRadius(pos, sea = true) { const h = this.heightAt(pos); return this.R + (sea && this.model.hasOcean && h < 0 ? 0 : h); }
  /** Altitude of a world position above ground / sea. */
  altitudeOf(pos) { return pos.length() - this.groundRadius(pos); }
  /** World position on the surface in direction `dir` (unit), raised by `lift` metres. */
  surfacePoint(dir, lift = 0, out = new THREE.Vector3()) {
    const h = this.model.height(dir.x, dir.y, dir.z);
    return out.copy(dir).multiplyScalar(this.R + (this.model.hasOcean && h < 0 ? 0 : h) + lift);
  }
  _cellKey(pos) { const c = 64; return `${Math.floor(pos.x / c)},${Math.floor(pos.y / c)},${Math.floor(pos.z / c)}`; }
  addCollider(c) { const k = this._cellKey(c.position); let a = this.colliders.get(k); if (!a) this.colliders.set(k, (a = [])); a.push(c); c._cell = k; return c; }
  removeCollider(c) { const a = this.colliders.get(c._cell); if (a) { const i = a.indexOf(c); if (i >= 0) a.splice(i, 1); if (!a.length) this.colliders.delete(c._cell); } }
  /** Collect colliders within `range` metres of pos (range <= 64). Returns `out`. */
  collidersNear(pos, range = 16, out = []) {
    out.length = 0; const c = 64;
    const x0 = Math.floor((pos.x - range) / c), x1 = Math.floor((pos.x + range) / c);
    const y0 = Math.floor((pos.y - range) / c), y1 = Math.floor((pos.y + range) / c);
    const z0 = Math.floor((pos.z - range) / c), z1 = Math.floor((pos.z + range) / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const a = this.colliders.get(`${x},${y},${z}`); if (!a) continue;
      for (let i = 0; i < a.length; i++) { const o = a[i]; const r = range + o.radius; if (o.position.distanceToSquared(pos) < r * r) out.push(o); }
    }
    return out;
  }
  /** Local solar time (hours 0..24) at a world direction. */
  localHour(dir) {
    const lon = Math.atan2(dir.z, dir.x);
    let h = 12 + ((lon - this._sunAngle) / (Math.PI * 2)) * 24;
    return ((h % 24) + 24) % 24;
  }
  /** Rotate the day so that the local solar time at `dir` is `hour`. */
  setLocalHour(hour, dir = this.player.up) {
    const lon = Math.atan2(dir.z, dir.x);
    this._sunAngle = lon - ((hour - 12) / 24) * Math.PI * 2;
    this._applySun();
  }
  /** Leave the surface for the star system (called by the player system when the ship climbs out). */
  leave() {
    const p = this.params;
    return this.ctx.scales.go('system', { galaxy: p.galaxy ?? 0, star: p.star ?? 1, fromPlanet: this.desc.index });
  }

  _startDir(params) {
    const m = this.model;
    let dir = m.spawn.dir, alt = params.alt !== undefined ? Number(params.alt) : null;
    const at = params.at;
    if (at !== undefined && at !== 'spawn') {
      if (String(at).includes(',')) {
        const [lat, lon] = String(at).split(',').map((v) => (Number(v) * Math.PI) / 180);
        dir = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
      } else if (m.sites[Number(at)]) dir = m.sites[Number(at)].dir;
    }
    return { dir: new THREE.Vector3(dir[0], dir[1], dir[2]).normalize(), alt };
  }

  _applySun() {
    const d = this.sunDeclination, a = this._sunAngle;
    this.sunDir.set(Math.cos(d) * Math.cos(a), Math.sin(d), Math.cos(d) * Math.sin(a)).normalize();
  }

  _sync() {
    const u = this.shared.uniforms, e = this.env, cam = this.camera;
    cam.updateMatrixWorld();
    u.uTime.value = this._time || 0;
    u.uSunDir.value.copy(this.sunDir);
    u.uSunColor.value.copy(e.sunColor).multiplyScalar(e.sunIntensity);
    u.uSkyColor.value.copy(e.skyColor).multiplyScalar(e.ambientIntensity);
    u.uGroundColor.value.copy(e.groundColor).multiplyScalar(e.ambientIntensity);
    u.uFogColor.value.copy(e.fogColor);
    u.uFogDensity.value = e.fogDensity;
    u.uCamPos.value.copy(cam.position);
    u.uCamWorld.value.copy(cam.matrixWorld);
    u.uNight.value = e.night;
    u.uWind.value.set(e.windDir.x, e.windDir.y, e.windDir.z, e.windStrength);
    // three lights follow the player so shadow frusta stay tight
    const p = this.player.position;
    this.sunLight.color.copy(e.sunColor); this.sunLight.intensity = e.sunIntensity;
    this.sunLight.position.copy(p).addScaledVector(this.sunDir, 600);
    this.sunLight.target.position.copy(p);
    this.hemiLight.color.copy(e.skyColor); this.hemiLight.groundColor.copy(e.groundColor); this.hemiLight.intensity = e.ambientIntensity;
    // hemisphere "up" must be the local up, not world Y
    this.hemiLight.position.copy(this.player.up);
  }

  enter(params, from) {
    const { ui, audio } = this.ctx;
    const d = this.desc;
    ui.setLocation({ kicker: `${this.sysDesc.name} system`, name: d.name, detail: d.mood?.line || d.label });
    audio.setScene('planet', { mood: d.mood?.music || d.type, planet: d });
    for (const [, s] of this._order) s.enter?.(params, from);
  }
  exit() { for (const [, s] of this._order) s.exit?.(); }

  update(dt, time) {
    this._time = time;
    this._sunAngle -= ((Math.PI * 2) / this.dayLength) * dt * this.daySpeed;
    this._applySun();
    for (let i = 0; i < this._order.length; i++) {
      const [name, s] = this._order[i];
      if (s.update) s.update(dt, time);
      if (name === 'player' || name === 'sky') this._sync();
    }
  }

  /** A system may take over rendering (multi-pass sky, refraction...) by setting planet.customRender. */
  render(renderer, target, dt) {
    if (this.customRender) { this.customRender(renderer, target, dt); return; }
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }

  resize(w, h) { super.resize(w, h); for (const [, s] of this._order) s.resize?.(w, h); }
  dispose() { for (const [, s] of this._order) { try { s.dispose?.(); } catch (e) { console.error(e); } } super.dispose(); }
}

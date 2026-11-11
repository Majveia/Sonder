# SONDER — a playable, simulated universe (three.js)

> *sonder (n.): the realisation that every passer-by has a life as vivid and complex as your own.*

One continuous journey: **cosmic web → galaxy → star system → planet surface**, with a voiced cinematic
intro, first/third-person exploration, vehicles, living worlds and cities. No build step: plain ES
modules + an import map, three.js r187 vendored in `vendor/three`. Open `index.html` through any static
server.

## The bar

"No Man's Sky × Starfield × Outer Wilds × Breath of the Wild × Pacific Drive", on an OLED display:
true black, HDR bloom, crisp detail, deliberate colour, constant gentle motion. Minimal, immersive UI.
Every world should feel authored — art direction borrowed from film, painting and games we love
(Miyazaki, Moebius, Tarkovsky, Kubrick, Blade Runner, Cowboy Bebop …), never generic "procedural noise".
Real physics where it shows: ΛCDM structure formation, Keplerian orbits, black-body colours,
gravitational lensing, Rayleigh/Mie scattering. If it looks like a tech demo, it is not done.

## Run / test

```bash
node tools/serve.cjs 8080            # static server (use your own port when several agents work at once)
node tools/shot.cjs --url "http://localhost:8080/?scale=planet&quality=high" --out .shots/x.png \
     --steps "wait:2000;key:KeyW:1500;shot:.shots/x2.png"      # see the header of tools/shot.cjs
```

* Headless Chromium renders with **software GL (~2–8 fps)**. Engine `dt` is clamped to 1/20 s, so
  simulated time runs slower than wall time there — use `step:<frames>:<dt>` to fast-forward and
  `frames:<n>` to wait for rendered frames. FPS numbers from headless runs say nothing about real GPUs.
* Look at your screenshots (Read tool) — every visual claim must be checked by eye.
* `window.SONDER = { engine, ctx, scale, go(name, params), step(frames, dt), errors, THREE }` for scripted tests.
* URL params: `scale=cosmic|galaxy|system|planet`, `galaxy= star= planet=` (home = 0 / 1 / 2),
  `intro=0`, `quality=low|medium|high|ultra`, `dpr=`, `mute=1`, `hud=0`; planet: `at=spawn|<site>|<lat>,<lon>`,
  `alt=`, `tod=<hour>`, `dayspeed=`.
* Screenshots go in `.shots/<your-area>/` (git-ignored). Never commit screenshots.

## Layout and ownership

```
index.html                 entry (import map)
src/main.js                boot, URL params, scale registry, window.SONDER
src/core/                  engine.js post.js scale.js input.js quality.js rng.js noise.js glsl.js flycam.js   (CORE)
src/universe/              universe.js (galaxies, systems, planets — pure data)  planet-model.js  names.js    (CORE)
src/ui/                    ui.js ui.css  (HUD contract)
src/audio/                 audio.js (AudioEngine contract) + assets
src/intro/                 intro.js (runIntro)
src/scales/cosmic/         cosmic web (N-body structure formation)
src/scales/galaxy/         one galaxy
src/scales/system/         star system, orbits, phenomena (black holes, pulsars…)
src/scales/planet/         index.js (integrator, CORE) shared.js + player/ sky/ terrain/ water/ flora/ fauna/ civ/ weather/
tools/                     serve.cjs shot.cjs
```

**Rules when several agents work in parallel**

* Edit only the paths you were assigned. Need a change in CORE or someone else's area? Make the
  smallest additive change possible, and say so in your final report (file + why).
* Do **not** run git commands that change state (`commit`, `add`, `stash`, `checkout`, `reset` …). The lead commits.
* No network at runtime: no CDNs, no remote fonts, no fetches to other origins. Everything is vendored or procedural.
* World content is deterministic: use `RNG` / `seedFrom` from `core/rng.js`, never `Math.random()` for anything persistent.

## Rendering conventions (read before writing a shader)

* **Linear HDR everywhere.** Scenes render into an RGBA16F MSAA target. Never tone-map or sRGB-encode in a
  material; emit radiance (values > 1 are welcome — they drive bloom). `PostFX` does bloom → tone map →
  grade → grain. Colours from hex: `new THREE.Color('#rrggbb')` already converts to linear.
* **True black.** Space is `0,0,0`. No grey fog in a vacuum, no lifted blacks.
* **Logarithmic depth buffer is ON.** Built-in three materials just work. A custom `ShaderMaterial` that
  depth-tests or writes depth must add the four chunks (`GLSL.logDepthParsVert/logDepthVert/
  logDepthParsFrag/logDepthFrag` from `core/glsl.js`; the vertex shader also needs `#include <common>`).
  Fullscreen / additive no-depth passes don't need them. Decode scene depth with `GLSL.logDepthDecode`.
* Per-scale look: set `this.grade = {...}` (keys in `DEFAULT_GRADE`, `core/post.js`): `exposure, bloom,
  bloomThreshold, bloomKnee, bloomRadius, contrast, saturation, lift, gain, vignette, grain, ca, toneMap`.
  Change it live with `ctx.post.setGrade(grade)` (eased). `ctx.post.letterbox / fade / flash / warp` are
  available for cinematics.
* Custom multi-pass rendering: implement `render(renderer, target, dt)` on the scale and leave the
  result in `target` (= `ctx.post.target`, depth texture at `ctx.post.depthTexture`). `FullscreenPass`
  in `core/post.js` is a ready-made fullscreen-triangle helper.
* Scale by `ctx.quality` (`particles`, `detail`, `shadows`, `raymarch`, `simGrid`, `mobile`, `tier`) —
  never sniff the device yourself. Must stay playable on phones at `low`.
* Budget for a mid-range GPU at 1440p/60: ≲ 300 draw calls, instancing for anything repeated, ray-march
  heavy effects at reduced resolution or ≤ ~64 steps. Dispose what you create (`dispose()`).
* Shared GLSL: `GLSL.common, simplex3, fbm, vnoise, blackbody` in `core/glsl.js`. JS noise: `core/noise.js`.

## Core contracts

**Scale** (`core/scale.js`): `export default class X extends Scale` with `async init(params)`,
`enter(params, fromName)`, `exit()`, `update(dt, time)`, `resize(w, h)`, `onTransition(phase, k)`,
`dispose()`, optional `render(...)`, `static persistent`. Owns `this.scene`, `this.camera`, `this.grade`.

**Context** `this.ctx = { engine, renderer, post, input, audio, ui, universe, quality, scales, state, params }`.
`ctx.state.location = { galaxy, star, planet }` is the player's current address — keep it updated.

**Travel**: `ctx.scales.go(name, params, { style: 'warp' | 'fade' | 'flash' | 'cut', out, in })` → Promise.
Params: `cosmic {focus?: galaxyId}` · `galaxy {galaxy, focusStar?}` · `system {galaxy, star, fromPlanet?}` ·
`planet {galaxy, star, planet, approach?}`. Going *up* a level is the `back_out` action (Esc / touch button).

**Input** (`core/input.js`): `input.move {x,y}`, `input.look {x,y}` (radians this frame), `input.zoom`,
`input.held(action)`, `input.hit(action)`, `input.pointer {x,y,nx,ny}`, `input.onTap(cb)`,
`input.setScheme({ pointerLock, joystick })`, `input.isTouch`. Actions: `forward back left right jump
descend sprint interact alt view map rollLeft rollRight brake back_out time photo help`. Never add raw
DOM listeners for gameplay — extend Input if something is missing (and report it).

**UI** (`ui/ui.js`): `title, caption, toast, setLocation, prompt, label/removeLabel, setActions, setHints,
setReticle, setVisible, clearContext`. Minimal by design: nothing permanent on screen except the faint
location header and a context prompt. Touch controls: invisible virtual stick on the left (appears under
the thumb), look-drag on the right, small round action buttons bottom-right via `ui.setActions`.

**Audio** (`audio/audio.js`): `setScene(name, params)`, `sfx(name, opts)`, `loop(name, level, params)`,
`say(line, opts) → Promise`, `stopVoice()`, `setMuted()`.

**Universe** (`universe/universe.js`): `universe.galaxy(id)`, `universe.system(galaxyId, starIndex)`
(star 0 of every galaxy is its central black hole; home = galaxy 0, star 1 "Vesper", planet 2 "Aurelia"),
`blackbodyRGB(K)`. Descriptors are plain data: see `homeSystem()` for every field a planet can carry
(`type, terrain, palette, atmosphere, ocean, life, civ, rings, moons, orbit, gameRadius, gravity,
dayLength, mood, parent, signature`). The home system holds nine hand-authored signature worlds.

**PlanetModel** (`universe/planet-model.js`, worker-safe, no three): `height(x,y,z,minWavelength)` metres
relative to radius `R` for a unit direction, `climate()`, `slope()`, `sites` (settlements; terrain is
already flattened under them), `spawn`, helpers `tangentOffset`, `tangentFrame`. Sea level is height 0.
The planet centre is the world origin; "up" is `normalize(position)`.

**Planet scale** (`scales/planet/index.js`): systems receive `planet` with `desc, sysDesc, model, R,
gravity, scene, camera, ctx, sunDir, env, player, shared, sunLight, hemiLight, systems` and helpers
`heightAt(pos)`, `groundRadius(pos)`, `altitudeOf(pos)`, `surfacePoint(dir, lift, out)`, `localHour()`,
`setLocalHour()`, `leave()`, `customRender`, plus two registries any system may fill: `planet.interactables`
(things the player can use: `{ position, radius, prompt, onInteract }`) and colliders
(`planet.addCollider({ position, radius, height })`, `collidersNear(pos, range, out)`). Every material on a world must use the shared atmosphere
(`shared.patchMaterial(builtInMaterial)`, or `shared.glsl.pars` + `sonderAtmosphere(color, worldPos)` + `shared.attach(shaderMaterial)`; `sonderSky(dir)` gives sky radiance for reflections)
so fog, sun and sky agree across terrain, plants, creatures and buildings.

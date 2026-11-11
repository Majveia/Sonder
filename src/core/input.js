// Unified input: keyboard + mouse (pointer lock or drag) + touch (virtual stick / look / pinch) + gamepad.
// Scales read a small, device-agnostic state every frame:
//   input.move   {x, y}   strafe / forward, each in [-1, 1]
//   input.look   {x, y}   radians this frame (x: turn right +, y: look down +)
//   input.zoom            wheel / pinch delta this frame (positive = zoom out / pull back)
//   input.held(action) / input.hit(action)   (hit = went down this frame)
//   input.pointer {x, y, nx, ny, down, over}  last pointer position (px and NDC)
//   input.onTap(cb)  click / tap without drag -> cb({x, y, nx, ny, button})
// A scale picks the control scheme on enter(): input.setScheme({ pointerLock, joystick }).
//
// Additions (all optional for scales; used by the UI layer):
//   input.device            'keyboard' | 'touch' | 'gamepad' — last device used; input.onDevice(cb)
//   input.settings          { sensitivity: 1, invertY: false } applied to `look` (menu writes it)
//   input.block(key) / unblock(key) / blocked   suspend gameplay input (pause menu) without touching `enabled`
//   input.consume(actionOrCode)   swallow a pending press so no scale sees it this frame
//   input.onLock(cb)        pointer-lock changes -> cb(locked);  input.lockPointer() / unlockPointer()
//   Esc while the pointer is locked only releases the pointer; a second Esc reaches `back_out`.
//   The touch stick has a radial dead-zone (stick.deadzone) and a haptic tick where supported.

const DEFAULT_ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],            // also: ascend / thrust up
  descend: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft', 'ShiftRight'], // also: boost
  interact: ['KeyE'],         // context action: enter / exit / land / dive
  alt: ['KeyF'],              // secondary: scan / light / horn
  view: ['KeyV'],             // toggle first / third person
  map: ['KeyM', 'Tab'],
  rollLeft: ['KeyQ'],
  rollRight: ['KeyR'],
  brake: ['KeyX'],
  back_out: ['Escape', 'Backspace'], // leave / go up a scale
  time: ['KeyT'],
  photo: ['KeyP'],
  help: ['KeyH'],
  menu: ['KeyO'],             // pause / options menu (handled by the UI)
};
const haptic = (ms) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.actions = { ...DEFAULT_ACTIONS };
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.zoom = 0;
    this.pointer = { x: 0, y: 0, nx: 0, ny: 0, down: false, over: false };
    this.isTouch = (typeof window !== 'undefined') && (('ontouchstart' in window) || navigator.maxTouchPoints > 0) && matchMedia('(pointer: coarse)').matches;
    this.locked = false;
    this.scheme = { pointerLock: false, joystick: false };
    this.sensitivity = { mouse: 0.0022, touch: 0.0052, pad: 2.6 };
    this.enabled = true;       // set false to ignore gameplay input (intro, menus)
    /** virtual stick visual state for the UI layer */
    this.stick = { active: false, ox: 0, oy: 0, x: 0, y: 0, radius: 54, deadzone: 0.12, sx: 0, sy: 0 };
    this.device = this.isTouch ? 'touch' : 'keyboard';
    this.settings = { sensitivity: 1, invertY: false };
    this._blocks = new Set();
    this._lockCbs = new Set();
    this._deviceCbs = new Set();
    this._unlockAt = -1e9;

    this._codes = new Set();
    this._hitCodes = new Set();
    this._vHeld = new Set();
    this._vHit = new Set();
    this._tapCbs = new Set();
    this._gestureCbs = new Set();
    this._keyCbs = new Set();
    this._lookAcc = { x: 0, y: 0 };
    this._zoomAcc = 0;
    this._touches = new Map(); // id -> {role, sx, sy, x, y, t0, moved}
    this._pinch = 0;
    this._mouse = { down: false, sx: 0, sy: 0, moved: 0, button: 0 };
    this._padPrev = [];
    this._bind();
  }

  setScheme(scheme) {
    this.scheme = { pointerLock: false, joystick: false, ...scheme };
    if (!this.scheme.pointerLock && document.pointerLockElement) document.exitPointerLock();
    this.stick.active = false;
  }

  /** true while something (pause menu …) suspends gameplay input */
  get blocked() { return this._blocks.size > 0; }
  block(key = 'ui') { this._blocks.add(key); this._vHeld.clear(); this.stick.active = false; }
  unblock(key = 'ui') { this._blocks.delete(key); }
  /** Swallow a pending press (action name or key code) so nothing reads it this frame. */
  consume(name) {
    const codes = this.actions[name] || [name];
    for (const c of codes) { this._hitCodes.delete(c); this._codes.delete(c); }
    this._vHit.delete(name); this._vHeld.delete(name);
  }
  onLock(cb) { this._lockCbs.add(cb); return () => this._lockCbs.delete(cb); }
  onDevice(cb) { this._deviceCbs.add(cb); return () => this._deviceCbs.delete(cb); }
  lockPointer() {
    const c = this.canvas;
    if (this.locked || !c.requestPointerLock) return;
    try { const p = c.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* headless / denied */ }
  }
  unlockPointer() { if (document.pointerLockElement) document.exitPointerLock(); }
  _setDevice(d) {
    if (this.device === d) return;
    this.device = d;
    for (const cb of this._deviceCbs) cb(d);
  }

  held(action) {
    if (!this.enabled || this._blocks.size) return false;
    if (this._vHeld.has(action)) return true;
    const codes = this.actions[action];
    if (codes) { for (const c of codes) if (this._codes.has(c)) return true; return false; }
    return this._codes.has(action);
  }
  hit(action) {
    if (!this.enabled || this._blocks.size) return false;
    if (this._vHit.has(action)) return true;
    const codes = this.actions[action];
    if (codes) { for (const c of codes) if (this._hitCodes.has(c)) return true; return false; }
    return this._hitCodes.has(action);
  }
  /** Drive an action from UI (touch buttons). */
  setVirtual(action, down) {
    if (down) { if (!this._vHeld.has(action)) this._vHit.add(action); this._vHeld.add(action); }
    else this._vHeld.delete(action);
  }
  /** One-shot virtual press. */
  trigger(action) { this._vHit.add(action); }

  onTap(cb) { this._tapCbs.add(cb); return () => this._tapCbs.delete(cb); }
  /** Fires on every user gesture (used to unlock audio, skip intro...). */
  onGesture(cb) { this._gestureCbs.add(cb); return () => this._gestureCbs.delete(cb); }
  onKey(cb) { this._keyCbs.add(cb); return () => this._keyCbs.delete(cb); }

  /** Call once at the start of each frame. */
  update(dt) {
    let mx = 0, my = 0;
    if (this._has('right')) mx += 1;
    if (this._has('left')) mx -= 1;
    if (this._has('forward')) my += 1;
    if (this._has('back')) my -= 1;
    if (this.stick.active) {
      // radial dead-zone, rescaled so the stick still reaches full deflection
      const sl = Math.hypot(this.stick.x, this.stick.y), dzs = this.stick.deadzone;
      const k = sl <= dzs ? 0 : (sl - dzs) / (1 - dzs) / sl;
      this.stick.sx = this.stick.x * k; this.stick.sy = this.stick.y * k;
      mx += this.stick.sx; my -= this.stick.sy;
    }
    let lx = this._lookAcc.x, ly = this._lookAcc.y;
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      const ax = dz(pad.axes[0] || 0), ay = dz(pad.axes[1] || 0);
      mx += ax; my -= ay;
      const rx = dz(pad.axes[2] || 0), ry = dz(pad.axes[3] || 0);
      if (ax || ay || rx || ry) this._setDevice('gamepad');
      lx += rx * Math.abs(rx) * this.sensitivity.pad * dt; ly += ry * Math.abs(ry) * this.sensitivity.pad * dt;
      const map = ['jump', 'descend', 'interact', 'view', 'rollLeft', 'rollRight', 'brake', 'sprint', 'map', 'back_out', 'alt'];
      for (let i = 0; i < map.length; i++) {
        const down = !!(pad.buttons[i] && pad.buttons[i].pressed);
        if (down !== !!this._padPrev[i]) { this.setVirtual(map[i], down); this._padPrev[i] = down; if (down) { this._setDevice('gamepad'); this._gesture(); } }
      }
      break;
    }
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const sens = this.settings.sensitivity || 1;
    lx *= sens; ly *= sens * (this.settings.invertY ? -1 : 1);
    if (this.enabled && !this._blocks.size) {
      this.move.x = mx; this.move.y = my;
      this.look.x = lx; this.look.y = ly;
      this.zoom = this._zoomAcc;
    } else {
      this.move.x = this.move.y = this.look.x = this.look.y = this.zoom = 0;
    }
    this._lookAcc.x = 0; this._lookAcc.y = 0; this._zoomAcc = 0;
  }
  /** Call once at the end of each frame. */
  endFrame() { this._hitCodes.clear(); this._vHit.clear(); }

  _has(action) { for (const c of this.actions[action]) if (this._codes.has(c)) return true; return false; }
  _gesture() { for (const cb of this._gestureCbs) cb(); }
  _setPointer(x, y) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = x - r.left; this.pointer.y = y - r.top;
    this.pointer.nx = (this.pointer.x / r.width) * 2 - 1;
    this.pointer.ny = -((this.pointer.y / r.height) * 2 - 1);
  }
  _tap(button = 0) {
    if (!this.enabled || this._blocks.size) return;
    const p = this.pointer;
    for (const cb of this._tapCbs) cb({ x: p.x, y: p.y, nx: p.nx, ny: p.ny, button });
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.altKey) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._setDevice('keyboard');
      // Esc while the pointer is (or was just) locked only releases the pointer — never a `back_out`.
      if (e.code === 'Escape' && (this.locked || performance.now() - this._unlockAt < 450)) {
        this._gesture(); for (const cb of this._keyCbs) cb('PointerRelease', e);
        return;
      }
      this._codes.add(e.code); this._hitCodes.add(e.code); this._gesture(); for (const cb of this._keyCbs) cb(e.code, e);
    });
    window.addEventListener('pointerdown', (e) => this._setDevice(e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'touch' : 'keyboard'), true);
    window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && (Math.abs(e.movementX) + Math.abs(e.movementY) > 2)) this._setDevice('keyboard'); }, true);
    window.addEventListener('keyup', (e) => { this._codes.delete(e.code); });
    window.addEventListener('blur', () => { this._codes.clear(); this._vHeld.clear(); this._mouse.down = false; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // mouse
    c.addEventListener('mousedown', (e) => {
      this._gesture();
      this._setPointer(e.clientX, e.clientY);
      this._mouse.down = true; this._mouse.moved = 0; this._mouse.button = e.button; this.pointer.down = true;
      if (this.scheme.pointerLock && !this.locked && this.enabled && !this._blocks.size && c.requestPointerLock) {
        try { const p = c.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* headless / denied */ }
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (!this._mouse.down) return;
      this._mouse.down = false; this.pointer.down = false;
      if (this._mouse.moved < 6 && !this.locked) this._tap(e.button);
    });
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this._lookAcc.x += e.movementX * this.sensitivity.mouse;
        this._lookAcc.y += e.movementY * this.sensitivity.mouse;
        return;
      }
      this._setPointer(e.clientX, e.clientY);
      this.pointer.over = true;
      if (this._mouse.down) {
        this._mouse.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
        this._lookAcc.x += e.movementX * this.sensitivity.mouse * 1.6;
        this._lookAcc.y += e.movementY * this.sensitivity.mouse * 1.6;
      }
    });
    c.addEventListener('mouseleave', () => { this.pointer.over = false; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      this._zoomAcc += Math.max(-3, Math.min(3, (e.deltaY * k) / 120));
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === c;
      if (was && !this.locked) { this._unlockAt = performance.now(); this._codes.clear(); }
      if (was !== this.locked) for (const cb of this._lockCbs) cb(this.locked);
    });

    // touch
    const touchStart = (e) => {
      e.preventDefault();
      this._gesture();
      const r = c.getBoundingClientRect();
      for (const t of e.changedTouches) {
        const x = t.clientX - r.left, y = t.clientY - r.top;
        let role = 'look';
        if (this.scheme.joystick && !this.stick.active && x < r.width * 0.45 && y > r.height * 0.25) {
          role = 'stick';
          this.stick.active = true; this.stick.ox = x; this.stick.oy = y; this.stick.x = 0; this.stick.y = 0;
          haptic(6);
        }
        this._touches.set(t.identifier, { role, sx: x, sy: y, x, y, t0: performance.now(), moved: 0 });
      }
      this._pinch = this._pinchDist();
    };
    const touchMove = (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const looks = [...this._touches.values()].filter((t) => t.role === 'look').length;
      for (const t of e.changedTouches) {
        const s = this._touches.get(t.identifier);
        if (!s) continue;
        const x = t.clientX - r.left, y = t.clientY - r.top;
        const dx = x - s.x, dy = y - s.y;
        s.moved += Math.abs(dx) + Math.abs(dy);
        s.x = x; s.y = y;
        if (s.role === 'stick') {
          let jx = (x - this.stick.ox) / this.stick.radius, jy = (y - this.stick.oy) / this.stick.radius;
          const l = Math.hypot(jx, jy);
          if (l > 1) {
            // let the stick origin trail the thumb so it never "runs out"
            this.stick.ox += (jx - jx / l) * this.stick.radius; this.stick.oy += (jy - jy / l) * this.stick.radius;
            jx /= l; jy /= l;
          }
          this.stick.x = jx; this.stick.y = jy;
        } else if (looks < 2) {
          this._lookAcc.x += dx * this.sensitivity.touch;
          this._lookAcc.y += dy * this.sensitivity.touch;
        }
      }
      if (looks >= 2) {
        const d = this._pinchDist();
        if (this._pinch > 0 && d > 0) this._zoomAcc += (this._pinch - d) / 60;
        this._pinch = d;
      }
    };
    const touchEnd = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const s = this._touches.get(t.identifier);
        if (!s) continue;
        this._touches.delete(t.identifier);
        if (s.role === 'stick') { this.stick.active = false; this.stick.x = 0; this.stick.y = 0; }
        else if (s.moved < 12 && performance.now() - s.t0 < 320) {
          const r = c.getBoundingClientRect();
          this._setPointer(s.x + r.left, s.y + r.top);
          this._tap(0);
        }
      }
      this._pinch = this._pinchDist();
    };
    c.addEventListener('touchstart', touchStart, { passive: false });
    c.addEventListener('touchmove', touchMove, { passive: false });
    c.addEventListener('touchend', touchEnd, { passive: false });
    c.addEventListener('touchcancel', touchEnd, { passive: false });
  }

  _pinchDist() {
    const ls = [...this._touches.values()].filter((t) => t.role === 'look');
    if (ls.length < 2) return 0;
    return Math.hypot(ls[0].x - ls[1].x, ls[0].y - ls[1].y);
  }
}

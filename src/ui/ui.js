// Minimal, immersive HUD. DOM overlay (crisp at any resolution), pointer-events off except real buttons.
// The API below is the contract every scale uses; visuals live in ui.css (design tokens at the top).
//
//   ui.title(main, sub, { style: 'hero'|'arrival', hold, kicker }) -> Promise   cinematic title / arrival card
//   ui.hideTitle()
//   ui.caption(text, { duration, speaker })  narration subtitle (serif italic, bottom centre); '' / null hides
//   ui.toast(text, { duration })             small transient notice (top centre)
//   ui.setLocation({ kicker, name, detail }) discreet location header (top-left); null hides it
//   ui.prompt({ key, text, action, icon })   context prompt (bottom centre; keycap on desktop, tappable pill on
//                                            touch); tap/click triggers `action` (default 'interact'); null hides
//   ui.label(id, { x, y, text, sub, visible, kind, priority, distance })   floating label at canvas px
//        kind: '' | 'marker' | 'target' | 'faint' | 'dotless'; distance: metres (number) or a ready string.
//        Overlapping labels: the lower-priority one folds to its dot. Cheap to call every frame.
//   ui.removeLabel(id)
//   ui.setActions([{ action, label, icon, toggle }])   touch buttons (≤ 4, arc near the right thumb). The icon is
//        the inline-SVG icon named `icon` or `action` (see icons.js); any other string is shown as a glyph.
//   ui.setHints([{ key, text }], { duration })         brief control hints (desktop), fade on their own
//   ui.setReticle('none' | 'dot' | 'ring' | 'cross')
//   ui.setVisible(bool)                      hide the whole HUD (cinematics / photo mode)
//   ui.clearContext()                        called automatically on every scale change
//   ui.gate({ title, sub, hint }) -> Promise resolved by the first user gesture (needed to unlock audio)
//   ui.icon(name) -> inline SVG markup string
import { icon, hasIcon } from './icons.js';

const el = (tag, cls, parent, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
};
const haptic = (ms) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
// deterministic per-letter jitter (UI only, nothing persistent)
const jitter = (i, n) => { const s = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453; return s - Math.floor(s); };

const KEY_NAMES = { Escape: 'Esc', Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', Enter: '↵', Tab: 'Tab' };
const keyText = (k) => {
  if (!k) return '';
  if (KEY_NAMES[k]) return KEY_NAMES[k];
  if (/^Key[A-Z]$/.test(k)) return k.slice(3);
  if (/^Digit\d$/.test(k)) return k.slice(5);
  return k.length <= 2 ? k.toUpperCase() : k;
};
/** fill `parent` with keycaps for "W A S D", "Space / C", "Shift" … */
function keycaps(parent, keys) {
  parent.textContent = '';
  const parts = String(keys).split(/\s*\/\s*/);
  parts.forEach((p, i) => {
    if (i) el('span', 'ui-key-sep', parent, '/');
    const t = keyText(p.trim());
    el('span', t.length > 2 ? 'ui-key wide' : 'ui-key', parent, t);
  });
}
/** split a string into revealable letter spans */
function letters(parent, text, { spread = 0.45, delay0 = 0.3, step = 0.085, jit = 0.22 } = {}) {
  parent.textContent = '';
  const chars = [...String(text)];
  const n = chars.length, c = (n - 1) / 2;
  chars.forEach((ch, i) => {
    const s = el('span', ch === ' ' ? 'ch sp' : 'ch', parent, ch === ' ' ? '' : ch);
    const o = (i - c) * spread;
    s.style.setProperty('--o', o.toFixed(3));
    s.style.setProperty('--d', `${(delay0 + i * step + jitter(i, n) * jit).toFixed(3)}s`);
    s.style.setProperty('--dx', `${(Math.abs(i - c) / Math.max(1, c) * 0.25 + jitter(i + 7, n) * 0.12).toFixed(3)}s`);
  });
  return n;
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : m < 1e5 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000).toLocaleString('en')} km`);

const MAX_LABEL_RECTS = 512;

export class UI {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.input = ctx.input;
    this.icon = icon;
    root.classList.add('sonder-ui');
    if (this.input.isTouch) root.classList.add('touch');
    root.dataset.device = this.input.device || (this.input.isTouch ? 'touch' : 'keyboard');
    this.input.onDevice?.((d) => { root.dataset.device = d; });

    // z-order: world-anchored first, cinematic last
    this.elLabels = el('div', 'ui-labels', root);
    this.elReticle = el('div', 'ui-reticle', root);
    this.elLoc = el('div', 'ui-loc', root);
    this.elLocKicker = el('div', 'ui-loc-kicker', this.elLoc);
    this.elLocName = el('div', 'ui-loc-name', this.elLoc);
    this.elLocDetail = el('div', 'ui-loc-detail', this.elLoc);
    this.elHints = el('div', 'ui-hints', root);
    this.elCaption = el('div', 'ui-caption', root);
    this._caps = [0, 1].map(() => {
      const n = el('div', 'ui-cap', this.elCaption);
      return { node: n, who: el('span', 'ui-cap-who', n), txt: el('span', 'ui-cap-txt', n), text: '' };
    });
    this._capI = 0;
    this.elPrompt = el('button', 'ui-prompt', root);
    this.elPrompt.type = 'button';
    this.elPromptIco = el('span', 'ui-prompt-ico', this.elPrompt);
    this.elPromptKey = el('span', 'ui-prompt-key', this.elPrompt);
    this.elPromptText = el('span', 'ui-prompt-text', this.elPrompt);
    this.elTitle = el('div', 'ui-title', root);
    this.elTitleKicker = el('div', 'ui-title-kicker', this.elTitle);
    this.elTitleMain = el('div', 'ui-title-main', this.elTitle);
    this.elTitleRule = el('div', 'ui-title-rule', this.elTitle);
    this.elTitleSub = el('div', 'ui-title-sub', this.elTitle);
    this.elToast = el('div', 'ui-toast', root);
    this.elToastText = el('span', '', this.elToast);
    // touch layer
    this.elStickGhost = el('div', 'ui-stick-ghost', root);
    el('div', 'ui-stick-ring', this.elStickGhost); el('div', 'ui-stick-knob', this.elStickGhost);
    this.elStick = el('div', 'ui-stick', root);
    el('div', 'ui-stick-ring', this.elStick);
    this.elStickDir = el('div', 'ui-stick-dir', this.elStick);
    this.elStickKnob = el('div', 'ui-stick-knob', this.elStick);
    this.elActions = el('div', 'ui-actions', root);

    this.labels = new Map();
    this._labelPool = [];
    this._lv = [];                                   // visible labels, reused every frame
    this._rects = new Float32Array(MAX_LABEL_RECTS * 4);
    this._promptKey = '';
    this._promptAction = null;
    this._actionsKey = '';
    this._actionBtns = [];
    this._timers = {};
    this._titleRes = null;
    this._stickUses = 0;
    this._st = { on: false, ox: NaN, oy: NaN, kx: NaN, ky: NaN, push: false, a: NaN, ghost: false };

    // prompt: tap / click fires its action
    const firePrompt = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!this._promptAction) return;
      this.input.trigger(this._promptAction); haptic(8);
      this.elPrompt.classList.add('press');
      this._later('press', 160, () => this.elPrompt.classList.remove('press'));
    };
    this.elPrompt.addEventListener('pointerdown', firePrompt);
    this._positionGhost();
    this._guardBrowserGestures();
  }

  _show(node, on) { node.classList.toggle('on', !!on); }
  _later(key, ms, fn) { clearTimeout(this._timers[key]); this._timers[key] = setTimeout(fn, ms); }
  _clear(key) { clearTimeout(this._timers[key]); }

  /** No pinch-zoom, double-tap zoom, pull-to-refresh, context menus or text selection anywhere. */
  _guardBrowserGestures() {
    const pd = (e) => e.preventDefault();
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, pd, { passive: false });
    document.addEventListener('dblclick', pd, { passive: false });
    document.addEventListener('contextmenu', pd);
    document.addEventListener('selectstart', pd);
    document.addEventListener('touchmove', (e) => { if (!e.target.closest?.('.ui-scroll')) e.preventDefault(); }, { passive: false });
  }

  // ---------------------------------------------------------------- cinematic title
  title(main, sub = '', { hold = 4.5, style = 'hero', kicker = '' } = {}) {
    const t = this.elTitle;
    if (this._titleRes) { const r = this._titleRes; this._titleRes = null; r(); }
    this._clear('title'); this._clear('titleOut');
    const n = letters(this.elTitleMain, main || '', style === 'arrival'
      ? { spread: 0.35, delay0: 0.15, step: 0.05, jit: 0.15 }
      : { spread: 0.45, delay0: 0.35, step: 0.09, jit: 0.25 });
    const fitN = style === 'arrival' ? 11 : 8;
    t.style.setProperty('--fit', Math.min(1, fitN / Math.max(1, n)).toFixed(3));
    this.elTitleKicker.textContent = '';
    if (kicker) el('span', '', this.elTitleKicker, kicker);
    this.elTitleSub.textContent = sub || '';
    t.className = `ui-title ${style === 'arrival' ? 'arrival' : 'hero'}`;
    void t.offsetWidth;                               // commit the hidden state so the reveal transitions
    t.classList.add('on');
    return new Promise((res) => {
      this._titleRes = res;
      if (hold > 0 && Number.isFinite(hold)) this._later('title', hold * 1000, () => this.hideTitle());
    });
  }
  hideTitle() {
    this._clear('title');
    const t = this.elTitle;
    if (!t.classList.contains('on')) { if (this._titleRes) { const r = this._titleRes; this._titleRes = null; r(); } return; }
    t.classList.remove('on'); t.classList.add('out');
    this._later('titleOut', 1900, () => {
      t.classList.remove('out');
      if (this._titleRes) { const r = this._titleRes; this._titleRes = null; r(); }
    });
  }

  // ---------------------------------------------------------------- narration
  caption(text, { duration = 5, speaker = '' } = {}) {
    const cur = this._caps[this._capI];
    if (!text) {
      this._clear('caption');
      cur.node.classList.remove('on'); cur.node.classList.add('off'); cur.text = '';
      return;
    }
    if (cur.text === text && cur.node.classList.contains('on')) {
      // same line again: just extend
    } else {
      if (cur.node.classList.contains('on')) { cur.node.classList.remove('on'); cur.node.classList.add('off'); cur.text = ''; }
      this._capI ^= 1;
      const c = this._caps[this._capI];
      c.node.classList.remove('on', 'off');
      c.who.textContent = speaker || '';
      c.txt.textContent = text; c.text = text;
      void c.node.offsetWidth;
      c.node.classList.add('on');
    }
    if (duration > 0) this._later('caption', duration * 1000, () => this.caption(null));
    else this._clear('caption');
  }

  toast(text, { duration = 3.2 } = {}) {
    this.elToastText.textContent = text; this._show(this.elToast, !!text);
    if (text) this._later('toast', duration * 1000, () => this._show(this.elToast, false));
  }

  setLocation(info) {
    if (!info) { this._show(this.elLoc, false); return; }
    this.elLocKicker.textContent = info.kicker || ''; this.elLocName.textContent = info.name || ''; this.elLocDetail.textContent = info.detail || '';
    this._show(this.elLoc, true);
  }

  // ---------------------------------------------------------------- context prompt
  prompt(p) {
    if (!p) {
      if (this._promptAction) { this._show(this.elPrompt, false); this.root.classList.remove('has-prompt'); }
      this._promptAction = null; this._promptKey = '';
      return;
    }
    const action = p.action || 'interact';
    const key = p.key || 'E';
    const k = `${action}|${key}|${p.text || ''}|${p.icon || ''}`;
    this._promptAction = action;
    if (k !== this._promptKey) {
      this._promptKey = k;
      this.elPromptIco.innerHTML = icon(p.icon && hasIcon(p.icon) ? p.icon : hasIcon(action) ? action : 'interact');
      keycaps(this.elPromptKey, key);
      this.elPromptText.textContent = p.text || '';
    }
    this._show(this.elPrompt, true);
    this.root.classList.add('has-prompt');
  }

  // ---------------------------------------------------------------- floating labels
  label(id, { x = 0, y = 0, text, sub, visible = true, kind = '', priority = 0, distance } = {}) {
    let l = this.labels.get(id);
    if (!l) {
      l = this._labelPool.pop();
      if (!l) {
        const node = el('div', 'ui-label');
        const dot = el('div', 'ui-label-dot', node);
        const txt = el('div', 'ui-label-txt', node);
        const main = el('div', 'ui-label-main', txt);
        const subRow = el('div', 'ui-label-sub', txt);
        const subT = el('span', '', subRow);
        const dist = el('span', 'ui-label-dist', subRow);
        l = { node, dot, txt, main, subRow, subT, dist };
      }
      Object.assign(l, { text: null, subText: null, distKey: null, kind: null, x: NaN, y: NaN, vis: false, on: false, crowd: false, prio: 0, w: 0, h: 14 });
      this.elLabels.appendChild(l.node);
      this.labels.set(id, l);
    }
    if (text !== undefined && text !== l.text) { l.main.textContent = text ?? ''; l.text = text; l.w = Math.max(l.w0 = (String(text ?? '').length * 9.4 + 4), l.w1 || 0); }
    if (sub !== undefined && sub !== l.subText) { l.subT.textContent = sub || ''; l.subText = sub; this._labelSub(l); }
    if (distance !== undefined) {
      const dk = typeof distance === 'number' ? (distance < 1000 ? Math.round(distance / 5) * 5 : distance < 1e5 ? Math.round(distance / 100) * 100 : Math.round(distance / 1000) * 1000) : distance;
      if (dk !== l.distKey) { l.distKey = dk; l.dist.textContent = dk == null || dk === '' ? '' : typeof dk === 'number' ? fmtDist(dk) : dk; this._labelSub(l); }
    }
    if (kind !== l.kind) { l.node.className = `ui-label${kind ? ' ' + kind : ''}${l.on ? ' on' : ''}${l.crowd ? ' crowd' : ''}`; l.kind = kind; }
    l.prio = priority;
    if (Math.abs(x - l.x) > 0.05 || Math.abs(y - l.y) > 0.05) {
      l.x = x; l.y = y;
      l.node.style.transform = `translate3d(${Math.round(x * 2) / 2}px,${Math.round(y * 2) / 2}px,0)`;
    }
    l.vis = !!visible;
  }
  _labelSub(l) {
    const s = (l.subText || '').length + (l.dist.textContent ? l.dist.textContent.length + 2 : 0);
    l.w1 = s * 6.4; l.w = Math.max(l.w0 || 0, l.w1); l.h = s ? 28 : 14;
  }
  removeLabel(id) {
    const l = this.labels.get(id);
    if (!l) return;
    l.node.remove(); this.labels.delete(id);
    l.node.classList.remove('on', 'crowd'); l.on = false; l.crowd = false;
    if (this._labelPool.length < 64) this._labelPool.push(l);
  }
  /** Per frame: decide which labels show text (priority first, greedy rectangle packing). No layout reads. */
  _layoutLabels() {
    const lv = this._lv; lv.length = 0;
    for (const l of this.labels.values()) {
      if (l.vis !== l.on) { l.on = l.vis; l.node.classList.toggle('on', l.on); }
      if (l.vis) lv.push(l);
    }
    if (lv.length > 1) lv.sort(byPriority);
    const R = this._rects; let nr = 0;
    for (let i = 0; i < lv.length; i++) {
      const l = lv[i];
      const dotless = l.kind === 'dotless';
      const x0 = dotless ? l.x - l.w / 2 : l.x - 6, y0 = l.y - 8, x1 = dotless ? l.x + l.w / 2 : l.x + 14 + l.w, y1 = l.y - 6 + l.h;
      let hit = false;
      for (let j = 0; j < nr; j += 4) if (x0 < R[j + 2] && x1 > R[j] && y0 < R[j + 3] && y1 > R[j + 1]) { hit = true; break; }
      if (!hit && nr < R.length) { R[nr] = x0; R[nr + 1] = y0; R[nr + 2] = x1; R[nr + 3] = y1; nr += 4; }
      if (hit !== l.crowd) { l.crowd = hit; l.node.classList.toggle('crowd', hit); }
    }
  }

  // ---------------------------------------------------------------- touch actions
  setActions(list = []) {
    list = (list || []).slice(0, 4);
    const key = list.map((a) => `${a.action}:${a.label || ''}:${a.icon || ''}:${a.toggle ? 1 : 0}`).join('|');
    if (key === this._actionsKey) return;
    this._actionsKey = key;
    for (const b of this._actionBtns) { if (b._held) this.input.setVirtual(b._action, false); b.remove(); }
    this._actionBtns = [];
    this.elActions.classList.remove('on');
    const n = list.length;
    // primary in the thumb's resting spot, the rest on an arc around it
    const slots = [[-30, -34, 58], [-122, -30, 46], [-102, -102, 46], [-34, -124, 46]];
    if (n === 2) slots[1] = [-112, -54, 46];
    list.forEach((a, i) => {
      const [x, y, s] = slots[i];
      const b = el('button', 'ui-action', this.elActions);
      b.type = 'button';
      b.style.setProperty('--x', `${x}px`); b.style.setProperty('--y', `${y}px`); b.style.setProperty('--s', `${s}px`);
      b.style.transitionDelay = `${i * 0.04}s`;
      el('span', 'ui-action-disc', b);
      const ic = el('span', 'ui-action-icon', b);
      const name = a.icon && hasIcon(a.icon) ? a.icon : hasIcon(a.action) ? a.action : null;
      if (name) ic.innerHTML = icon(name);
      else el('span', 'ui-glyph', ic, a.icon || (a.label || a.action || '?').slice(0, 1).toUpperCase());
      if (a.label) el('span', 'ui-action-label', b, a.label);
      b.dataset.action = a.action; b.setAttribute('aria-label', a.label || a.action);
      b._action = a.action; b._held = false;
      const down = (e) => {
        e.preventDefault(); e.stopPropagation();
        try { b.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        haptic(7);
        if (a.toggle) { const on = !b.classList.contains('toggled'); b.classList.toggle('toggled', on); this.input.setVirtual(a.action, on); b._held = on; if (!on) this.input.trigger(a.action); }
        else { b._held = true; this.input.setVirtual(a.action, true); }
        b.classList.add('down');
      };
      const up = (e) => {
        if (e) e.preventDefault();
        b.classList.remove('down');
        if (!a.toggle && b._held) { b._held = false; this.input.setVirtual(a.action, false); }
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', () => up());
      this._actionBtns.push(b);
    });
    if (n) requestAnimationFrame(() => this.elActions.classList.add('on'));
  }

  // ---------------------------------------------------------------- hints / reticle / visibility
  setHints(list = [], { duration = 9 } = {}) {
    this.elHints.textContent = '';
    this.elHints.classList.remove('on', 'off');
    this._clear('hints');
    if (!list || !list.length) return;
    list.forEach((h, i) => {
      const r = el('div', 'ui-hint', this.elHints);
      r.style.setProperty('--i', i);
      keycaps(el('span', 'ui-hint-keys', r), h.key);
      el('span', 'ui-hint-text', r, h.text);
    });
    void this.elHints.offsetWidth;
    this.elHints.classList.add('on');
    if (duration > 0) this._later('hints', duration * 1000, () => { this.elHints.classList.add('off'); this.elHints.classList.remove('on'); });
  }
  setReticle(kind = 'none') { this.elReticle.className = `ui-reticle ${kind || 'none'}`; }
  setVisible(v) { this.root.classList.toggle('hidden', !v); }

  // ---------------------------------------------------------------- opening gate
  /** Opening gate: wordmark + a breathing "click to begin". Resolves on the first gesture (unlocks audio). */
  gate({ title = 'SONDER', sub = 'a universe, simulated', hint = this.input.isTouch ? 'touch to begin' : 'click to begin', phones = true } = {}) {
    return new Promise((resolve) => {
      const g = el('div', 'ui-gate', this.root.parentNode);
      g.setAttribute('role', 'button'); g.setAttribute('aria-label', `${title}. ${hint}`);
      letters(el('div', 'ui-gate-mark', g), title, { spread: 0.5, delay0: 0.25, step: 0.12, jit: 0.3 });
      el('div', 'ui-gate-rule', g);
      if (sub) el('div', 'ui-gate-sub', g, sub);
      const foot = el('div', 'ui-gate-foot', g);
      el('div', 'ui-gate-hint', foot, hint);
      if (phones) { const p = el('div', 'ui-gate-phones', foot); p.innerHTML = icon('headphones'); el('span', '', p, 'headphones recommended'); }
      // tiny affordances: quality tier (reloads) and sound
      const q = this.ctx.quality?.tier || this.ctx.params?.quality || 'auto';
      const left = el('div', 'ui-gate-corner l', g);
      const qb = el('button', 'ui-gate-btn', left); qb.type = 'button';
      qb.innerHTML = `<span>quality</span><b>${q}</b>`;
      qb.title = 'cycle quality tier (reloads)';
      const right = el('div', 'ui-gate-corner r', g);
      const sb = el('button', 'ui-gate-btn', right); sb.type = 'button';
      const drawSound = () => { const m = !!this.ctx.audio?.muted; sb.innerHTML = `<span>${m ? 'sound off' : 'sound on'}</span>${icon(m ? 'mute' : 'sound')}`; };
      drawSound();
      const stop = (e) => { e.stopPropagation(); };
      qb.addEventListener('pointerdown', stop); sb.addEventListener('pointerdown', stop);
      qb.addEventListener('click', (e) => {
        e.stopPropagation();
        const tiers = ['low', 'medium', 'high', 'ultra'];
        const next = tiers[(tiers.indexOf(q) + 1) % tiers.length];
        const u = new URL(location.href); u.searchParams.set('quality', next); location.replace(u.toString());
      });
      sb.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.audio?.setMuted?.(!this.ctx.audio.muted); drawSound(); });

      void g.offsetWidth;
      requestAnimationFrame(() => g.classList.add('on'));
      let done = false;
      const finish = (e) => {
        if (done) return;
        if (e.type === 'keydown' && (e.key === 'Tab' || e.metaKey || e.altKey || e.ctrlKey)) return;
        if (e.type === 'keydown' && (e.key === 'Enter' || e.key === ' ') && e.target?.closest?.('.ui-gate-btn')) return;
        done = true;
        e.preventDefault();
        window.removeEventListener('keydown', finish, true); g.removeEventListener('pointerdown', finish);
        g.classList.remove('on'); g.classList.add('out');
        setTimeout(() => g.remove(), 3200);
        resolve();
      };
      g.addEventListener('pointerdown', finish); window.addEventListener('keydown', finish, true);
    });
  }

  clearContext() {
    for (const id of [...this.labels.keys()]) this.removeLabel(id);
    this.prompt(null); this.setActions([]); this.setHints([]); this.setReticle('none');
  }

  _positionGhost() {
    const s = this.elStickGhost.style;
    s.left = 'calc(108px + var(--safe-l))'; s.top = 'auto'; s.bottom = 'calc(118px + var(--safe-b))';
  }

  update() {
    // stick — write only what changed
    const s = this.input.stick, st = this._st;
    const on = !!s.active && !this.input.blocked;
    if (on !== st.on) { st.on = on; this.elStick.classList.toggle('on', on); if (on) this._stickUses++; }
    if (on) {
      if (s.ox !== st.ox || s.oy !== st.oy) { st.ox = s.ox; st.oy = s.oy; this.elStick.style.transform = `translate3d(${s.ox}px,${s.oy}px,0)`; }
      const kx = Math.round(s.x * s.radius * 2) / 2, ky = Math.round(s.y * s.radius * 2) / 2;
      if (kx !== st.kx || ky !== st.ky) { st.kx = kx; st.ky = ky; this.elStickKnob.style.transform = `translate3d(${kx}px,${ky}px,0)`; }
      const push = s.x * s.x + s.y * s.y > 0.06;
      if (push !== st.push) { st.push = push; this.elStick.classList.toggle('push', push); }
      if (push) {
        const a = Math.round(Math.atan2(s.x, -s.y) * 50) / 50;
        if (a !== st.a) { st.a = a; this.elStickDir.style.setProperty('--a', `${a}rad`); }
      }
    }
    const ghost = this.input.isTouch && !!this.input.scheme?.joystick && !on && this._stickUses < 3 && !this.input.blocked;
    if (ghost !== st.ghost) { st.ghost = ghost; this.elStickGhost.classList.toggle('on', ghost); }
    if (this.labels.size) this._layoutLabels();
  }
}

function byPriority(a, b) { return (b.prio - a.prio) || (a.y - b.y); }

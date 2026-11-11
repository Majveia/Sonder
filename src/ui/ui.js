// Minimal, immersive HUD. DOM overlay (crisp at any resolution), pointer-events off except real buttons.
// The API below is the contract every scale uses; visuals live in ui.css.
//
//   ui.title(main, sub, { hold })            big cinematic title card -> Promise
//   ui.caption(text, { duration })           narration subtitle (bottom centre)
//   ui.toast(text, { duration })             small transient notice
//   ui.setLocation({ kicker, name, detail }) discreet location header (top-left); null hides it
//   ui.prompt({ key, text, action })         context prompt (bottom centre); tap/click triggers `action`; null hides
//   ui.label(id, { x, y, text, sub, visible, kind })   floating label at canvas px (hover names, markers)
//   ui.removeLabel(id)
//   ui.setActions([{ action, label, icon, hold }])     touch buttons (mobile) / faint key hints (desktop)
//   ui.setHints([{ key, text }], { duration })         brief control hints, fade on their own
//   ui.setReticle('none' | 'dot' | 'ring')
//   ui.setVisible(bool)                      hide the whole HUD (cinematics / photo mode)
//   ui.clearContext()                        called automatically on every scale change

const el = (tag, cls, parent, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
};

export class UI {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.input = ctx.input;
    root.classList.add('sonder-ui');
    if (this.input.isTouch) root.classList.add('touch');
    this.elTitle = el('div', 'ui-title', root);
    this.elTitleMain = el('div', 'ui-title-main', this.elTitle);
    this.elTitleSub = el('div', 'ui-title-sub', this.elTitle);
    this.elCaption = el('div', 'ui-caption', root);
    this.elToast = el('div', 'ui-toast', root);
    this.elLoc = el('div', 'ui-loc', root);
    this.elLocKicker = el('div', 'ui-loc-kicker', this.elLoc);
    this.elLocName = el('div', 'ui-loc-name', this.elLoc);
    this.elLocDetail = el('div', 'ui-loc-detail', this.elLoc);
    this.elPrompt = el('button', 'ui-prompt', root);
    this.elPromptKey = el('span', 'ui-prompt-key', this.elPrompt);
    this.elPromptText = el('span', 'ui-prompt-text', this.elPrompt);
    this.elLabels = el('div', 'ui-labels', root);
    this.elActions = el('div', 'ui-actions', root);
    this.elHints = el('div', 'ui-hints', root);
    this.elReticle = el('div', 'ui-reticle', root);
    this.elStick = el('div', 'ui-stick', root);
    this.elStickKnob = el('div', 'ui-stick-knob', this.elStick);
    this.labels = new Map();
    this._promptAction = null;
    this._timers = {};
    const fire = (e) => { e.preventDefault(); if (this._promptAction) this.input.trigger(this._promptAction); };
    this.elPrompt.addEventListener('pointerdown', fire);
  }

  _show(node, on) { node.classList.toggle('on', !!on); }
  _later(key, ms, fn) { clearTimeout(this._timers[key]); this._timers[key] = setTimeout(fn, ms); }

  title(main, sub = '', { hold = 4.5 } = {}) {
    this.elTitleMain.textContent = main; this.elTitleSub.textContent = sub;
    this._show(this.elTitle, true);
    return new Promise((res) => this._later('title', hold * 1000, () => { this._show(this.elTitle, false); setTimeout(res, 1600); }));
  }
  hideTitle() { clearTimeout(this._timers.title); this._show(this.elTitle, false); }

  caption(text, { duration = 5 } = {}) {
    if (!text) { this._show(this.elCaption, false); return; }
    this.elCaption.textContent = text; this._show(this.elCaption, true);
    if (duration > 0) this._later('caption', duration * 1000, () => this._show(this.elCaption, false));
  }
  toast(text, { duration = 3.2 } = {}) {
    this.elToast.textContent = text; this._show(this.elToast, true);
    this._later('toast', duration * 1000, () => this._show(this.elToast, false));
  }
  setLocation(info) {
    if (!info) { this._show(this.elLoc, false); return; }
    this.elLocKicker.textContent = info.kicker || ''; this.elLocName.textContent = info.name || ''; this.elLocDetail.textContent = info.detail || '';
    this._show(this.elLoc, true);
  }
  prompt(p) {
    if (!p) { this._show(this.elPrompt, false); this._promptAction = null; return; }
    this._promptAction = p.action || 'interact';
    this.elPromptKey.textContent = this.input.isTouch ? '' : (p.key || 'E');
    this.elPromptKey.style.display = this.input.isTouch ? 'none' : '';
    this.elPromptText.textContent = p.text || '';
    this._show(this.elPrompt, true);
  }
  label(id, { x = 0, y = 0, text, sub, visible = true, kind = '' } = {}) {
    let l = this.labels.get(id);
    if (!l) {
      const node = el('div', 'ui-label', this.elLabels);
      l = { node, main: el('div', 'ui-label-main', node), sub: el('div', 'ui-label-sub', node), text: null, subText: null, kind: null };
      this.labels.set(id, l);
    }
    if (text !== undefined && text !== l.text) { l.main.textContent = text; l.text = text; }
    if (sub !== undefined && sub !== l.subText) { l.sub.textContent = sub || ''; l.subText = sub; }
    if (kind !== l.kind) { l.node.className = `ui-label ${kind}`; l.kind = kind; }
    l.node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    l.node.classList.toggle('on', !!visible);
  }
  removeLabel(id) { const l = this.labels.get(id); if (l) { l.node.remove(); this.labels.delete(id); } }

  setActions(list = []) {
    this.elActions.textContent = '';
    for (const a of list) {
      const b = el('button', 'ui-action', this.elActions);
      el('span', 'ui-action-icon', b, a.icon || '');
      el('span', 'ui-action-label', b, a.label || '');
      b.dataset.action = a.action;
      const down = (e) => { e.preventDefault(); b.classList.add('down'); this.input.setVirtual(a.action, true); };
      const up = (e) => { e.preventDefault(); b.classList.remove('down'); this.input.setVirtual(a.action, false); };
      b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
    }
  }
  setHints(list = [], { duration = 9 } = {}) {
    this.elHints.textContent = '';
    for (const h of list) { const r = el('div', 'ui-hint', this.elHints); el('span', 'ui-hint-key', r, h.key); el('span', 'ui-hint-text', r, h.text); }
    this._show(this.elHints, list.length > 0);
    if (duration > 0) this._later('hints', duration * 1000, () => this._show(this.elHints, false));
  }
  setReticle(kind = 'none') { this.elReticle.className = `ui-reticle ${kind}`; }
  setVisible(v) { this.root.classList.toggle('hidden', !v); }

  clearContext() {
    for (const id of [...this.labels.keys()]) this.removeLabel(id);
    this.prompt(null); this.setActions([]); this.setHints([]); this.setReticle('none');
  }

  update() {
    const s = this.input.stick;
    if (s.active) {
      this.elStick.classList.add('on');
      this.elStick.style.transform = `translate3d(${s.ox}px, ${s.oy}px, 0)`;
      this.elStickKnob.style.transform = `translate3d(${s.x * s.radius}px, ${s.y * s.radius}px, 0)`;
    } else this.elStick.classList.remove('on');
  }
}

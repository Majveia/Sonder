// Cosmic-time scrubber: a hairline from the Big Bang to today, a play/pause glyph and a
// comoving/expanding toggle. Lives in the #ui root, styled with the ui.css tokens. Pure UI —
// its own pointer handling only (the overlay has pointer-events none elsewhere).
const CSS = `
.cw-time { position: absolute; left: 50%; bottom: calc(22px + var(--safe-b, 0px)); transform: translateX(-50%); width: min(46vw, 520px);
  display: flex; align-items: center; gap: 14px; opacity: 0; transition: opacity var(--d-3, 1.1s) var(--ease, ease); pointer-events: none; }
.cw-time.on { opacity: 1; pointer-events: auto; }
.sonder-ui.has-prompt .cw-time { bottom: calc(76px + var(--safe-b, 0px)); }
.cw-btn { flex: none; font: inherit; color: var(--ink-2, #ccd); background: none; border: 0; padding: 4px; margin: 0; cursor: pointer; pointer-events: auto;
  font-size: var(--t-2xs, 9px); letter-spacing: var(--tr-2, 0.26em); text-transform: uppercase; text-shadow: var(--halo-soft, none); transition: color var(--d-1, 0.18s); }
.cw-btn:hover { color: var(--ink, #fff); }
.cw-play { width: 18px; height: 18px; position: relative; padding: 0; }
.cw-play::before, .cw-play::after { content: ""; position: absolute; top: 4px; width: 2px; height: 10px; background: currentColor; transition: all var(--d-1, 0.18s); }
.cw-play::before { left: 5px; } .cw-play::after { left: 11px; }
.cw-play.paused::before { left: 6px; width: 0; height: 0; top: 4px; background: none; border-left: 8px solid currentColor; border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
.cw-play.paused::after { opacity: 0; }
.cw-track { position: relative; flex: 1; height: 22px; cursor: pointer; touch-action: none; }
.cw-line { position: absolute; left: 0; right: 0; top: 50%; height: var(--line, 1px); background: var(--hair, rgba(228,236,252,0.26)); }
.cw-avail { position: absolute; left: 0; top: 50%; height: var(--line, 1px); background: var(--hair-2, rgba(228,236,252,0.5)); }
.cw-fill { position: absolute; left: 0; top: 50%; height: var(--line, 1px); background: rgba(var(--accent-rgb, 176,216,255), 0.9); box-shadow: 0 0 6px rgba(var(--accent-rgb, 176,216,255), 0.5); }
.cw-thumb { position: absolute; top: 50%; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--ink, #fff); box-shadow: 0 0 8px rgba(var(--accent-rgb, 176,216,255), 0.8); }
.cw-ends { position: absolute; left: 0; right: 0; top: 100%; margin-top: -2px; display: flex; justify-content: space-between; font-size: var(--t-3xs, 8px); letter-spacing: var(--tr-2, 0.26em); text-transform: uppercase; color: var(--ink-4, rgba(214,224,242,0.22)); pointer-events: none; }
.cw-read { position: absolute; left: 0; right: 0; bottom: 100%; margin-bottom: 2px; text-align: center; font-family: var(--serif, serif); font-style: italic; font-size: var(--t-s, 12px); color: var(--ink-3, rgba(214,224,242,0.4)); pointer-events: none; opacity: 0; transition: opacity var(--d-2, 0.5s); }
.cw-time:hover .cw-read, .cw-time.drag .cw-read { opacity: 1; }
.touch .cw-time { width: min(62vw, 420px); }
`;

export class TimeScrubber {
  constructor(root, api) {
    this.api = api;
    this.root = root;
    if (!document.getElementById('cw-time-css')) {
      const st = document.createElement('style'); st.id = 'cw-time-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    const el = (tag, cls, parent) => { const e = document.createElement(tag); e.className = cls; parent?.appendChild(e); return e; };
    this.el = el('div', 'cw-time', root);
    this.play = el('button', 'cw-btn cw-play', this.el); this.play.title = 'Play / pause cosmic time (T)';
    this.track = el('div', 'cw-track', this.el);
    el('div', 'cw-line', this.track);
    this.avail = el('div', 'cw-avail', this.track);
    this.fill = el('div', 'cw-fill', this.track);
    this.thumb = el('div', 'cw-thumb', this.track);
    const ends = el('div', 'cw-ends', this.track);
    el('span', '', ends).textContent = 'Big Bang';
    el('span', '', ends).textContent = 'Today';
    this.read = el('div', 'cw-read', this.track);
    this.exp = el('button', 'cw-btn cw-exp', this.el); this.exp.title = 'Comoving / expanding view (V)';
    this.play.addEventListener('click', () => api.togglePlay());
    this.exp.addEventListener('click', () => api.toggleExpansion());
    const set = (e) => { const r = this.track.getBoundingClientRect(); api.setTau(Math.max(0, Math.min(api.getMaxTau(), (e.clientX - r.left) / r.width))); };
    this.track.addEventListener('pointerdown', (e) => { this.dragging = true; this.el.classList.add('drag'); this.track.setPointerCapture(e.pointerId); set(e); e.stopPropagation(); });
    this.track.addEventListener('pointermove', (e) => { if (this.dragging) set(e); });
    const up = () => { this.dragging = false; this.el.classList.remove('drag'); };
    this.track.addEventListener('pointerup', up); this.track.addEventListener('pointercancel', up);
    this._vis = false;
  }
  setVisible(v) { if (v !== this._vis) { this._vis = v; this.el.classList.toggle('on', v); } }
  setReadout(t) { this.read.textContent = t; }
  update() {
    if (!this._vis) return;
    const t = this.api.getTau(), m = this.api.getMaxTau();
    const pct = `${(t * 100).toFixed(2)}%`;
    if (pct !== this._pct) { this._pct = pct; this.fill.style.width = pct; this.thumb.style.left = pct; }
    const ap = `${(m * 100).toFixed(1)}%`;
    if (ap !== this._ap) { this._ap = ap; this.avail.style.width = ap; }
    const playing = this.api.isPlaying();
    if (playing !== this._pl) { this._pl = playing; this.play.classList.toggle('paused', !playing); }
    const ex = this.api.isExpanding();
    if (ex !== this._ex) { this._ex = ex; this.exp.textContent = ex ? 'Expanding' : 'Comoving'; }
  }
  dispose() { this.el.remove(); }
}

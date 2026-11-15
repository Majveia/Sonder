// PLACEHOLDER — replaced by the real galaxy scale.
import { makePlaceholder } from '../placeholder.js';
export default makePlaceholder({ name: 'galaxy', kicker: 'Galaxy', next: 'system', back: 'cosmic', color: [1.0, 0.85, 0.7], describe: (ctx, p) => { const g = ctx.universe.galaxy(p.galaxy ?? 0); return { name: g.name, detail: g.type }; } });

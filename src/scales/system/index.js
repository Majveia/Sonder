// PLACEHOLDER — replaced by the real star system scale.
import { makePlaceholder } from '../placeholder.js';
export default makePlaceholder({ name: 'system', kicker: 'Star system', next: 'planet', back: 'galaxy', color: [1.0, 0.9, 0.6], count: 3000, describe: (ctx, p) => { const s = ctx.universe.system(p.galaxy ?? 0, p.star ?? 1); return { name: s.name, detail: `${s.star.label} · ${s.planets.length} worlds` }; } });

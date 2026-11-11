// Procedural naming. Deterministic for a given RNG stream.

const SOFT = ['ae', 'el', 'lu', 'mi', 'na', 'ri', 'sa', 'the', 'ia', 'o', 'ra', 'ven', 'lys', 'mir', 'ael', 'on', 'eth', 'ir', 'un', 'a',
  'se', 'li', 'no', 'va', 'ne', 'ya', 'sol', 'el', 'is', 'an', 'da', 'ro', 'me', 'ka', 'shi', 'en', 'or', 'il', 'au', 'ce', 'te', 'la', 'thi', 'my', 'ha', 'ne', 'phe', 'ze'];
const HARD = ['kor', 'zan', 'drak', 'vek', 'tor', 'gul', 'bar', 'khe', 'tar', 'rok', 'vash', 'nok', 'qar', 'dun', 'mor', 'grim', 'sken', 'thar', 'ux', 'bel',
  'zor', 'kal', 'dra', 'gor', 'sar', 'tek', 'vol', 'kru', 'hax', 'ond', 'yr', 'ak', 'ul', 'esk', 'ob'];
const ENDS = ['a', 'ia', 'is', 'os', 'on', 'ar', 'el', 'en', 'ys', 'ara', 'ine', 'eth', 'or', 'us', 'ei', 'ae', 'ium', 'ion', 'ath', 'une', 'ora', 'yx', 'e', 'i'];

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** A single invented word. style: 'soft' | 'hard' | 'mixed' */
export function word(rng, style = 'mixed', syllables = 0) {
  const n = syllables || rng.weighted([[1, 1], [2, 6], [3, 3]]);
  let s = '';
  for (let i = 0; i < n; i++) {
    const pool = style === 'soft' ? SOFT : style === 'hard' ? HARD : (rng.chance(0.68) ? SOFT : HARD);
    let syl = rng.pick(pool);
    // avoid ugly triple vowels / doubled chunks
    if (s && /[aeiouy]$/.test(s) && /^[aeiouy]/.test(syl)) syl = rng.pick(HARD);
    s += syl;
  }
  if (rng.chance(0.55) || s.length < 4) {
    const e = rng.pick(ENDS);
    if (!(/[aeiouy]$/.test(s) && /^[aeiouy]/.test(e))) s += e; else s += 'n' + e;
  }
  if (s.length > 10) s = s.slice(0, 9);
  return cap(s);
}

const GALAXY_SUFFIX = {
  spiral: ['Spiral', 'Whorl', 'Pinwheel', 'Wheel', 'Gyre'],
  barred: ['Bar', 'Spindle', 'Crossing', 'Loom'],
  elliptical: ['Halo', 'Lantern', 'Ember', 'Pearl'],
  lenticular: ['Lens', 'Disc', 'Mirror'],
  irregular: ['Drift', 'Cloud', 'Veil', 'Tatter', 'Shoal'],
  ring: ['Ring', 'Crown', 'Annulus', 'Halo'],
};

export function galaxyName(rng, type) {
  const base = word(rng, 'soft');
  if (rng.chance(0.18)) return `${base}-${rng.int(11, 989)}`;
  return `${base} ${rng.pick(GALAXY_SUFFIX[type] || GALAXY_SUFFIX.spiral)}`;
}

export function starName(rng) {
  if (rng.chance(0.22)) {
    const cat = rng.pick(['SND', 'HLC', 'KV', 'TYC', 'GL', 'VX']);
    return `${cat}-${rng.int(100, 9999)}`;
  }
  const w = word(rng, 'mixed');
  if (rng.chance(0.12)) return `${w} ${rng.pick(['Prime', 'Major', 'Minor', 'Australis', 'Borealis'])}`;
  return w;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
export function planetName(rng, starNameStr, index, inhabited) {
  if (inhabited || rng.chance(0.35)) return word(rng, rng.chance(0.7) ? 'soft' : 'mixed');
  return `${starNameStr} ${ROMAN[index] || index + 1}`;
}

const CITY_SUFFIX = ['', '', '', ' Reach', ' Hollow', ' Landing', ' Rise', ' Haven', ' Spire', ' Market', ' Gate', ' Terrace', ' Harbor', ' Crossing'];
export function cityName(rng, style = 'soft') {
  return word(rng, style) + rng.pick(CITY_SUFFIX);
}

export function personName(rng) {
  return `${word(rng, 'soft', 2)} ${word(rng, 'mixed', 2)}`;
}

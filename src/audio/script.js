// Narration script. ids are stable: pre-rendered voice files live at src/audio/voice/<id>.(ogg|mp3)
// and the intro / scales refer to lines by id. `pause` = seconds of silence after the line.

export const INTRO_LINES = [
  { id: 'intro-01', text: 'In the beginning, there was no darkness. Only light. Everywhere, all at once.', pause: 1.6 },
  { id: 'intro-02', text: 'Then the light thinned. The universe cooled, and for the first time, it went dark.', pause: 1.8 },
  { id: 'intro-03', text: 'But the dark was never empty. Gravity was already at work. Gathering. Patiently. For a hundred million years.', pause: 1.6 },
  { id: 'intro-04', text: 'The first stars woke. Then galaxies, strung along threads of unseen matter, like dew on a web.', pause: 2.0 },
  { id: 'intro-05', text: 'Every point of light you see is a hundred billion suns.', pause: 1.4 },
  { id: 'intro-06', text: 'Around those suns, worlds. On some of those worlds: oceans. Cities. Footprints.', pause: 1.4 },
  { id: 'intro-07', text: 'And lives. Each one as vivid, and as complicated, as your own.', pause: 2.2 },
  { id: 'intro-08', text: 'There is a word for that feeling.', pause: 3.2 },
  { id: 'intro-09', text: 'The universe is waiting. Go anywhere.', pause: 1.0 },
];

// Spoken once, the first time the traveller reaches each place.
export const MOMENT_LINES = [
  { id: 'galaxy-first', text: 'A galaxy. Two hundred billion suns, turning together once every quarter of a billion years.' },
  { id: 'system-first', text: 'One star. A handful of worlds, falling around it forever, and never landing.' },
  { id: 'planet-first', text: 'Ground. Air. Weather. Somewhere down there, someone is having an ordinary day.' },
  { id: 'blackhole-first', text: 'Here, gravity has won. Light bends around the edge. And time, for anyone close, runs slow.' },
  { id: 'pulsar-first', text: 'A dead star, the size of a city, turning faster than a heartbeat. It is keeping perfect time for no one.' },
  { id: 'home-first', text: 'Vesper. A quiet yellow star. This is where we begin.' },
  { id: 'return-cosmic', text: 'From out here, every home looks the same. A small light, holding on.' },
  { id: 'world-cinder', text: 'Cinder. A world still being forged.' },
  { id: 'world-sirocco', text: 'Sirocco. Pastel mesas, slow caravans, and a sky like old paper.' },
  { id: 'world-aurelia', text: 'Aurelia. Wind in tall grass. White towns on green hills.' },
  { id: 'world-thalassa', text: 'Thalassa. One ocean, thinking slowly.' },
  { id: 'world-noctis', text: 'Noctis. Rain, neon, and forty billion stories.' },
  { id: 'world-leviathan', text: 'Leviathan. A storm older than memory.' },
  { id: 'world-mycelia', text: 'Mycelia. The forest glows because it is listening.' },
  { id: 'world-hyperborea', text: 'Hyperborea. Something was left here, for us to find.' },
  { id: 'world-eremos', text: 'Eremos. The edge of the map, singing quietly.' },
];

export const ALL_LINES = [...INTRO_LINES, ...MOMENT_LINES];
export const LINE_BY_ID = Object.fromEntries(ALL_LINES.map((l) => [l.id, l]));

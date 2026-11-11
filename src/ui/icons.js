// SONDER icon set — hairline, 24-unit grid, round caps, drawn with `currentColor`.
// Keyed by action name so scales can just pass `{ action, label }` to ui.setActions().
//   icon(name) -> '<svg …>' markup string ('' when unknown)   ICONS -> { name: path data }
// Paths are stroked unless they start with "F:" (filled).

const P = {
  jump: 'M6.5 13.2 12 7.7l5.5 5.5M5.5 18h13',
  ascend: 'M7 11.5 12 6.5l5 5M7 17.5l5-5 5 5',
  descend: 'M7 12.5l5 5 5-5M7 6.5l5 5 5-5',
  sprint: 'M6 7l5 5-5 5M12.5 7l5 5-5 5',
  boost: 'M6 7l5 5-5 5M12.5 7l5 5-5 5',
  interact: 'M12 4.2 19.8 12 12 19.8 4.2 12zM12 10.4v3.2M10.4 12h3.2',
  view: 'M2.8 12s3.4-5.8 9.2-5.8 9.2 5.8 9.2 5.8-3.4 5.8-9.2 5.8S2.8 12 2.8 12zM12 9.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z',
  map: 'M4 6.6l5-2 6 2 5-2v12.8l-5 2-6-2-5 2zM9 4.6v12.8M15 6.6v12.8',
  back_out: 'M9.5 7 5 11.5 9.5 16M5.6 11.5h8.2a4.7 4.7 0 0 1 4.7 4.7v1.3',
  back: 'M9.5 7 5 11.5 9.5 16M5.6 11.5h8.2a4.7 4.7 0 0 1 4.7 4.7v1.3',
  leave: 'M9.5 7 5 11.5 9.5 16M5.6 11.5h8.2a4.7 4.7 0 0 1 4.7 4.7v1.3',
  brake: 'M12 3.8a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4zM10 9.2v5.6M14 9.2v5.6',
  light: 'M12 8.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8zM12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6',
  scan: 'M12 10.8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zM8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4',
  alt: 'M12 10.8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zM8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4',
  photo: 'M4 8.4h3.1l1.6-2.4h6.6l1.6 2.4H20v10H4zM12 10.2a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2z',
  time: 'M12 3.8a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4zM12 7.6V12l3 1.9',
  rollLeft: 'M5.5 12a6.5 6.5 0 1 0 6.5-6.5H9.8M11.4 3 8.8 5.5l2.6 2.5',
  rollRight: 'M18.5 12A6.5 6.5 0 1 1 12 5.5h2.2M12.6 3l2.6 2.5-2.6 2.5',
  help: 'M9.4 9.3a2.7 2.7 0 1 1 3.9 2.4c-.8.4-1.3 1-1.3 1.9v.6M12 17.4v.2',
  more: 'F:M5.6 10.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zM12 10.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zM18.4 10.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  sound: 'M4.5 9.5h3l4.5-3.8v12.6L7.5 14.5h-3zM15.4 9.2a4 4 0 0 1 0 5.6M17.8 6.8a7.4 7.4 0 0 1 0 10.4',
  mute: 'M4.5 9.5h3l4.5-3.8v12.6L7.5 14.5h-3zM15.5 9.5l5 5M20.5 9.5l-5 5',
  headphones: 'M4.6 15.2V12a7.4 7.4 0 0 1 14.8 0v3.2M4.6 14.4h2.6v5.2H4.6zM16.8 14.4h2.6v5.2h-2.6z',
  fullscreen: 'M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15',
  mouse: 'M12 3.6c3 0 5.2 2.3 5.2 5.4v6c0 3-2.3 5.4-5.2 5.4S6.8 18 6.8 15V9c0-3.1 2.3-5.4 5.2-5.4zM12 6.8v2.6',
  play: 'M8.5 6.2v11.6L18 12z',
  thrust: 'M12 4.5v10M8 10.5l4 4 4-4M7 19.5h10',
  land: 'M12 4.5v9M8.5 10l3.5 3.5 3.5-3.5M4.5 18.5h15',
  horn: 'M5 10h2.6L15 6v12l-7.4-4H5zM18 9.5v5',
  dive: 'M12 4.5v9M8.5 10l3.5 3.5 3.5-3.5M4.5 17.5c1.2 0 1.8-1 3-1s1.8 1 3 1 1.8-1 3-1 1.8 1 3 1 1.8-1 3-1',
};
P.forward = 'M7 13.5 12 8.5l5 5';
P.ship = P.thrust;

export const ICONS = P;

const cache = new Map();
export function icon(name, cls = '') {
  const d = P[name];
  if (!d) return '';
  const key = name + '|' + cls;
  let s = cache.get(key);
  if (!s) {
    const filled = d.startsWith('F:');
    const path = filled ? d.slice(2) : d;
    s = `<svg class="ui-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
      (filled ? `<path d="${path}" fill="currentColor" stroke="none"/>` : `<path d="${path}"/>`) + '</svg>';
    cache.set(key, s);
  }
  return s;
}
export const hasIcon = (name) => !!P[name];

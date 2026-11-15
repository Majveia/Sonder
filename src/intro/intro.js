// Cinematic intro — contract stub. The real sequence replaces this file but keeps the export:
//
//   runIntro(ctx) -> Promise<void>   resolves when the intro has finished (or was skipped) and
//                                    control should be handed to the player in the cosmic scale.
//
// The intro plays *inside* the live cosmic-web scale (ctx.scales.current), which exposes:
//   scale.cinematic = true|false     true disables player camera control
//   scale.setTime(a)                 cosmic scale factor 0..1 (0 = smooth early universe, 1 = today)
//   scale.setReveal(k)               0..1 master visibility
//   scale.camera                     free to position while cinematic
//   scale.homePosition               THREE.Vector3 of the home galaxy's halo
export async function runIntro(ctx) {
  ctx.ui.setVisible(true);
}

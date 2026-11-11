// AudioEngine — contract stub. The real implementation (generative score, SFX, narrator) replaces
// the bodies but MUST keep this surface, which the rest of the game calls:
//
//   audio.unlock()                      resume the AudioContext on the first user gesture
//   audio.setScene(name, params)        music / ambience mood: 'intro' | 'cosmic' | 'galaxy' | 'system' | 'planet' | 'blackhole'
//                                       params may carry { mood: 'meadow' | 'dune' | 'tide' | 'noir' | 'spore' | 'glass' | 'ember' | 'giant', night: 0..1 }
//   audio.sfx(name, opts)               one-shots: 'warp', 'transition', 'select', 'hover', 'land', 'jump', 'step', 'engine-start', ...
//   audio.loop(name, level, params)     continuous layers driven every frame: 'engine', 'wind', 'thrust', 'rain' (level 0..1)
//   audio.say(id | { text, id }, opts)  narrator line -> Promise resolving when the line ends ({ caption: true } shows subtitles)
//   audio.stopVoice()
//   audio.setMuted(bool) / audio.muted
//   audio.update(dt, time)
export class AudioEngine {
  constructor(ctx) { this.ctx = ctx; this.muted = false; this.unlocked = false; }
  unlock() { this.unlocked = true; }
  setScene() {}
  sfx() {}
  loop() {}
  say() { return Promise.resolve(); }
  stopVoice() {}
  setMuted(m) { this.muted = !!m; }
  update() {}
}

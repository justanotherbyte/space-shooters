// Synthesized sound effects, no audio files.
let ctx: AudioContext | null = null;
let out: GainNode;
let noise: AudioBuffer;

export function unlockAudio() {
  if (ctx) return void ctx.resume();
  ctx = new AudioContext();
  const comp = ctx.createDynamicsCompressor();
  out = ctx.createGain();
  out.gain.value = 0.5;
  out.connect(comp).connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur);
}

function hiss(dur: number, vol: number, freq: number, q = 1) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource();
  s.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur);
}

export const sfx = {
  shoot() { tone("sawtooth", 1400, 180, 0.12, 0.18); tone("square", 700, 90, 0.09, 0.08); hiss(0.06, 0.15, 3000); },
  enemyShot(dist: number) { const v = Math.max(0.02, 0.22 - dist * 0.006); tone("square", 520, 140, 0.16, v); },
  heavyShot(dist: number) { const v = Math.max(0.03, 0.3 - dist * 0.006); tone("sawtooth", 220, 50, 0.3, v); hiss(0.2, v, 500); },
  hit(crit: boolean) { tone("triangle", crit ? 2400 : 1700, crit ? 1800 : 1300, 0.05, 0.16); },
  kill(heavy: boolean) { hiss(heavy ? 0.9 : 0.5, 0.45, heavy ? 300 : 700, 0.7); tone("sine", heavy ? 90 : 140, 30, heavy ? 0.8 : 0.4, 0.4); },
  hurt() { tone("sine", 160, 50, 0.25, 0.4); hiss(0.15, 0.25, 900); },
  wave() { [440, 554, 659, 880].forEach((f, i) => tone("square", f, f, 0.14, 0.08, i * 0.09)); },
  warp() { tone("sine", 120, 900, 0.5, 0.06); },
  toss(dist: number) { tone("triangle", 300, 900, 0.18, Math.max(0.02, 0.14 - dist * 0.004)); },
  boom(dist: number) { const v = Math.max(0.08, 0.6 - dist * 0.012); hiss(1.1, v, 220, 0.6); tone("sine", 110, 28, 0.9, v); },
  smoke(dist: number) { hiss(1.6, Math.max(0.03, 0.22 - dist * 0.005), 2400, 0.4); },
  clank(dist: number) { tone("square", 900, 600, 0.06, Math.max(0.02, 0.12 - dist * 0.004)); },
  snap() { tone("sawtooth", 1800, 200, 0.12, 0.3); hiss(0.2, 0.3, 4000); },
};

// Every sound is synthesised with WebAudio: no samples, no asset licences.
// `rate` < 1 slows and deepens a sound (used by slow-motion replays).

import type { GameEvent } from "../../sim/index";

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  enabled = true;

  /** Must be called from a user gesture once. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, rate = 1, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    dur /= rate;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0 * rate, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * rate), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private hiss(freq: number, q: number, dur: number, vol: number, rate = 1, type: BiquadFilterType = "bandpass") {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    dur /= rate;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq * rate;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  play(e: GameEvent, rate = 1, mySide = -1) {
    if (!this.enabled || !this.ctx || this.ctx.state !== "running") return;
    const p = e.power;
    switch (e.type) {
      case "hit": {
        // a wet "boing": falling sine + a harmonic + a tiny click
        const f = 260 + Math.min(p, 22) * 14 + (e.side ? 30 : 0);
        this.tone("sine", f, f * 0.42, 0.22, 0.5, rate);
        this.tone("triangle", f * 2.01, f * 0.9, 0.09, 0.12, rate);
        this.hiss(2400, 2, 0.03, 0.25, rate);
        if (p >= 18) this.tone("sawtooth", 90, 40, 0.18, 0.12, rate);
        break;
      }
      case "jump":
        this.tone("sine", 210, 480, 0.12, 0.12, rate);
        break;
      case "land":
        this.tone("sine", 130, 55, 0.1, 0.1 + Math.min(p, 15) * 0.01, rate);
        break;
      case "wall":
        this.tone("square", 520, 300, 0.06, 0.05, rate);
        this.hiss(3200, 6, 0.08, 0.12, rate);
        break;
      case "net":
        this.tone("triangle", 150, 120, 0.32, 0.22, rate);
        this.hiss(700, 3, 0.15, 0.15, rate);
        break;
      case "ground":
        this.hiss(500, 0.7, 0.3, 0.6, rate, "lowpass");
        this.tone("sine", 90, 40, 0.18, 0.4, rate);
        break;
      case "point": {
        const good = mySide < 0 || e.side === mySide;
        if (good) {
          this.tone("sine", 660, 660, 0.14, 0.18, rate);
          this.tone("sine", 990, 990, 0.25, 0.18, rate, 0.11 / rate);
        } else {
          this.tone("sine", 440, 420, 0.16, 0.16, rate);
          this.tone("sine", 330, 300, 0.3, 0.16, rate, 0.13 / rate);
        }
        break;
      }
      case "serve":
        this.tone("sine", 880, 880, 0.06, 0.06, rate);
        break;
      case "win":
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone("triangle", f, f, 0.3, 0.16, rate, i * 0.09));
        break;
      case "fault":
        this.tone("square", 200, 150, 0.25, 0.06, rate);
        break;
    }
  }

  tick(high = false) {
    if (!this.enabled || !this.ctx || this.ctx.state !== "running") return;
    this.tone("sine", high ? 1046 : 523, high ? 1046 : 523, high ? 0.3 : 0.1, 0.14);
  }
}

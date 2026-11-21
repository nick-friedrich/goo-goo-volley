// Replays store no video and no positions: only the state at the start of the
// rally and the buttons pressed since. Because the simulation is
// deterministic, re-running those inputs rebuilds the rally exactly.

import { cloneState, Phase, step, type GameEvent, type State } from "../../sim/index";

export interface Clip {
  start: State;
  inputs: number[]; // [in0, in1, in0, in1, ...]
}

export class Recorder {
  private start: State | null = null;
  private inputs: number[] = [];
  private lastPhase = -1;

  /** Call before stepping `s` with these inputs. */
  record(s: State, in0: number, in1: number) {
    if (s.phase === Phase.Serve && this.lastPhase !== Phase.Serve) {
      this.start = cloneState(s);
      this.inputs = [];
    }
    this.lastPhase = s.phase;
    if (this.start) this.inputs.push(in0, in1);
  }

  clip(): Clip | null {
    return this.start ? { start: this.start, inputs: this.inputs.slice() } : null;
  }

  get bytes() {
    return this.inputs.length / 2; // 3 bits per player: one byte per frame is plenty
  }
}

export const REPLAY_RATE = 0.4;
const BEFORE = 54; // ticks of rally shown before the point
const AFTER = 14;

export class Replayer {
  prev: State;
  cur: State;
  private i: number;
  private end: number;
  private acc = 0;
  readonly frames: number;

  constructor(private clip: Clip) {
    const n = clip.inputs.length / 2;
    this.frames = n;
    const s = cloneState(clip.start);
    const from = Math.max(0, n - BEFORE);
    for (let k = 0; k < from; k++) step(s, clip.inputs[k * 2], clip.inputs[k * 2 + 1]);
    this.i = from;
    this.end = n + AFTER;
    this.cur = s;
    this.prev = cloneState(s);
  }

  get done() {
    return this.i >= this.end;
  }

  get alpha() {
    return this.acc;
  }

  /** Advance by real seconds; returns events that happened (for effects). */
  advance(dt: number): GameEvent[] {
    const ev: GameEvent[] = [];
    this.acc += dt * 60 * REPLAY_RATE;
    while (this.acc >= 1 && !this.done) {
      this.acc -= 1;
      this.prev = cloneState(this.cur);
      const k = this.i++;
      const a = this.clip.inputs[k * 2] ?? 0, b = this.clip.inputs[k * 2 + 1] ?? 0;
      step(this.cur, a, b, ev);
    }
    return ev;
  }
}

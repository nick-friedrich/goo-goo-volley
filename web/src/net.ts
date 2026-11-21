// Online play: a WebSocket connection (with an optional fake-lag line for the
// video) and the prediction + rollback match client.

import { cloneState, createState, hashState, step, TICK_MS, type GameEvent, type State } from "../../sim/index";
import type { ClientMsg, ServerMsg } from "../../sim/protocol";
import { Recorder } from "./replay";

/** Delays messages by lagMs/2 each way while keeping their order. */
class LagLine {
  private q: { at: number; fn: () => void }[] = [];
  private last = 0;
  constructor(private conn: Connection) {}
  push(fn: () => void) {
    const at = Math.max(performance.now() + this.conn.lagMs / 2, this.last);
    this.last = at;
    if (this.conn.lagMs <= 0 && this.q.length === 0) return fn();
    this.q.push({ at, fn });
    this.flush();
  }
  private flush = () => {
    const now = performance.now();
    while (this.q.length && this.q[0].at <= now) this.q.shift()!.fn();
    if (this.q.length) setTimeout(this.flush, Math.max(0, this.q[0].at - now));
  };
}

export class Connection {
  private ws: WebSocket | null = null;
  lagMs = 0;
  rtt = 80;
  private rttSamples = 0;
  private out = new LagLine(this);
  private inn = new LagLine(this);
  private pingTimer = 0;
  onMessage: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = (this.ws = new WebSocket(`${proto}://${location.host}/ws`));
      ws.onopen = () => {
        this.pingTimer = window.setInterval(() => this.send({ t: "ping", c: performance.now() }), 500);
        this.send({ t: "ping", c: performance.now() });
        resolve();
      };
      ws.onerror = () => reject(new Error("Could not reach the game server."));
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        this.ws = null;
        this.onClose();
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data) as ServerMsg;
        this.inn.push(() => {
          if (m.t === "pong") {
            const sample = performance.now() - m.c;
            this.rtt = this.rttSamples++ === 0 ? sample : this.rtt * 0.85 + sample * 0.15;
          } else this.onMessage(m);
        });
      };
    });
  }

  send(m: ClientMsg) {
    const ws = this.ws;
    if (!ws) return;
    this.out.push(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)));
  }
}

const BUFFER_FRAMES = 2; // safety margin so inputs arrive before the server needs them
const MAX_AHEAD = 45; // never predict more than this many frames

export interface NetStats {
  ahead: number;
  resim: number;
  resimMs: number;
  lead: number;
  checks: number;
  desyncs: number;
  lastHash: number;
}

/**
 * The client side of an online match.
 *
 * `confirmed` only ever advances with inputs the server has confirmed, so it
 * is identical to the server's game. For display we copy it and re-simulate
 * the frames we have already played locally (our real inputs + a guess for
 * the opponent: "same buttons as last time"). When the truth arrives, we throw
 * the guess away and do it again. That's rollback.
 */
export class OnlineMatch {
  confirmed = createState();
  confirmedPrev = createState();
  predicted = createState();
  predictedPrev = createState();
  localFrame = 0;
  predict = true;
  readonly recorder = new Recorder();
  readonly stats: NetStats = { ahead: 0, resim: 0, resimMs: 0, lead: 0, checks: 0, desyncs: 0, lastHash: 0 };

  private mine = new Map<number, number>();
  private lastMine = 0;
  private lastOpp = 0;
  private clockOffset = -Infinity; // server frame ≈ now / TICK_MS + clockOffset (as seen here)
  private fxFrame = -1;
  private alpha = 0;
  private startedAt: number;

  constructor(readonly side: 0 | 1, private conn: Connection) {
    this.startedAt = performance.now();
  }

  /** A confirmed frame from the server. Returns authoritative events (points, wins). */
  onFrame(m: Extract<ServerMsg, { t: "f" }>): GameEvent[] {
    const ev: GameEvent[] = [];
    if (m.f !== this.confirmed.frame) return ev; // duplicate or out of order: ignore
    this.confirmedPrev = cloneState(this.confirmed);
    this.recorder.record(this.confirmed, m.a, m.b);
    step(this.confirmed, m.a, m.b, ev);
    this.lastOpp = this.side === 0 ? m.b : m.a;
    this.mine.delete(m.f);
    this.stats.lead = m.l;
    if (m.h !== undefined) {
      const h = hashState(this.confirmed);
      this.stats.checks++;
      this.stats.lastHash = h;
      if (h !== m.h) this.stats.desyncs++;
    }
    // clock: the newest frame we have seen, relative to our clock (max filters out jitter)
    const sample = m.f + 1 - performance.now() / TICK_MS;
    this.clockOffset = Math.max(sample, this.clockOffset - 0.02);
    return ev;
  }

  /** Run local frames up to where we should be, then rebuild the predicted view. */
  update(input: number): GameEvent[] {
    const now = performance.now();
    const rttFrames = this.conn.rtt / TICK_MS;
    const serverNow =
      this.clockOffset === -Infinity ? (now - this.startedAt) / TICK_MS : now / TICK_MS + this.clockOffset;
    const target = serverNow + rttFrames + BUFFER_FRAMES;
    this.alpha = target - Math.floor(target);

    let ticks = 0;
    while (this.localFrame < Math.floor(target) && ticks++ < 8 && this.localFrame - this.confirmed.frame < MAX_AHEAD) {
      this.mine.set(this.localFrame, input);
      this.conn.send({ t: "in", f: this.localFrame, i: input });
      this.localFrame++;
    }
    this.lastMine = input;

    // rollback: start from the truth and replay everything since
    const t0 = performance.now();
    const ev: GameEvent[] = [];
    const s = cloneState(this.confirmed);
    let prev = s;
    const n = this.localFrame - this.confirmed.frame;
    for (let f = this.confirmed.frame; f < this.localFrame; f++) {
      if (f === this.localFrame - 1) prev = cloneState(s);
      const me = this.mine.get(f) ?? this.lastMine;
      const scratch: GameEvent[] = [];
      step(s, this.side === 0 ? me : this.lastOpp, this.side === 0 ? this.lastOpp : me, scratch);
      if (f > this.fxFrame) {
        ev.push(...scratch);
        this.fxFrame = f;
      }
    }
    this.predicted = s;
    this.predictedPrev = n > 0 ? prev : cloneState(s);
    this.stats.resim = n;
    this.stats.resimMs = this.stats.resimMs * 0.95 + (performance.now() - t0) * 0.05; // smoothed: browsers round timers
    this.stats.ahead = n;
    return ev;
  }

  /** What to draw. */
  view(): { prev: State; cur: State; alpha: number } {
    return this.predict
      ? { prev: this.predictedPrev, cur: this.predicted, alpha: this.alpha }
      : { prev: this.confirmedPrev, cur: this.confirmed, alpha: 1 };
  }
}

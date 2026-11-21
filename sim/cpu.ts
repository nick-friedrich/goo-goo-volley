// The CPU player. It sees the same State a human sees, predicts the ball with
// the real physics (predictBall), and turns a plan into button presses.
// Everything it "thinks" lives in `brain` so the game can draw it.

import {
  BALL_R, FP, GOO_GRAVITY, GOO_JUMP, GOO_R, HOME_X, JUMP, LEFT, NET_X, Phase, RIGHT,
  predictBall, type State,
} from "./index";

export type Difficulty = "easy" | "normal" | "hard";

const LEVELS: Record<Difficulty, { reaction: number; error: number; jumpChance: number; spikeZone: number }> = {
  easy: { reaction: 18, error: 34, jumpChance: 0.2, spikeZone: 90 },
  normal: { reaction: 12, error: 20, jumpChance: 0.55, spikeZone: 150 },
  hard: { reaction: 3, error: 4, jumpChance: 0.95, spikeZone: 210 },
};

export interface Brain {
  mode: "serve" | "intercept" | "spike" | "home" | "idle";
  /** predicted ball path, flat [x, y, ...] in fixed point */
  path: number[];
  /** where the CPU expects to meet the ball, fixed point, or null */
  meetX: number | null;
  meetY: number | null;
  targetX: number;
  /** ticks until the planned jump (-1 = no jump planned) */
  jumpIn: number;
  /** ticks until the brain next updates its plan */
  reactIn: number;
}

/** Height (fixed point) of a goo's centre k ticks after pressing jump and holding it. */
const JUMP_TABLE: number[] = (() => {
  const t = [GOO_R];
  let y = GOO_R, vy = GOO_JUMP;
  for (let k = 1; k < 40; k++) {
    vy -= GOO_GRAVITY;
    y += vy;
    t.push(Math.max(y, GOO_R));
  }
  return t;
})();

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTACT = GOO_R + BALL_R; // centre distance at contact

export class CpuPlayer {
  readonly brain: Brain;
  private rand: () => number;
  private cfg: (typeof LEVELS)[Difficulty];
  private planAt = 0; // frame at which to (re)plan
  private lastRally = -1;
  private lastPhase = -1;
  private jumpFrame = -1;
  private holdJump = 0;
  private serveWait = 0;

  constructor(readonly side: 0 | 1, difficulty: Difficulty = "normal", seed = 1234) {
    this.cfg = LEVELS[difficulty];
    this.rand = mulberry32(seed);
    this.brain = { mode: "idle", path: [], meetX: null, meetY: null, targetX: HOME_X[side], jumpIn: -1, reactIn: 0 };
  }

  setDifficulty(d: Difficulty) {
    this.cfg = LEVELS[d];
  }

  /** +1 if the net is to our right, -1 if it is to our left */
  private get toNet() {
    return this.side === 0 ? 1 : -1;
  }

  private noise(units: number) {
    return Math.round((this.rand() * 2 - 1) * units * FP);
  }

  think(s: State): number {
    const me = s.goos[this.side];
    const b = this.brain;

    // React to the world changing (somebody hit the ball, a new rally) after a human-ish delay.
    if (s.rally !== this.lastRally || s.phase !== this.lastPhase) {
      this.lastRally = s.rally;
      this.lastPhase = s.phase;
      this.planAt = s.frame + this.cfg.reaction;
      if (s.phase === Phase.Serve) this.serveWait = 20 + Math.floor(this.rand() * 40);
    }
    if (s.frame >= this.planAt) {
      this.plan(s);
      this.planAt = s.frame + 24; // refine regularly
    }
    b.reactIn = Math.max(0, this.planAt - s.frame);

    let input = 0;
    const dx = b.targetX - me.x;
    if (dx > 3 * FP) input |= RIGHT;
    else if (dx < -3 * FP) input |= LEFT;

    if (s.phase === Phase.Serve && s.server === this.side) {
      if (this.serveWait > 0) this.serveWait--;
      else if (Math.abs(dx) < 4 * FP && me.grounded) this.jumpFrame = s.frame;
    }

    if (this.jumpFrame >= 0) {
      b.jumpIn = Math.max(0, this.jumpFrame - s.frame);
      if (s.frame >= this.jumpFrame && me.grounded) {
        this.jumpFrame = -1;
        this.holdJump = 18;
      }
    } else b.jumpIn = -1;

    if (this.holdJump > 0) {
      this.holdJump--;
      input |= JUMP;
    }
    return input;
  }

  private plan(s: State) {
    const b = this.brain;
    const home = HOME_X[this.side];
    this.jumpFrame = -1;

    if (s.phase === Phase.Serve) {
      b.path = [s.ball.x, s.ball.y];
      if (s.server === this.side) {
        b.mode = "serve";
        b.targetX = s.ball.x - this.toNet * (14 * FP + Math.abs(this.noise(10)));
        b.meetX = s.ball.x;
        b.meetY = s.ball.y;
      } else {
        b.mode = "home";
        b.targetX = home;
        b.meetX = b.meetY = null;
      }
      return;
    }

    if (s.phase !== Phase.Play) {
      b.mode = "idle";
      b.path = [];
      b.meetX = b.meetY = null;
      b.targetX = home;
      return;
    }

    // Where does the ball come down to bumping height on our side?
    const bump = predictBall(s.ball, this.side, GOO_R + CONTACT - 4 * FP);
    b.path = bump.path;

    if (bump.tick < 0) {
      b.mode = "home";
      b.meetX = b.meetY = null;
      b.targetX = home;
      return;
    }

    // Stand a little behind the ball so the contact normal points at the net.
    const aim = 18 * FP + this.noise(this.cfg.error);
    b.mode = "intercept";
    b.meetX = bump.x;
    b.meetY = bump.y;
    b.targetX = bump.x - this.toNet * aim;

    // Close to the net and feeling brave? Jump and spike it instead.
    const nearNet = Math.abs(bump.x - NET_X) < this.cfg.spikeZone * FP;
    if (nearNet && this.rand() < this.cfg.jumpChance) {
      const high = predictBall(s.ball, this.side, 235 * FP);
      if (high.tick > 0) {
        // find k so that our head meets the ball when it reaches `high`
        const want = high.y - CONTACT + 10 * FP;
        let k = 1;
        while (k < 20 && JUMP_TABLE[k] < want) k++;
        const jumpIn = high.tick - k;
        if (jumpIn >= 0) {
          b.mode = "spike";
          b.meetX = high.x;
          b.meetY = high.y;
          b.targetX = high.x - this.toNet * (12 * FP + this.noise(this.cfg.error / 2));
          this.jumpFrame = s.frame + jumpIn;
        }
      }
    }
  }
}

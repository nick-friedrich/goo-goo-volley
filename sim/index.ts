// Goo Goo Volley simulation.
//
// Pure and deterministic: integer math only, no Math.random, no clocks, no I/O.
// The browser (CPU games, online prediction) and the server (the referee) run
// exactly this code, so the same inputs always produce the same game.
//
// Coordinates: x runs 0..COURT_W left to right, y is height above the sand.
// Every length is in fixed-point "milli-units": FP = 1 world unit.

export const FP = 1000;
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

export const COURT_W = 800 * FP;
export const NET_X = 400 * FP;
export const NET_R = 7 * FP; // the net is a capsule: half-thickness
export const NET_TOP = 170 * FP;

export const GOO_R = 44 * FP;
export const GOO_SPEED = 6 * FP; // per tick
export const GOO_JUMP = 15 * FP;
export const GOO_GRAVITY = 750;
export const GOO_SHORT_HOP = 900; // extra gravity while rising with jump released

export const BALL_R = 24 * FP;
export const BALL_GRAVITY = 380;
export const BALL_MAX_SPEED = 22 * FP;
export const HIT_SPEED = 13 * FP;
export const SERVE_HEIGHT = 200 * FP; // reachable from a jump with room to aim, not from the ground

export const WIN_SCORE = 7;
export const MAX_TOUCHES = 3;
export const INTRO_TICKS = 150;
export const POINT_TICKS = 180;
export const TOUCH_COOLDOWN = 10;

export const HOME_X: readonly [number, number] = [200 * FP, 600 * FP];

// Input bits
export const LEFT = 1;
export const RIGHT = 2;
export const JUMP = 4;

export const Phase = { Intro: 0, Serve: 1, Play: 2, Point: 3, Over: 4 } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export interface Goo {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: number; // 0 | 1
  cooldown: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface State {
  frame: number;
  phase: Phase;
  timer: number;
  goos: [Goo, Goo];
  ball: Ball;
  score: [number, number];
  server: number; // side that serves next
  touchSide: number; // side that touched last (-1 = nobody since the net)
  touches: number;
  ballSide: number;
  rally: number; // hits this rally
  pointWinner: number;
  winner: number;
}

export type EventType = "jump" | "land" | "hit" | "wall" | "net" | "ground" | "point" | "serve" | "win" | "fault";

export interface GameEvent {
  type: EventType;
  side: number;
  x: number;
  y: number;
  power: number;
}

const newGoo = (x: number): Goo => ({ x, y: GOO_R, vx: 0, vy: 0, grounded: 1, cooldown: 0 });

export function createState(): State {
  const s: State = {
    frame: 0,
    phase: Phase.Intro,
    timer: INTRO_TICKS,
    goos: [newGoo(HOME_X[0]), newGoo(HOME_X[1])],
    ball: { x: HOME_X[0], y: SERVE_HEIGHT, vx: 0, vy: 0 },
    score: [0, 0],
    server: 0,
    touchSide: -1,
    touches: 0,
    ballSide: 0,
    rally: 0,
    pointWinner: -1,
    winner: -1,
  };
  return s;
}

export function cloneState(s: State): State {
  return {
    ...s,
    goos: [{ ...s.goos[0] }, { ...s.goos[1] }],
    ball: { ...s.ball },
    score: [s.score[0], s.score[1]],
  };
}

/** FNV-1a over every field. Server and clients compare these to prove they agree. */
export function hashState(s: State): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193);
    h ^= (v / 0x100000000) | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(s.frame); mix(s.phase); mix(s.timer);
  for (const g of s.goos) { mix(g.x); mix(g.y); mix(g.vx); mix(g.vy); mix(g.grounded); mix(g.cooldown); }
  const b = s.ball;
  mix(b.x); mix(b.y); mix(b.vx); mix(b.vy);
  mix(s.score[0]); mix(s.score[1]); mix(s.server); mix(s.touchSide); mix(s.touches);
  mix(s.ballSide); mix(s.rally); mix(s.pointWinner); mix(s.winner);
  return h >>> 0;
}

// ---------------------------------------------------------------- integer helpers

const div = (a: number, b: number) => Math.trunc(a / b);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const abs = Math.abs;

export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

function capSpeed(b: Ball) {
  const s2 = b.vx * b.vx + b.vy * b.vy;
  if (s2 > BALL_MAX_SPEED * BALL_MAX_SPEED) {
    const s = isqrt(s2);
    b.vx = div(b.vx * BALL_MAX_SPEED, s);
    b.vy = div(b.vy * BALL_MAX_SPEED, s);
  }
}

function emit(ev: GameEvent[] | undefined, type: EventType, side: number, x: number, y: number, power = 0) {
  ev?.push({ type, side, x, y, power });
}

// ---------------------------------------------------------------- goos

function gooBounds(side: number): [number, number] {
  return side === 0 ? [GOO_R, NET_X - NET_R - GOO_R] : [NET_X + NET_R + GOO_R, COURT_W - GOO_R];
}

function updateGoo(g: Goo, input: number, side: number, ev?: GameEvent[]) {
  g.vx = (input & RIGHT ? GOO_SPEED : 0) - (input & LEFT ? GOO_SPEED : 0);

  if (g.grounded && input & JUMP) {
    g.vy = GOO_JUMP;
    g.grounded = 0;
    emit(ev, "jump", side, g.x, g.y);
  }
  if (!g.grounded) {
    g.vy -= GOO_GRAVITY;
    if (g.vy > 0 && !(input & JUMP)) g.vy -= GOO_SHORT_HOP; // tap = short hop
  }

  g.x += g.vx;
  g.y += g.vy;
  const [lo, hi] = gooBounds(side);
  g.x = clamp(g.x, lo, hi);

  if (g.y <= GOO_R) {
    if (!g.grounded) emit(ev, "land", side, g.x, GOO_R, div(-g.vy, FP));
    g.y = GOO_R;
    g.vy = 0;
    g.grounded = 1;
  }
  if (g.cooldown > 0) g.cooldown--;
}

// ---------------------------------------------------------------- ball

/** Ball vs walls and net. Shared by the real game and the CPU's predictor. */
function ballWorld(b: Ball, ev?: GameEvent[]) {
  b.vy -= BALL_GRAVITY;
  b.x += b.vx;
  b.y += b.vy;

  if (b.x < BALL_R) {
    b.x = BALL_R;
    b.vx = div(abs(b.vx) * 9, 10);
    emit(ev, "wall", 0, b.x, b.y, div(abs(b.vx), FP));
  } else if (b.x > COURT_W - BALL_R) {
    b.x = COURT_W - BALL_R;
    b.vx = -div(abs(b.vx) * 9, 10);
    emit(ev, "wall", 1, b.x, b.y, div(abs(b.vx), FP));
  }

  // Net: closest point on the vertical segment (NET_X, 0..NET_TOP)
  const cy = b.y < NET_TOP ? (b.y < 0 ? 0 : b.y) : NET_TOP;
  const dx = b.x - NET_X;
  const dy = b.y - cy;
  const minD = BALL_R + NET_R;
  const d2 = dx * dx + dy * dy;
  if (d2 < minD * minD) {
    const d = isqrt(d2);
    let nx: number, ny: number;
    if (d === 0) {
      nx = b.vx > 0 ? -FP : FP;
      ny = 0;
    } else {
      nx = div(dx * FP, d);
      ny = div(dy * FP, d);
    }
    b.x = NET_X + div(nx * minD, FP);
    b.y = cy + div(ny * minD, FP);
    const dot = div(b.vx * nx + b.vy * ny, FP);
    if (dot < 0) {
      b.vx = div((b.vx - div(2 * dot * nx, FP)) * 85, 100);
      b.vy = div((b.vy - div(2 * dot * ny, FP)) * 85, 100);
      emit(ev, "net", b.x < NET_X ? 0 : 1, b.x, b.y, div(-dot, FP));
    }
  }
  capSpeed(b);
}

function collideGoo(s: State, side: number, countTouch: boolean, ev?: GameEvent[]): boolean {
  const g = s.goos[side];
  const b = s.ball;
  const dx = b.x - g.x;
  const dy = b.y - g.y;
  const minD = GOO_R + BALL_R;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minD * minD) return false;

  const d = isqrt(d2) || 1;
  const nx = div(dx * FP, d);
  const ny = div(dy * FP, d);
  b.x = g.x + div(nx * minD, FP);
  b.y = g.y + div(ny * minD, FP);
  // A hit always sends the ball off at the same speed along the contact normal,
  // plus some of the goo's own motion. Positioning is the skill.
  b.vx = div(nx * HIT_SPEED, FP) + div(g.vx, 2);
  b.vy = div(ny * HIT_SPEED, FP) + div(g.vy, 3);
  capSpeed(b);

  if (!countTouch || g.cooldown > 0) return false;
  g.cooldown = TOUCH_COOLDOWN;
  s.rally++;
  if (s.touchSide === side) s.touches++;
  else {
    s.touchSide = side;
    s.touches = 1;
  }
  const power = div(isqrt(b.vx * b.vx + b.vy * b.vy), FP);
  emit(ev, "hit", side, b.x, b.y, power);
  return true;
}

// ---------------------------------------------------------------- rules

function holdBall(s: State) {
  s.ball.x = HOME_X[s.server];
  s.ball.y = SERVE_HEIGHT;
  s.ball.vx = 0;
  s.ball.vy = 0;
}

function resetForServe(s: State) {
  for (let side = 0; side < 2; side++) {
    const g = s.goos[side];
    g.x = HOME_X[side];
    g.y = GOO_R;
    g.vx = g.vy = 0;
    g.grounded = 1;
    g.cooldown = 0;
  }
  s.phase = Phase.Serve;
  s.touchSide = -1;
  s.touches = 0;
  s.rally = 0;
  s.pointWinner = -1;
  s.ballSide = s.server;
  holdBall(s);
}

function scorePoint(s: State, winner: number, ev?: GameEvent[]) {
  s.score[winner]++;
  s.pointWinner = winner;
  s.server = winner;
  s.phase = Phase.Point;
  s.timer = POINT_TICKS;
  emit(ev, "point", winner, s.ball.x, s.ball.y, s.rally);
}

/** Advance the game by one tick. Mutates `s`. Optional `ev` collects events for sound and effects. */
export function step(s: State, in0: number, in1: number, ev?: GameEvent[]): void {
  s.frame++;
  const inputs = [in0, in1];

  if (s.phase === Phase.Over) {
    updateGoo(s.goos[0], in0, 0, ev);
    updateGoo(s.goos[1], in1, 1, ev);
    return;
  }

  if (s.phase === Phase.Intro) {
    updateGoo(s.goos[0], in0, 0, ev);
    updateGoo(s.goos[1], in1, 1, ev);
    if (--s.timer <= 0) {
      resetForServe(s);
      emit(ev, "serve", s.server, s.ball.x, s.ball.y);
    }
    return;
  }

  if (s.phase === Phase.Point) {
    for (let side = 0; side < 2; side++) updateGoo(s.goos[side], inputs[side], side, ev);
    const b = s.ball;
    ballWorld(b);
    if (b.y <= BALL_R) {
      b.y = BALL_R;
      if (b.vy < -2 * FP) emit(ev, "ground", b.x < NET_X ? 0 : 1, b.x, 0, div(-b.vy, FP));
      b.vy = div(-b.vy * 50, 100);
      b.vx = div(b.vx * 80, 100);
    }
    if (--s.timer <= 0) {
      if (s.score[s.pointWinner] >= WIN_SCORE) {
        s.phase = Phase.Over;
        s.winner = s.pointWinner;
        emit(ev, "win", s.winner, b.x, b.y);
      } else {
        resetForServe(s);
        emit(ev, "serve", s.server, s.ball.x, s.ball.y);
      }
    }
    return;
  }

  for (let side = 0; side < 2; side++) updateGoo(s.goos[side], inputs[side], side, ev);

  if (s.phase === Phase.Serve) {
    // The ball hangs in the air until the server touches it.
    holdBall(s);
    if (collideGoo(s, s.server, true, ev)) s.phase = Phase.Play;
    return;
  }

  // Phase.Play
  const b = s.ball;
  ballWorld(b, ev);

  const side = b.x < NET_X ? 0 : 1;
  if (side !== s.ballSide) {
    s.ballSide = side;
    s.touchSide = -1;
    s.touches = 0;
  }

  for (let g = 0; g < 2; g++) {
    if (collideGoo(s, g, true, ev) && s.touches > MAX_TOUCHES) {
      emit(ev, "fault", g, b.x, b.y);
      scorePoint(s, 1 - g, ev);
      return;
    }
  }

  if (b.y <= BALL_R) {
    b.y = BALL_R;
    emit(ev, "ground", side, b.x, 0, div(-b.vy, FP));
    b.vy = div(-b.vy * 50, 100);
    b.vx = div(b.vx * 80, 100);
    scorePoint(s, 1 - side, ev);
  }
}

// ---------------------------------------------------------------- prediction

export interface Prediction {
  /** flat [x, y, x, y, ...] in fixed point, one sample per tick */
  path: number[];
  /** first tick at which the ball is at or below `height` on `side`, or -1 */
  tick: number;
  x: number;
  y: number;
}

/**
 * Fly the ball forward ignoring the goos, using the same physics as the game.
 * Used by the CPU brain: "where will the ball be when it comes down to height h?"
 */
export function predictBall(ball: Ball, side: number, height: number, maxTicks = 180): Prediction {
  const b = { ...ball };
  const path: number[] = [b.x, b.y];
  for (let t = 1; t <= maxTicks; t++) {
    ballWorld(b);
    path.push(b.x, b.y);
    const onSide = side === 0 ? b.x < NET_X : b.x > NET_X;
    if (b.vy < 0 && b.y <= height && onSide) return { path, tick: t, x: b.x, y: b.y };
    if (b.y <= BALL_R) return { path, tick: -1, x: b.x, y: b.y };
  }
  return { path, tick: -1, x: b.x, y: b.y };
}

import { describe, expect, test } from "bun:test";
import { playMatch } from "./bench";
import { cloneState, createState, hashState, Phase, step } from "./index";

describe("simulation", () => {
  test("replaying the same inputs gives the same hash every frame", () => {
    const { s, inputs } = playMatch("normal", "hard", 42);
    const r = createState();
    for (let i = 0; i < inputs.length; i += 2) step(r, inputs[i], inputs[i + 1]);
    expect(hashState(r)).toBe(hashState(s));
    expect(r.score).toEqual(s.score);
  });

  test("clone is independent", () => {
    const s = createState();
    const c = cloneState(s);
    step(c, 2, 0);
    expect(hashState(s)).not.toBe(hashState(c));
    expect(s.goos[0].x).not.toBe(c.goos[0].x);
  });

  test("CPU vs CPU matches finish with real rallies", () => {
    for (const seed of [1, 2, 3]) {
      const { s, rallies } = playMatch("normal", "normal", seed);
      expect(s.phase).toBe(Phase.Over);
      const avg = rallies.reduce((a, b) => a + b, 0) / rallies.length;
      expect(avg).toBeGreaterThan(1.5);
    }
  });

  test("all positions stay integers", () => {
    const { s } = playMatch("hard", "easy", 9);
    for (const v of [s.ball.x, s.ball.y, s.goos[0].x, s.goos[1].y]) expect(Number.isInteger(v)).toBe(true);
  });
});

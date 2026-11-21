// CPU vs CPU matches without graphics: `bun sim/bench.ts`
import { CpuPlayer, type Difficulty } from "./cpu";
import { createState, Phase, step, type GameEvent } from "./index";

export function playMatch(d0: Difficulty, d1: Difficulty, seed: number, maxFrames = 60 * 60 * 15) {
  const s = createState();
  const a = new CpuPlayer(0, d0, seed);
  const b = new CpuPlayer(1, d1, seed * 7 + 1);
  const inputs: number[] = [];
  const rallies: number[] = [];
  const ev: GameEvent[] = [];
  while (s.phase !== Phase.Over && s.frame < maxFrames) {
    const i0 = a.think(s), i1 = b.think(s);
    inputs.push(i0, i1);
    ev.length = 0;
    step(s, i0, i1, ev);
    for (const e of ev) if (e.type === "point") rallies.push(e.power);
  }
  return { s, inputs, rallies };
}

if (import.meta.main) {
  for (const [d0, d1] of [["easy", "normal"], ["normal", "normal"], ["normal", "hard"], ["hard", "hard"]] as const) {
    for (const seed of [1, 2, 3]) {
      const { s, rallies } = playMatch(d0, d1, seed);
      const avg = rallies.reduce((a, b) => a + b, 0) / Math.max(1, rallies.length);
      console.log(`${d0} vs ${d1} seed ${seed}: ${s.score.join(":")} in ${(s.frame / 60).toFixed(0)}s, avg rally ${avg.toFixed(1)} hits, max ${Math.max(...rallies)}`);
    }
  }
}

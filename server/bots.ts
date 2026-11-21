// Two headless CPU clients play an invite match against the real server and
// check every state hash the server sends. `bun server/bots.ts [seconds]`
// JOIN=ABCD bun server/bots.ts 30   → one bot joins your invite code instead

import { CpuPlayer } from "../sim/cpu";
import { createState, hashState, step } from "../sim/index";
import type { ClientMsg, ServerMsg } from "../sim/protocol";

const URL = process.env.WS ?? "ws://localhost:8787/ws";
const SECONDS = Number(process.argv[2] ?? 8);

function bot(name: string, onReady: (send: (m: ClientMsg) => void) => void, onMsg?: (m: ServerMsg) => void) {
  const ws = new WebSocket(URL);
  const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
  const stats = { frames: 0, checks: 0, desyncs: 0, score: "0:0", side: -1 };
  let s = createState();
  let cpu: CpuPlayer | null = null;
  let sent = -1;
  ws.onopen = () => onReady(send);
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMsg;
    onMsg?.(m);
    if (m.t === "start") {
      stats.side = m.side;
      s = createState();
      cpu = new CpuPlayer(m.side, "hard", name.length);
    }
    if (m.t === "f" && cpu) {
      step(s, m.a, m.b);
      stats.frames++;
      stats.score = s.score.join(":");
      if (m.h !== undefined) {
        stats.checks++;
        if (hashState(s) !== m.h) stats.desyncs++;
      }
      // decide from the confirmed state, a few frames ahead (like a laggy human)
      const input = cpu.think(s);
      while (sent < m.f + 4) send({ t: "in", f: ++sent, i: input });
    }
  };
  return { ws, stats };
}

let code = process.env.JOIN ?? "";
let guest: ReturnType<typeof bot> | null = null;
const host = code ? bot("guest!", (send) => send({ t: "join", code })) : bot("host", (send) => send({ t: "create" }), (m) => {
  if (m.t === "room") {
    code = m.code;
    console.log(`room ${code} created, guest joining…`);
    guest = bot("guest!", (send) => send({ t: "join", code }));
  }
});

setTimeout(() => {
  for (const [n, b] of [["host", host], ["guest", guest]] as const) {
    if (!b) continue;
    const st = b.stats;
    console.log(`${n}: side ${st.side}, ${st.frames} frames, score ${st.score}, hash checks ${st.checks}, desyncs ${st.desyncs}`);
  }
  const ok = host.stats.checks > 0 && host.stats.desyncs === 0 && (guest?.stats.desyncs ?? 0) === 0;
  console.log(ok ? "OK: clients and server agree on every checked frame" : "FAIL");
  process.exit(ok ? 0 : 1);
}, SECONDS * 1000);

// Goo Goo Volley server: rooms, invite codes, a random queue, and the referee.
//
// The server owns the clock. Every tick it takes each player's input for that
// frame (or repeats their last one if it is late), steps the shared simulation,
// and broadcasts the confirmed inputs. Clients predict ahead and roll back.

import type { ServerWebSocket } from "bun";
import { join, normalize } from "node:path";
import { createState, hashState, Phase, step, TICK_MS, type State } from "../sim/index";
import type { ClientMsg, ServerMsg } from "../sim/protocol";

const PORT = Number(process.env.PORT ?? 8787);
const DIST = join(import.meta.dir, "../dist");
const HASH_EVERY = 60;

// Abuse limits. Normal play is ~62 messages/s per player and one room per socket.
const LIMITS = {
  connections: Number(process.env.MAX_CONNECTIONS ?? 2000),
  perIp: Number(process.env.MAX_PER_IP ?? 8),
  rooms: Number(process.env.MAX_ROOMS ?? 1000),
  msgsPerSec: 100, // sustained, per socket
  msgBurst: 200,
  maxMessageBytes: 256,
  idleSeconds: Number(process.env.IDLE_SECONDS ?? 30), // clients ping every 0.5 s: silence = dead or hostile
  inviteMinutes: 30, // an unanswered invite expires
};
// Behind a proxy every connection comes from the proxy, so read the player's
// address from a header the proxy sets, e.g. IP_HEADER=cf-connecting-ip
// (Cloudflare) or x-forwarded-for. Leave it unset when players connect directly,
// otherwise they could fake the header.
const IP_HEADER = process.env.IP_HEADER?.toLowerCase();

interface Peer {
  id: number;
  ip: string;
  room: Room | null;
  side: 0 | 1;
  queued: boolean;
  tokens: number;
  refilled: number;
  lastMsg: number;
}

interface Room {
  code: string;
  players: (ServerWebSocket<Peer> | null)[];
  sim: State | null;
  startedAt: number;
  pending: [Map<number, number>, Map<number, number>];
  last: [number, number];
  lead: [number, number];
  rematch: [boolean, boolean];
  private: boolean;
  createdAt: number;
}

const rooms = new Map<string, Room>();
const perIp = new Map<string, number>();
const sockets = new Set<ServerWebSocket<Peer>>();
let connections = 0;
let queue: ServerWebSocket<Peer> | null = null;
let nextId = 1;

const send = (ws: ServerWebSocket<Peer> | null, msg: ServerMsg) => ws?.send(JSON.stringify(msg));

function makeCode(): string {
  const abc = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels: no accidental words
  let code: string;
  do code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
  while (rooms.has(code));
  return code;
}

function newRoom(isPrivate: boolean): Room {
  const room: Room = {
    code: makeCode(),
    players: [null, null],
    sim: null,
    startedAt: 0,
    pending: [new Map(), new Map()],
    last: [0, 0],
    lead: [0, 0],
    rematch: [false, false],
    private: isPrivate,
    createdAt: performance.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function seat(room: Room, ws: ServerWebSocket<Peer>, side: 0 | 1) {
  room.players[side] = ws;
  ws.data.room = room;
  ws.data.side = side;
}

function startMatch(room: Room) {
  room.sim = createState();
  room.startedAt = performance.now();
  room.pending = [new Map(), new Map()];
  room.last = [0, 0];
  room.rematch = [false, false];
  room.players.forEach((p, side) => send(p, { t: "start", side: side as 0 | 1, code: room.code }));
  log(`match ${room.code} started`);
}

function leaveRoom(ws: ServerWebSocket<Peer>) {
  if (queue === ws) queue = null;
  const room = ws.data.room;
  if (!room) return;
  ws.data.room = null;
  const other = room.players[1 - ws.data.side];
  room.players[ws.data.side] = null;
  room.sim = null;
  if (other) {
    send(other, { t: "left" });
    other.data.room = null;
  }
  rooms.delete(room.code);
}

function tickRoom(room: Room, now: number) {
  const s = room.sim;
  if (!s) return;
  // Catch up on every frame that is due (timers in JS are never exactly on time).
  let due = Math.floor((now - room.startedAt) / TICK_MS);
  let guard = 10;
  while (s.frame < due && guard-- > 0) {
    const f = s.frame; // the frame we are about to simulate
    const inputs = [0, 1].map((p) => {
      const got = room.pending[p].get(f);
      if (got !== undefined) {
        room.pending[p].delete(f);
        room.last[p] = got;
      }
      return room.last[p];
    }) as [number, number];

    step(s, inputs[0], inputs[1]);
    const h = s.frame % HASH_EVERY === 0 ? hashState(s) : undefined;
    for (let p = 0; p < 2; p++) {
      send(room.players[p], { t: "f", f, a: inputs[0], b: inputs[1], l: room.lead[p], ...(h !== undefined && { h }) });
    }
    if (s.phase === Phase.Over) {
      log(`match ${room.code} over ${s.score.join(":")}`);
      room.sim = null;
      return;
    }
  }
  if (guard <= 0) room.startedAt = now - s.frame * TICK_MS; // we stalled; don't fast-forward
}

setInterval(() => {
  const now = performance.now();
  for (const room of rooms.values()) tickRoom(room, now);
}, 4);

setInterval(() => {
  const now = performance.now();
  for (const room of rooms.values()) {
    const waiting = room.private && !room.players[1] && !room.sim;
    if (waiting && now - room.createdAt > LIMITS.inviteMinutes * 60_000 && room.players[0]) {
      send(room.players[0], { t: "error", msg: "Your invite expired. Create a new one." });
      leaveRoom(room.players[0]);
    }
  }
}, 60_000);

// Bun's own ping/pong keeps a socket "active", so check for game messages
// ourselves: real clients ping every 0.5 s.
setInterval(() => {
  const now = performance.now();
  for (const ws of sockets) if (now - ws.data.lastMsg > LIMITS.idleSeconds * 1000) ws.close(1000, "idle");
}, 5_000);

/** Token bucket: true if this socket may send another message. */
function allow(p: Peer): boolean {
  const now = performance.now();
  p.tokens = Math.min(LIMITS.msgBurst, p.tokens + ((now - p.refilled) / 1000) * LIMITS.msgsPerSec);
  p.refilled = now;
  if (p.tokens < 1) return false;
  p.tokens--;
  return true;
}

function onMessage(ws: ServerWebSocket<Peer>, msg: ClientMsg) {
  const room = ws.data.room;
  switch (msg.t) {
    case "ping":
      send(ws, { t: "pong", c: msg.c });
      break;

    case "create": {
      leaveRoom(ws);
      if (rooms.size >= LIMITS.rooms) {
        send(ws, { t: "error", msg: "The server is full right now. Try again in a minute." });
        break;
      }
      const r = newRoom(true);
      seat(r, ws, 0);
      send(ws, { t: "room", code: r.code });
      break;
    }

    case "join": {
      const r = rooms.get(String(msg.code).toUpperCase());
      if (!r || !r.private || r.players[1] || r.players[0] === ws) {
        send(ws, { t: "error", msg: "That invite is not open anymore." });
        break;
      }
      leaveRoom(ws);
      seat(r, ws, 1);
      startMatch(r);
      break;
    }

    case "queue": {
      leaveRoom(ws);
      if (rooms.size >= LIMITS.rooms) {
        send(ws, { t: "error", msg: "The server is full right now. Try again in a minute." });
        break;
      }
      if (queue && queue !== ws && queue.readyState === 1) {
        const r = newRoom(false);
        seat(r, queue, 0);
        seat(r, ws, 1);
        queue.data.queued = false;
        queue = null;
        startMatch(r);
      } else {
        queue = ws;
        send(ws, { t: "waiting" });
      }
      break;
    }

    case "leave":
      leaveRoom(ws);
      break;

    case "in": {
      if (!room?.sim) break;
      const p = ws.data.side;
      const f = msg.f | 0;
      const next = room.sim.frame;
      room.lead[p] = f - next;
      if (f >= next && f < next + 600) room.pending[p].set(f, msg.i & 7);
      else if (f < next) room.last[p] = msg.i & 7; // late: apply from the next frame on
      break;
    }

    case "rematch": {
      if (!room || room.sim) break;
      room.rematch[ws.data.side] = true;
      const other = room.players[1 - ws.data.side];
      send(other, { t: "rematch" });
      if (room.rematch[0] && room.rematch[1]) startMatch(room);
      break;
    }
  }
}

function log(s: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${s} (rooms: ${rooms.size})`);
}

const server = Bun.serve<Peer>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const fwd = IP_HEADER ? req.headers.get(IP_HEADER)?.split(",")[0].trim() : undefined;
      const ip = fwd || srv.requestIP(req)?.address || "?";
      if (connections >= LIMITS.connections) return new Response("server full", { status: 503 });
      if ((perIp.get(ip) ?? 0) >= LIMITS.perIp) return new Response("too many connections", { status: 429 });
      const data: Peer = { id: nextId++, ip, room: null, side: 0, queued: false, tokens: LIMITS.msgBurst, refilled: performance.now(), lastMsg: performance.now() };
      if (srv.upgrade(req, { data })) return;
      return new Response("expected a websocket", { status: 400 });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, rooms: rooms.size, connections });
    // Static files from the Vite build
    const path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    const file = Bun.file(join(DIST, path === "/" ? "index.html" : path));
    if (await file.exists()) {
      // Vite puts a content hash in every asset name, so those never change.
      const immutable = path.startsWith("/assets/");
      return new Response(file, {
        headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
      });
    }
    return new Response(Bun.file(join(DIST, "index.html")), { headers: { "cache-control": "no-cache" } });
  },
  websocket: {
    maxPayloadLength: LIMITS.maxMessageBytes,
    idleTimeout: LIMITS.idleSeconds * 2, // transport-level backstop
    open(ws) {
      sockets.add(ws);
      connections++;
      perIp.set(ws.data.ip, (perIp.get(ws.data.ip) ?? 0) + 1);
    },
    message(ws, raw) {
      ws.data.lastMsg = performance.now();
      if (!allow(ws.data)) {
        ws.close(1008, "too many messages");
        return;
      }
      try {
        onMessage(ws, JSON.parse(String(raw)) as ClientMsg);
      } catch {
        /* ignore garbage */
      }
    },
    close(ws) {
      sockets.delete(ws);
      connections--;
      const n = (perIp.get(ws.data.ip) ?? 1) - 1;
      if (n > 0) perIp.set(ws.data.ip, n);
      else perIp.delete(ws.data.ip);
      leaveRoom(ws);
    },
  },
});

log(`Goo Goo Volley server on http://localhost:${server.port}`);

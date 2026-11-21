# Goo Goo Volley

Squishy 3D beach volleyball in the browser. Play the CPU, a friend on the same keyboard,
an invite link, or a random opponent. First to 7.

Inspired by the classic blob-volleyball games of the 2000s (such as Blobby Volley).
All code, characters, art and sound here are original; nothing is taken from those games.

## Run it

```sh
bun install
bun run dev        # Vite on :5173 + game server on :8787 (proxied at /ws)
bun test           # simulation tests
bun sim/bench.ts   # CPU vs CPU matches, no graphics
bun server/bots.ts # two bot clients play through the real server and check hashes
```

Production: `bun run build && bun run start` serves the game and the WebSocket from one
port (`PORT`, default 8787). Or `docker build -t goo-goo-volley . && docker run -p 8787:8787 goo-goo-volley`,
then put it behind a reverse proxy that passes WebSocket upgrades on `/ws`. The live version runs at
**https://googoovolley.getwimi.app** with `compose.prod.yaml` behind Caddy and Cloudflare.

Abuse limits (environment variables, defaults in brackets): `MAX_CONNECTIONS` [2000], `MAX_PER_IP` [8],
`MAX_ROOMS` [1000], `IDLE_SECONDS` [30]. Each socket may send 100 messages/s (bursts of 200) of at most
256 bytes, and unanswered invites expire after 30 minutes. **Behind a proxy set `IP_HEADER`** to the header
that carries the player's address (`cf-connecting-ip` behind Cloudflare, `x-forwarded-for` behind a plain
proxy that overwrites it); without it every player looks like the proxy. Leave it unset when players connect
directly, or they could fake their address. `/health` reports rooms and connections.

## How it works

```
sim/      deterministic game: integer physics, rules, CPU brain, protocol types
web/      Vite + three.js: 3D beach, squishy goos, effects, sound, UI, netcode client
server/   Bun: rooms, invite codes, random queue, the referee
```

- **One simulation everywhere.** `sim/index.ts` is plain TypeScript using only integer
  math, so the browser and the server compute bit-identical games. Every 60 frames the
  server sends a hash of its state; the client compares (Netcode panel → State check).
- **2D game, 3D show.** The physics is a flat side view (circles, a capsule net, two walls).
  three.js draws it on a beach: a spring drives squash and stretch, and a vertex shader
  adds wobble and lean. The eyes follow the ball.
- **CPU brain.** The CPU predicts the ball with the real physics (`predictBall`), picks a
  spot behind the ball so the bounce goes toward the net, and sometimes times a jump spike.
  It reacts with a human-ish delay. Press **B** to see the path, meeting point, target and jump timer.
- **Netcode.** The server owns the clock and broadcasts confirmed inputs each frame.
  The client runs ahead by about one round trip, plays your input immediately and guesses the
  opponent's input ("same buttons as before"). When the real inputs arrive it rewinds to the
  confirmed state and re-simulates (rollback). Press **N** for the panel and the fake-lag slider,
  and untick prediction to see why it matters.
- **Replays are inputs.** A rally is stored as its starting state + the buttons pressed
  (one byte per frame). Re-running them rebuilds the point exactly; the slow-motion replay
  with an orbiting camera is just that, played at 0.4×.
- **Sound** is synthesised with WebAudio. There are no audio files.

## Keys

Move `←` `→` / `A` `D`, jump `↑` / `W` / `Space` (hold to jump higher).
Two players on one keyboard: left `A` `D` `W`, right arrows.
`B` CPU brain · `N` netcode panel · `R` replays on/off · `M` sound · `Esc` menu.

`ggv.state()` in the browser console returns the live game state.

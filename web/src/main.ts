import * as THREE from "three";
import { CpuPlayer, type Difficulty } from "../../sim/cpu";
import { cloneState, createState, GOO_R, Phase, step, TICK_MS, type GameEvent, type State } from "../../sim/index";
import type { ServerMsg } from "../../sim/protocol";
import { Sfx } from "./audio";
import { readLocal, readSolo, setupTouch } from "./input";
import { Connection, OnlineMatch } from "./net";
import { Recorder, REPLAY_RATE, Replayer } from "./replay";
import { S, View } from "./view";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const view = new View($("#stage"));
const sfx = new Sfx();
const conn = new Connection();
setupTouch($("#touch"));

// ---------------------------------------------------------------- game modes

type Kind = "demo" | "cpu" | "local" | "practice";
type Mode = Kind | "online";

interface LocalGame {
  kind: Kind;
  s: State;
  prev: State;
  cpu: [CpuPlayer | null, CpuPlayer | null];
  rec: Recorder;
  acc: number;
}

let mode: Mode = "demo";
let local: LocalGame | null = null;
let online: OnlineMatch | null = null;
let replay: Replayer | null = null;
let names: [string, string] = ["MINT", "TANGO"];
let difficulty: Difficulty = "normal";
const tools = { brain: false, net: false, replay: true, sound: true };

function newLocal(kind: Kind): LocalGame {
  const seed = (Math.random() * 1e9) | 0;
  const cpu: LocalGame["cpu"] =
    kind === "demo"
      ? [new CpuPlayer(0, "hard", seed), new CpuPlayer(1, "normal", seed + 1)]
      : kind === "local"
        ? [null, null]
        : [null, new CpuPlayer(1, kind === "practice" ? "easy" : difficulty, seed)];
  const s = createState();
  return { kind, s, prev: cloneState(s), cpu, rec: new Recorder(), acc: 0 };
}

function startLocal(kind: Kind) {
  leaveOnline();
  endReplay();
  local = newLocal(kind);
  mode = kind;
  names = kind === "cpu" ? ["YOU", "CPU"] : kind === "practice" ? ["YOU", "CPU"] : ["MINT", "TANGO"];
  view.setCameraMode(kind === "demo" ? "menu" : "live");
  lastScore = [-1, -1];
  show(kind === "demo" ? "menu" : kind === "practice" ? "waiting" : null);
}

function tickLocal(g: LocalGame) {
  const s = g.s;
  const human = (side: 0 | 1) => (g.kind === "local" ? readLocal(side) : readSolo());
  const i0 = g.cpu[0] ? g.cpu[0].think(s) : human(0);
  const i1 = g.cpu[1] ? g.cpu[1].think(s) : human(1);
  g.rec.record(s, i0, i1);
  g.prev = cloneState(s);
  const ev: GameEvent[] = [];
  step(s, i0, i1, ev);
  liveEffects(ev);
  rules(ev, g.rec, s);
}

// ---------------------------------------------------------------- online

function leaveOnline() {
  if (online || mode === "practice") conn.send({ t: "leave" });
  online = null;
}

async function goOnline(what: "queue" | "create" | { join: string }) {
  sfx.unlock();
  startLocal("practice");
  const join = typeof what === "object";
  $("#wait-title").textContent = join ? "Joining your friend…" : what === "queue" ? "Looking for an opponent…" : "Creating a private match…";
  $("#invite-box").hidden = true;
  try {
    await conn.connect();
  } catch (e) {
    toast((e as Error).message);
    return startLocal("demo");
  }
  conn.send(join ? { t: "join", code: what.join } : { t: what });
}

conn.onMessage = (m: ServerMsg) => {
  switch (m.t) {
    case "room": {
      const url = `${location.origin}/?room=${m.code}`;
      $("#wait-title").textContent = "Your private match is ready";
      $("#invite-box").hidden = false;
      $<HTMLInputElement>("#invite-link").value = url;
      break;
    }
    case "waiting":
      $("#wait-title").textContent = "Looking for an opponent…";
      break;
    case "start":
      endReplay();
      local = null;
      online = new OnlineMatch(m.side, conn);
      online.predict = $<HTMLInputElement>("#predict").checked;
      mode = "online";
      names = m.side === 0 ? ["YOU", "RIVAL"] : ["RIVAL", "YOU"];
      lastScore = [-1, -1];
      view.setCameraMode("live");
      show(null);
      history.replaceState(null, "", "/");
      break;
    case "f": {
      if (!online) break;
      const ev = online.onFrame(m);
      if (!online.predict) liveEffects(ev);
      rules(ev, online.recorder, online.confirmed);
      break;
    }
    case "rematch":
      $("#rematch-note").textContent = "Your opponent wants a rematch!";
      break;
    case "left":
      toast("Your opponent left the match.");
      online = null;
      startLocal("demo");
      break;
    case "error":
      toast(m.msg);
      startLocal("demo");
      history.replaceState(null, "", "/");
      break;
  }
};
conn.onClose = () => {
  if (mode === "online" || mode === "practice") {
    toast("Lost the connection to the server.");
    online = null;
    startLocal("demo");
  }
};

// ---------------------------------------------------------------- events → effects, rules → UI

function liveEffects(ev: GameEvent[]) {
  if (replay) return;
  for (const e of ev) {
    view.fx(e);
    if (mode !== "demo") sfx.play(e, 1, mySide());
  }
}

function mySide() {
  return online ? online.side : mode === "cpu" || mode === "practice" ? 0 : -1;
}

function rules(ev: GameEvent[], rec: Recorder, s: State) {
  for (const e of ev) {
    if (e.type === "point") {
      banner(`${names[e.side] === "YOU" ? "Point!" : `${cap(names[e.side])} scores`}`, e.power > 1 ? `${e.power} hit rally` : "");
      const clip = rec.clip();
      if (tools.replay && mode !== "demo" && clip && clip.inputs.length > 30) startReplay(new Replayer(clip));
    }
    if (e.type === "serve") banner("");
    if (e.type === "win") {
      if (mode === "demo") {
        setTimeout(() => mode === "demo" && startLocal("demo"), 3500);
        continue;
      }
      const me = mySide();
      $("#over-title").textContent = me < 0 ? `${cap(names[e.side])} wins!` : e.side === me ? "You win!" : names[e.side] === "CPU" ? "The CPU wins" : "You lose";
      $("#over-score").textContent = `${s.score[0]} : ${s.score[1]}`;
      $("#rematch-note").textContent = "";
      show("over");
    }
  }
}

const cap = (s: string) => s[0] + s.slice(1).toLowerCase();

function startReplay(r: Replayer) {
  replay = r;
  view.setCameraMode("replay");
  document.body.classList.add("replay");
  $("#replay-badge").hidden = false;
}

function endReplay() {
  if (!replay) return;
  replay = null;
  view.setCameraMode(mode === "demo" ? "menu" : "live");
  document.body.classList.remove("replay");
  $("#replay-badge").hidden = true;
}

// ---------------------------------------------------------------- UI

function show(panel: "menu" | "waiting" | "over" | null) {
  for (const id of ["menu", "waiting", "over"]) $("#" + id).hidden = id !== panel;
  $("#hud").hidden = mode === "demo";
}

let bannerText = "";
function banner(text: string, sub = "") {
  const html = text ? `${text}${sub ? `<small>${sub}</small>` : ""}` : "";
  if (html === bannerText) return;
  bannerText = html;
  const b = $("#banner");
  b.innerHTML = html;
  b.classList.remove("pop");
  void b.offsetWidth;
  if (html) b.classList.add("pop");
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
}

let lastScore: [number, number] = [-1, -1];
let lastCount = -1;
function updateHud(s: State) {
  $("#name0").textContent = names[0];
  $("#name1").textContent = names[1];
  for (let i = 0; i < 2; i++) {
    if (s.score[i] !== lastScore[i]) {
      const el = $("#score" + i);
      el.textContent = String(s.score[i]);
      if (lastScore[i] >= 0) {
        el.classList.remove("bump");
        void el.offsetWidth;
        el.classList.add("bump");
      }
      lastScore[i] = s.score[i];
    }
  }
  if (s.phase === Phase.Intro) {
    const n = Math.ceil(s.timer / 50);
    if (n !== lastCount) {
      lastCount = n;
      banner(String(n));
      if (mode !== "demo") sfx.tick();
    }
  } else if (lastCount > 0 && s.phase === Phase.Serve) {
    lastCount = 0;
    banner("Go!");
    if (mode !== "demo") sfx.tick(true);
    setTimeout(() => bannerText === "Go!" && banner(""), 700);
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-act]")) {
  b.addEventListener("click", () => {
    sfx.unlock();
    const act = b.dataset.act;
    if (act === "cpu") startLocal("cpu");
    if (act === "local") startLocal("local");
    if (act === "queue") void goOnline("queue");
    if (act === "invite") void goOnline("create");
    if (act === "menu") {
      leaveOnline();
      startLocal("demo");
    }
    if (act === "rematch") {
      if (online) {
        conn.send({ t: "rematch" });
        $("#rematch-note").textContent = "Waiting for your opponent…";
      } else if (local) startLocal(local.kind);
    }
    b.blur();
  });
}
for (const r of document.querySelectorAll<HTMLInputElement>("input[name=diff]")) {
  r.addEventListener("change", () => (difficulty = r.value as Difficulty));
}
$("#copy").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("#invite-link");
  try {
    await navigator.clipboard.writeText(input.value);
    toast("Link copied. Send it to a friend!");
  } catch {
    input.select();
  }
});

function setTool(name: keyof typeof tools, on = !tools[name]) {
  tools[name] = on;
  $(`[data-tool=${name}]`).classList.toggle("on", on);
  if (name === "net") $("#netpanel").hidden = !on;
  if (name === "sound") sfx.enabled = on;
  if (name === "replay" && !on) endReplay();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
  b.addEventListener("click", () => {
    setTool(b.dataset.tool as keyof typeof tools);
    b.blur();
  });
}
window.addEventListener("keydown", (e) => {
  if (e.repeat || (e.target as HTMLElement).tagName === "INPUT") return;
  sfx.unlock();
  const k = e.code;
  if (k === "KeyB") setTool("brain");
  else if (k === "KeyN") setTool("net");
  else if (k === "KeyR") setTool("replay");
  else if (k === "KeyM") setTool("sound");
  else if (k === "Escape" && mode !== "demo") {
    leaveOnline();
    startLocal("demo");
  } else if (replay && (k === "Space" || k === "Enter")) endReplay();
});

const lag = $<HTMLInputElement>("#lag");
lag.addEventListener("input", () => {
  conn.lagMs = Number(lag.value);
  $("#lag-out").textContent = `${lag.value} ms`;
});
$<HTMLInputElement>("#predict").addEventListener("change", (e) => {
  if (online) online.predict = (e.target as HTMLInputElement).checked;
});

let netUpdate = 0;
function updateNetPanel() {
  if (!tools.net || performance.now() - netUpdate < 120) return;
  netUpdate = performance.now();
  const set = (id: string, html: string) => ($(id).innerHTML = html);
  if (!online) {
    set("#ns-mode", mode === "practice" ? "waiting for match" : "offline");
    for (const id of ["#ns-rtt", "#ns-ahead", "#ns-resim", "#ns-lead", "#ns-sync"]) set(id, "–");
    if (conn.open) set("#ns-rtt", `${conn.rtt.toFixed(0)} ms`);
    return;
  }
  const st = online.stats;
  set("#ns-mode", `online · ${online.side === 0 ? "left" : "right"}`);
  set("#ns-rtt", `${conn.rtt.toFixed(0)} ms`);
  const fr = (n: number) => `${n} frame${n === 1 ? "" : "s"}`;
  set("#ns-ahead", `${fr(st.ahead)} · ${(st.ahead * TICK_MS).toFixed(0)} ms`);
  set("#ns-resim", `${fr(st.resim)} in ${(st.resimMs * 1000).toFixed(0)} µs`);
  set("#ns-lead", st.lead >= 0 ? `<span class="ok">${fr(st.lead)} early</span>` : `<span class="bad">${fr(-st.lead)} late</span>`);
  set(
    "#ns-sync",
    st.desyncs
      ? `<span class="bad">✗ ${st.desyncs} mismatches</span>`
      : st.checks
        ? `<span class="ok">✓ ${st.checks}× identical</span> <small>${st.lastHash.toString(16).padStart(8, "0")}</small>`
        : "waiting…",
  );
}

// ---------------------------------------------------------------- labels over the goos

const head = new THREE.Vector3();
function placeLabel(el: HTMLElement, s: State, side: number, on: boolean, lift = 0.45) {
  el.hidden = !on;
  if (!on) return;
  const g = s.goos[side];
  head.set(g.x * S, (g.y + GOO_R) * S + lift, 0);
  const p = view.toScreen(head);
  el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
}

function updateBrain(cur: State) {
  const label = $("#brain-label");
  const cpu = local?.cpu[1] ?? null;
  const on = tools.brain && !!cpu && !replay;
  view.setBrain(on ? cpu!.brain : null, 1, cur.goos[1].x * S);
  if (!on || !cpu) return placeLabel(label, cur, 1, false);
  const b = cpu.brain;
  const f = (v: number | null) => (v === null ? "–" : Math.round(v / 1000));
  label.innerHTML =
    `<b>${b.mode.toUpperCase()}</b><br>` +
    `meet ball at x=${f(b.meetX)} y=${f(b.meetY)}<br>` +
    `walk to x=${f(b.targetX)}<br>` +
    (b.jumpIn >= 0 ? `jump in ${b.jumpIn} frames<br>` : "") +
    `rethink in ${b.reactIn} frames`;
  placeLabel(label, cur, 1, b.mode !== "idle", 0.55);
}

// ---------------------------------------------------------------- main loop

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  let draw: { prev: State; cur: State; alpha: number } | null = null;
  let truth: State | null = null;

  if (online) {
    const ev = online.update(readSolo());
    if (online.predict) liveEffects(ev);
    draw = online.view();
    truth = online.confirmed;
  } else if (local) {
    local.acc += dt * 1000;
    let n = 0;
    while (local.acc >= TICK_MS && n++ < 6) {
      local.acc -= TICK_MS;
      tickLocal(local);
    }
    if (n >= 6) local.acc = 0;
    draw = { prev: local.prev, cur: local.s, alpha: local.acc / TICK_MS };
    truth = local.s;
  }

  if (replay) {
    for (const e of replay.advance(dt)) {
      view.fx(e);
      if (mode !== "demo") sfx.play(e, REPLAY_RATE * 1.4, mySide());
    }
    // a replay never outlasts the pause between points
    if (replay.done || (truth && truth.phase !== Phase.Point && truth.phase !== Phase.Over)) endReplay();
    else draw = { prev: replay.prev, cur: replay.cur, alpha: replay.alpha };
  }

  if (draw && truth) {
    view.render(draw.prev, draw.cur, draw.alpha, dt);
    updateHud(truth);
    updateBrain(draw.cur);
    const me = mySide();
    placeLabel($("#you-label"), draw.cur, me, me >= 0 && !replay && truth.phase !== Phase.Over);
  }
  updateNetPanel();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot

const room = new URLSearchParams(location.search).get("room");
if (room) void goOnline({ join: room });
else startLocal("demo");
requestAnimationFrame(frame);

// Debug handle for the console and for scripted video takes: ggv.state()
Object.assign(window, { ggv: { state: () => (online ? online.confirmed : local?.s), mode: () => mode } });

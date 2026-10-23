import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { BloomEffect, BrightnessContrastEffect, EffectComposer, EffectPass, HueSaturationEffect, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode } from "postprocessing";
import { buildArena, type Arena } from "./arena";
import { PALETTE } from "./kit";
import { Striker, createMech, type Organism } from "./mechs";
import { sfx, unlockAudio } from "./audio";
import { Debug, type Unit } from "./debug";
import { Fx } from "./fx";
import { Gear } from "./gear";
import { Net } from "./net";
import * as physics from "./physics";
import { KINDS, MODES, PLAYER_COLOR, SWARMS, SWARM_COLORS, TICK_MS } from "./protocol";
import type { EnemyRow, GameEvent, GearKind, Kind, Phase, PlayerRow, Snapshot, Swarm, Welcome } from "./protocol";
import { Knife } from "./knife";
import { Rifle } from "./weapon";

await RAPIER.init();

const INTERP_TICKS = 2;
const EYE = 1.6;
const SHOT_MS = 140;
const STAB_MS = 450; // as KNIFE_TICKS in src/sim.py
const SWAP_S = 0.4; // put one weapon away (first 0.15 s), bring the other up
const BASE_FOV = 78;
const SCOPE_FOV = 28; // about 2.8x
// Hit spheres per kind, as in src/sim.py: [height, radius].
const HIT: Record<Kind, [number, number][]> = { striker: [[0.95, 0.55], [1.65, 0.32]], sentinel: [[1.35, 1.05], [2.6, 0.6]] };
const HEIGHT: Record<Kind, number> = { striker: 1.9, sentinel: 3.0 };

const $ = (id: string) => document.getElementById(id)!;
const rand = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
function stored(key: string, make: () => string) {
  try {
    const v = sessionStorage.getItem(key) ?? make();
    sessionStorage.setItem(key, v);
    return v;
  } catch {
    return make();
  }
}

// Room from the URL, so a reload rejoins the same ArenaAgent.
const params = new URLSearchParams(location.search);
let room = params.get("room") ?? "";
if (!/^[A-Za-z0-9_-]{3,32}$/.test(room)) {
  room = `r-${rand(6)}`;
  history.replaceState(null, "", `?room=${room}`);
}
let pid = stored("crosswind-pid", () => `p-${rand(10)}`);
const callsign = (p: string | null) => (p ? p.slice(-4).toUpperCase() : "Unknown");
$("room-name").textContent = room;

// Renderer and post-processing
const renderer = new THREE.WebGLRenderer({ powerPreference: "high-performance", antialias: false, stencil: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$("app").appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
// Light haze for distance only: the arena itself stays crisp.
scene.fog = new THREE.Fog(0xd3e6ee, 90, 430);
const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, 400);
// The rifle has its own camera with a fixed field of view, so zooming the world doesn't magnify it.
const vmCamera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.01, 10);
camera.rotation.order = "YXZ";
scene.add(camera);
// The viewmodel scene: the rifle follows the camera through `rig`.
const vmScene = new THREE.Scene();
const rig = new THREE.Group();
vmScene.add(rig, new THREE.HemisphereLight(0xd8eef7, 0xd6ccb4, 1.6));
const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
const vmPass = new RenderPass(vmScene, vmCamera);
vmPass.clearPass.color = false;
vmPass.ignoreBackground = true;
composer.addPass(vmPass);
composer.addPass(new EffectPass(
  camera,
  // Bloom only for what really glows: energy, flashes, fire.
  new BloomEffect({ mipmapBlur: true, intensity: 0.55, luminanceThreshold: 0.92, luminanceSmoothing: 0.08, radius: 0.55 }),
  new SMAAEffect(),
  new HueSaturationEffect({ saturation: 0.06 }),
  new BrightnessContrastEffect({ contrast: 0.05 }),
  new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }),
));
addEventListener("resize", () => {
  camera.aspect = vmCamera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  vmCamera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

const rapier = new RAPIER.World({ x: 0, y: -18, z: 0 });
const fx = new Fx(scene, rapier);
const gear = new Gear(scene, fx);
const rifle = new Rifle(rig);
const knife = new Knife(rig);
const controls = new PointerLockControls(camera, renderer.domElement);
const debug = new Debug(scene, room);

// Game state
let arena: Arena | null = null;
const me: physics.Body = { x: 0, y: 2.2, z: 0, vx: 0, vy: 0, vz: 0, ground: true, radius: 0.4, height: 1.8 };
const smooth = new THREE.Vector3(); // shown position minus predicted position, decays to 0
let pending: [number, number, number, number][] = [];
let outbox: [number, number, number, number][] = [];
let seq = 0;
let lastSend = 0;
let hp = 100;
let phase: Phase = "lobby";
let deployed = false;
let paused = false;
let firing = false;
let scoping = false;
let weapon: "rifle" | "knife" = "rifle";
let swapT = SWAP_S; // seconds into a weapon swap
let zoom = 0; // 0 at the hip, 1 fully scoped
let nextShot = 0;
let shake = 0;
let tickOffset: number | null = null;
let welcomed = false;
const snaps: { tick: number; rows: Map<string, number[]> }[] = [];
const keys = new Set<string>();

interface EnemyView { org: Organism; kind: Kind; swarm: Swarm; pos: THREE.Vector3; last: THREE.Vector3; speed: number; mode: string; hp: number; spawning: boolean; emerge: number }
const enemies = new Map<number, EnemyView>();
// Other players: an explorer with a name tag. `org` is null while they're down.
interface Ally { org: Organism | null; pos: THREE.Vector3; last: THREE.Vector3; speed: number; hp: number; paused: boolean; tag: HTMLDivElement }
const others = new Map<string, Ally>();

const nowTick = () => performance.now() / TICK_MS + (tickOffset ?? 0);
const renderTick = () => nowTick() - INTERP_TICKS;

// Networking
const net = new Net(room, pid, {
  welcome: onWelcome,
  snapshot: onSnapshot,
  checkpoint: (c) => {
    if (c.best !== undefined) $("over-best").textContent = String(c.best);
  },
  link(up) {
    $("link").classList.toggle("show", !up && welcomed);
    $("link-state").textContent = up ? "Linked to ArenaAgent" : "Connecting…";
    $("link-state").classList.toggle("up", up);
  },
  error(code) {
    if (code === "replaced") {
      // Another tab joined as this player (a duplicated tab shares sessionStorage).
      // Take a new identity; the socket reconnects and joins with it.
      pid = net.pid = `p-${rand(10)}`;
      try { sessionStorage.setItem("crosswind-pid", pid); } catch { /* private mode */ }
      return;
    }
    $("link-state").textContent = code === "protocol" ? "Protocol mismatch: reload the page" : `Server rejected: ${code}`;
  },
});

function onWelcome(w: Welcome) {
  welcomed = true;
  if (!arena) {
    physics.setLevel(w.level.boxes, w.level.ramps);
    arena = buildArena(scene, w.level, rapier);
    ($("deploy") as HTMLButtonElement).disabled = false;
  }
  for (const id of [...enemies.keys()]) removeEnemy(id);
  for (const p of [...others.keys()]) removeAlly(p);
  fx.clearBolts();
  gear.clear();
  snaps.length = 0;
  pending = [];
  outbox = [];
  smooth.set(0, 0, 0);
  tickOffset = null;
  const s = w.snap;
  if (s.me) {
    [me.x, me.y, me.z, me.vx, me.vy, me.vz] = s.me;
    me.ground = s.me[6] === 1;
    setHp(s.me[7]);
  }
  for (const [id, o] of Object.entries(s.orders ?? {})) debug.orders.set(Number(id), o);
  for (const t of SWARMS) setTactic(t, w.tactics[t] ?? "standby", "");
  setPhase(w.phase, w.wave);
  $("over-best").textContent = String(w.best);
  onSnapshot({ ...s, ev: [] });
  for (const p of s.projectiles ?? []) fx.addBolt(p.id, p.o, p.v, SWARM_COLORS[p.sw], p.kind === "sentinel", s.tick);
  for (const g of s.gear ?? []) gear.deploy(g.id, g.kind, SWARM_COLORS[g.sw], g.p, g.t);
  $("over").hidden = w.phase !== "over";
  if (!deployed || paused || w.phase === "over") net.send({ t: "pause", on: true });
}

function onSnapshot(s: Snapshot) {
  debug.onSnapshot(s);
  const target = s.tick - performance.now() / TICK_MS;
  tickOffset = tickOffset === null || Math.abs(target - tickOffset) > 6 ? target : tickOffset + (target - tickOffset) * 0.08;

  const rows = new Map<string, number[]>();
  for (const e of s.e) rows.set(`e${e[0]}`, e);
  for (const p of s.pl) rows.set(`p${p[0]}`, p.slice(1) as number[]);
  snaps.push({ tick: s.tick, rows });
  while (snaps.length > 40) snaps.shift();

  for (const e of s.e) if (!enemies.has(e[0])) addEnemy(e);
  const present = new Set(s.e.map((e) => e[0]));
  for (const id of [...enemies.keys()]) if (!present.has(id)) removeEnemy(id);
  syncOthers(s.pl);

  for (const ev of s.ev) onEvent(ev, s.tick);
  $("hostiles").textContent = String(s.e.length);
  renderPips(s.e);
  $("score").textContent = String(s.sc[0]);
  $("kills").textContent = String(s.sc[1]);

  // Reconcile: start from the server's state, replay inputs it hasn't applied.
  if (s.me && s.ack !== undefined) {
    const before = new THREE.Vector3(me.x, me.y, me.z);
    [me.x, me.y, me.z, me.vx, me.vy, me.vz] = s.me;
    me.ground = s.me[6] === 1;
    setHp(s.me[7]);
    pending = pending.filter((f) => f[0] > s.ack!);
    if (hp > 0) for (const f of pending) physics.stepPlayer(me, f[1], f[2]);
    const err = before.sub(new THREE.Vector3(me.x, me.y, me.z));
    if (err.length() < 3) smooth.add(err);
    else smooth.set(0, 0, 0);
  }
}

function addEnemy(e: EnemyRow) {
  const kind = KINDS[e[1]], swarm = SWARMS[e[8]];
  const org = createMech(kind, SWARM_COLORS[swarm]);
  org.marking = MARKING[swarmTactic[swarm]] ?? 1;
  const pos = new THREE.Vector3(e[2], e[3], e[4]);
  org.root.position.copy(pos);
  scene.add(org.root);
  const spawning = e[9] === 1;
  enemies.set(e[0], { org, kind, swarm, pos, last: pos.clone(), speed: 0, mode: MODES[e[7]], hp: e[6], spawning, emerge: spawning ? 0 : 1 });
}

function removeEnemy(id: number, shatter = false) {
  const v = enemies.get(id);
  if (!v) return;
  enemies.delete(id);
  debug.forget(id);
  if (shatter) {
    fx.destroy(v.org, SWARM_COLORS[v.swarm]); // fx removes it when it blows apart
  } else {
    v.org.dispose();
    scene.remove(v.org.root);
  }
}

function syncOthers(rows: PlayerRow[]) {
  const ids = new Set(rows.map((r) => r[0]));
  for (const r of rows) {
    let a = others.get(r[0]);
    if (!a) {
      const tag = document.createElement("div");
      $("allies").appendChild(tag);
      a = { org: null, pos: new THREE.Vector3(r[1], r[2], r[3]), last: new THREE.Vector3(r[1], r[2], r[3]), speed: 0, hp: r[5], paused: false, tag };
      others.set(r[0], a);
    }
    a.hp = r[5];
    a.paused = r[6] === 1;
    if (a.hp > 0 && !a.org) {
      a.org = new Striker(PLAYER_COLOR, true);
      a.org.root.position.copy(a.pos);
      scene.add(a.org.root);
    }
  }
  for (const p of others.keys()) if (!ids.has(p)) removeAlly(p);
  $("squad").textContent = String(1 + rows.length);
}

function removeAlly(p: string, shatter = false) {
  const a = others.get(p);
  if (!a?.org) {
    if (a && !shatter) { a.tag.remove(); others.delete(p); }
    return;
  }
  if (shatter) fx.destroy(a.org, PLAYER_COLOR);
  else {
    a.org.dispose();
    scene.remove(a.org.root);
  }
  a.org = null;
  if (!shatter) { a.tag.remove(); others.delete(p); }
}

const tmp = new THREE.Vector3();
function onEvent(ev: GameEvent, tick: number) {
  switch (ev.k) {
    case "spawn":
      fx.dropIn(tmp.set(ev.p[0], 0, ev.p[2]), SWARM_COLORS[ev.sw]);
      if (tmp.distanceTo(camPos()) < 30) sfx.warp();
      break;
    case "proj": {
      const v = enemies.get(ev.src);
      const heavy = ev.kind === "sentinel";
      if (v) {
        v.org.fire();
        fx.flash(v.org.muzzle(0, tmp), SWARM_COLORS[ev.sw], heavy ? 25 : 12, 0.08);
      }
      fx.addBolt(ev.id, ev.o, ev.v, SWARM_COLORS[ev.sw], heavy, tick);
      const d = tmp.set(ev.o[0], ev.o[1], ev.o[2]).distanceTo(camPos());
      if (heavy) sfx.heavyShot(d); else sfx.enemyShot(d);
      break;
    }
    case "pend":
      fx.endBolt(ev.id, ev.p, ev.hit !== null);
      break;
    case "shot": {
      if (ev.pid === pid) break;
      const org = others.get(ev.pid)?.org;
      org?.fire();
      const from = org ? org.muzzle(0, tmp) : tmp.set(ev.o[0], ev.o[1] - 0.2, ev.o[2]);
      fx.shot(from, new THREE.Vector3(...ev.e), PLAYER_COLOR);
      break;
    }
    case "down":
      if (ev.pid === pid) {
        firing = false;
        banner("You're down", others.size ? "Back when your squad clears the wave" : "", 4000);
      } else {
        removeAlly(ev.pid, true);
        feed(`${callsign(ev.pid)} is down`, "ally");
      }
      break;
    case "respawn":
      if (ev.pid === pid) banner("Back in the fight", "Redeployed with 50 integrity", 2000);
      else feed(`${callsign(ev.pid)} is back`, "ally");
      break;
    case "hit": {
      const target = enemies.get(ev.id);
      target?.org.hit();
      fx.armorHit(tmp.set(ev.p[0], ev.p[1], ev.p[2]), target?.kind === "sentinel" ? PALETTE.gray : PALETTE.cream, ev.crit);
      if (ev.pid === pid) {
        const hm = $("hitmarker");
        hm.classList.toggle("crit", ev.crit);
        hm.animate([{ opacity: 1, transform: "rotate(45deg) scale(1.3)" }, { opacity: 0, transform: "rotate(45deg) scale(1)" }], { duration: 220 });
        sfx.hit(ev.crit);
      }
      break;
    }
    case "death": {
      const v = enemies.get(ev.id);
      if (v) removeEnemy(ev.id, true);
      sfx.kill(ev.kind === "sentinel");
      feed(`${ev.by === pid ? "You" : callsign(ev.by)} destroyed ${ev.kind} #${ev.id}`, ev.sw);
      break;
    }
    case "dmg":
      if (ev.pid !== pid) break;
      setHp(ev.hp);
      shake = Math.min(1, shake + ev.amt / 20);
      sfx.hurt();
      $("damage").animate([{ opacity: Math.min(1, ev.amt / 12) }, { opacity: 0 }], { duration: 500 });
      damageArrow(ev.from[0], ev.from[1]);
      break;
    case "phase":
      setPhase(ev.phase, ev.wave);
      if (ev.phase === "intermission") banner(ev.wave ? `Wave ${ev.wave + 1} incoming` : "Arena online", `Next wave in ${Math.round(ev.t)}s`, 2500);
      break;
    case "wave":
      banner(`Wave ${ev.wave}`, `${ev.count} hostiles · 2 swarms`, 2200);
      sfx.wave();
      break;
    case "cleared":
      banner("Wave cleared", `+${ev.bonus} · integrity restored`, 2200);
      break;
    case "over":
      $("over-score").textContent = String(ev.score);
      $("over-wave").textContent = String(ev.wave);
      $("over-kills").textContent = String(ev.kills);
      $("over-best").textContent = String(ev.best);
      $("over").hidden = false;
      firing = false;
      controls.unlock();
      break;
    case "throw": {
      enemies.get(ev.src)?.org.signal();
      gear.toss(ev.id, ev.kind, SWARM_COLORS[ev.sw], ev.o, ev.p, ev.t);
      sfx.toss(tmp.set(ev.o[0], ev.o[1], ev.o[2]).distanceTo(camPos()));
      feed(`${ev.sw[0].toUpperCase()}${ev.sw.slice(1)} · ${gearWords[ev.kind]}`, ev.sw);
      break;
    }
    case "deploy": {
      gear.deploy(ev.id, ev.kind, SWARM_COLORS[ev.sw], ev.p, ev.t);
      const d = tmp.set(ev.p[0], ev.p[1], ev.p[2]).distanceTo(camPos());
      if (ev.kind === "smoke") sfx.smoke(d); else sfx.clank(d);
      break;
    }
    case "gend": {
      gear.end(ev.id, ev.kind, ev.p, ev.hit);
      const d = tmp.set(ev.p[0], ev.p[1], ev.p[2]).distanceTo(camPos());
      if (ev.kind === "frag") {
        sfx.boom(d);
        shake = Math.min(1, shake + Math.max(0, 1 - d / 16));
      }
      if (ev.kind === "trap" && ev.hit) {
        if (d < 30) sfx.snap();
        feed(ev.hit === pid ? "Spike trap!" : `${callsign(ev.hit)} hit a spike trap`, "ally");
      }
      break;
    }
    case "reset":
      for (const id of [...enemies.keys()]) removeEnemy(id);
      fx.clearBolts();
      gear.clear();
      $("over").hidden = true;
      for (const sw of SWARMS) setTactic(sw, "standby", "");
      break;
    case "decision":
      debug.onDecision(ev);
      if (ev.status === "applied" && ev.tactic && ev.tactic !== swarmTactic[ev.sw]) signalSwarm(ev.sw, ev.tactic);
      if (ev.status === "applied" && ev.tactic) setTactic(ev.sw, ev.tactic, ev.note ?? "", ev.source === "llm" ? ev.callout ?? "" : "");
      break;
  }
}

// Swarm visual language. When a swarm's agent changes tactics, its mechs flash
// their visors in sequence and raise their weapons together; their markings
// settle at a new intensity: dark for an ambush, blazing for a rush.
const MARKING: Record<string, number> = { ambush: 0.25, rush: 1.7, kite: 0.85, retreat: 0.6, regroup: 0.8 };
const swarmTactic: Record<Swarm, string> = { alpha: "none", bravo: "none" };
const signals = new Map<number, number>(); // time (ms) -> enemy id

function signalSwarm(sw: Swarm, tactic: string) {
  swarmTactic[sw] = tactic;
  const units = [...enemies.entries()].filter(([, v]) => v.swarm === sw);
  for (const [, v] of units) v.org.marking = MARKING[tactic] ?? 1;
  if (tactic === "ambush" || !units.length) return; // they go quiet
  const cx = units.reduce((s, [, v]) => s + v.pos.x, 0) / units.length;
  const cz = units.reduce((s, [, v]) => s + v.pos.z, 0) / units.length;
  const sequential = ["flank", "bait", "crossfire", "harass"].includes(tactic);
  const ripple = tactic === "retreat" || tactic === "regroup";
  const order = units.sort(([, a], [, b]) => sequential
    ? Math.atan2(a.pos.z - cz, a.pos.x - cx) - Math.atan2(b.pos.z - cz, b.pos.x - cx)
    : Math.hypot(a.pos.x - me.x, a.pos.z - me.z) - Math.hypot(b.pos.x - me.x, b.pos.z - me.z));
  const now = performance.now();
  order.forEach(([id], i) => {
    let at = now + (sequential ? i * 130 : ripple ? i * 80 : i * 90);
    while (signals.has(at)) at += 0.01;
    signals.set(at, id);
  });
}

// HUD
function setHp(v: number) {
  hp = v;
  $("hp-text").textContent = String(v);
  ($("hp-fill") as HTMLElement).style.transform = `scaleX(${v / 100})`;
  ($("hp-lag") as HTMLElement).style.transform = `scaleX(${v / 100})`;
  $("health").classList.toggle("low", v <= 30);
}
// One pip per active hostile, in its swarm's color.
let pipKey = "";
function renderPips(rows: EnemyRow[]) {
  const key = rows.map((e) => e[8]).join("");
  if (key === pipKey) return;
  pipKey = key;
  $("pips").innerHTML = rows.map((e) => `<i class="${SWARMS[e[8]]}"></i>`).join("");
}
function setPhase(p: Phase, w: number) {
  phase = p;
  $("wavebar-label").textContent = `WAVE ${String(w).padStart(2, "0")}`;
  $("wave").textContent = String(w);
}
const tacticWords: Record<string, string> = {
  assault: "Coordinated assault", flank: "Flanking", crossfire: "Crossfire", phalanx: "Shield wall", rush: "Rush",
  kite: "Kiting", harass: "Hit and run", ambush: "Ambush", bait: "Baiting",
  retreat: "Retreating", regroup: "Regrouping", idle: "Standby", none: "Standby",
};
const gearWords: Record<GearKind, string> = { frag: "Frag out", smoke: "Smoke out", trap: "Spike trap laid" };
// `callout` is the LLM strategist's radio line when its directive is in force.
function setTactic(sw: Swarm, tactic: string, note: string, callout = "") {
  const el = $(`tac-${sw}`);
  const text = tacticWords[tactic] ?? tactic;
  if (el.textContent !== text) {
    el.textContent = text;
    const row = el.parentElement!;
    row.classList.remove("pulse");
    void row.offsetWidth;
    row.classList.add("pulse");
  }
  const noteEl = $(`note-${sw}`);
  noteEl.textContent = callout ? `"${callout}"` : note;
  noteEl.classList.toggle("llm", !!callout);
}
let bannerTimer = 0;
function banner(title: string, sub: string, ms: number) {
  $("banner-title").textContent = title;
  $("banner-sub").textContent = sub;
  $("banner").classList.add("show");
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => $("banner").classList.remove("show"), ms);
}
function feed(text: string, sw: Swarm | "ally") {
  const el = document.createElement("div");
  el.textContent = text;
  el.className = sw;
  $("feed").appendChild(el);
  setTimeout(() => el.remove(), 3000);
  while ($("feed").children.length > 5) $("feed").firstChild!.remove();
}
function damageArrow(fx_: number, fz: number) {
  const dx = fx_ - me.x, dz = fz - me.z;
  // Angle of the source relative to where the camera faces.
  const ang = Math.atan2(dx, -dz) + camera.rotation.y;
  const el = document.createElement("div");
  el.className = "dmg-dir";
  el.style.transform = `rotate(${ang}rad)`;
  $("dmg-dirs").appendChild(el);
  el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900 }).onfinish = () => el.remove();
}
// Input
addEventListener("keydown", (e) => {
  if (e.code === "F3") { e.preventDefault(); debug.togglePanel(); return; }
  if (e.code === "F4") { e.preventDefault(); debug.toggleViz(); return; }
  if (controls.isLocked && !e.repeat && e.code === "KeyQ" && swapT >= SWAP_S) swapT = 0;
  if (controls.isLocked && !e.repeat && e.code === "KeyF" && weapon === "knife" && swapT >= SWAP_S && knife.inspect()) {
    sfx.whirl([0.5, 0.95, 1.35]); // once per pass around the finger
  }
  keys.add(e.code);
  if (e.code === "Space") e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());
addEventListener("mousedown", (e) => {
  if (!controls.isLocked) return;
  if (e.button === 0) firing = true;
  if (e.button === 2) scoping = true;
});
addEventListener("mouseup", (e) => {
  if (e.button === 0) firing = false;
  if (e.button === 2) scoping = false;
});
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("mousemove", (e) => {
  if (!controls.isLocked) return;
  rifle.look(e.movementX, e.movementY);
  knife.look(e.movementX, e.movementY);
});

function inputBits() {
  let k = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) k |= physics.FORWARD;
  if (keys.has("KeyS") || keys.has("ArrowDown")) k |= physics.BACK;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) k |= physics.LEFT;
  if (keys.has("KeyD") || keys.has("ArrowRight")) k |= physics.RIGHT;
  if (keys.has("Space")) k |= physics.JUMP;
  if (keys.has("ShiftLeft") || keys.has("ShiftRight")) k |= physics.SPRINT;
  return k;
}

const deploy = () => { unlockAudio(); controls.lock(); };
$("deploy").addEventListener("click", deploy);
$("resume").addEventListener("click", deploy);
$("invite").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $("invite").textContent = "Link copied · send it to a friend";
  } catch {
    $("invite").textContent = location.href;
  }
});
$("restart").addEventListener("click", () => { net.send({ t: "restart" }); deploy(); });
$("toggle-debug").addEventListener("click", () => debug.togglePanel());
$("toggle-viz").addEventListener("click", () => debug.toggleViz());
controls.addEventListener("lock", () => {
  deployed = true;
  paused = false;
  $("start").hidden = true;
  $("pause").hidden = true;
  net.send({ t: "pause", on: false });
});
controls.addEventListener("unlock", () => {
  firing = false;
  scoping = false;
  keys.clear();
  if (phase === "over") return;
  paused = true;
  $("pause-note").textContent = others.size
    ? "Your squad fights on · enemies ignore you while paused"
    : "Simulation paused on the server";
  $("pause").hidden = false;
  net.send({ t: "pause", on: true });
});

// Shooting: the server decides hits; the client draws the shot right away.
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
function shoot() {
  const dir = camera.getWorldDirection(new THREE.Vector3());
  net.send({ t: "fire", d: [dir.x, dir.y, dir.z], rt: renderTick() });
  rifle.fire();
  sfx.shoot();
  const origin = camPos();
  ray.origin = origin;
  ray.dir = dir;
  const hit = rapier.castRay(ray, 150, true, undefined, undefined, undefined, undefined, (c) => arena!.levelColliders.has(c.handle));
  let t = hit ? hit.timeOfImpact : 150;
  let enemyHit = false;
  for (const v of enemies.values()) {
    for (const [h, r] of HIT[v.kind]) {
      const c = tmp.set(v.pos.x, v.pos.y + h, v.pos.z).sub(origin);
      const along = c.dot(dir);
      const d2 = c.lengthSq() - along * along;
      if (along > 0 && d2 < r * r) {
        const at = along - Math.sqrt(r * r - d2);
        if (at < t) { t = at; enemyHit = true; }
      }
    }
  }
  const end = origin.clone().addScaledVector(dir, t);
  const muzzle = rifle.muzzle(new THREE.Vector3());
  fx.shot(muzzle, end, PLAYER_COLOR);
  shake = Math.min(1, shake + 0.05);
  if (!enemyHit && t < 150) fx.impact(end, PLAYER_COLOR);
}

// The knife: a short thrust the server resolves, like a shot with 2.6 m of reach.
function stab() {
  const dir = camera.getWorldDirection(new THREE.Vector3());
  net.send({ t: "stab", d: [dir.x, dir.y, dir.z], rt: renderTick() });
  knife.slash();
  sfx.slash();
  shake = Math.min(1, shake + 0.04);
}

const tagPos = new THREE.Vector3();
function allyTag(p: string, a: Ally) {
  tagPos.copy(a.pos).setY(a.pos.y + 2.35).project(camera);
  const visible = !!a.org && tagPos.z < 1 && Math.abs(tagPos.x) < 1.1 && Math.abs(tagPos.y) < 1.1;
  a.tag.style.display = visible ? "" : "none";
  if (!visible) return;
  a.tag.style.left = `${(tagPos.x * 0.5 + 0.5) * innerWidth}px`;
  a.tag.style.top = `${(-tagPos.y * 0.5 + 0.5) * innerHeight}px`;
  const text = `${callsign(p)} · ${a.paused ? "paused" : a.hp}`;
  if (a.tag.textContent !== text) a.tag.textContent = text;
  a.tag.classList.toggle("paused", a.paused);
}

function camPos() {
  return new THREE.Vector3(me.x + smooth.x, me.y + smooth.y + EYE, me.z + smooth.z);
}

// Entity interpolation at renderTick
function interpolate() {
  const rt = renderTick();
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].tick <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
  }
  const k = a && b && b.tick > a.tick ? THREE.MathUtils.clamp((rt - a.tick) / (b.tick - a.tick), 0, 1) : 1;
  const sample = (key: string) => {
    const rb = b?.rows.get(key), ra = a?.rows.get(key) ?? rb;
    if (!rb || !ra) return null;
    return { ra, rb };
  };
  for (const [id, v] of enemies) {
    const s = sample(`e${id}`);
    if (!s) continue;
    const { ra, rb } = s;
    v.pos.set(ra[2] + (rb[2] - ra[2]) * k, ra[3] + (rb[3] - ra[3]) * k, ra[4] + (rb[4] - ra[4]) * k);
    v.org.root.position.copy(v.pos);
    let dy = rb[5] - ra[5];
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    v.org.root.rotation.y = ra[5] + dy * k;
    v.mode = MODES[rb[7]];
    v.spawning = rb[9] === 1;
  }
  for (const [p, a] of others) {
    const s = sample(`p${p}`);
    if (!s) continue;
    const { ra, rb } = s;
    a.pos.set(ra[0] + (rb[0] - ra[0]) * k, ra[1] + (rb[1] - ra[1]) * k, ra[2] + (rb[2] - ra[2]) * k);
    let dy = rb[3] - ra[3];
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    a.org?.root.position.copy(a.pos);
    a.org?.root.rotation.set(0, ra[3] + dy * k, 0);
  }
}

// The frame loop
let acc = 0;
let last = performance.now();
let elapsed = 0;
const playerPos = new THREE.Vector3();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  elapsed += dt;
  const active = deployed && !paused && welcomed && phase !== "over";

  // Fixed 60 Hz input steps: predict locally, queue for the server.
  if (active) {
    acc += dt;
    while (acc >= physics.INPUT_DT) {
      acc -= physics.INPUT_DT;
      const bits = inputBits();
      const f: [number, number, number, number] = [++seq, bits, camera.rotation.y, camera.rotation.x];
      pending.push(f);
      outbox.push(f);
      if (hp > 0) physics.stepPlayer(me, bits, f[2]);
    }
    if (pending.length > 240) pending.splice(0, pending.length - 240);
    if (outbox.length && (now - lastSend >= 33 || outbox.length >= 6)) {
      net.send({ t: "in", f: outbox.splice(0, 12) });
      lastSend = now;
    }
    if (firing && hp > 0 && now >= nextShot && swapT >= SWAP_S) {
      nextShot = now + (weapon === "rifle" ? SHOT_MS : STAB_MS);
      if (weapon === "rifle") shoot(); else stab();
    }
  } else {
    acc = 0;
  }

  smooth.multiplyScalar(Math.exp(-dt * 12));
  shake = Math.max(0, shake - dt * 2.5);
  const cam = camPos();
  camera.position.set(cam.x + (Math.random() - 0.5) * shake * 0.12, cam.y + (Math.random() - 0.5) * shake * 0.12, cam.z);
  // Hold right mouse to scope in: the world zooms, the rifle rises to the eye,
  // then the scope's lens takes over. Mouse speed scales with the zoom.
  zoom += ((scoping && active && hp > 0 && weapon === "rifle" ? 1 : 0) - zoom) * Math.min(1, dt * 12);
  if (zoom < 0.001) zoom = 0;
  const ease = zoom * zoom * (3 - 2 * zoom);
  const fov = BASE_FOV + (SCOPE_FOV - BASE_FOV) * ease;
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  controls.pointerSpeed = fov / BASE_FOV;
  // Swapping: the weapon in hand drops away, then the other comes up.
  if (swapT < SWAP_S) {
    const was = swapT;
    swapT = Math.min(SWAP_S, swapT + dt);
    if (was < 0.15 && swapT >= 0.15) {
      weapon = weapon === "rifle" ? "knife" : "rifle";
      if (weapon === "knife") { knife.draw(); sfx.whirl([0.15]); }
    }
  }
  const down = swapT < 0.15 ? swapT / 0.15 : 0;
  const up = swapT < 0.15 ? 0 : 1 - (swapT - 0.15) / (SWAP_S - 0.15);
  rifle.lowered = weapon === "rifle" ? Math.max(down, up) : 1;
  knife.lowered = weapon === "knife" ? (swapT < 0.15 ? down : 0) : 1; // the knife's draw brings it up
  rifle.aim(ease);
  const lens = Math.min(1, Math.max(0, (zoom - 0.75) / 0.25));
  $("scope").style.opacity = String(lens);
  $("crosshair").style.opacity = String(1 - lens);
  rig.position.copy(camera.position);
  rig.quaternion.copy(camera.quaternion);
  rig.updateMatrixWorld(true);
  vmCamera.position.copy(camera.position);
  vmCamera.quaternion.copy(camera.quaternion);

  interpolate();
  const units: Unit[] = [];
  for (const [id, v] of enemies) {
    v.speed = v.speed * 0.8 + (v.pos.distanceTo(v.last) / Math.max(dt, 1e-3)) * 0.2;
    v.last.copy(v.pos);
    // A new mech drops in on its thrusters while the server says it's spawning.
    v.emerge = Math.min(1, v.emerge + dt / (v.spawning ? 0.6 : 0.2));
    v.org.root.position.y = v.pos.y + (1 - v.emerge) ** 2 * 7;
    v.org.update(dt, v.speed, v.emerge < 1 ? "rush" : v.mode);
    units.push({ id, swarm: v.swarm, pos: v.pos, height: HEIGHT[v.kind], mode: v.mode });
  }
  for (const [at, id] of signals) {
    if (at > performance.now()) continue;
    signals.delete(at);
    const v = enemies.get(id);
    if (!v) continue;
    v.org.signal();
    fx.signal(tmp.copy(v.pos).setY(v.pos.y + HEIGHT[v.kind] * 0.8), SWARM_COLORS[v.swarm]);
  }
  for (const [p, a] of others) {
    a.speed = a.speed * 0.8 + (a.pos.distanceTo(a.last) / Math.max(dt, 1e-3)) * 0.2;
    a.last.copy(a.pos);
    a.org?.update(dt, a.speed);
    allyTag(p, a);
  }
  arena?.update(elapsed);
  fx.update(dt, nowTick());
  gear.update(dt);
  const nade = active && hp > 0 ? gear.frag(playerPos.set(me.x, me.y, me.z)) : null;
  $("nade").hidden = !nade;
  if (nade) ($("nade").firstElementChild as HTMLElement).style.transform = `rotate(${Math.atan2(nade.x - me.x, -(nade.z - me.z)) + camera.rotation.y}rad)`;
  rifle.update(dt, Math.hypot(me.vx, me.vz), me.ground);
  knife.update(dt, Math.hypot(me.vx, me.vz), me.ground);
  debug.update(units, playerPos.set(me.x, me.y, me.z), camera, net.rtt, INTERP_TICKS * TICK_MS);
  composer.render(dt);
}
requestAnimationFrame(frame);

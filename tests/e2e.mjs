// Protocol checks against a running worker (`npm run worker` first).
//   node tests/e2e.mjs [ws://localhost:8787]
const base = process.argv[2] ?? "ws://localhost:8787";
const room = `e2e-${Date.now().toString(36)}`;
const url = `${base}/agents/arena-agent/${room}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, msg) => { if (!ok) { console.error("FAIL", msg); process.exit(1); } console.log("ok", msg); };

function connect(pid) {
  const ws = new WebSocket(url);
  const c = { ws, snaps: [], welcome: null, state: null, errors: [], other: [] };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === "s") c.snaps.push(msg);
    else if (msg.t === "welcome") c.welcome = msg;
    else if (msg.type === "cf_agent_state") c.state = msg.state;
    else if (msg.t === "error" || msg.type === "cf_agent_state_error") c.errors.push(msg);
    else c.other.push(msg);
  };
  c.open = new Promise((r) => (ws.onopen = r));
  c.send = (o) => ws.send(typeof o === "string" ? o : JSON.stringify(o));
  c.join = () => c.send({ t: "join", v: 1, pid });
  c.last = () => c.snaps[c.snaps.length - 1];
  return c;
}

// 1. Join, play, and get a monotonically increasing tick.
const a = connect("e2e-player");
await a.open;
a.join();
let seq = 0;
const walker = setInterval(() => a.send({ t: "in", f: [[++seq, 1, 0, 0], [++seq, 1, 0, 0]] }), 33);
await sleep(5000);
assert(a.welcome && a.welcome.level.boxes.length > 10, "welcome carries the level");
const ticks = a.snaps.map((s) => s.tick);
assert(ticks.every((t, i) => i === 0 || t === ticks[i - 1] + 1), `ticks increase by one (${ticks.length} snapshots)`);
assert(a.snaps.length >= 85, `about 20 snapshots a second (${a.snaps.length} in 5 s)`);
assert(a.last().ack > 0 && a.last().ack <= seq, `server acks inputs (ack ${a.last().ack} of ${seq})`);

// 2. Hostile input is ignored and the loop keeps running.
for (const bad of [
  "not json", "[1,2,3]", '{"t":"in","f":[[1e309,1,0,0]]}', '{"t":"in","f":[[999999,999,NaN,0]]}',
  { t: "fire", d: "x", rt: 0 }, { t: "fire", d: [0, 0, 0], rt: 1e308 }, { t: "join", v: 1, pid: "../../etc" },
  { t: "in", f: Array(500).fill([1, 1, 0, 0]) }, "x".repeat(10000),
]) a.send(bad);
a.send({ type: "cf_agent_state", state: { match: "hacked", score: 1e9 } });
const before = a.last().tick;
await sleep(600);
assert(a.last().tick > before + 8, "simulation still ticking after malformed frames");
assert(a.state?.match !== "hacked", "clients can't overwrite the arena's state");

// 3. Rate limit: flooding inputs can't move faster than 60 frames a second.
// Frames over the cap are dropped (the ack skips them), so measure distance:
// sprinting along +x from the cover the walker ran into is open floor.
clearInterval(walker);
const p0 = a.last().me;
const t0 = Date.now();
const flood = setInterval(() => {
  const f = [];
  for (let i = 0; i < 12; i++) f.push([++seq, 1 | 32, -Math.PI / 2, 0]);
  a.send({ t: "in", f });
}, 10);
await sleep(1500);
clearInterval(flood);
await sleep(200);
const p1 = a.last().me;
const dist = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
const max = 11 * ((Date.now() - t0) / 1000 + 9 / 60 + 0.05); // + the 9-frame jitter budget and one stale snapshot
assert(dist > 5 && dist <= max, `flooded inputs moved ${dist.toFixed(1)} m, sprint speed allows ${max.toFixed(1)} m`);
clearInterval(walker);

// 4. Reconnect with the same player id: full resync of the same match.
const match = a.state?.match ?? a.welcome.match;
const hp = a.last().me[7];
a.ws.close();
await sleep(500);
const b = connect("e2e-player");
await b.open;
b.join();
await sleep(1500);
assert(b.welcome?.match === match, "reconnect resumes the same match");
assert(b.welcome.snap.me[7] === hp || b.welcome.snap.me[7] <= hp, "reconnect keeps the player's health");
assert(Array.isArray(b.welcome.snap.e), "reconnect gets every enemy in the welcome snapshot");

// 5. A second player joins the same room and each sees the other.
const d = connect("e2e-second");
await d.open;
d.join();
await sleep(1000);
assert(d.welcome?.match === match, "second player joins the same match");
assert(b.last().pl.some((p) => p[0] === "e2e-second"), "first player sees the second");
assert(d.last().pl.some((p) => p[0] === "e2e-player"), "second player sees the first");

// 6. Joining with an id already in use replaces the older connection.
const dup = connect("e2e-second");
await dup.open;
dup.join();
await sleep(800);
assert(d.errors.some((e) => e.code === "replaced") && d.ws.readyState >= 2, "older connection for the same player is closed");
assert(dup.welcome && dup.last()?.me, "newest connection takes over the player");

// 7. A player who leaves drops out of everyone else's snapshots.
dup.ws.close();
await sleep(800);
assert(!b.last().pl.some((p) => p[0] === "e2e-second"), "a player who leaves disappears for the others");

// 8. A version mismatch is refused.
const c = connect("e2e-other");
await c.open;
c.send({ t: "join", v: 99, pid: "e2e-other" });
await sleep(500);
assert(c.errors.some((e) => e.code === "protocol"), "wrong protocol version is rejected");

console.log("swarm decisions seen:", a.snaps.flatMap((s) => s.ev).filter((e) => e.k === "decision").length);
process.exit(0);

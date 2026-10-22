// Replays input frames through web/src/physics.ts; tests/test_mirror.py compares with Python.
import { setLevel, stepPlayer } from "../web/src/physics.ts";
const { level, frames, start } = JSON.parse(await new Promise((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => r(s)); }));
setLevel(level.boxes, level.ramps);
const b = { x: start[0], y: start[1], z: start[2], vx: 0, vy: 0, vz: 0, ground: true, radius: 0.4, height: 1.8 };
const out = [];
for (const [keys, yaw] of frames) { stepPlayer(b, keys, yaw); out.push([b.x, b.y, b.z]); }
console.log(JSON.stringify(out));

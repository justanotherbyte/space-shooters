// Mirrors src/physics.py line for line, so client prediction matches the
// server's movement. Change both together.

export type Box = [number, number, number, number, number, number, string];
export type Ramp = [number, number, number, number, "x" | "z", number, number];

export const GRAVITY = 22.0;
export const JUMP_SPEED = 7.5;
export const WALK_SPEED = 7.0;
export const SPRINT_SPEED = 11.0;
export const AIR_CONTROL = 6.0;
export const STEP = 0.55;

export const FORWARD = 1, BACK = 2, LEFT = 4, RIGHT = 8, JUMP = 16, SPRINT = 32;
export const INPUT_DT = 1 / 60;

let BOXES: Box[] = [];
let RAMPS: Ramp[] = [];

export function setLevel(boxes: Box[], ramps: Ramp[]) {
  BOXES = boxes;
  RAMPS = ramps;
}

export interface Body {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  ground: boolean;
  radius: number; height: number;
}

function rampHeight(r: Ramp, x: number, z: number): number | null {
  const [rx0, rz0, rx1, rz1, axis, h0, h1] = r;
  if (x < rx0 || x > rx1 || z < rz0 || z > rz1) return null;
  const t = axis === "x" ? (x - rx0) / (rx1 - rx0) : (z - rz0) / (rz1 - rz0);
  return h0 + (h1 - h0) * t;
}

export function floorAt(x: number, z: number, feet: number): number {
  let best = 0.0;
  for (const b of BOXES) {
    if (b[0] <= x && x <= b[3] && b[2] <= z && z <= b[5] && b[4] <= feet + STEP && b[4] > best) best = b[4];
  }
  for (const r of RAMPS) {
    const h = rampHeight(r, x, z);
    if (h !== null && h <= feet + STEP && h > best) best = h;
  }
  return best;
}

function rampBlocks(x: number, z: number, feet: number): boolean {
  for (const r of RAMPS) {
    const h = rampHeight(r, x, z);
    if (h !== null && h > feet + STEP) return true;
  }
  return false;
}

function pushOut(body: Body) {
  const r = body.radius;
  for (const b of BOXES) {
    if (b[4] <= body.y + STEP || b[1] >= body.y + body.height) continue;
    const cx = Math.min(Math.max(body.x, b[0]), b[3]);
    const cz = Math.min(Math.max(body.z, b[2]), b[5]);
    const dx = body.x - cx, dz = body.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      body.x += dx / d * (r - d);
      body.z += dz / d * (r - d);
    } else {
      const exits: [number, number, number][] = [
        [body.x - b[0] + r, -1.0, 0.0],
        [b[3] - body.x + r, 1.0, 0.0],
        [body.z - b[2] + r, 0.0, -1.0],
        [b[5] - body.z + r, 0.0, 1.0],
      ];
      let [depth, ex, ez] = exits[0];
      for (const e of exits) if (e[0] < depth) [depth, ex, ez] = e;
      body.x += ex * depth;
      body.z += ez * depth;
    }
  }
}

export function move(body: Body, wx: number, wz: number, dt: number, jump = false) {
  if (body.ground) {
    body.vx = wx; body.vz = wz;
    if (jump) {
      body.vy = JUMP_SPEED;
      body.ground = false;
    }
  } else {
    const k = Math.min(1.0, AIR_CONTROL * dt);
    body.vx += (wx - body.vx) * k;
    body.vz += (wz - body.vz) * k;
  }
  body.vy -= GRAVITY * dt;

  const nx = body.x + body.vx * dt;
  if (!rampBlocks(nx, body.z, body.y)) body.x = nx;
  const nz = body.z + body.vz * dt;
  if (!rampBlocks(body.x, nz, body.y)) body.z = nz;
  pushOut(body);

  const floor = floorAt(body.x, body.z, body.y);
  const ny = body.y + body.vy * dt;
  if (ny <= floor) {
    body.y = floor; body.vy = 0.0; body.ground = true;
  } else if (body.ground && body.vy <= 0 && body.y - floor <= STEP) {
    body.y = floor; body.vy = 0.0;
  } else {
    body.y = ny; body.ground = false;
  }
}

export function inputVelocity(keys: number, yaw: number): [number, number] {
  const f = (keys & FORWARD ? 1 : 0) - (keys & BACK ? 1 : 0);
  const s = (keys & RIGHT ? 1 : 0) - (keys & LEFT ? 1 : 0);
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  const wx = -sin * f + cos * s;
  const wz = -cos * f - sin * s;
  const n = Math.sqrt(wx * wx + wz * wz);
  if (n < 1e-9) return [0.0, 0.0];
  const speed = keys & SPRINT && f > 0 ? SPRINT_SPEED : WALK_SPEED;
  return [wx / n * speed, wz / n * speed];
}

export function stepPlayer(body: Body, keys: number, yaw: number) {
  const [wx, wz] = inputVelocity(keys, yaw);
  move(body, wx, wz, INPUT_DT, (keys & JUMP) !== 0);
}

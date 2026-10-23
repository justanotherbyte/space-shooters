// The alien clearing. The server's level stays the collision truth (boxes and
// ramps, mirrored into Rapier for ray casts); everything drawn here is an
// organic stand-in laid over it: walls become cliffs, platforms rock mesas,
// pillars giant fungi, low cover fallen logs, crates crystal-crusted boulders.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Level } from "./protocol";
import { SWARM_COLORS } from "./protocol";
import type { Box, Ramp } from "./physics";
import { PALETTE, type BioMaterial, blob, bioMaterial, cap, fbm, glow, merge, noise, paint, rng, smoothstep, tube, uTime, warp } from "./bio";

export interface Arena {
  group: THREE.Group;
  levelColliders: Set<number>;
  update(t: number): void;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (hex: number) => new THREE.Color(hex);
const mix = (a: number, b: number, t: number) => C(a).lerp(C(b), Math.min(1, Math.max(0, t)));

// Rock strata, dark to light, cool and slightly violet.
const STRATA = [0x141d2b, 0x1b2a38, 0x173c45, 0x24243f, 0x1d3340];
const MOSS = 0x1b4a44;
const BARK = 0x262b40;

export function buildArena(scene: THREE.Scene, level: Level, rapier: RAPIER.World): Arena {
  const group = new THREE.Group();
  const levelColliders = new Set<number>();
  const R = rng(1337);
  const inner = level.half - 0.4; // the walkable floor ends here

  // Collision for local ray casts: the same boxes and ramps the server uses.
  const fixed = rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  levelColliders.add(rapier.createCollider(RAPIER.ColliderDesc.cuboid(level.half + 2, 0.5, level.half + 2).setTranslation(0, -0.5, 0), fixed).handle);
  for (const [x0, y0, z0, x1, y1, z1] of level.boxes) {
    levelColliders.add(rapier.createCollider(
      RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), fixed).handle);
  }
  for (const r of level.ramps) {
    const pts = rampCorners(r).flatMap((p) => [p.x, p.y, p.z]);
    levelColliders.add(rapier.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts))!, fixed).handle);
  }

  const solids = level.boxes.filter((b) => b[6] !== "wall");
  const inBox = (x: number, z: number, b: Box, pad: number) => x > b[0] - pad && x < b[3] + pad && z > b[2] - pad && z < b[5] + pad;
  const inRamp = (x: number, z: number, r: Ramp, pad: number) => x > r[0] - pad && x < r[2] + pad && z > r[1] - pad && z < r[3] + pad;
  const gates = Object.entries(level.gates).flatMap(([sw, list]) => list.map(([x, z]) => ({ sw, x, z })));

  // Pools of luminous liquid, placed on open floor.
  const pools: { x: number; z: number; r: number }[] = [];
  for (let tries = 0; pools.length < 5 && tries < 400; tries++) {
    const x = (R() - 0.5) * 2 * (inner - 4), z = (R() - 0.5) * 2 * (inner - 4), r = 1.4 + R() * 1.6;
    const clear = !solids.some((b) => inBox(x, z, b, r + 1.5)) && !level.ramps.some((rp) => inRamp(x, z, rp, r + 1)) &&
      !gates.some((g) => Math.hypot(g.x - x, g.z - z) < r + 4) && !pools.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + r + 6) &&
      Math.hypot(x, z) > 11;
    if (clear) pools.push({ x, z, r });
  }

  // Terrain: flat floor inside, cliffs at the walls, rolling hills beyond.
  const height = (x: number, z: number) => {
    const m = Math.max(Math.abs(x), Math.abs(z));
    const floor = (fbm(x * 0.3, 0, z * 0.3, 1, 3) - 0.5) * 0.05;
    if (m < inner) return floor;
    const foot = inner + 0.4 + fbm(x * 0.05 + 40, 0, z * 0.05, 3, 3) * 2.4;
    const rise = smoothstep(foot, foot + 3.4, m);
    const cliff = 9 + fbm(x * 0.07, 2, z * 0.07, 7, 4) * 7;
    const hills = smoothstep(40, 110, m) * (fbm(x * 0.018, 5, z * 0.018, 11, 4) * 30 - 6);
    return floor * (1 - rise) + rise * (cliff + hills);
  };
  const terrainGeo = new THREE.PlaneGeometry(240, 240, 230, 230).rotateX(-Math.PI / 2);
  warp(terrainGeo, (p) => { p.y = height(p.x, p.z); });
  const poolGlow = (x: number, z: number) => pools.reduce((g, p) => Math.max(g, smoothstep(p.r + 2.2, p.r, Math.hypot(x - p.x, z - p.z))), 0);
  paint(terrainGeo, {
    indexed: true,
    color: (p, n) => {
      if (p.y < 0.3) {
        const patch = fbm(p.x * 0.11, 0, p.z * 0.11, 4, 4);
        const c = mix(PALETTE.shadow, PALETTE.terrain, 0.35 + patch * 0.8);
        c.lerp(C(MOSS), smoothstep(0.55, 0.75, fbm(p.x * 0.07, 9, p.z * 0.07, 6, 3)) * 0.6);
        return c.lerp(C(0x1f6f66), poolGlow(p.x, p.z) * 0.5);
      }
      const band = (p.y * 0.32 + fbm(p.x * 0.09, p.y * 0.12, p.z * 0.09, 12, 3) * 1.7) % 1;
      const c = C(STRATA[Math.floor(band * STRATA.length)]);
      return c.lerp(C(MOSS), smoothstep(0.75, 0.95, n.y));
    },
    emit: (p, n) => {
      if (p.y < 0.3) {
        const speck = noise(p.x * 2.4, 0, p.z * 2.4, 21) * smoothstep(0.55, 0.8, fbm(p.x * 0.07, 9, p.z * 0.07, 6, 3));
        const lichen = speck > 0.9 ? (speck - 0.9) * 4 : 0;
        return glow(PALETTE.turquoise, lichen).add(glow(PALETTE.cyan, poolGlow(p.x, p.z) * 0.22));
      }
      return null;
    },
    // Luminous seams run through the cliff faces (drawn per pixel by the material).
    vein: (p, n) => (p.y > 0.5 ? smoothstep(0.3, 0.75, 1 - n.y) * smoothstep(0.52, 0.68, fbm(p.x * 0.06, p.y * 0.08, p.z * 0.06, 41, 3)) : 0),
  });
  const terrainMat = bioMaterial({ flat: false, rough: 0.95, envIntensity: 0.4, vein: { color: PALETTE.cyan, k: 0.55, freq: 0.2, width: 0.015 } });
  group.add(new THREE.Mesh(terrainGeo, terrainMat));

  // Static organic pieces, merged by material.
  const rockParts: THREE.BufferGeometry[] = [];
  const fungusParts: THREE.BufferGeometry[] = [];
  const hangParts: THREE.BufferGeometry[] = [];
  const crystalParts: THREE.BufferGeometry[] = [];
  const liquidParts: THREE.BufferGeometry[] = [];
  const lights: THREE.PointLight[] = [];

  const rockColor = (top: number, hasTop: boolean, seed: number) => (p: THREE.Vector3, n: THREE.Vector3) => {
    if (hasTop && n.y > 0.7 && p.y > top - 0.3) return mix(MOSS, PALETTE.terrain, fbm(p.x * 0.4, 0, p.z * 0.4, seed, 2));
    const band = (p.y * 1.4 + fbm(p.x * 0.3, p.y * 0.4, p.z * 0.3, seed, 3) * 1.6) % 1;
    return C(STRATA[Math.floor(band * STRATA.length)]);
  };
  // Rock glows only along seams in its sides.
  const rockVein = (p: THREE.Vector3, n: THREE.Vector3) => (1 - Math.abs(n.y)) * smoothstep(0.5, 0.66, fbm(p.x * 0.18, p.y * 0.25, p.z * 0.18, 43, 3));

  // A box of rock with weathered sides and an exact, walkable top.
  const rockOver = (b: Box, seed: number, rampTop?: (x: number, z: number) => number) => {
    const [x0, , z0, x1, y1, z1] = b;
    const w = x1 - x0, d = z1 - z0, h = y1;
    const g = new THREE.BoxGeometry(w, rampTop ? 1 : h, d, Math.ceil(w / 0.6), rampTop ? 3 : Math.ceil(h / 0.5), Math.ceil(d / 0.6));
    warp(g, (p) => {
      const wx = p.x + (x0 + x1) / 2, wz = p.z + (z0 + z1) / 2;
      const kx = Math.pow(Math.abs(p.x) / (w / 2), 6), kz = Math.pow(Math.abs(p.z) / (d / 2), 6);
      const k = Math.max(kx, kz);
      const t = rampTop ? p.y + 0.5 : p.y / h + 0.5; // 0 at the base, 1 at the top
      const top = rampTop ? rampTop(wx, wz) : h;
      const y = t * top;
      const n = fbm(wx * 0.45, y * 0.6, wz * 0.45, seed, 3) - 0.45;
      const push = n * 0.55 + (1 - t) * 0.3; // flare at the base
      p.set(wx + Math.sign(p.x) * push * kx, y - 0.14 * k * t * t, wz + Math.sign(p.z) * push * kz);
    });
    return g;
  };

  // A creeping root from (x, z) out along `angle`, hugging the ground.
  const root = (x: number, z: number, y0: number, angle: number, reach: number, r0: number, seed: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const a = angle + (noise(t * 2, seed, 0, seed) - 0.5) * 1.2;
      pts.push(V(x + Math.cos(a) * reach * t, y0 * (1 - t) * (1 - t) + 0.06 + noise(t * 4, 0, seed, seed) * 0.12, z + Math.sin(a) * reach * t));
    }
    return paint(tube(pts, (t) => r0 * (1 - t * 0.85), 10, 5), {
      color: (p) => mix(BARK, MOSS, fbm(p.x, p.y, p.z, seed, 2) * 0.8),
      emit: (p) => glow(PALETTE.cyan, smoothstep(0.75, 0.82, noise(p.x * 1.5, p.y, p.z * 1.5, seed)) * 0.6),
    });
  };

  // A shelf fungus sticking out of a surface at `p`, facing `dir`.
  const shelf = (p: THREE.Vector3, dir: number, size: number, seed: number) => {
    const g = paint(cap(size, size * 0.35, seed, 10), {
      color: (q, n) => (n.y < -0.2 ? C(0x2a3a55) : mix(0x2b2550, 0x3a2f63, noise(q.x * 4, 0, q.z * 4, seed))),
      emit: (_q, n) => (n.y < -0.2 ? glow(PALETTE.turquoise, 1.1) : null),
    });
    g.scale(1, 0.7, 0.55);
    g.rotateY(dir);
    g.translate(p.x, p.y, p.z);
    return g;
  };

  // A hanging strand, swaying more toward its tip.
  const strand = (top: THREE.Vector3, length: number, seed: number, color: number, r = 0.035) => {
    const pts = [0, 0.33, 0.66, 1].map((t) => V(top.x + (noise(t * 3, seed, 1, seed) - 0.5) * 0.4, top.y - length * t, top.z + (noise(t * 3, seed, 5, seed) - 0.5) * 0.4));
    return paint(tube(pts, (t) => r * (1 - t * 0.7), 6, 3), {
      color: BARK,
      emit: (p) => glow(color, smoothstep(0.82, 1, (top.y - p.y) / length) * 1.8),
      sway: (p) => Math.pow(Math.max(0, (top.y - p.y) / length), 1.5) * 0.6,
      phase: seed * 1.7,
    });
  };

  // A giant mushroom: stem from (x, y, z) to the cap at height h.
  const mushroom = (x: number, y: number, z: number, h: number, capR: number, seed: number, light: number, lean: [number, number], tendrils: number) => {
    const [bx, bz] = lean;
    const top = V(x + bx, y + h, z + bz);
    const stemR = Math.max(0.5, capR * 0.2);
    const stem = tube([V(x, y - 0.6, z), V(x + bx * 0.25, y + h * 0.35, z + bz * 0.2), V(x + bx * 0.7, y + h * 0.72, z + bz * 0.75), top],
      (t) => stemR * (0.78 + 0.75 * Math.pow(1 - t, 5)) * (1 + 0.06 * Math.sin(t * 19 + seed)), 16, 9);
    fungusParts.push(paint(stem, {
      color: (p) => mix(0x2a3150, 0x48527a, (p.y - y) / h * 0.7 + fbm(p.x, p.y * 0.2, p.z, seed, 2) * 0.4),
      vein: (p) => 0.35 + 0.5 * smoothstep(y, y + h, p.y),
    }));
    const H = capR * 0.32;
    const capGeo = paint(cap(capR, H, seed, 72), {
      color: (p, n) => (n.y < -0.25 ? C(0x2c3658) : mix(0x2a2152, 0x46327a, fbm(p.x * 0.5, p.y, p.z * 0.5, seed, 2))),
      emit: (p, n) => {
        const r = Math.hypot(p.x, p.z) / capR;
        if (n.y < -0.25) {
          const a = Math.atan2(p.z, p.x);
          const gills = Math.pow(Math.abs(Math.sin(a * 18 + seed)), 10);
          return glow(light, (0.05 + 1.7 * gills) * smoothstep(0.15, 0.6, r) * smoothstep(1.02, 0.8, r));
        }
        const spot = noise(p.x * 1.4 / capR * 4, p.y * 2, p.z * 1.4 / capR * 4, seed);
        return glow(PALETTE.turquoise, spot > 0.74 ? (spot - 0.74) * 7 : 0).add(glow(light, smoothstep(0.93, 1.02, r) * 0.8));
      },
    });
    capGeo.rotateX((noise(seed, 1, 2, 3) - 0.5) * 0.2);
    capGeo.rotateZ((noise(seed, 4, 5, 6) - 0.5) * 0.2);
    capGeo.translate(top.x, top.y - 0.2, top.z);
    fungusParts.push(capGeo);
    const rr = rng(seed);
    for (let i = 0; i < tendrils; i++) {
      const a = rr() * Math.PI * 2, rad = capR * (0.35 + rr() * 0.6);
      hangParts.push(strand(V(top.x + Math.cos(a) * rad, top.y - 0.25 - rad / capR * H * 0.3, top.z + Math.sin(a) * rad), 1 + rr() * capR * 0.45, seed * 31 + i, light));
    }
    return top;
  };

  // Crystal clusters, for boulders and the mesa corners.
  const crystals = (x: number, y: number, z: number, n: number, size: number, seed: number) => {
    const rr = rng(seed);
    for (let i = 0; i < n; i++) {
      const h = size * (0.5 + rr());
      const g = new THREE.CylinderGeometry(0, size * 0.18, h, 5, 1);
      g.translate(0, h / 2, 0);
      g.rotateZ((rr() - 0.5) * 1.1);
      g.rotateX((rr() - 0.5) * 1.1);
      g.translate(x + (rr() - 0.5) * size * 0.6, y - 0.05, z + (rr() - 0.5) * size * 0.6);
      const c = rr() < 0.5 ? PALETTE.violet : PALETTE.cyan;
      crystalParts.push(paint(g, { color: mix(c, 0xffffff, 0.15), emit: (p) => glow(c, 0.6 + (p.y - y) / h * 1.6), phase: rr() * 6 }));
    }
  };

  // The level's solids, dressed.
  solids.forEach((b, i) => {
    const [x0, , z0, x1, y1, z1, kind] = b;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    const seed = 100 + i * 13;
    if (kind === "platform") {
      rockParts.push(paint(rockOver(b, seed), { color: rockColor(y1, true, seed), vein: rockVein }));
      // Roots spilling over the rim, shelf fungi on the faces.
      const rr = rng(seed);
      const per = Math.ceil((w + d) / 3);
      for (let k = 0; k < per; k++) {
        const side = Math.floor(rr() * 4);
        const t = 0.1 + rr() * 0.8;
        const [ex, ez, nx, nz] = side === 0 ? [x0 + w * t, z0, 0, -1] : side === 1 ? [x0 + w * t, z1, 0, 1] : side === 2 ? [x0, z0 + d * t, -1, 0] : [x1, z0 + d * t, 1, 0];
        if (Math.max(Math.abs(ex + nx), Math.abs(ez + nz)) > inner) continue; // that face is against the cliff
        if (k % 2 === 0) {
          const pts = [V(ex - nx * 0.8, y1 + 0.05, ez - nz * 0.8), V(ex + nx * 0.25, y1 - 0.2, ez + nz * 0.25), V(ex + nx * 0.5, y1 * 0.45, ez + nz * 0.5), V(ex + nx * 1.4, 0.05, ez + nz * 1.4)];
          rockParts.push(paint(tube(pts, (s) => 0.16 * (1 - s * 0.6), 10, 5), { color: BARK, emit: null }));
        } else {
          fungusParts.push(shelf(V(ex + nx * 0.25, 0.6 + rr() * (y1 - 0.9), ez + nz * 0.25), Math.atan2(nx, nz), 0.35 + rr() * 0.35, seed + k));
        }
        if (k % 3 === 0) hangParts.push(strand(V(ex + nx * 0.3, y1 - 0.05, ez + nz * 0.3), y1 * (0.4 + rr() * 0.5), seed + k * 7, PALETTE.cyan, 0.025));
      }
      if (y1 < 3) for (const [qx, qz] of [[x0 + 1, z0 + 1], [x1 - 1, z1 - 1], [x0 + 1, z1 - 1], [x1 - 1, z0 + 1]]) crystals(qx, y1, qz, 5, 0.7, seed + qx);
    } else if (kind === "pillar") {
      const lightColor = i % 2 ? PALETTE.violet : PALETTE.cyan;
      const top = mushroom(cx, 0, cz, 8.6, 5 + (i % 3) * 0.6, seed, lightColor, [(noise(i, 1, 1, 9) - 0.5) * 0.5, (noise(i, 2, 2, 9) - 0.5) * 0.5], 16);
      for (let k = 0; k < 6; k++) rockParts.push(root(cx, cz, 0.7, k / 6 * Math.PI * 2 + i, 3.5 + noise(k, i, 0, 4) * 3, 0.32, seed + k));
      const l = new THREE.PointLight(lightColor, 20, 22, 1.7);
      l.position.set(top.x, 5.2, top.z);
      lights.push(l);
    } else if (kind === "cover") {
      // A fallen log, sunk into the soil at both ends.
      const along = w > d;
      const len = Math.max(w, d), r = Math.min(1.3 / 2, 0.66);
      const a = along ? V(x0 - 0.2, 0, cz) : V(cx, 0, z0 - 0.2), e = along ? V(x1 + 0.2, 0, cz) : V(cx, 0, z1 + 0.2);
      const pts = [0, 0.15, 0.5, 0.85, 1].map((t) => a.clone().lerp(e, t).setY(t === 0 || t === 1 ? 0.15 : r - 0.04 + Math.sin(t * Math.PI) * 0.06));
      rockParts.push(paint(tube(pts, (t) => r * (0.92 + 0.12 * Math.sin(t * 9 + seed)), Math.ceil(len * 3), 9), {
        color: (p) => mix(BARK, 0x3a3555, fbm(p.x * 1.2, p.y * 3, p.z * 1.2, seed, 3)).lerp(C(MOSS), smoothstep(0.85, 1.25, p.y) * 0.8),
          vein: 0.5,
      }));
      const rr = rng(seed);
      for (let k = 0; k < 3; k++) {
        const t = 0.2 + rr() * 0.6, sgn = rr() < 0.5 ? -1 : 1;
        const p = a.clone().lerp(e, t);
        fungusParts.push(shelf(along ? V(p.x, 0.5 + rr() * 0.4, cz + sgn * r) : V(cx + sgn * r, 0.5 + rr() * 0.4, p.z), along ? (sgn > 0 ? 0 : Math.PI) : (sgn > 0 ? Math.PI / 2 : -Math.PI / 2), 0.3 + rr() * 0.2, seed + k));
      }
    } else {
      // A boulder whose top sits at the crate's height, crusted with crystals.
      const g = blob(w * 0.58, y1 * 0.68, d * 0.58, 2, 0.22, 1.3, seed);
      g.translate(cx, y1 * 0.32, cz);
      rockParts.push(paint(g, { color: rockColor(y1, true, seed), vein: rockVein }));
      crystals(cx + (noise(i, 0, 0, 2) - 0.5) * w * 0.4, y1 - 0.15, cz, 4 + (i % 3), 0.55, seed);
    }
  });

  level.ramps.forEach((r, i) => {
    const [rx0, rz0, rx1, rz1, axis, h0, h1] = r;
    const at = (x: number, z: number) => Math.max(0.02, axis === "x" ? h0 + (h1 - h0) * (x - rx0) / (rx1 - rx0) : h0 + (h1 - h0) * (z - rz0) / (rz1 - rz0));
    const seed = 500 + i * 7;
    rockParts.push(paint(rockOver([rx0, 0, rz0, rx1, Math.max(h0, h1), rz1, "ramp"], seed, at), {
      color: (p, n) => (n.y > 0.6 ? mix(0x1c3a3f, MOSS, fbm(p.x * 0.5, 0, p.z * 0.5, seed, 2)) : C(STRATA[Math.floor(((p.y * 1.4 + fbm(p.x, p.y, p.z, seed, 2)) % 1) * STRATA.length)])),
      emit: null,
    }));
    // Roots running down both sides of the slope.
    for (const side of [0, 1]) {
      const along = axis === "z";
      const sx = along ? (side ? rx1 : rx0) : rx0, sz = along ? rz0 : (side ? rz1 : rz0);
      const ex = along ? sx : rx1, ez = along ? rz1 : sz;
      const pts = [0, 0.33, 0.66, 1].map((t) => { const x = sx + (ex - sx) * t, z = sz + (ez - sz) * t; return V(x, at(x, z) + 0.05, z); });
      rockParts.push(paint(tube(pts, () => 0.18, 12, 5), { color: BARK, emit: null }));
    }
  });

  // Burrows where the swarms emerge, glowing in each swarm's color.
  gates.forEach((g, i) => {
    const color = SWARM_COLORS[g.sw as "alpha" | "bravo"];
    for (let k = 0; k < 7; k++) {
      const a = k / 7 * Math.PI * 2 + i;
      const s = blob(0.45 + noise(k, i, 0, 3) * 0.3, 0.35, 0.45, 1, 0.3, 1.5, 700 + i * 9 + k);
      s.translate(g.x + Math.cos(a) * 2.2, 0.05, g.z + Math.sin(a) * 2.2);
      rockParts.push(paint(s, { color: rockColor(0.4, true, 700 + k), emit: null }));
      const spike = new THREE.ConeGeometry(0.07, 0.6 + noise(k, i, 1, 3) * 0.6, 5);
      spike.rotateZ((noise(k, i, 2, 3) - 0.5) * 0.8);
      spike.translate(g.x + Math.cos(a + 0.4) * 1.6, 0.3, g.z + Math.sin(a + 0.4) * 1.6);
      liquidParts.push(paint(spike, { color: 0x2a1e2a, emit: (p) => glow(color, smoothstep(0.1, 0.9, p.y) * 1.8), phase: i }));
    }
    const disc = warp(new THREE.CircleGeometry(1.8, 24).rotateX(-Math.PI / 2), (p) => {
      const k = 1 + (noise(Math.atan2(p.z, p.x) * 1.2, i, 0, 8) - 0.5) * 0.4;
      p.set(g.x + p.x * k, 0.035, g.z + p.z * k);
    });
    liquidParts.push(paint(disc, { color: 0x1a1020, emit: (p) => glow(color, 0.5 + 0.9 * smoothstep(1.8, 0.2, Math.hypot(p.x - g.x, p.z - g.z))), phase: i * 2 }));
  });

  // Luminous pools.
  pools.forEach((pl, i) => {
    const disc = warp(new THREE.CircleGeometry(pl.r, 32).rotateX(-Math.PI / 2), (p) => {
      const k = 1 + (noise(Math.atan2(p.z, p.x) * 1.4, i, 3, 5) - 0.5) * 0.5;
      p.set(pl.x + p.x * k, 0.03, pl.z + p.z * k);
    });
    liquidParts.push(paint(disc, { color: 0x0d3a3a, emit: (p) => glow(PALETTE.cyan, 0.55 + 0.6 * smoothstep(pl.r, 0, Math.hypot(p.x - pl.x, p.z - pl.z))), phase: i * 1.3 }));
    if (i < 2) {
      const l = new THREE.PointLight(PALETTE.cyan, 10, 12, 1.8);
      l.position.set(pl.x, 0.9, pl.z);
      lights.push(l);
    }
  });

  // Giant fungi on the hills beyond the cliffs: the skyline.
  const far = rng(99);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + far() * 0.2;
    const dist = 46 + far() * 60;
    const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
    const colors = [PALETTE.cyan, PALETTE.violet, PALETTE.turquoise];
    mushroom(x, height(x, z), z, 16 + far() * 24, 7 + far() * 9, 900 + i, colors[i % 3], [(far() - 0.5) * 6, (far() - 0.5) * 6], i % 2 ? 10 : 0);
  }
  // Weathered rock formations along the foot of the cliffs.
  const fr = rng(17);
  for (let i = 0; i < 64; i++) {
    const side = i % 4, t = (fr() - 0.5) * 2 * (level.half + 2);
    const out = level.half + 1.4 + fr() * 2.5;
    const [x, z] = side === 0 ? [t, -out] : side === 1 ? [t, out] : side === 2 ? [-out, t] : [out, t];
    const s = 1.4 + fr() * 2.6;
    const g = blob(s * (0.6 + fr() * 0.5), s * (1 + fr() * 1.6), s * (0.6 + fr() * 0.5), 2, 0.28, 0.9, 400 + i);
    g.rotateY(fr() * Math.PI);
    g.translate(x, s * 0.5, z);
    rockParts.push(paint(g, { color: rockColor(-1, false, 400 + i), vein: rockVein }));
  }
  // Vines down the cliff faces.
  const vr = rng(5);
  for (let i = 0; i < 70; i++) {
    const side = Math.floor(vr() * 4), t = (vr() - 0.5) * 2 * (level.half - 2);
    const [x, z] = side === 0 ? [t, -level.half - 1.6] : side === 1 ? [t, level.half + 1.6] : side === 2 ? [-level.half - 1.6, t] : [level.half + 1.6, t];
    const h = height(x, z);
    if (h < 6) continue;
    hangParts.push(strand(V(x, h - 0.3, z), 3 + vr() * (h - 4), 300 + i, vr() < 0.3 ? PALETTE.violet : PALETTE.cyan, 0.05));
  }

  const rockMat = bioMaterial({ rough: 0.92, envIntensity: 0.35, vein: { color: PALETTE.cyan, k: 0.7, freq: 0.6, width: 0.02 } });
  const fungusMat = bioMaterial({ rough: 0.7, side: THREE.DoubleSide, pulse: 0.12, pulseSpeed: 0.8, envIntensity: 0.6, vein: { color: PALETTE.turquoise, k: 0.8, freq: 1.3, width: 0.03 } });
  const hangMat = bioMaterial({ rough: 0.8, sway: 0.35, pulse: 0.3, pulseSpeed: 1.6 });
  const crystalMat = bioMaterial({ rough: 0.15, metal: 0.1, transparent: true, opacity: 0.82, pulse: 0.15, pulseSpeed: 1.1, envIntensity: 1.6 });
  const liquidMat = bioMaterial({ rough: 0.1, pulse: 0.22, pulseSpeed: 1.4, envIntensity: 1.5 });
  for (const [parts, mat] of [[rockParts, rockMat], [fungusParts, fungusMat], [hangParts, hangMat], [crystalParts, crystalMat], [liquidParts, liquidMat]] as const) {
    if (parts.length) group.add(new THREE.Mesh(merge(parts), mat));
  }

  // Vegetation, instanced and clustered.
  const surface = (x: number, z: number): number | null => {
    if (Math.max(Math.abs(x), Math.abs(z)) > inner - 0.3) return null;
    for (const b of solids) {
      if (!inBox(x, z, b, 0.25)) continue;
      return b[6] === "platform" && inBox(x, z, b, -0.6) ? b[4] : null;
    }
    if (level.ramps.some((r) => inRamp(x, z, r, 0.2))) return null;
    if (pools.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + 0.3)) return null;
    return 0;
  };
  const nearFeature = (x: number, z: number) => solids.some((b) => inBox(x, z, b, 2.2)) || Math.max(Math.abs(x), Math.abs(z)) > inner - 3;
  const scatter = (geo: THREE.BufferGeometry, mat: BioMaterial, count: number, seed: number, o: { scale: [number, number]; cluster: number; outside?: number; tilt?: number }) => {
    const rr = rng(seed);
    const m = new THREE.InstancedMesh(geo, mat, count);
    const q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3(), mat4 = new THREE.Matrix4();
    let n = 0;
    for (let tries = 0; n < count && tries < count * 40; tries++) {
      let x: number, z: number, y: number | null;
      if (rr() < (o.outside ?? 0)) {
        const a = rr() * Math.PI * 2, dist = level.half + 3 + rr() * 34;
        x = Math.cos(a) * dist; z = Math.sin(a) * dist; y = height(x, z);
      } else {
        x = (rr() - 0.5) * 2 * inner; z = (rr() - 0.5) * 2 * inner; y = surface(x, z);
        if (y === null) continue;
        const dens = smoothstep(0.42, 0.68, fbm(x * 0.09, seed, z * 0.09, seed, 3)) + (nearFeature(x, z) ? 0.45 : 0);
        if (rr() > dens * o.cluster) continue;
      }
      const k = o.scale[0] + rr() * (o.scale[1] - o.scale[0]);
      e.set((rr() - 0.5) * (o.tilt ?? 0.25), rr() * Math.PI * 2, (rr() - 0.5) * (o.tilt ?? 0.25));
      m.setMatrixAt(n++, mat4.compose(p.set(x, y - 0.02, z), q.setFromEuler(e), s.set(k, k * (0.8 + rr() * 0.4), k)));
    }
    m.count = n;
    m.frustumCulled = false;
    group.add(m);
    return m;
  };

  scatter(grassTuft(), bioMaterial({ rough: 0.8, sway: 0.5, pulse: 0.25, pulseSpeed: 1.3, side: THREE.DoubleSide }), 2100, 11, { scale: [0.6, 1.1], cluster: 1.4, outside: 0.25 });
  scatter(fern(), bioMaterial({ rough: 0.8, sway: 0.4, side: THREE.DoubleSide, pulse: 0.2 }), 260, 12, { scale: [0.5, 1.0], cluster: 0.9, outside: 0.3 });
  scatter(crystalFlower(), bioMaterial({ rough: 0.2, transparent: true, opacity: 0.85, sway: 0.25, pulse: 0.35, pulseSpeed: 1.8, envIntensity: 1.4 }), 170, 13, { scale: [0.7, 1.3], cluster: 0.7, outside: 0.2 });
  scatter(sporeSacs(), bioMaterial({ rough: 0.5, pulse: 0.55, pulseSpeed: 2.2 }), 130, 14, { scale: [0.45, 0.9], cluster: 0.5, outside: 0.2, tilt: 0.1 });
  scatter(coral(), bioMaterial({ rough: 0.6, pulse: 0.25, pulseSpeed: 0.9 }), 110, 15, { scale: [0.6, 1.4], cluster: 0.5, outside: 0.35 });
  scatter(smallShroom(), bioMaterial({ rough: 0.7, side: THREE.DoubleSide, pulse: 0.3, pulseSpeed: 1.2 }), 220, 16, { scale: [0.6, 2.4], cluster: 0.7, outside: 0.3, tilt: 0.3 });

  // Drifting spores and wandering luminous insects.
  const spores = particles(2400, [72, 16, 72], 0.085, [PALETTE.cyan, PALETTE.turquoise, PALETTE.violet], 0.55, false);
  const insects = particles(70, [56, 6, 56], 0.2, [PALETTE.turquoise, PALETTE.cyan], 1.4, true);
  group.add(spores, insects);

  group.add(sky());
  group.add(new THREE.HemisphereLight(0x4b4f8c, PALETTE.shadow, 0.55));
  const moon = new THREE.DirectionalLight(0x8f86ff, 0.35);
  moon.position.set(-30, 50, 20);
  group.add(moon, ...lights);
  const base = lights.map((l) => l.intensity);

  scene.add(group);
  return {
    group,
    levelColliders,
    update(t: number) {
      uTime.value = t;
      lights.forEach((l, i) => { l.intensity = base[i] * (0.85 + 0.15 * Math.sin(t * 0.9 + i * 1.7)); });
    },
  };
}

function rampCorners(r: Ramp): THREE.Vector3[] {
  const [x0, z0, x1, z1, axis, h0, h1] = r;
  const h = (x: number, z: number) => (axis === "x" ? h0 + (h1 - h0) * (x - x0) / (x1 - x0) : h0 + (h1 - h0) * (z - z0) / (z1 - z0));
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].flatMap(([x, z]) => [V(x, 0, z), V(x, h(x, z), z)]);
}

// Vegetation geometry: built once, drawn many times.

function grassTuft() {
  const rr = rng(3);
  const blades: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const h = 0.18 + rr() * 0.26;
    const lean = (rr() - 0.5) * 0.6, a = rr() * Math.PI * 2, off = rr() * 0.12;
    const g = new THREE.ConeGeometry(0.028, h, 3, 2, true);
    g.translate(0, h / 2, 0);
    warp(g, (p) => { const t = p.y / h; p.x += Math.sin(a) * off + lean * t * t * h; p.z += Math.cos(a) * off; });
    blades.push(paint(g, {
      color: (p) => mix(0x0f2a2c, 0x1f5a52, p.y / h),
      emit: (p) => glow(i % 3 ? PALETTE.turquoise : PALETTE.cyan, smoothstep(0.75, 1, p.y / h) * 1.1),
      sway: (p) => Math.pow(p.y / h, 2) * 0.12,
    }));
  }
  return merge(blades);
}

function fern() {
  const fronds: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const g = new THREE.PlaneGeometry(0.16, 1, 1, 10);
    warp(g, (p) => {
      const t = p.y + 0.5; // 0 at the base
      const w = Math.sin(t * Math.PI) * (1 - t * 0.4);
      const curl = t * t * 1.4;
      const r = 0.7 * t;
      p.set(p.x * w, Math.sin(Math.min(curl, Math.PI * 0.9) + 0.4) * r * 0.9, Math.cos(Math.min(curl, Math.PI * 0.9) + 0.4) * r * 0.9 - 0.25 * t);
    });
    g.rotateY(i / 6 * Math.PI * 2);
    fronds.push(paint(g, {
      color: (p) => mix(0x123532, 0x2b6b5c, Math.hypot(p.x, p.z) * 1.4),
      emit: (p) => glow(PALETTE.cyan, smoothstep(0.012, 0, Math.abs(Math.sin(Math.atan2(p.x, p.z) * 3))) * 0.35 + smoothstep(0.6, 0.7, Math.hypot(p.x, p.z)) * 0.25),
      sway: (p) => Math.hypot(p.x, p.z) * 0.12,
    }));
  }
  return merge(fronds);
}

function crystalFlower() {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(tube([V(0, 0, 0), V(0.03, 0.25, 0), V(0, 0.5, 0.02)], () => 0.02, 5, 4), { color: 0x1d3b3c, sway: (p) => p.y * 0.1 }));
  for (let i = 0; i < 6; i++) {
    const g = new THREE.OctahedronGeometry(1, 0);
    g.scale(0.05, 0.22, 0.02);
    g.translate(0, 0.2, 0);
    g.rotateX(0.75);
    g.rotateY(i / 6 * Math.PI * 2);
    g.translate(0, 0.5, 0.02);
    const c = i % 2 ? PALETTE.violet : 0xc49bff;
    parts.push(paint(g, { color: c, emit: (p) => glow(c, 0.5 + (p.y - 0.5) * 3), sway: (p) => p.y * 0.1 }));
  }
  const pistil = new THREE.IcosahedronGeometry(0.05, 0).translate(0, 0.52, 0.02);
  parts.push(paint(pistil, { color: 0xffffff, emit: glow(PALETTE.turquoise, 2.4), sway: 0.05 }));
  return merge(parts);
}

function sporeSacs() {
  const parts: THREE.BufferGeometry[] = [];
  const rr = rng(8);
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1, d = 0.12 + rr() * 0.1, h = 0.12 + rr() * 0.25, s = 0.1 + rr() * 0.09;
    parts.push(paint(tube([V(0, 0, 0), V(Math.cos(a) * d * 0.5, h * 0.6, Math.sin(a) * d * 0.5), V(Math.cos(a) * d, h, Math.sin(a) * d)], () => 0.025, 4, 4), { color: 0x1d2c3c }));
    const bulb = blob(s, s * 1.25, s, 1, 0.15, 3, 40 + i).translate(Math.cos(a) * d, h + s, Math.sin(a) * d);
    parts.push(paint(bulb, { color: 0x1c4a44, emit: (p) => glow(PALETTE.turquoise, 0.25 + smoothstep(h, h + s * 2, p.y) * 1.1) }));
  }
  return merge(parts);
}

function coral() {
  const parts: THREE.BufferGeometry[] = [];
  const rr = rng(21);
  const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
    const to = from.clone().addScaledVector(dir, len);
    const mid = from.clone().lerp(to, 0.5).add(V((rr() - 0.5) * len * 0.3, 0, (rr() - 0.5) * len * 0.3));
    parts.push(paint(tube([from, mid, to], (t) => r * (1 - t * 0.45), 4, 4), {
      color: (p) => mix(0x221c3a, 0x4a3577, p.y),
      emit: (p) => glow(depth === 0 ? PALETTE.cyan : PALETTE.violet, depth === 0 ? smoothstep(0.6, 1, (p.distanceTo(from)) / len) * 2.2 : 0.15),
      sway: (p) => p.y * 0.05,
    }));
    if (depth === 0) return;
    for (let i = 0; i < 2 + (rr() < 0.4 ? 1 : 0); i++) {
      const d = dir.clone().add(V((rr() - 0.5) * 1.3, 0.3, (rr() - 0.5) * 1.3)).normalize();
      grow(to, d, len * 0.7, r * 0.6, depth - 1);
    }
  };
  grow(V(0, 0, 0), V(0, 1, 0), 0.35, 0.05, 2);
  return merge(parts);
}

function smallShroom() {
  const parts: THREE.BufferGeometry[] = [];
  const rr = rng(31);
  for (let i = 0; i < 3; i++) {
    const h = 0.12 + rr() * 0.22, x = (rr() - 0.5) * 0.3, z = (rr() - 0.5) * 0.3, R = 0.06 + rr() * 0.07;
    parts.push(paint(tube([V(x, 0, z), V(x + 0.02, h * 0.5, z), V(x, h, z + 0.02)], (t) => R * 0.32 * (1.2 - t * 0.4), 4, 5), { color: 0x3a4468 }));
    const c = cap(R, R * 0.5, 50 + i, 9);
    c.translate(x, h, z + 0.02);
    const col = i % 2 ? PALETTE.turquoise : PALETTE.cyan;
    parts.push(paint(c, {
      color: (_p, n) => (n.y < -0.2 ? C(0x24304d) : C(0x2d2456)),
      emit: (_p, n) => glow(col, n.y < -0.2 ? 1.6 : 0.35),
    }));
  }
  return merge(parts);
}

function softDot(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Points drifting through a box: spores rise and wander, insects loop and blink. */
function particles(count: number, size: [number, number, number], pointSize: number, colors: number[], k: number, insects: boolean) {
  const rr = rng(count);
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos.set([(rr() - 0.5) * size[0], rr() * size[1] + (insects ? 0.6 : 0), (rr() - 0.5) * size[2]], i * 3);
    const c = glow(colors[i % colors.length], k * (0.4 + rr() * 0.6));
    col.set([c.r, c.g, c.b], i * 3);
    seed[i] = rr();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
  const m = new THREE.PointsMaterial({ size: pointSize, map: softDot(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = "uniform float uTime; attribute float seed; varying float vBlink;\n" + sh.vertexShader.replace("#include <begin_vertex>", insects
      ? `#include <begin_vertex>
        float s = seed * 40.0;
        transformed += vec3(sin(uTime * 0.45 + s) * 2.6, sin(uTime * 0.8 + s * 1.3) * 0.7, cos(uTime * 0.37 + s * 0.7) * 2.6);
        vBlink = 0.25 + 0.75 * pow(abs(sin(uTime * 1.3 + s)), 6.0);`
      : `#include <begin_vertex>
        float s = seed * 40.0;
        transformed.y = mod(position.y + uTime * (0.12 + seed * 0.25), ${size[1].toFixed(1)});
        transformed.x += sin(uTime * 0.3 + s) * 0.9;
        transformed.z += cos(uTime * 0.27 + s * 1.7) * 0.9;
        vBlink = 1.0;`);
    sh.fragmentShader = "varying float vBlink;\n" + sh.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\n diffuseColor.rgb *= vBlink;");
  };
  m.customProgramCacheKey = () => (insects ? "insects" : "spores");
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

function sky(): THREE.Mesh {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTime, top: { value: C(0x080a1c) }, horizon: { value: C(PALETTE.fog) }, aurora: { value: glow(PALETTE.violet, 0.35) }, aurora2: { value: glow(PALETTE.cyan, 0.25) } },
    vertexShader: "varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }",
    fragmentShader: `
      uniform float uTime; uniform vec3 top; uniform vec3 horizon; uniform vec3 aurora; uniform vec3 aurora2; varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, top, pow(h, 0.55));
        float a = atan(vDir.z, vDir.x);
        float band = exp(-pow((h - 0.28 - 0.06 * sin(a * 3.0 + uTime * 0.05)) * 9.0, 2.0));
        c += band * mix(aurora, aurora2, 0.5 + 0.5 * sin(a * 2.0 - uTime * 0.03)) * (0.6 + 0.4 * sin(a * 7.0 + uTime * 0.1));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

// A dim reflection environment so wet and glassy surfaces catch the forest's light.
export function bioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  env.background = C(PALETTE.shadow);
  const panel = (color: number, k: number, x: number, y: number, z: number, w: number, h: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: glow(color, k), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(PALETTE.fog, 1.4, 0, 10, 0, 18, 18);
  panel(PALETTE.cyan, 1.6, -10, 1, 0, 4, 8);
  panel(PALETTE.violet, 1.6, 10, 1, 2, 4, 8);
  panel(PALETTE.turquoise, 1.0, 0, 1, -10, 8, 3);
  panel(PALETTE.shadow, 1, 0, -10, 0, 30, 30);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.06).texture;
  pmrem.dispose();
  return tex;
}

// The weapons-testing facility: a sunlit concrete arena inside a military
// megastructure. The server's level stays the collision truth (boxes and
// ramps, mirrored into Rapier for ray casts); everything drawn here dresses it:
// walls become buttressed concrete with hangar doors, pillars hold a gantry
// with the reactor ring hung at the center, galleries become raised
// walkways, low cover becomes jersey barriers, crates become cargo units.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import type { Level } from "./protocol";
import { SWARM_COLORS } from "./protocol";
import type { Ramp } from "./physics";
import { PALETTE, type Paint, canvasTexture, cylinder, glow, merge, outline, paint, plate, rng, toonMaterial, toonRamp, uTime } from "./kit";

export interface Arena {
  group: THREE.Group;
  levelColliders: Set<number>;
  update(t: number): void;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (hex: number) => new THREE.Color(hex);

const CONCRETE = PALETTE.concrete, CONCRETE_DARK = 0xb9b6aa, SLATE = PALETTE.slate, STEEL = PALETTE.steel, NAVY = PALETTE.navy, GOLD = PALETTE.gold;
const DECK = 0xa9b2b6;

export function buildArena(scene: THREE.Scene, level: Level, rapier: RAPIER.World): Arena {
  const group = new THREE.Group();
  const levelColliders = new Set<number>();
  const H = level.half;

  // Collision for local ray casts: the same boxes and ramps the server uses.
  const fixed = rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  levelColliders.add(rapier.createCollider(RAPIER.ColliderDesc.cuboid(H + 2, 0.5, H + 2).setTranslation(0, -0.5, 0), fixed).handle);
  for (const [x0, y0, z0, x1, y1, z1] of level.boxes) {
    levelColliders.add(rapier.createCollider(
      RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), fixed).handle);
  }
  for (const r of level.ramps) {
    const pts = rampCorners(r).flatMap((p) => [p.x, p.y, p.z]);
    levelColliders.add(rapier.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts))!, fixed).handle);
  }

  // Geometry goes into buckets, one merged mesh each.
  const solid: THREE.BufferGeometry[] = []; // casts and receives shadows, outlined
  const detail: THREE.BufferGeometry[] = []; // small parts: rails, stripes, seams
  const far: THREE.BufferGeometry[] = []; // the skyline, no shadows
  const lamps: THREE.BufferGeometry[] = []; // emissive bits
  const block = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: Paint["color"], bucket = solid, bevel?: number) => {
    const g = plate(x1 - x0, y1 - y0, z1 - z0, { bevel: bevel ?? Math.min(0.12, (x1 - x0) / 4, (y1 - y0) / 4, (z1 - z0) / 4) });
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    bucket.push(paint(g, { color }));
  };
  // Light from above, darker toward the base: the painted look of an anime background.
  const vert = (top: number, bottom: number, h0: number, h1: number) => (p: THREE.Vector3) => C(bottom).lerp(C(top), Math.min(1, Math.max(0, (p.y - h0) / (h1 - h0))));

  // Hazard stripes: slanted gold and navy bands along a vertical face.
  const stripes = (start: THREE.Vector3, along: THREE.Vector3, out: THREE.Vector3, length: number, y0: number, h: number, bucket = detail, w = 0.45, skip?: (p: THREE.Vector3) => boolean) => {
    const n = Math.max(1, Math.round(length / w));
    const step = length / n;
    for (let i = 0; i < n; i++) {
      const a = start.clone().addScaledVector(along, i * step).addScaledVector(out, 0.03);
      if (skip?.(a.clone().addScaledVector(along, step / 2))) continue;
      const b = a.clone().addScaledVector(along, step);
      const skew = along.clone().multiplyScalar(Math.min(step, h) * 0.6);
      const quad = new THREE.BufferGeometry().setFromPoints([
        a.clone().setY(y0), b.clone().setY(y0), b.clone().setY(y0 + h).add(skew),
        a.clone().setY(y0), b.clone().setY(y0 + h).add(skew), a.clone().setY(y0 + h).add(skew),
      ]);
      // Wind each quad to face `out`.
      const nrm = new THREE.Vector3().crossVectors(b.clone().sub(a), V(0, 1, 0));
      if (nrm.dot(out) < 0) quad.setIndex([0, 2, 1, 3, 5, 4]);
      bucket.push(paint(quad, { color: i % 2 ? NAVY : GOLD }));
    }
  };

  // The floor: painted concrete.
  const floorTex = canvasTexture(2048, 2048, (g) => paintFloor(g, level));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ map: floorTex, gradientMap: toonRamp }));
  floor.receiveShadow = true;
  group.add(floor);
  // The world beyond: a plain apron of concrete out to the haze.
  const apron = new THREE.Mesh(new THREE.RingGeometry(H + 0.5, 700, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ color: 0xc7c3b5, gradientMap: toonRamp }));
  apron.position.y = -0.02;
  apron.receiveShadow = true;
  group.add(apron);

  // Perimeter: tall concrete walls with buttresses, seams, a hazard band and a parapet.
  const walls: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [V(-H, 0, -H), V(1, 0, 0), V(0, 0, 1)], [V(H, 0, H), V(-1, 0, 0), V(0, 0, -1)],
    [V(-H, 0, H), V(0, 0, -1), V(1, 0, 0)], [V(H, 0, -H), V(0, 0, 1), V(-1, 0, 0)],
  ];
  const doors = Object.entries(level.gates).flatMap(([sw, list]) => list.map(([x, z]) => {
    // Each gate gets a hangar door in the nearest wall behind it.
    const onZ = Math.abs(z) >= Math.abs(x);
    return { sw, x: onZ ? x : Math.sign(x) * H, z: onZ ? Math.sign(z) * H : z, onZ };
  }));
  const H9 = level.wallH;
  for (const [start, along, inward] of walls) {
    const len = H * 2;
    // The wall itself, a little thicker than its collision box on the outside.
    const end = start.clone().addScaledVector(along, len);
    const outside = inward.clone().multiplyScalar(-2.5);
    const corners = [start, end, end.clone().add(outside), start.clone().add(outside)];
    const xs = corners.map((c) => c.x), zs = corners.map((c) => c.z);
    block(Math.min(...xs), 0, Math.min(...zs), Math.max(...xs), H9, Math.max(...zs), vert(CONCRETE, CONCRETE_DARK, 0, H9), solid, 0.2);
    // Parapet and coping on top.
    const top = start.clone().addScaledVector(inward, 0.15);
    const p0 = top.clone(), p1 = top.clone().addScaledVector(along, len).addScaledVector(inward, 0.5);
    block(Math.min(p0.x, p1.x), H9, Math.min(p0.z, p1.z), Math.max(p0.x, p1.x), H9 + 0.9, Math.max(p0.z, p1.z), CONCRETE_DARK, solid, 0.08);
    // Buttresses every 8 m, skipping doorways.
    for (let s = 4; s < len; s += 8) {
      const at = start.clone().addScaledVector(along, s);
      if (doors.some((d) => Math.hypot(d.x - at.x, d.z - at.z) < 5)) continue;
      const a = at.clone().addScaledVector(along, -0.7), b = at.clone().addScaledVector(along, 0.7).addScaledVector(inward, 0.25);
      block(Math.min(a.x, b.x), 0, Math.min(a.z, b.z), Math.max(a.x, b.x), H9 - 0.6, Math.max(a.z, b.z), vert(0xc9c5b7, 0xa9a598, 0, H9), solid, 0.15);
      // A wall lamp on each buttress.
      const lamp = at.clone().addScaledVector(inward, 0.33).setY(H9 - 1.6);
      lamps.push(paint(plate(0.5, 0.25, 0.2).translate(lamp.x, lamp.y, lamp.z), { color: 0xffffff, emit: glow(0xfff2c8, 1.4) }));
    }
    // Panel seams: horizontal lines at 3 m and 6 m.
    for (const y of [3, 6.2]) {
      const a = start.clone().addScaledVector(inward, 0.02);
      const b = a.clone().addScaledVector(along, len).addScaledVector(inward, 0.04);
      block(Math.min(a.x, b.x), y, Math.min(a.z, b.z), Math.max(a.x, b.x), y + 0.06, Math.max(a.z, b.z), SLATE, detail, 0.01);
    }
    // A hazard band along the base.
    stripes(start, along, inward, len, 0, 0.7);
  }

  // Hangar doors behind each spawn gate, with lights in the swarm's color.
  doors.forEach((d) => {
    const color = SWARM_COLORS[d.sw as "alpha" | "bravo"];
    const inward = d.onZ ? V(0, 0, -Math.sign(d.z)) : V(-Math.sign(d.x), 0, 0);
    const along = d.onZ ? V(1, 0, 0) : V(0, 0, 1);
    const c = V(d.x, 0, d.z).addScaledVector(inward, 0.05);
    const w = 7, h = 6.5;
    const frame = (o: number, a0: number, a1: number, y0: number, y1: number, col: number, depth = 0.25) => {
      const p = c.clone().addScaledVector(along, a0).addScaledVector(inward, o), q = c.clone().addScaledVector(along, a1).addScaledVector(inward, o + depth);
      block(Math.min(p.x, q.x), y0, Math.min(p.z, q.z), Math.max(p.x, q.x), y1, Math.max(p.z, q.z), col, solid, 0.06);
    };
    frame(0, -w / 2 - 0.8, -w / 2, 0, h + 0.8, STEEL);
    frame(0, w / 2, w / 2 + 0.8, 0, h + 0.8, STEEL);
    frame(0, -w / 2 - 0.8, w / 2 + 0.8, h, h + 0.8, STEEL);
    // The door, raised off the floor to show the dark bay the mechs come out of.
    frame(-0.05, -w / 2, w / 2, 0, 1.6, 0x1c2433, 0.1);
    for (let y = 1.6; y < h; y += 0.55) frame(-0.02, -w / 2, w / 2, y, y + 0.5, y % 1.1 < 0.55 ? 0x8695a2 : 0x7b8a97, 0.18);
    for (const side of [-1, 1]) stripes(c.clone().addScaledVector(along, side > 0 ? w / 2 + 0.8 : -w / 2 - 0.8).addScaledVector(inward, 0.25), along.clone().multiplyScalar(-side), inward, 0.8, 0, h, detail, 0.4);
    for (const s of [-2, 0, 2]) {
      const p = c.clone().addScaledVector(along, s).addScaledVector(inward, 0.3).setY(h + 0.4);
      lamps.push(paint(plate(0.5, 0.3, 0.12).translate(p.x, p.y, p.z), { color: 0xffffff, emit: glow(color, 2.2) }));
    }
  });

  // Pillars: steel columns on concrete footings, with a band of hazard stripes.
  const pillars = level.boxes.filter((b) => b[6] === "pillar");
  for (const [x0, , z0, x1, y1, z1] of pillars) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    block(x0, 0, z0, x1, 1.2, z1, CONCRETE_DARK, solid, 0.2);
    block(x0, 1.2, z0, x1, y1, z1, vert(0x8a9cab, 0x6a7c8b, 1.2, y1), solid, 0.18);
    for (const [px, pz, ax, az, ox, oz] of [[x0, z0, 1, 0, 0, -1], [x1, z1, -1, 0, 0, 1], [x0, z1, 0, -1, -1, 0], [x1, z0, 0, 1, 1, 0]] as const) {
      stripes(V(px, 0, pz), V(ax, 0, az), V(ox, 0, oz), x1 - x0, 1.5, 0.7);
    }
    block(cx - 1.5, y1 - 0.2, cz - 1.5, cx + 1.5, y1 + 0.6, cz + 1.5, NAVY, solid, 0.1);
  }

  // The gantry: trusses between the pillar tops, and the reactor ring hung over the center.
  if (pillars.length === 4) {
    const top = pillars[0][4] + 0.6;
    const xs = [...new Set(pillars.map((b) => (b[0] + b[3]) / 2))], zs = [...new Set(pillars.map((b) => (b[2] + b[5]) / 2))];
    const beam = (a: THREE.Vector3, b: THREE.Vector3, h: number, col: number) => {
      const len = a.distanceTo(b);
      const g = plate(0.7, h, len, { bevel: 0.08 });
      g.lookAt(b.clone().sub(a));
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      solid.push(paint(g, { color: col }));
    };
    for (const z of zs) beam(V(xs[0], top, z), V(xs[1], top, z), 1.2, SLATE);
    for (const x of xs) beam(V(x, top, zs[0]), V(x, top, zs[1]), 1.2, SLATE);
    for (const x of xs) for (const z of zs) beam(V(x, top + 0.3, z), V(x * 0.25, top + 3, z * 0.25), 0.6, STEEL);
    stripes(V(xs[0], 0, zs[0] + 0.36), V(1, 0, 0), V(0, 0, 1), xs[1] - xs[0], top - 0.35, 0.3, detail, 0.6);
  }

  // Platforms: the central command deck and the raised walkways along the sides.
  // Points on a platform face where a ramp meets it: no vents, stripes or railings there.
  const onRamp = (p: THREE.Vector3) => level.ramps.some(([rx0, rz0, rx1, rz1]) => p.x > rx0 - 0.4 && p.x < rx1 + 0.4 && p.z > rz0 - 0.4 && p.z < rz1 + 0.4);
  for (const b of level.boxes.filter((b) => b[6] === "platform")) {
    const [x0, , z0, x1, y1, z1] = b;
    block(x0, 0, z0, x1, y1 - 0.25, z1, vert(0xcdc9bb, 0xa8a497, 0, y1), solid, 0.18);
    block(x0 - 0.05, y1 - 0.25, z0 - 0.05, x1 + 0.05, y1, z1 + 0.05, DECK, solid, 0.05);
    // Recessed bays and vents along the open faces.
    const faces: [number, number, number, number, number, number][] = [[x0, z0, 1, 0, 0, -1], [x1, z1, -1, 0, 0, 1], [x0, z1, 0, -1, -1, 0], [x1, z0, 0, 1, 1, 0]];
    for (const [fx, fz, ax, az, ox, oz] of faces) {
      const len = Math.abs(ax) ? x1 - x0 : z1 - z0;
      const mid = V(fx + ax * len / 2, 0, fz + az * len / 2);
      if (Math.max(Math.abs(mid.x + ox), Math.abs(mid.z + oz)) > H - 0.5) continue; // against the perimeter wall
      for (let s = 1.5; s < len - 1; s += 3) {
        const p = V(fx + ax * s, 0, fz + az * s);
        if (onRamp(p.clone().addScaledVector(V(ax, 0, az), -0.9)) || onRamp(p.clone().addScaledVector(V(ax, 0, az), 0.9))) continue;
        const a = p.clone().addScaledVector(V(ax, 0, az), -0.9), e = p.clone().addScaledVector(V(ax, 0, az), 0.9).addScaledVector(V(ox, 0, oz), 0.06);
        for (let y = 0.5; y < y1 - 0.6; y += 0.28) {
          block(Math.min(a.x, e.x), y, Math.min(a.z, e.z), Math.max(a.x, e.x), y + 0.12, Math.max(a.z, e.z), NAVY, detail, 0.02);
        }
      }
      stripes(V(fx, 0, fz), V(ax, 0, az), V(ox, 0, oz), len, y1 - 0.25, 0.25, detail, 0.6, onRamp);
      // Railings on the walkways' open edges: just outside the walkable edge (they
      // have no collision), and open wherever a ramp comes up.
      if (y1 > 3) {
        const at = (s: number) => V(fx + ax * s, 0, fz + az * s).addScaledVector(V(ox, 0, oz), 0.12);
        const runs: [number, number][] = [];
        for (let s = 0; s <= len + 1e-6; s += 0.25) {
          const open = !onRamp(V(fx + ax * s, 0, fz + az * s));
          const last = runs[runs.length - 1];
          if (open && last && Math.abs(last[1] - (s - 0.25)) < 1e-6) last[1] = s;
          else if (open) runs.push([s, s]);
        }
        for (const [s0, s1] of runs) {
          if (s1 - s0 < 0.5) continue;
          for (let s = s0; s <= s1 + 1e-6; s += Math.max(0.5, (s1 - s0) / Math.max(1, Math.round((s1 - s0) / 2)))) {
            const p = at(s);
            block(p.x - 0.05, y1, p.z - 0.05, p.x + 0.05, y1 + 1.05, p.z + 0.05, GOLD, detail, 0.015);
          }
          const p = at(s0), q = at(s1);
          for (const y of [y1 + 0.5, y1 + 1.0]) block(Math.min(p.x, q.x) - 0.04, y, Math.min(p.z, q.z) - 0.04, Math.max(p.x, q.x) + 0.04, y + 0.07, Math.max(p.z, q.z) + 0.04, GOLD, detail, 0.015);
        }
      }
    }
  }

  // A painted emblem on the central command deck.
  const deck = level.boxes.find((b) => b[6] === "platform" && Math.abs(b[0] + b[3]) < 1);
  if (deck) {
    const emblem = canvasTexture(1024, 1024, (g) => {
      g.translate(512, 512);
      g.strokeStyle = "rgba(255,200,87,0.95)";
      g.lineWidth = 26;
      g.beginPath(); g.arc(0, 0, 400, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 10;
      g.beginPath(); g.arc(0, 0, 340, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "rgba(39,51,71,0.85)";
      for (let i = 0; i < 4; i++) {
        g.save(); g.rotate((i * Math.PI) / 2);
        g.beginPath(); g.moveTo(0, -392); g.lineTo(26, -348); g.lineTo(-26, -348); g.closePath(); g.fill();
        g.restore();
      }
      g.font = "800 112px 'Barlow Semi Condensed', 'Arial Narrow', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("CROSSWIND", 0, -10);
      g.font = "600 52px 'Barlow Semi Condensed', 'Arial Narrow', sans-serif";
      g.fillStyle = "rgba(239,81,69,0.9)";
      g.fillText("TEST RANGE 3", 0, 90);
    });
    const size = Math.min(deck[3] - deck[0], deck[5] - deck[2]) - 1;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ map: emblem, gradientMap: toonRamp, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    plane.position.set((deck[0] + deck[3]) / 2, deck[4] + 0.01, (deck[2] + deck[5]) / 2);
    plane.receiveShadow = true;
    group.add(plane);
  }

  // Ramps: steel plate with grip bars and gold edges.
  for (const r of level.ramps) {
    const [x0, z0, x1, z1, axis, h0, h1] = r;
    solid.push(paint(new ConvexGeometry(rampCorners(r)), { color: (_p, n) => (n.y > 0.5 ? C(DECK) : C(0x8d99a1)) }));
    const along = axis === "z", len = along ? z1 - z0 : x1 - x0;
    const hAt = (t: number) => h0 + (h1 - h0) * t;
    for (let s = 0.5; s < len; s += 0.8) {
      const t = s / len;
      const y = hAt(t) + 0.02;
      if (along) block(x0 + 0.3, y, z0 + s - 0.06, x1 - 0.3, y + 0.05, z0 + s + 0.06, NAVY, detail, 0.01);
      else block(x0 + s - 0.06, y, z0 + 0.3, x0 + s + 0.06, y + 0.05, z1 - 0.3, NAVY, detail, 0.01);
    }
    // Gold kerbs down both sides, sloped with the ramp and only a hand's height above it.
    for (const side of [0, 1]) {
      const pts: THREE.Vector3[] = [];
      for (const t of [0, 1]) {
        const y = hAt(t) + 0.08;
        for (const d of [0, 0.15]) {
          const x = along ? (side ? x1 - d : x0 + d) : x0 + t * len;
          const z = along ? z0 + t * len : (side ? z1 - d : z0 + d);
          pts.push(V(x, 0, z), V(x, y, z));
        }
      }
      detail.push(paint(new ConvexGeometry(pts), { color: GOLD }));
    }
  }

  // Cover: segmented concrete jersey barriers with gold caps; crates: cargo units.
  for (const b of level.boxes) {
    const [x0, , z0, x1, y1, z1, kind] = b;
    if (kind === "cover") {
      const alongX = x1 - x0 > z1 - z0, len = alongX ? x1 - x0 : z1 - z0, depth = alongX ? z1 - z0 : x1 - x0;
      const n = Math.max(1, Math.round(len / 2));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * len + 0.04, e = ((i + 1) / n) * len - 0.04;
        const g = plate(depth, y1, e - a, { top: 0.45, bevel: 0.08 });
        if (alongX) g.rotateY(Math.PI / 2);
        g.translate(alongX ? x0 + (a + e) / 2 : (x0 + x1) / 2, y1 / 2, alongX ? (z0 + z1) / 2 : z0 + (a + e) / 2);
        solid.push(paint(g, { color: vert(0xd9d6c9, 0xb4b0a3, 0, y1) }));
        if (i % 2 === 0) {
          const cx = alongX ? x0 + (a + e) / 2 : (x0 + x1) / 2, cz = alongX ? (z0 + z1) / 2 : z0 + (a + e) / 2;
          block(cx - (alongX ? 0.5 : 0.24), y1 - 0.02, cz - (alongX ? 0.24 : 0.5), cx + (alongX ? 0.5 : 0.24), y1 + 0.05, cz + (alongX ? 0.24 : 0.5), GOLD, detail, 0.02);
        }
      }
    } else if (kind === "crate") {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const tall = y1 > 1.8;
      block(x0, 0, z0, x1, y1, z1, tall ? 0x6f8696 : 0x8c9a83, solid, 0.1);
      // Corner frames, a stencilled panel and a status light.
      for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) block(px - 0.08, 0, pz - 0.08, px + 0.08, y1 + 0.02, pz + 0.08, NAVY, detail, 0.02);
      block(cx - 0.4, y1 * 0.35, z0 - 0.03, cx + 0.4, y1 * 0.65, z0 + 0.02, tall ? GOLD : 0xe8e4d6, detail, 0.01);
      lamps.push(paint(plate(0.18, 0.1, 0.18).translate(cx, y1 + 0.06, cz), { color: 0xffffff, emit: glow(tall ? PALETTE.cyan : GOLD, 2) }));
    }
  }

  // Beyond the walls: hangars, cooling towers, stacks, antennas, cranes.
  const R = rng(7);
  const out = (min: number, max: number) => {
    for (;;) {
      const x = (R() - 0.5) * 2 * max, z = (R() - 0.5) * 2 * max;
      if (Math.max(Math.abs(x), Math.abs(z)) > min) return [x, z];
    }
  };
  for (let i = 0; i < 9; i++) {
    const [x, z] = out(48, 110);
    const w = 22 + R() * 18, d = 20 + R() * 14, h = 12 + R() * 10;
    const rot = Math.round(R() * 4) * (Math.PI / 2);
    const hall = plate(w, h, d, { bevel: 0.4 });
    hall.translate(0, h / 2, 0);
    const roof = new THREE.CylinderGeometry(d / 2, d / 2, w, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(Math.PI / 2);
    roof.scale(1, 0.55, 1).translate(0, h, 0);
    const doorG = plate(w * 0.5, h * 0.75, 0.6, { bevel: 0.1 }).translate(0, h * 0.375, -d / 2 - 0.2);
    for (const [g, col] of [[hall, vert(0xe2ded1, 0xbdb9ac, 0, h)], [roof, C(0x9fafbb)], [doorG, C(0x6f7f8d)]] as const) {
      g.rotateY(rot);
      g.translate(x, 0, z);
      far.push(paint(g, { color: col as never }));
    }
  }
  for (let i = 0; i < 4; i++) {
    const [x, z] = out(60, 130);
    const h = 30 + R() * 14;
    const prof = [[9, 0], [7, h * 0.4], [5.6, h * 0.7], [6.2, h]].map(([r, y]) => new THREE.Vector2(r, y));
    const tower = new THREE.LatheGeometry(prof, 16).translate(x, 0, z);
    far.push(paint(tower, { color: (p) => (p.y > h * 0.82 && p.y < h * 0.9 ? C(PALETTE.vermilion) : C(0xdedbd0)) }));
  }
  for (let i = 0; i < 6; i++) {
    const [x, z] = out(45, 120);
    const h = 26 + R() * 30;
    far.push(paint(cylinder(1.4, 1.9, h, 10).translate(x, h / 2, z), { color: (p) => (Math.floor(p.y / (h / 7)) % 2 && p.y > h * 0.55 ? C(PALETTE.vermilion) : C(0xe8e4d6)) }));
  }
  for (let i = 0; i < 5; i++) {
    const [x, z] = out(42, 90);
    const h = 30 + R() * 25;
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) far.push(paint(cylinder(0.12, 0.18, h, 4).translate(x + dx * 0.9, h / 2, z + dz * 0.9), { color: STEEL }));
    for (let y = 3; y < h; y += 3.5) far.push(paint(plate(2.2, 0.15, 2.2, { bevel: 0.02 }).translate(x, y, z), { color: STEEL }));
    far.push(paint(new THREE.LatheGeometry([0.1, 1.2, 2.6, 3.4].map((r, k) => new THREE.Vector2(r, k * 0.35)), 12).rotateX(-0.8).translate(x, h + 1, z), { color: 0xeeeae0 }));
    lamps.push(paint(plate(0.5, 0.5, 0.5).translate(x, h + 2.4, z), { color: 0xffffff, emit: glow(PALETTE.vermilion, 2.5) }));
  }
  for (let i = 0; i < 3; i++) {
    const [x, z] = out(50, 90);
    const h = 34 + R() * 10, a = R() * Math.PI * 2;
    far.push(paint(plate(2, h, 2, { bevel: 0.1 }).translate(x, h / 2, z), { color: GOLD }));
    const boom = plate(36, 1.6, 1.6, { bevel: 0.1 }).translate(10, h + 1, 0).rotateY(a).translate(x, 0, z);
    far.push(paint(boom, { color: GOLD }));
  }
  // The city on the horizon.
  for (let i = 0; i < 90; i++) {
    const a = R() * Math.PI * 2, dist = 190 + R() * 160;
    const w = 8 + R() * 18, h = 20 + R() * 80;
    const g = plate(w, h, w * (0.6 + R() * 0.6), { bevel: 0.6, top: 0.7 + R() * 0.3 });
    g.translate(Math.cos(a) * dist, h / 2, Math.sin(a) * dist);
    far.push(paint(g, { color: vert(0xb8c6cf, 0x9aaab6, 0, 100) }));
  }

  const toon = toonMaterial();
  const solidMesh = outline(new THREE.Mesh(merge(solid), toon), 0.0016, 0x2a3548);
  solidMesh.castShadow = solidMesh.receiveShadow = true;
  const detailMesh = new THREE.Mesh(merge(detail), toon);
  detailMesh.castShadow = detailMesh.receiveShadow = true;
  const farMesh = outline(new THREE.Mesh(merge(far), toon), 0.0012, 0x5a6a7c);
  const lampMesh = new THREE.Mesh(merge(lamps), toonMaterial({ pulse: 0.15, pulseSpeed: 1.5 }));
  group.add(solidMesh, detailMesh, farMesh, lampMesh);

  // The reactor ring, hung over the central deck.
  const reactor = new THREE.Group();
  reactor.position.set(0, 14.5, 0);
  const ring = outline(new THREE.Mesh(paint(new THREE.TorusGeometry(3.2, 0.45, 6, 16).rotateX(Math.PI / 2), { color: (p, n) => (n.y > 0.3 ? C(STEEL) : C(NAVY)) }), toon), 0.0018);
  const core = new THREE.Mesh(paint(new THREE.IcosahedronGeometry(1.1, 1), { color: 0xffffff, emit: glow(PALETTE.cyan, 2.6) }), toonMaterial({ pulse: 0.3, pulseSpeed: 2.4 }));
  const inner = outline(new THREE.Mesh(paint(new THREE.TorusGeometry(2, 0.18, 4, 12), { color: GOLD }), toon), 0.0018);
  reactor.add(ring, core, inner);
  for (const [x, z] of [[2.3, 2.3], [-2.3, 2.3], [2.3, -2.3], [-2.3, -2.3]]) {
    const cable = new THREE.Mesh(paint(cylinder(0.06, 0.06, 6, 4).translate(0, 3, 0), { color: NAVY }), toon);
    cable.position.set(x, 0, z);
    cable.lookAt(x * 4, 3.6, z * 4);
    cable.rotateX(Math.PI / 2);
    reactor.add(cable);
  }
  group.add(reactor);

  // Daylight: a strong sun with crisp shadows, and a sky fill that keeps shade readable.
  group.add(sky());
  group.add(new THREE.HemisphereLight(0xcfeaf6, 0xd9cfb6, 1.5));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(30, 60, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -46;
  sc.right = sc.top = 46;
  sc.near = 10;
  sc.far = 160;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  group.add(sun, sun.target);

  scene.add(group);
  return {
    group,
    levelColliders,
    update(t: number) {
      uTime.value = t;
      ring.rotation.y = t * 0.15;
      inner.rotation.x = t * 0.6;
      inner.rotation.z = t * 0.4;
      core.rotation.y = -t * 0.5;
      reactor.position.y = 14.5 + Math.sin(t * 0.7) * 0.15;
    },
  };
}

function rampCorners(r: Ramp): THREE.Vector3[] {
  const [x0, z0, x1, z1, axis, h0, h1] = r;
  const h = (x: number, z: number) => (axis === "x" ? h0 + (h1 - h0) * (x - x0) / (x1 - x0) : h0 + (h1 - h0) * (z - z0) / (z1 - z0));
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].flatMap(([x, z]) => [V(x, 0, z), V(x, Math.max(0.01, h(x, z)), z)]);
}

function paintFloor(g: CanvasRenderingContext2D, level: Level) {
  const S = 2048, H = level.half, k = S / (H * 2);
  const px = (x: number) => (x + H) * k, pz = (z: number) => (z + H) * k;
  g.fillStyle = "#cfcbbd";
  g.fillRect(0, 0, S, S);
  // Weathering: a few large, faint blotches.
  const R = rng(3);
  for (let i = 0; i < 60; i++) {
    const x = R() * S, y = R() * S, r = 40 + R() * 160;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(120,118,104,${0.05 + R() * 0.06})`);
    grad.addColorStop(1, "rgba(120,118,104,0)");
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Slabs: 4 m concrete with expansion joints.
  g.strokeStyle = "rgba(90,104,124,0.45)";
  g.lineWidth = 2;
  for (let i = 0; i <= S; i += 4 * k) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
  }
  // The central plaza: a ring and a dashed square in gold.
  g.strokeStyle = "rgba(240,190,80,0.9)";
  g.lineWidth = 10;
  g.beginPath(); g.arc(px(0), pz(0), 14 * k, 0, Math.PI * 2); g.stroke();
  g.setLineDash([3 * k, 1.5 * k]);
  g.lineWidth = 8;
  g.strokeRect(px(-17), pz(-17), 34 * k, 34 * k);
  g.setLineDash([]);
  // Hazard bands at the foot of the walkways.
  for (const sx of [-1, 1]) {
    const x = sx > 0 ? 21.2 : -21.8;
    for (let z = -12; z < 12; z += 0.9) {
      g.fillStyle = Math.round((z + 12) / 0.9) % 2 ? "#2b3547" : "#f2bd4c";
      g.beginPath();
      g.moveTo(px(x), pz(z)); g.lineTo(px(x + 0.6), pz(z + 0.45)); g.lineTo(px(x + 0.6), pz(z + 0.9)); g.lineTo(px(x), pz(z + 0.45));
      g.fill();
    }
  }
  // Spawn circles in each swarm's color, with chevrons pointing into the arena.
  for (const [sw, list] of Object.entries(level.gates)) {
    const col = sw === "alpha" ? "rgba(239,81,69,0.85)" : "rgba(46,134,255,0.85)";
    for (const [x, z] of list) {
      g.strokeStyle = col;
      g.lineWidth = 9;
      g.beginPath(); g.arc(px(x), pz(z), 2.4 * k, 0, Math.PI * 2); g.stroke();
      const a = Math.atan2(-z, -x);
      g.fillStyle = col;
      for (let c = 0; c < 3; c++) {
        const d = 3.4 + c * 1.1;
        const cx = px(x + Math.cos(a) * d), cy = pz(z + Math.sin(a) * d);
        g.save(); g.translate(cx, cy); g.rotate(a);
        g.beginPath(); g.moveTo(14, 0); g.lineTo(-8, -18); g.lineTo(-2, 0); g.lineTo(-8, 18); g.fill();
        g.restore();
      }
    }
  }
  // Stencilled sector numbers.
  g.fillStyle = "rgba(70,84,104,0.55)";
  g.font = "bold 120px 'Barlow Semi Condensed', 'Arial Narrow', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const [x, z, t] of [[-11, 18, "07"], [11, -18, "12"], [-18, -6, "03"], [18, 6, "09"]] as const) {
    g.save(); g.translate(px(x), pz(z)); g.rotate(x < 0 ? -Math.PI / 2 : Math.PI / 2); g.fillText(t, 0, 0); g.restore();
  }
  g.font = "bold 46px 'Barlow Semi Condensed', 'Arial Narrow', sans-serif";
  g.fillText("TEST RANGE 3 · LIVE FIRE", px(0), pz(16.5));
}

function sky(): THREE.Mesh {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTime, top: { value: C(0x5fa9d6) }, horizon: { value: C(0xd7eaf0) }, sunDir: { value: V(30, 60, 22).normalize() } },
    vertexShader: "varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }",
    fragmentShader: `
      uniform float uTime; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, top, pow(h, 0.6));
        float sun = max(dot(vDir, sunDir), 0.0);
        c += vec3(1.0, 0.95, 0.85) * (pow(sun, 600.0) * 2.0 + pow(sun, 12.0) * 0.18);
        // Flat anime clouds with crisp edges and a shaded underside.
        if (vDir.y > 0.02) {
          vec2 uv = vDir.xz / (vDir.y + 0.15) * 1.6 + vec2(uTime * 0.004, 0.0);
          float n = fbm(uv);
          float body = smoothstep(0.56, 0.58, n);
          float lit = smoothstep(0.6, 0.66, fbm(uv + sunDir.xz * 0.04));
          vec3 cloud = mix(vec3(0.82, 0.86, 0.93), vec3(1.0), lit);
          c = mix(c, cloud, body * smoothstep(0.02, 0.2, vDir.y));
        }
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

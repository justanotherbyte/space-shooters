// Procedural creatures. Each model faces -z with its feet at y = 0.
//   Striker:  a quadruped hunter, veins glowing in its swarm's color
//   Sentinel: a fungal behemoth, light leaking through its cracked shell
//   Explorer: the human players, as other players see them
// Part geometry is built once per kind and color, then shared; each body
// gets its own materials so it can flash, pulse and fade on its own.
import * as THREE from "three";
import type { Kind } from "./protocol";
import { PALETTE, type BioMaterial, type BioOptions, blob, bioMaterial, cap, fbm, glow, merge, noise, paint, smoothstep, tube, warp } from "./bio";

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (hex: number) => new THREE.Color(hex);
const EYE = PALETTE.coral; // every hostile has the same burning eyes

export interface Organism {
  root: THREE.Group;
  kind: Kind | "explorer";
  /** Height of the body's center, for effects. */
  hipY: number;
  marking: number;
  update(dt: number, speed: number, mode?: string): void;
  hit(): void;
  fire(): void;
  signal(): void;
  muzzle(i: number, out: THREE.Vector3): THREE.Vector3;
  /** Death, from 0 (alive) to 1 (gone into the soil). */
  collapse(k: number): void;
  dispose(): void;
}

const cache = new Map<string, Record<string, THREE.BufferGeometry>>();
function parts(key: string, build: () => Record<string, THREE.BufferGeometry>) {
  let p = cache.get(key);
  if (!p) cache.set(key, (p = build()));
  return p;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  return o;
}

abstract class Base implements Organism {
  root = new THREE.Group();
  body = new THREE.Group();
  skin: BioMaterial;
  marking = 1;
  protected markNow = 1;
  protected flashT = 0;
  protected signalT = 0;
  protected phase = Math.random() * 6;
  protected muzzles: THREE.Object3D[] = [];
  abstract kind: Kind | "explorer";
  abstract hipY: number;

  constructor(vein?: BioOptions["vein"]) {
    this.skin = bioMaterial({ rough: 0.42, metal: 0.15, envIntensity: 0.9, vein });
    this.root.add(this.body);
  }

  hit() { this.flashT = 1; }
  signal() { this.signalT = 1; }
  fire() {}

  muzzle(i: number, out: THREE.Vector3) {
    return this.muzzles[i % this.muzzles.length].getWorldPosition(out);
  }

  protected glowUpdate(dt: number, extra = 0) {
    this.markNow += (this.marking - this.markNow) * Math.min(1, dt * 3);
    this.flashT = Math.max(0, this.flashT - dt * 5);
    this.signalT = Math.max(0, this.signalT - dt * 1.8);
    const u = this.skin.userData.u;
    u.glow.value = this.markNow * (1 + this.signalT * 2.5) + extra;
    u.flash.value.setRGB(this.flashT * 1.6, this.flashT * 1.1, this.flashT * 0.9);
  }

  abstract update(dt: number, speed: number, mode?: string): void;
  abstract collapse(k: number): void;

  dispose() {
    this.skin.dispose();
  }
}

// Striker: the hunter

interface Leg { hip: THREE.Group; knee: THREE.Group; foot: THREE.Object3D; a1: number; a2: number; front: boolean; offset: number }

export class Striker extends Base {
  kind = "striker" as const;
  hipY = 0.9;
  private legs: Leg[] = [];
  private head = new THREE.Group();
  private tail: THREE.Group[] = [];
  private crouch = 0;
  private lunge = 0;

  constructor(color: number) {
    super({ color, k: 2.6, freq: 13, width: 0.06 });
    const g = parts(`striker:${color}`, () => strikerParts(color));
    const S = this.skin;
    this.body.position.y = this.hipY;
    this.body.add(mesh(g.torso, S), mesh(g.plates, S), mesh(g.neck, S));
    this.head.position.set(0, 0.62, -0.84);
    this.head.add(mesh(g.head, S));
    const mouth = new THREE.Object3D();
    mouth.position.set(0, -0.04, -0.34);
    this.head.add(mouth);
    this.muzzles.push(mouth);
    this.body.add(this.head);
    // Legs: front pair straight, hind pair digitigrade.
    for (const [x, z, front, offset] of [[-0.2, -0.42, true, 0], [0.2, -0.42, true, Math.PI], [-0.21, 0.4, false, Math.PI], [0.21, 0.4, false, 0]] as const) {
      const hip = new THREE.Group();
      hip.position.set(x, -0.04, z);
      hip.add(mesh(front ? g.upperF : g.upperH, S));
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      knee.add(mesh(g.lower, S));
      const foot = mesh(g.foot, S, 0, -0.46, 0);
      knee.add(foot);
      hip.add(knee);
      this.body.add(hip);
      const [a1, a2] = front ? [-0.15, 0.3] : [0.35, -0.7];
      this.legs.push({ hip, knee, foot, a1, a2, front, offset });
    }
    // A tail of six links that sways a beat behind the body.
    let parent: THREE.Object3D = this.body;
    let at = V(0, 0.05, 0.72);
    for (let i = 0; i < 6; i++) {
      const link = new THREE.Group();
      link.position.copy(at);
      link.add(mesh(g[`tail${i}`], S));
      parent.add(link);
      this.tail.push(link);
      parent = link;
      at = V(0, 0, 0.21);
    }
  }

  fire() { this.lunge = 1; }

  update(dt: number, speed: number, mode?: string) {
    const amp = Math.min(1, speed / 5);
    const stalk = mode === "hold" || mode === "flank" ? 1 : 0;
    this.crouch += (stalk - this.crouch) * Math.min(1, dt * 4);
    this.lunge = Math.max(0, this.lunge - dt * 3.5);
    this.phase += dt * (2 + speed * 1.7);
    const p = this.phase, c = this.crouch, f = this.flashT;
    this.body.position.y = this.hipY - c * 0.22 + Math.abs(Math.sin(p * 2)) * 0.04 * amp;
    this.body.position.z = -this.lunge * 0.3 + f * 0.12;
    this.body.rotation.x = -0.06 - amp * 0.08 - c * 0.05 + f * 0.35;
    this.head.rotation.x = c * 0.3 - this.lunge * 0.25 + Math.sin(p * 2) * 0.05 * amp;
    this.head.position.z = -0.84 - this.lunge * 0.12;
    for (const l of this.legs) {
      const s = Math.sin(p + l.offset), lift = Math.max(0, Math.cos(p + l.offset));
      l.hip.rotation.x = l.a1 + s * 0.55 * amp + c * (l.front ? -0.25 : 0.3);
      l.knee.rotation.x = l.a2 + lift * 0.7 * amp * (l.front ? 1 : -1) + c * (l.front ? 0.5 : -0.5);
      l.foot.rotation.x = -(l.hip.rotation.x + l.knee.rotation.x);
      l.hip.rotation.z = 0;
    }
    this.tail.forEach((link, i) => {
      link.rotation.y = Math.sin(p * 0.9 - i * 0.7) * (0.12 + amp * 0.12);
      link.rotation.x = i === 0 ? 0.18 - c * 0.3 : -0.06 + Math.sin(p - i) * 0.03;
    });
    this.glowUpdate(dt);
  }

  collapse(k: number) {
    const e = 1 - (1 - k) * (1 - k);
    this.body.position.y = this.hipY - e * 0.62;
    this.body.rotation.z = e * 0.55;
    this.body.rotation.x = -0.1 - e * 0.2;
    for (const l of this.legs) l.hip.rotation.z = (l.hip.position.x > 0 ? 1 : -1) * e * 1.1;
    this.tail.forEach((link) => { link.rotation.x = e * 0.15; });
    const u = this.skin.userData.u;
    u.glow.value = k < 0.12 ? 3 : (1 - k) * 1.4;
    u.flash.value.setScalar(Math.max(0, 0.6 - k * 3));
  }
}

function strikerParts(color: number): Record<string, THREE.BufferGeometry> {
  const skinColor = (p: THREE.Vector3, n: THREE.Vector3) =>
    C(0x131926).lerp(C(0x2e3d55), smoothstep(0.1, -0.6, n.y) * 0.7).lerp(C(0x1d2638), noise(p.x * 9, p.y * 9, p.z * 9, 4) * 0.6);
  // Veins show along the flanks and limbs, fading over the back and belly.
  const flanks = (k = 1) => (_p: THREE.Vector3, n: THREE.Vector3) => k * (0.25 + 0.75 * smoothstep(0.1, 0.6, Math.abs(n.x)));
  const out: Record<string, THREE.BufferGeometry> = {};
  // A long body, chest raised, haunches tapering.
  out.torso = paint(warp(blob(0.41, 0.34, 0.82, 2, 0.1, 2.2, 7), (p) => {
    p.y += -p.z * 0.14 + Math.max(0, -p.z) * 0.05;
    p.x *= 1 - Math.max(0, p.z) * 0.25;
  }), { color: skinColor, vein: flanks() });
  // Armor plates swept back along the spine.
  const plates: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const s = 1 - i * 0.12;
    const g = new THREE.ConeGeometry(0.1 * s, 0.34 * s, 3);
    g.scale(1, 1, 0.45);
    g.rotateX(-1.05);
    g.translate(0, 0.27 + 0.06 * Math.cos(i), -0.42 + i * 0.18);
    plates.push(paint(g, { color: 0x0e121b, vein: 0.6 }));
  }
  out.plates = merge(plates);
  out.neck = paint(tube([V(0, 0.08, -0.55), V(0, 0.36, -0.74), V(0, 0.6, -0.84)], (t) => 0.17 - t * 0.06, 8, 7), { color: skinColor, vein: flanks(0.9) });
  // Head: an elongated skull, a jaw, swept horns, burning eyes.
  const head: THREE.BufferGeometry[] = [];
  head.push(paint(warp(blob(0.17, 0.13, 0.34, 1, 0.12, 3, 11), (p) => { p.z -= 0.12; p.y -= Math.max(0, -p.z - 0.15) * 0.25; }), { color: skinColor, vein: flanks(0.7) }));
  head.push(paint(warp(blob(0.1, 0.05, 0.22, 1, 0.1, 4, 12), (p) => { p.z -= 0.18; p.y -= 0.09; }), { color: 0x0f141f }));
  for (const sx of [-1, 1]) {
    head.push(paint(tube([V(sx * 0.06, 0.08, 0.02), V(sx * 0.1, 0.18, 0.22), V(sx * 0.12, 0.2, 0.42)], (t) => 0.035 * (1 - t * 0.85), 6, 4), { color: 0x0c1018, emit: (p) => glow(color, smoothstep(0.25, 0.42, p.z) * 1.6) }));
    head.push(paint(new THREE.IcosahedronGeometry(0.034, 1).translate(sx * 0.075, 0.035, -0.22), { color: 0xffffff, emit: glow(EYE, 5.5) }));
  }
  head.push(paint(new THREE.IcosahedronGeometry(0.04, 0).translate(0, -0.06, -0.34), { color: 0x000000, emit: glow(color, 2.4) }));
  out.head = merge(head);
  // Legs
  const limb = (len: number, r0: number, r1: number, bend: number, seed: number) =>
    paint(tube([V(0, 0, 0), V(0, -len * 0.5, bend), V(0, -len, 0)], (t) => r0 + (r1 - r0) * t + Math.sin(t * Math.PI) * 0.02, 6, 6), { color: skinColor, vein: 0.8, phase: seed });
  out.upperF = limb(0.42, 0.1, 0.07, 0.04, 21);
  out.upperH = limb(0.42, 0.125, 0.07, -0.06, 22);
  out.lower = limb(0.46, 0.065, 0.036, 0.03, 23);
  const foot: THREE.BufferGeometry[] = [];
  for (const a of [-0.35, 0, 0.35]) {
    const g = new THREE.ConeGeometry(0.022, 0.14, 4);
    g.rotateX(-Math.PI / 2 - 0.25);
    g.rotateY(a);
    g.translate(Math.sin(a) * 0.03, 0.01, -0.07);
    foot.push(paint(g, { color: 0x0b0e15 }));
  }
  out.foot = merge(foot);
  for (let i = 0; i < 6; i++) {
    const r0 = 0.11 * (1 - i / 6.5), r1 = 0.11 * (1 - (i + 1) / 6.5);
    out[`tail${i}`] = paint(tube([V(0, 0, 0), V(0, 0.005, 0.11), V(0, 0, 0.22)], (t) => r0 + (r1 - r0) * t, 3, 6), {
      color: skinColor,
      emit: (p) => (i === 5 ? glow(color, 1.2 + smoothstep(0.1, 0.22, p.z) * 2.5) : null),
      vein: i === 5 ? 0 : 0.9,
    });
  }
  return out;
}

// Sentinel: the fungal behemoth

export class Sentinel extends Base {
  kind = "sentinel" as const;
  hipY = 1.55;
  private sacMat: BioMaterial;
  private sacs = new THREE.Group();
  private head = new THREE.Group();
  private legs: { hip: THREE.Group; knee: THREE.Group; offset: number; side: number }[] = [];
  private charge = 0;
  private flare = 0;
  private recoil = 0;

  constructor(color: number) {
    super({ color, k: 3, freq: 5.5, width: 0.09 });
    const g = parts(`sentinel:${color}`, () => sentinelParts(color));
    const S = this.skin;
    this.sacMat = bioMaterial({ rough: 0.15, transparent: true, opacity: 0.78, envIntensity: 1.5 });
    this.body.position.y = this.hipY;
    this.body.add(mesh(g.shell, S), mesh(g.belly, S), mesh(g.fungi, S));
    this.sacs.add(mesh(g.sacs, this.sacMat));
    this.body.add(this.sacs);
    this.head.position.set(0, 0.18, -1.0);
    this.head.add(mesh(g.head, S));
    const maw = new THREE.Object3D();
    maw.position.set(0, 0.02, -0.5);
    this.head.add(maw);
    this.muzzles.push(maw);
    this.body.add(this.head);
    for (const [x, z, offset] of [[-0.82, -0.6, 0], [0.82, -0.6, Math.PI], [-0.82, 0.68, Math.PI], [0.82, 0.68, 0]] as const) {
      const hip = new THREE.Group();
      hip.position.set(x, -0.3, z);
      hip.rotation.z = Math.sign(x) * 0.22;
      hip.add(mesh(g.upper, S));
      const knee = new THREE.Group();
      knee.position.y = -0.6;
      knee.add(mesh(g.lower, S));
      hip.add(knee);
      this.body.add(hip);
      this.legs.push({ hip, knee, offset, side: Math.sign(x) });
    }
  }

  fire() {
    this.flare = 1;
    this.charge = 0;
    this.recoil = 1;
  }

  update(dt: number, speed: number) {
    const amp = Math.min(1, speed / 2.6);
    this.phase += dt * (1 + speed * 0.9);
    this.charge += dt;
    this.flare = Math.max(0, this.flare - dt * 2.5);
    this.recoil = Math.max(0, this.recoil - dt * 2);
    const p = this.phase, f = this.flashT;
    this.body.position.y = this.hipY + Math.abs(Math.sin(p)) * 0.06 * amp - f * 0.08;
    this.body.rotation.z = Math.sin(p) * 0.05 * amp;
    this.body.rotation.x = this.recoil * 0.12 + f * 0.12;
    this.head.rotation.x = -this.recoil * 0.2 + Math.sin(p * 0.5) * 0.03;
    for (const l of this.legs) {
      const s = Math.sin(p + l.offset);
      l.hip.rotation.x = s * 0.3 * amp;
      l.knee.rotation.x = -Math.max(0, Math.cos(p + l.offset)) * 0.45 * amp;
      l.hip.rotation.z = l.side * 0.22;
    }
    // The sacs build up between volleys: dim after a shot, swelling toward the next.
    const ready = smoothstep(1.0, 2.8, this.charge);
    const beat = Math.sin(this.charge * (5 + ready * 9));
    this.sacs.scale.setScalar(1 + ready * 0.08 * beat + this.flare * 0.12);
    const su = this.sacMat.userData.u;
    su.glow.value = (0.45 + ready * 1.6 * (0.75 + 0.25 * beat) + this.flare * 3) * (1 + this.signalT * 1.5);
    this.glowUpdate(dt, this.flare * 1.5);
  }

  collapse(k: number) {
    const e = 1 - (1 - k) * (1 - k);
    this.body.position.y = this.hipY - e * 1.05;
    this.body.rotation.x = -e * 0.35;
    this.body.rotation.z = e * 0.25;
    for (const l of this.legs) {
      l.hip.rotation.z = l.side * (0.22 + e * 1.0);
      l.knee.rotation.x = -e * 1.2;
    }
    this.sacs.scale.setScalar(k < 0.25 ? 1 + k * 2.4 : 0.001); // they burst
    const u = this.skin.userData.u;
    u.glow.value = k < 0.2 ? 3.5 : (1 - k) * 1.8;
    u.flash.value.setScalar(Math.max(0, 0.5 - k * 2.5));
  }

  /** Where the sacs are, for the burst on death. */
  sacPositions(): THREE.Vector3[] {
    this.root.updateMatrixWorld(true);
    return [V(0.55, 0.55, 0.35), V(-0.6, 0.45, 0.5), V(0.2, 0.75, 0.75), V(-0.3, 0.7, -0.1), V(0.7, 0.2, -0.3)].map((p) => this.body.localToWorld(p));
  }

  dispose() {
    super.dispose();
    this.sacMat.dispose();
  }
}

function sentinelParts(color: number): Record<string, THREE.BufferGeometry> {
  const out: Record<string, THREE.BufferGeometry> = {};
  const shellColor = (p: THREE.Vector3, n: THREE.Vector3) =>
    C(0x151927).lerp(C(0x2c3048), smoothstep(0.35, 0.7, fbm(p.x * 1.6, p.y * 1.6, p.z * 1.6, 3, 3))).lerp(C(0x101420), smoothstep(0, -0.7, n.y));
  // Light leaks through cracks in the shell (drawn per pixel by the material), with a faint inner glow.
  const inner = (k: number) => () => glow(color, 0.06 * k);
  // A broad, lopsided shell with a hump.
  out.shell = paint(warp(blob(1.05, 0.78, 1.2, 3, 0.2, 1.3, 3), (p) => {
    p.x *= p.x > 0 ? 1.1 : 0.93;
    p.y += Math.max(0, p.y) * 0.25 * Math.exp(-((p.z - 0.2) ** 2) * 2);
  }), { color: shellColor, emit: inner(1), vein: 1 });
  out.belly = paint(blob(0.75, 0.4, 0.95, 2, 0.12, 2, 4).translate(0, -0.42, 0.05), { color: 0x262a3d, emit: inner(0.5), vein: 0.5 });
  // Fungi sprouting from the back.
  const fungi: THREE.BufferGeometry[] = [];
  for (const [x, y, z, s, c] of [[0.35, 0.78, 0.2, 1, PALETTE.turquoise], [-0.3, 0.72, 0.45, 0.8, PALETTE.cyan], [0.05, 0.86, -0.25, 0.65, PALETTE.turquoise], [-0.55, 0.55, -0.2, 0.55, PALETTE.cyan]] as const) {
    fungi.push(paint(tube([V(x, y - 0.1, z), V(x + 0.03, y + 0.15 * s, z), V(x - 0.02, y + 0.32 * s, z + 0.03)], (t) => 0.06 * s * (1.2 - t * 0.4), 5, 6), { color: 0x3a4466 }));
    const g = cap(0.24 * s, 0.12 * s, 60 + x * 10, 12).translate(x - 0.02, y + 0.32 * s, z + 0.03);
    fungi.push(paint(g, { color: (_p, n) => (n.y < -0.2 ? C(0x24304d) : C(0x2e2a5a)), emit: (_p, n) => glow(c, n.y < -0.2 ? 1.8 : 0.3) }));
  }
  out.fungi = merge(fungi);
  // Translucent sacs, lit from inside in the swarm's color.
  const sacs: THREE.BufferGeometry[] = [];
  for (const [x, y, z, s] of [[0.55, 0.55, 0.35, 0.3], [-0.6, 0.45, 0.5, 0.26], [0.2, 0.75, 0.75, 0.22], [-0.3, 0.7, -0.1, 0.2], [0.7, 0.2, -0.3, 0.18]]) {
    sacs.push(paint(blob(s, s * 1.15, s, 2, 0.12, 3, 80 + x * 10).translate(x, y, z), {
      color: C(color).lerp(C(0xffffff), 0.2),
      emit: (p) => glow(color, 0.8 + fbm(p.x * 9, p.y * 9, p.z * 9, 13, 2) * 0.6),
    }));
  }
  out.sacs = merge(sacs);
  // A low, heavy head with mandibles around a glowing maw.
  const head: THREE.BufferGeometry[] = [];
  head.push(paint(warp(blob(0.48, 0.34, 0.42, 2, 0.15, 2.4, 9), (p) => { p.z -= 0.1; }), { color: shellColor, emit: inner(1), vein: 0.8 }));
  for (const sx of [-1, 1]) {
    head.push(paint(tube([V(sx * 0.22, -0.12, -0.35), V(sx * 0.3, -0.2, -0.62), V(sx * 0.12, -0.26, -0.82)], (t) => 0.07 * (1 - t * 0.8), 6, 5), { color: 0x0e121c }));
    for (const ey of [0.06, 0.15]) head.push(paint(new THREE.IcosahedronGeometry(0.035, 0).translate(sx * (0.16 + ey * 0.3), ey, -0.48), { color: 0xffffff, emit: glow(EYE, 5) }));
  }
  head.push(paint(blob(0.16, 0.12, 0.08, 1, 0.1, 4, 14).translate(0, -0.05, -0.5), { color: 0x000000, emit: glow(color, 3.2) }));
  out.head = merge(head);
  const limb = (len: number, r0: number, r1: number, seed: number) =>
    paint(tube([V(0, 0, 0), V(0, -len * 0.5, 0.06), V(0, -len, 0)], (t) => r0 + (r1 - r0) * t, 6, 7), { color: shellColor, vein: 0.7, phase: seed });
  out.upper = limb(0.6, 0.28, 0.2, 31);
  const lower = limb(0.6, 0.19, 0.26, 32);
  out.lower = merge([lower, paint(new THREE.CylinderGeometry(0.32, 0.36, 0.12, 8).translate(0, -0.62, 0), { color: 0x0f1320 })]);
  return out;
}

// Explorer: the other players

export class Explorer extends Base {
  kind = "explorer" as const;
  hipY = 1.0;
  private legs: THREE.Group[] = [];
  private gun = new THREE.Group();

  constructor() {
    super();
    const g = parts("explorer", explorerParts);
    const S = this.skin;
    this.body.position.y = this.hipY;
    this.body.add(mesh(g.torso, S));
    this.gun.position.set(0.28, 0.32, -0.25);
    this.gun.add(mesh(g.gun, S));
    const tip = new THREE.Object3D();
    tip.position.set(0, 0, -0.55);
    this.gun.add(tip);
    this.muzzles.push(tip);
    this.body.add(this.gun);
    for (const x of [-0.13, 0.13]) {
      const hip = new THREE.Group();
      hip.position.set(x, 0, 0);
      hip.add(mesh(g.leg, S));
      this.body.add(hip);
      this.legs.push(hip);
    }
  }

  fire() { this.gun.position.z = -0.17; }

  update(dt: number, speed: number) {
    const amp = Math.min(1, speed / 6);
    this.phase += dt * (2 + speed * 1.3);
    this.legs.forEach((l, i) => { l.rotation.x = Math.sin(this.phase + i * Math.PI) * 0.6 * amp; });
    this.body.position.y = this.hipY + Math.abs(Math.sin(this.phase)) * 0.04 * amp;
    this.gun.position.z += (-0.25 - this.gun.position.z) * Math.min(1, dt * 10);
    this.glowUpdate(dt);
  }

  collapse(k: number) {
    this.body.rotation.x = k * 1.35;
    this.body.position.y = this.hipY - k * 0.7;
    this.skin.userData.u.glow.value = 1 - k;
  }
}

function explorerParts(): Record<string, THREE.BufferGeometry> {
  const suit = (p: THREE.Vector3) => C(0x1d2a3a).lerp(C(0x2f4a52), noise(p.x * 6, p.y * 6, p.z * 6, 2) * 0.5);
  const torso: THREE.BufferGeometry[] = [];
  torso.push(paint(blob(0.24, 0.34, 0.17, 1, 0.08, 3, 1).translate(0, 0.32, 0), { color: suit, emit: (p) => glow(PALETTE.cyan, smoothstep(0.015, 0, Math.abs(p.x)) * 1.2) }));
  torso.push(paint(blob(0.15, 0.17, 0.16, 1, 0.05, 3, 2).translate(0, 0.78, 0), { color: 0x16202c }));
  torso.push(paint(blob(0.11, 0.045, 0.04, 1, 0, 1, 3).translate(0, 0.79, -0.15), { color: 0xffffff, emit: glow(PALETTE.cyan, 3.2) }));
  torso.push(paint(blob(0.15, 0.22, 0.1, 1, 0.1, 3, 4).translate(0, 0.4, 0.2), { color: 0x14202a }));
  torso.push(paint(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8).translate(0.09, 0.42, 0.3), { color: 0x0d3a36, emit: glow(PALETTE.turquoise, 2) }));
  const leg = paint(tube([V(0, 0, 0), V(0, -0.5, -0.04), V(0, -0.98, 0.02)], (t) => 0.075 - t * 0.02, 6, 6), { color: suit });
  const gun: THREE.BufferGeometry[] = [];
  gun.push(paint(tube([V(0, 0, 0.2), V(0, 0.02, -0.15), V(0, 0, -0.5)], (t) => 0.05 - t * 0.02, 6, 6), { color: 0x141826, emit: (p) => glow(PALETTE.cyan, smoothstep(0.02, 0, Math.abs(p.x + p.y * 0.3)) * 2) }));
  return { torso: merge(torso), leg, gun: merge(gun) };
}

export function createCreature(kind: Kind, color: number): Striker | Sentinel {
  return kind === "striker" ? new Striker(color) : new Sentinel(color);
}

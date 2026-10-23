// Procedural mecha. Each model faces -z with its feet at y = 0.
//   Striker:  a fast humanoid assault frame, cream armor in its swarm's color
//   Sentinel: a heavy siege frame, navy and warm gray with shoulder cannons
// Allies (other players) are Strikers in the player's cyan livery.
// Part geometry is built once per kind and livery, then shared; each mech has
// its own materials so it can flash, glow and charge on its own.
import * as THREE from "three";
import type { Kind } from "./protocol";
import { PALETTE, type ToonMaterial, cylinder, glow, merge as mergeAll, outline, paint, plate, prism, smoothstep, toonMaterial } from "./kit";

const { cream: CREAM, navy: NAVY, gold: GOLD, cyan: CYAN, gray: GRAY, orange: ORANGE } = PALETTE;

export interface Organism {
  root: THREE.Group;
  kind: Kind | "ally";
  /** Height of the body's center, for effects. */
  hipY: number;
  /** How bright the markings burn (dim for an ambush). */
  marking: number;
  update(dt: number, speed: number, mode?: string): void;
  hit(): void;
  fire(): void;
  signal(): void;
  muzzle(i: number, out: THREE.Vector3): THREE.Vector3;
  /** The last moments before destruction, from 0 to 1. */
  collapse(k: number): void;
  /** The armor meshes, which fly apart when the mech is destroyed. */
  panels(): THREE.Mesh[];
  dispose(): void;
}

type Parts = Record<string, THREE.BufferGeometry>;
const cache = new Map<string, Parts>();
const shared = (key: string, build: () => Parts) => cache.get(key) ?? cache.set(key, build()).get(key)!;

// A chevron over each enemy's head, a constant size on screen: readable at any range.
const chevron = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.beginPath(); g.moveTo(6, 14); g.lineTo(58, 14); g.lineTo(32, 52); g.closePath();
  g.lineWidth = 9; g.strokeStyle = "#0b1220"; g.stroke();
  g.fillStyle = "#ffffff"; g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const flameGeo = new THREE.ConeGeometry(0.07, 0.5, 6, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.25);
const flameMat = new THREE.MeshBasicMaterial({ color: glow(0xbff6ff, 2.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

abstract class Mech implements Organism {
  root = new THREE.Group();
  body = new THREE.Group();
  armor: ToonMaterial = toonMaterial();
  marking = 1;
  abstract kind: Kind | "ally";
  abstract hipY: number;
  protected meshes: THREE.Mesh[] = [];
  protected muzzles: THREE.Object3D[] = [];
  protected flames: THREE.Mesh[] = [];
  protected thrust = 0;
  protected markNow = 1;
  protected hitT = 0;
  protected signalT = 0;
  protected recoil = 0;
  protected phase = Math.random() * 6;
  protected last = new THREE.Vector3();
  protected fwd = 0;
  protected lat = 0;
  private marker?: THREE.Sprite;
  private markerColor = new THREE.Color();
  private shotT = 0;

  constructor() {
    this.root.add(this.body);
  }

  /** Mark this mech as hostile, with a chevron in `color` above `height`. */
  protected mark(color: number, height: number) {
    this.markerColor.setHex(color);
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: chevron, color, sizeAttenuation: false, depthWrite: false }));
    this.marker.scale.setScalar(0.042);
    this.marker.position.y = height;
    this.root.add(this.marker);
  }

  /** An outlined, shadow-casting armor part. */
  protected part(g: THREE.BufferGeometry, parent: THREE.Object3D, x = 0, y = 0, z = 0, mat: THREE.Material = this.armor) {
    const m = outline(new THREE.Mesh(g, mat), 0.0036);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    this.meshes.push(m);
    return m;
  }

  protected flame(parent: THREE.Object3D, x: number, y: number, z: number, scale = 1) {
    const f = new THREE.Mesh(flameGeo, flameMat);
    f.position.set(x, y, z);
    f.scale.setScalar(0.001);
    f.userData.size = scale;
    parent.add(f);
    this.flames.push(f);
  }

  hit() { this.hitT = 1; }
  signal() { this.signalT = 1; }
  fire() { this.recoil = 1; this.shotT = 1; }
  panels() { return this.meshes; }

  muzzle(i: number, out: THREE.Vector3) {
    return this.muzzles[i % this.muzzles.length].getWorldPosition(out);
  }

  /** Track the mech's own motion, so legs can follow travel while the torso aims. */
  protected motion(dt: number) {
    const p = this.root.position;
    if (this.last.lengthSq() === 0) this.last.copy(p);
    const vx = (p.x - this.last.x) / Math.max(dt, 1e-3), vz = (p.z - this.last.z) / Math.max(dt, 1e-3);
    this.last.copy(p);
    const yaw = this.root.rotation.y;
    const f = vx * -Math.sin(yaw) + vz * -Math.cos(yaw), l = vx * Math.cos(yaw) + vz * -Math.sin(yaw);
    const k = Math.min(1, dt * 8);
    this.fwd += (f - this.fwd) * k;
    this.lat += (l - this.lat) * k;
  }

  protected common(dt: number, thrustWanted: number) {
    this.hitT = Math.max(0, this.hitT - dt * 5);
    this.signalT = Math.max(0, this.signalT - dt * 1.2);
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.thrust += (thrustWanted - this.thrust) * Math.min(1, dt * 10);
    this.markNow += (this.marking - this.markNow) * Math.min(1, dt * 3);
    const flick = 0.85 + Math.random() * 0.3;
    for (const f of this.flames) f.scale.set(this.thrust * f.userData.size, this.thrust * f.userData.size, this.thrust * f.userData.size * flick + 0.001);
    // The chevron flashes white and swells as the mech fires; it hides in an ambush.
    this.shotT = Math.max(0, this.shotT - dt * 4);
    if (this.marker) {
      this.marker.visible = this.marking > 0.5;
      this.marker.material.color.copy(this.markerColor).lerp(new THREE.Color(0xffffff), this.shotT);
      this.marker.scale.setScalar(0.042 * (1 + this.shotT * 0.6));
    }
    const u = this.armor.userData.u;
    u.glow.value = this.markNow * (1 + Math.max(0, Math.sin(this.signalT * Math.PI * 3)) * 2.5 * this.signalT);
    u.flash.value.setRGB(this.hitT * 1.4, this.hitT * 1.4, this.hitT * 1.3);
  }

  abstract update(dt: number, speed: number, mode?: string): void;

  collapse(k: number) {
    // Shuddering, the reactor flaring white before it goes.
    this.body.position.x = (Math.random() - 0.5) * 0.08 * (1 - k);
    this.armor.userData.u.flash.value.setRGB(1.5 * k, 1.2 * k, 0.8 * k);
    this.armor.userData.u.glow.value = 1 + k * 4;
  }

  dispose() {
    this.armor.dispose();
  }
}

// Striker: the assault frame

interface Leg { thigh: THREE.Group; knee: THREE.Group; ankle: THREE.Group; side: number }

export class Striker extends Mech {
  kind: Kind | "ally" = "striker";
  hipY = 1.04;
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private legs: Leg[] = [];
  private arms: { shoulder: THREE.Group; elbow: THREE.Group; side: number }[] = [];
  private stride = 1;
  private crouch = 0;
  private aim = 0;
  private guard = 0;

  constructor(accent: number, ally = false) {
    super();
    if (ally) this.kind = "ally";
    else this.mark(accent, 2.35);
    const g = shared(`striker:${accent}:${ally}`, () => strikerParts(accent, ally));
    this.body.add(this.hips, this.torso);
    this.hips.position.y = this.hipY;
    this.part(g.pelvis, this.hips);
    for (const side of [-1, 1]) {
      const thigh = new THREE.Group();
      thigh.position.set(side * 0.14, -0.06, 0);
      this.part(g.thigh, thigh);
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      this.part(g.shin, knee);
      const ankle = new THREE.Group();
      ankle.position.y = -0.48;
      this.part(g.foot, ankle);
      knee.add(ankle);
      thigh.add(knee);
      this.hips.add(thigh);
      this.legs.push({ thigh, knee, ankle, side });
    }
    this.torso.position.y = this.hipY + 0.06;
    this.part(g.chest, this.torso);
    for (const side of [-1, 1]) this.flame(this.torso, side * 0.1, 0.32, 0.37);
    this.head.position.set(0, 0.66, -0.02);
    this.part(g.head, this.head);
    this.torso.add(this.head);
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.4, 0.46, 0);
      this.part(side < 0 ? g.pauldronL : g.pauldronR, shoulder);
      const elbow = new THREE.Group();
      elbow.position.y = -0.3;
      this.part(side > 0 ? g.foreR : g.foreL, elbow);
      if (side > 0) {
        const tip = new THREE.Object3D();
        tip.position.set(0, -0.28, -0.62);
        elbow.add(tip);
        this.muzzles.push(tip);
      }
      shoulder.add(elbow);
      this.torso.add(shoulder);
      this.arms.push({ shoulder, elbow, side });
    }
  }

  update(dt: number, speed: number, mode?: string) {
    this.motion(dt);
    const amp = Math.min(1, speed / 5.5);
    // Legs turn toward the direction of travel; the torso keeps aiming.
    let dir = speed > 0.6 ? Math.atan2(this.lat, this.fwd) : 0;
    let cycle = 1;
    if (Math.abs(dir) > Math.PI / 2) { dir -= Math.PI * Math.sign(dir); cycle = -1; }
    this.stride += (cycle - this.stride) * Math.min(1, dt * 6);
    this.hips.rotation.y += (-dir * 0.9 - this.hips.rotation.y) * Math.min(1, dt * 8);
    this.phase += dt * (3 + speed * 1.15) * this.stride;
    const p = this.phase;
    const stalk = mode === "hold" ? 1 : 0;
    this.crouch += (stalk - this.crouch) * Math.min(1, dt * 4);
    const firing = mode === "assault" || mode === "suppress" || mode === "fallback" || mode === "rush";
    this.aim += ((firing || this.signalT > 0 ? 1 : 0) - this.aim) * Math.min(1, dt * 6);
    this.guard += ((mode === "retreat" || mode === "regroup" ? 1 : 0) - this.guard) * Math.min(1, dt * 5);
    const c = this.crouch, h = this.hitT;
    this.body.position.y = Math.abs(Math.sin(p)) * 0.06 * amp - c * 0.16;
    for (const l of this.legs) {
      const s = Math.sin(p + (l.side > 0 ? Math.PI : 0));
      l.thigh.rotation.x = s * 0.75 * amp + c * 0.5;
      l.knee.rotation.x = -Math.max(0, Math.sin(p + (l.side > 0 ? Math.PI : 0) + 1.4)) * 1.2 * amp - c * 1.0;
      l.ankle.rotation.x = -(l.thigh.rotation.x + l.knee.rotation.x) * 0.7;
    }
    // A forward lean when running, a bank into strafes, a jolt when hit or firing.
    this.torso.rotation.x = -0.16 * amp + h * 0.3 + this.recoil * 0.08 - c * 0.1;
    this.torso.rotation.z = THREE.MathUtils.clamp(-this.lat * 0.03, -0.22, 0.22);
    this.torso.rotation.y = Math.sin(p) * 0.08 * amp;
    this.head.rotation.x = -this.torso.rotation.x * 0.6;
    for (const a of this.arms) {
      const right = a.side > 0;
      const ready = right ? -0.55 - this.aim * 0.75 : -0.35 - this.guard * 1.0;
      a.shoulder.rotation.x = ready + Math.sin(p + (right ? 0 : Math.PI)) * 0.3 * amp * (1 - this.aim * (right ? 1 : 0)) + (right ? this.recoil * 0.25 : 0);
      a.elbow.rotation.x = right ? -0.9 + this.aim * 0.75 : -1.1 - this.guard * 0.4;
      a.shoulder.rotation.z = a.side * (0.08 + this.guard * (right ? 0 : 0.3));
    }
    // Thrusters for flanks, rushes, retreats and sudden sidesteps.
    const boosting = mode === "flank" || mode === "rush" || mode === "retreat" || Math.abs(this.lat) > 5.5;
    this.common(dt, boosting ? 1 : 0);
  }
}

function strikerParts(swarm: number, ally: boolean): Parts {
  // Enemies wear their swarm's color as the main armor, cream as the second;
  // allies are mostly cream with the player's cyan.
  const primary = ally ? CREAM : swarm, accent = ally ? swarm : CREAM;
  const joint = ally ? 0x31445e : NAVY, visor = ally ? GOLD : CYAN;
  const one = (g: THREE.BufferGeometry, color: number, emit?: THREE.Color) => paint(g, { color, emit });
  const p: Parts = {};
  p.pelvis = mergeAll([
    one(plate(0.36, 0.18, 0.24), joint),
    one(plate(0.17, 0.18, 0.08, { top: 1.3 }).translate(0, -0.07, -0.14), primary),
    one(plate(0.1, 0.26, 0.22, { top: 0.8 }).rotateZ(-0.2).translate(-0.23, -0.08, 0), accent),
    one(plate(0.1, 0.26, 0.22, { top: 0.8 }).rotateZ(0.2).translate(0.23, -0.08, 0), accent),
    one(plate(0.24, 0.2, 0.07).translate(0, -0.06, 0.13), primary),
  ]);
  p.thigh = mergeAll([
    one(plate(0.15, 0.42, 0.17).translate(0, -0.2, 0), joint),
    one(plate(0.17, 0.3, 0.07, { top: 1.15 }).translate(0, -0.2, -0.09), primary),
  ]);
  p.shin = mergeAll([
    one(prism([[-0.06, 0.06], [0.06, 0.06], [0.08, -0.04], [0, -0.12], [-0.08, -0.04]], 0.12).rotateY(Math.PI / 2).rotateX(-0.2).translate(0, -0.02, -0.11), accent),
    one(plate(0.2, 0.46, 0.25, { top: 1.15, topD: 1.05 }).translate(0, -0.25, 0.01), primary),
    one(plate(0.06, 0.34, 0.03).translate(0, -0.26, -0.12), accent),
    one(plate(0.13, 0.18, 0.08).translate(0, -0.38, 0.13), joint),
  ]);
  p.foot = mergeAll([
    one(plate(0.18, 0.1, 0.36, { top: 0.75, shear: -0.03 }).translate(0, -0.03, -0.05), joint),
    one(plate(0.17, 0.06, 0.12, { top: 0.6 }).translate(0, 0.0, -0.17), primary),
  ]);
  p.chest = mergeAll([
    one(cylinder(0.1, 0.12, 0.16, 8).translate(0, 0.08, 0), joint),
    one(plate(0.26, 0.15, 0.2).translate(0, 0.2, 0), joint),
    one(plate(0.5, 0.34, 0.32, { top: 1.18, topD: 0.92, shear: 0.02 }).translate(0, 0.42, 0), primary),
    one(plate(0.13, 0.11, 0.05, { top: 0.7 }).translate(-0.13, 0.4, -0.17), accent),
    one(plate(0.13, 0.11, 0.05, { top: 0.7 }).translate(0.13, 0.4, -0.17), accent),
    one(plate(0.24, 0.07, 0.06).translate(0, 0.56, -0.15), GOLD),
    one(plate(0.1, 0.12, 0.05, { top: 0.4 }).translate(0, 0.32, -0.17), joint),
    // The backpack and its twin thruster nozzles.
    one(plate(0.36, 0.32, 0.17).translate(0, 0.42, 0.22), joint),
    one(cylinder(0.055, 0.075, 0.14, 8).rotateX(Math.PI / 2).translate(-0.1, 0.32, 0.32), 0x1b2433),
    one(cylinder(0.055, 0.075, 0.14, 8).rotateX(Math.PI / 2).translate(0.1, 0.32, 0.32), 0x1b2433),
    one(plate(0.08, 0.3, 0.06, { top: 0.4 }).rotateX(0.5).translate(-0.12, 0.62, 0.26), accent),
    one(plate(0.08, 0.3, 0.06, { top: 0.4 }).rotateX(0.5).translate(0.12, 0.62, 0.26), accent),
  ]);
  // The head: a raked helmet, a mono-eye visor slit and a gold V-fin.
  p.head = mergeAll([
    one(cylinder(0.05, 0.06, 0.08, 6).translate(0, -0.05, 0), joint),
    one(plate(0.2, 0.15, 0.22, { top: 0.78, topD: 0.85, shear: 0.02 }).translate(0, 0.05, 0), primary),
    one(plate(0.13, 0.08, 0.06, { top: 0.6 }).translate(0, -0.01, -0.11), joint),
    one(plate(0.15, 0.03, 0.025).translate(0, 0.03, -0.125), 0xffffff, glow(visor, 3)),
    one(plate(0.03, 0.17, 0.02, { top: 0.4 }).rotateZ(0.62).translate(-0.05, 0.13, -0.1), GOLD),
    one(plate(0.03, 0.17, 0.02, { top: 0.4 }).rotateZ(-0.62).translate(0.05, 0.13, -0.1), GOLD),
    one(plate(0.04, 0.06, 0.04).translate(0, 0.09, -0.1), accent),
    one(plate(0.02, 0.14, 0.02).rotateX(-0.6).translate(0, 0.16, 0.1), joint),
  ]);
  // Shoulders: big geometric pauldrons.
  const pauldron = (side: number) => mergeAll([
    one(prism([[-0.15, 0.12], [0.13, 0.15], [0.19, 0.0], [0.12, -0.13], [-0.14, -0.1]], 0.34, 0.03).rotateZ(side < 0 ? Math.PI : 0).translate(side * 0.04, 0.03, 0), accent),
    one(plate(0.04, 0.24, 0.3).translate(side * 0.2, 0.02, 0), primary),
    one(plate(0.12, 0.12, 0.12).translate(-side * 0.02, -0.02, 0), joint),
    one(plate(0.11, 0.28, 0.12).translate(0, -0.16, 0), joint),
  ]);
  p.pauldronL = pauldron(-1);
  p.pauldronR = pauldron(1);
  const fore = (side: number) => [
    one(plate(0.15, 0.3, 0.16, { top: 1.12 }).translate(0, -0.14, 0), primary),
    one(plate(0.16, 0.06, 0.17).translate(0, -0.02, 0), accent),
    one(plate(0.1, 0.09, 0.1).translate(0, -0.33, 0), joint),
    ...(side < 0 ? [one(plate(0.05, 0.42, 0.26, { top: 0.8 }).translate(-0.1, -0.16, -0.02), accent)] : []),
  ];
  // The right hand carries a beam rifle.
  p.foreR = mergeAll([
    ...fore(1),
    one(plate(0.08, 0.12, 0.48).translate(0, -0.3, -0.26), joint),
    one(plate(0.1, 0.07, 0.26).translate(0, -0.24, -0.2), primary),
    one(cylinder(0.025, 0.03, 0.22, 6).rotateX(Math.PI / 2).translate(0, -0.28, -0.56), joint),
    one(plate(0.05, 0.04, 0.04).translate(0, -0.28, -0.66), 0xffffff, glow(ally ? swarm : GOLD, 2.4)),
  ]);
  p.foreL = mergeAll(fore(-1));
  return p;
}

// Sentinel: the siege frame

export class Sentinel extends Mech {
  kind = "sentinel" as const;
  hipY = 1.52;
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private cannons = new THREE.Group();
  private legs: Leg[] = [];
  private arms: THREE.Group[] = [];
  private charge = 0;
  private chargeMat: ToonMaterial = toonMaterial();
  private core: THREE.Mesh;

  constructor(accent: number) {
    super();
    this.mark(accent, 3.55);
    const g = shared(`sentinel:${accent}`, () => sentinelParts(accent));
    this.body.add(this.hips, this.torso);
    this.hips.position.y = this.hipY;
    this.part(g.pelvis, this.hips);
    for (const side of [-1, 1]) {
      const thigh = new THREE.Group();
      thigh.position.set(side * 0.44, -0.05, 0);
      this.part(g.thigh, thigh);
      const knee = new THREE.Group();
      knee.position.y = -0.64;
      this.part(g.shin, knee);
      const ankle = new THREE.Group();
      ankle.position.y = -0.68;
      this.part(g.foot, ankle);
      knee.add(ankle);
      thigh.add(knee);
      this.hips.add(thigh);
      this.legs.push({ thigh, knee, ankle, side });
    }
    this.torso.position.y = this.hipY + 0.08;
    this.part(g.chest, this.torso);
    this.core = this.part(g.core, this.torso, 0, 0, 0, this.chargeMat);
    this.torso.add(this.cannons);
    this.part(g.cannons, this.cannons);
    this.part(g.muzzles, this.cannons, 0, 0, 0, this.chargeMat);
    for (const sx of [-1.07, -0.89, 0.89, 1.07]) {
      const tip = new THREE.Object3D();
      tip.position.set(sx, 1.26, -1.12);
      this.cannons.add(tip);
      this.muzzles.push(tip);
    }
    for (const side of [-1, 1]) this.flame(this.torso, side * 0.35, 0.5, 0.62, 1.8);
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 1.02, 0.62, 0);
      this.part(g.upperArm, shoulder);
      const elbow = new THREE.Group();
      elbow.position.y = -0.5;
      this.part(g.forearm, elbow);
      shoulder.add(elbow);
      this.torso.add(shoulder);
      this.arms.push(shoulder);
    }
  }

  fire() {
    super.fire();
    this.charge = 0;
  }

  update(dt: number, speed: number, mode?: string) {
    this.motion(dt);
    const amp = Math.min(1, speed / 2.6);
    this.phase += dt * (1.4 + speed * 0.6);
    this.charge += dt;
    const p = this.phase, h = this.hitT;
    // Heavy footfalls: the whole frame drops as each foot lands.
    this.body.position.y = -Math.abs(Math.cos(p)) * 0.09 * amp;
    for (const l of this.legs) {
      const s = Math.sin(p + (l.side > 0 ? Math.PI : 0));
      l.thigh.rotation.x = s * 0.36 * amp;
      l.knee.rotation.x = -Math.max(0, Math.sin(p + (l.side > 0 ? Math.PI : 0) + 1.2)) * 0.55 * amp;
      l.ankle.rotation.x = -(l.thigh.rotation.x + l.knee.rotation.x) * 0.8;
    }
    this.torso.rotation.z = Math.sin(p) * 0.05 * amp;
    this.torso.rotation.x = h * 0.12 + this.recoil * 0.1;
    this.cannons.position.z = this.recoil * 0.22;
    this.arms.forEach((a, i) => { a.rotation.x = Math.sin(p + i * Math.PI) * 0.18 * amp - 0.1; });
    // The cannons charge between volleys: dim after a shot, blazing as the next comes due.
    const ready = smoothstep(1.2, 3.0, this.charge);
    const cu = this.chargeMat.userData.u;
    cu.glow.value = 0.35 + ready * 2.2 + Math.max(0, 1 - this.charge * 6) * 3 + this.signalT * 2;
    this.core.scale.setScalar(1 + ready * 0.06 * Math.sin(this.charge * 18));
    this.common(dt, mode === "retreat" || mode === "rush" ? 1 : 0);
  }

  dispose() {
    super.dispose();
    this.chargeMat.dispose();
  }
}

function sentinelParts(accent: number): Parts {
  const one = (g: THREE.BufferGeometry, color: number, emit?: THREE.Color) => paint(g, { color, emit });
  const p: Parts = {};
  p.pelvis = mergeAll([
    one(plate(0.9, 0.34, 0.6), NAVY),
    one(plate(0.4, 0.3, 0.12, { top: 1.3 }).translate(0, -0.1, -0.33), GRAY),
    one(plate(0.2, 0.42, 0.5, { top: 0.8 }).rotateZ(-0.18).translate(-0.56, -0.12, 0), GRAY),
    one(plate(0.2, 0.42, 0.5, { top: 0.8 }).rotateZ(0.18).translate(0.56, -0.12, 0), GRAY),
  ]);
  p.thigh = mergeAll([
    one(plate(0.34, 0.64, 0.38).translate(0, -0.31, 0), NAVY),
    one(plate(0.4, 0.46, 0.14, { top: 1.12 }).translate(0, -0.3, -0.2), GRAY),
    one(plate(0.08, 0.3, 0.02).translate(-0.12, -0.3, -0.27), ORANGE),
  ]);
  p.shin = mergeAll([
    one(prism([[-0.16, 0.12], [0.16, 0.12], [0.2, -0.04], [0, -0.24], [-0.2, -0.04]], 0.24).rotateY(Math.PI / 2).rotateX(-0.2).translate(0, -0.02, -0.26), ORANGE),
    one(plate(0.5, 0.7, 0.54, { top: 1.12, topD: 1.06 }).translate(0, -0.36, 0.02), GRAY),
    one(plate(0.1, 0.5, 0.03).translate(0.14, -0.38, -0.26), accent),
    one(plate(0.34, 0.24, 0.12).translate(0, -0.5, 0.29), NAVY),
  ]);
  p.foot = mergeAll([
    one(plate(0.52, 0.18, 0.8, { top: 0.82, shear: -0.04 }).translate(0, -0.05, -0.08), NAVY),
    one(plate(0.5, 0.1, 0.24, { top: 0.6 }).translate(0, 0.02, -0.4), GRAY),
  ]);
  p.chest = mergeAll([
    one(plate(0.64, 0.3, 0.5).translate(0, 0.15, 0), NAVY),
    one(plate(1.34, 0.86, 0.96, { top: 1.12, topD: 0.9, shear: 0.04 }).translate(0, 0.62, 0.02), GRAY),
    one(plate(1.0, 0.5, 0.1, { top: 1.1 }).translate(0, 0.6, -0.48), NAVY),
    one(plate(0.5, 0.08, 0.06).translate(0, 0.95, -0.46), ORANGE),
    // Shoulders: very broad blocks with the swarm's stripe.
    one(plate(0.64, 0.56, 0.8, { top: 0.9 }).translate(-1.0, 0.86, 0), accent),
    one(plate(0.64, 0.56, 0.8, { top: 0.9 }).translate(1.0, 0.86, 0), accent),
    one(plate(0.66, 0.12, 0.82).translate(-1.0, 0.98, 0), GRAY),
    one(plate(0.66, 0.12, 0.82).translate(1.0, 0.98, 0), GRAY),
    one(plate(0.12, 0.3, 0.04).translate(-1.15, 0.78, -0.41), ORANGE),
    one(plate(0.12, 0.3, 0.04).translate(1.15, 0.78, -0.41), ORANGE),
    // A low sensor head between the shoulders.
    one(plate(0.38, 0.26, 0.36, { top: 0.8 }).translate(0, 1.1, -0.2), NAVY),
    one(plate(0.3, 0.04, 0.03).translate(0, 1.12, -0.39), 0xffffff, glow(ORANGE, 3)),
    // Exhausts on the back.
    one(plate(0.9, 0.5, 0.26).translate(0, 0.55, 0.56), NAVY),
    one(cylinder(0.11, 0.14, 0.2, 8).rotateX(Math.PI / 2).translate(-0.35, 0.5, 0.72), 0x1b2433),
    one(cylinder(0.11, 0.14, 0.2, 8).rotateX(Math.PI / 2).translate(0.35, 0.5, 0.72), 0x1b2433),
  ]);
  // The reactor core in its armored frame; it glows with the cannons' charge.
  p.core = mergeAll([
    one(cylinder(0.2, 0.2, 0.08, 6).rotateX(Math.PI / 2).translate(0, 0.6, -0.55), 0xffffff, glow(ORANGE, 2.6)),
    one(cylinder(0.27, 0.27, 0.05, 6).rotateX(Math.PI / 2).translate(0, 0.6, -0.53), GOLD),
  ]);
  // Twin cannons on each shoulder.
  const cannon = (x: number) => [
    one(plate(0.38, 0.34, 0.95).translate(x, 1.26, -0.12), NAVY),
    one(plate(0.4, 0.1, 0.6).translate(x, 1.46, -0.05), GRAY),
    one(cylinder(0.07, 0.08, 0.95, 8).rotateX(Math.PI / 2).translate(x - 0.09, 1.26, -0.62), 0x1b2433),
    one(cylinder(0.07, 0.08, 0.95, 8).rotateX(Math.PI / 2).translate(x + 0.09, 1.26, -0.62), 0x1b2433),
    one(plate(0.04, 0.2, 0.5).translate(x + 0.21, 1.26, -0.1), ORANGE),
  ];
  p.cannons = mergeAll([...cannon(-0.98), ...cannon(0.98)]);
  p.muzzles = mergeAll([-1.07, -0.89, 0.89, 1.07].map((x) => one(cylinder(0.075, 0.075, 0.05, 8).rotateX(Math.PI / 2).translate(x, 1.26, -1.1), 0xffffff, glow(accent, 2.4))));
  p.upperArm = mergeAll([one(plate(0.28, 0.5, 0.3).translate(0, -0.25, 0), NAVY)]);
  p.forearm = mergeAll([
    one(plate(0.5, 0.72, 0.54, { top: 1.18 }).translate(0, -0.36, -0.02), GRAY),
    one(plate(0.52, 0.12, 0.56).translate(0, -0.08, -0.02), accent),
    one(plate(0.3, 0.22, 0.3).translate(0, -0.8, -0.02), NAVY),
    one(plate(0.06, 0.4, 0.03).translate(0.14, -0.38, -0.3), ORANGE),
  ]);
  return p;
}

export function createMech(kind: Kind, color: number): Striker | Sentinel {
  return kind === "striker" ? new Striker(color) : new Sentinel(color);
}


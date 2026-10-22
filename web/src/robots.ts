// Procedural faceted robots. Each model faces -z with its feet at y = 0.
import * as THREE from "three";
import type { Kind } from "./protocol";

const plateMat = (color: number) =>
  new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.32, flatShading: true });

// A frustum with `sides` faces, from radius `bottom` up to `top`.
function frustum(top: number, bottom: number, h: number, sides = 4, sx = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(top, bottom, h, sides, 1);
  if (sides === 4) g.rotateY(Math.PI / 4);
  g.scale(sx, 1, sz);
  return g;
}

// A flat profile in the yz plane (side view), extruded along x.
function profile(points: [number, number][], width: number): THREE.BufferGeometry {
  const s = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false });
  g.translate(0, 0, -width / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  return o;
}

// A faint self-light so silhouettes read against the dark arena.
const BASE_GLOW = new THREE.Color(0x0c0a1c);

interface Leg { hip: THREE.Group; knee: THREE.Group; foot: THREE.Mesh }

export class Robot {
  root = new THREE.Group();
  body = new THREE.Group();
  torso = new THREE.Group();
  legs: Leg[] = [];
  arms: THREE.Group[] = [];
  muzzles: THREE.Object3D[] = [];
  armor: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
  phase = Math.random() * 6;
  flashT = 0;
  recoil = 0;
  hipY: number;
  base: { hip: number; knee: number; stride: number; bob: number; cadence: number };

  constructor(public kind: Kind, color: number) {
    this.armor = plateMat(0x4a4672);
    this.trim = plateMat(0x8a84c0);
    this.glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.6), toneMapped: false });
    this.armor.emissive.copy(BASE_GLOW);
    this.trim.emissive.copy(BASE_GLOW);
    this.root.add(this.body);
    if (kind === "striker") {
      this.hipY = 1.0;
      this.base = { hip: -0.35, knee: 0.7, stride: 0.55, bob: 0.05, cadence: 1.7 };
      this.buildStriker();
    } else {
      this.hipY = 1.36;
      this.base = { hip: -0.25, knee: 0.5, stride: 0.35, bob: 0.07, cadence: 1.15 };
      this.buildSentinel();
    }
    this.root.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = false; });
  }

  private leg(x: number, thigh: number, shin: number, t0: number, t1: number, foot: THREE.BufferGeometry) {
    const hip = new THREE.Group();
    hip.position.set(x, this.hipY, 0);
    hip.add(mesh(frustum(t0, t0 * 0.75, thigh, 4, 1, 1.2), this.armor, 0, -thigh / 2, 0));
    const knee = new THREE.Group();
    knee.position.y = -thigh;
    knee.add(mesh(new THREE.OctahedronGeometry(t0 * 0.85), this.trim));
    knee.add(mesh(frustum(t1 * 0.8, t1, shin, 4, 1, 1.3), this.armor, 0, -shin / 2, 0));
    const stripe = mesh(new THREE.BoxGeometry(0.03, shin * 0.6, 0.03), this.glow, 0, -shin / 2, -t1 * 0.95);
    knee.add(stripe);
    const f = mesh(foot, this.trim, 0, -shin, 0);
    knee.add(f);
    hip.add(knee);
    this.body.add(hip);
    this.legs.push({ hip, knee, foot: f });
  }

  private buildStriker() {
    const A = this.armor, T = this.trim, G = this.glow;
    const foot = profile([[-0.2, 0], [0.1, 0], [0.06, 0.08], [-0.12, 0.06]], 0.14);
    this.leg(-0.16, 0.48, 0.52, 0.12, 0.1, foot);
    this.leg(0.16, 0.48, 0.52, 0.12, 0.1, foot);
    this.body.add(mesh(frustum(0.3, 0.2, 0.2, 4, 1, 0.8), T, 0, this.hipY, 0));

    const t = this.torso;
    t.position.y = this.hipY + 0.08;
    this.body.add(t);
    t.add(mesh(frustum(0.17, 0.21, 0.24, 6), A, 0, 0.12, 0));
    t.add(mesh(frustum(0.5, 0.26, 0.52, 6, 1, 0.66), A, 0, 0.47, 0));
    // Chest plates angled out to a keel.
    for (const s of [-1, 1]) {
      const plate = mesh(profile([[0, -0.2], [0.05, 0.22], [-0.04, 0.26], [-0.08, -0.1]], 0.2), T, s * 0.13, 0.45, -0.2);
      plate.rotation.y = s * 0.35;
      t.add(plate);
    }
    t.add(mesh(new THREE.OctahedronGeometry(0.075), G, 0, 0.42, -0.27));
    for (let i = 0; i < 3; i++) {
      const fin = mesh(profile([[0, 0], [0.32, 0.1], [0.05, 0.28]], 0.03), T, 0, 0.3 + i * 0.13, 0.17);
      fin.rotation.x = -0.2;
      t.add(fin);
    }
    // Head: a forward-pointing wedge with a visor slit.
    const head = new THREE.Group();
    head.position.y = 0.82;
    t.add(head);
    const skull = mesh(new THREE.OctahedronGeometry(0.15), A);
    skull.scale.set(1, 0.75, 1.5);
    head.add(skull);
    head.add(mesh(new THREE.BoxGeometry(0.2, 0.035, 0.04), G, 0, 0.01, -0.19));
    head.add(mesh(profile([[0.18, 0], [-0.05, 0.16], [-0.12, 0.05]], 0.02), T, 0, 0.06, 0));
    // Arms: a blaster on the right, a blade on the left.
    for (const s of [-1, 1]) {
      const pauldron = mesh(new THREE.ConeGeometry(0.2, 0.38, 4), T, s * 0.47, 0.66, 0);
      pauldron.rotation.z = -s * Math.PI / 2.4;
      t.add(pauldron);
      const arm = new THREE.Group();
      arm.position.set(s * 0.44, 0.6, 0);
      arm.add(mesh(new THREE.OctahedronGeometry(0.09), T));
      arm.add(mesh(frustum(0.085, 0.065, 0.3, 4), A, 0, -0.15, 0));
      const fore = new THREE.Group();
      fore.position.y = -0.3;
      fore.add(mesh(new THREE.OctahedronGeometry(0.07), A));
      fore.add(mesh(frustum(0.075, 0.09, 0.38, 4, 1, 1), T, 0, 0, -0.17).rotateX(Math.PI / 2));
      if (s > 0) {
        fore.add(mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.3, 6).rotateX(Math.PI / 2), A, 0, 0.02, -0.46));
        const tip = mesh(new THREE.TorusGeometry(0.045, 0.012, 3, 6), G, 0, 0.02, -0.61);
        fore.add(tip);
        this.muzzles.push(tip);
      } else {
        fore.add(mesh(profile([[0, 0.02], [-0.5, 0], [0, -0.04]], 0.015), G, 0, -0.02, -0.3));
      }
      arm.add(fore);
      arm.rotation.x = 0.15;
      t.add(arm);
      this.arms.push(arm);
    }
  }

  private buildSentinel() {
    const A = this.armor, T = this.trim, G = this.glow;
    const foot = profile([[-0.38, 0], [0.26, 0], [0.2, 0.14], [-0.3, 0.12]], 0.42);
    this.leg(-0.42, 0.7, 0.7, 0.24, 0.24, foot);
    this.leg(0.42, 0.7, 0.7, 0.24, 0.24, foot);
    for (const l of this.legs) {
      const guard = mesh(new THREE.ConeGeometry(0.2, 0.42, 4), T, 0, 0.05, -0.2);
      guard.rotation.x = -Math.PI / 2;
      l.knee.add(guard);
    }
    this.body.add(mesh(frustum(0.6, 0.42, 0.34, 6, 1, 0.8), T, 0, this.hipY + 0.05, 0));

    const t = this.torso;
    t.position.y = this.hipY + 0.15;
    this.body.add(t);
    t.add(mesh(frustum(1.0, 0.68, 1.1, 6, 1, 0.75), A, 0, 0.65, 0));
    // Front armor in two angled slabs, with the core glowing through a slit.
    for (const s of [-1, 1]) {
      const slab = mesh(profile([[0, -0.45], [0.12, 0.42], [-0.05, 0.5], [-0.12, -0.38]], 0.62), T, s * 0.34, 0.62, -0.5);
      slab.rotation.y = s * 0.3;
      t.add(slab);
    }
    t.add(mesh(new THREE.OctahedronGeometry(0.2), G, 0, 0.62, -0.5));
    t.add(mesh(new THREE.BoxGeometry(0.05, 0.8, 0.05), G, 0, 0.62, -0.58));
    // Sunken sensor head with three eyes.
    const head = mesh(frustum(0.28, 0.34, 0.3, 4, 1.2, 1), A, 0, 1.3, -0.25);
    t.add(head);
    for (const x of [-0.12, 0, 0.12]) t.add(mesh(new THREE.OctahedronGeometry(0.04), G, x, 1.32, -0.6));
    // Shoulder cannon pods.
    for (const s of [-1, 1]) {
      const pod = new THREE.Group();
      pod.position.set(s * 1.0, 1.18, 0);
      pod.add(mesh(frustum(0.26, 0.3, 0.9, 4, 1, 0.9).rotateX(Math.PI / 2), A));
      const shell = mesh(profile([[0.5, 0], [-0.5, 0.05], [-0.3, 0.32], [0.35, 0.22]], 0.5), T, 0, 0.18, 0);
      pod.add(shell);
      for (const dx of [-0.1, 0.1]) {
        pod.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.6, 6).rotateX(Math.PI / 2), T, dx, -0.04, -0.7));
        const m = mesh(new THREE.TorusGeometry(0.065, 0.018, 3, 6), G, dx, -0.04, -1.0);
        pod.add(m);
        this.muzzles.push(m);
      }
      pod.add(mesh(new THREE.BoxGeometry(0.04, 0.04, 0.7), G, s * 0.24, 0.05, -0.1));
      t.add(pod);
      this.arms.push(pod);
    }
    // Reactor on the back.
    const reactor = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.3, 6).rotateX(Math.PI / 2), T, 0, 0.8, 0.6);
    t.add(reactor);
    t.add(mesh(new THREE.TorusGeometry(0.22, 0.03, 3, 6), G, 0, 0.8, 0.76));
    for (const s of [-1, 1]) {
      const fin = mesh(profile([[0, 0], [0.55, 0.15], [0.1, 0.5]], 0.04), T, s * 0.4, 1.05, 0.3);
      fin.rotation.z = s * 0.3;
      t.add(fin);
    }
  }

  /** speed in m/s; t is time in seconds. */
  update(dt: number, speed: number) {
    const b = this.base;
    const amp = Math.min(1, speed / (this.kind === "striker" ? 5 : 2.6));
    this.phase += dt * (1 + speed) * b.cadence;
    this.legs.forEach((l, i) => {
      const p = this.phase + i * Math.PI;
      l.hip.rotation.x = b.hip + Math.sin(p) * b.stride * amp;
      l.knee.rotation.x = b.knee + Math.max(0, Math.sin(p + 1.2)) * 0.7 * amp;
      l.foot.rotation.x = -(l.hip.rotation.x + l.knee.rotation.x); // keep the foot level
    });
    this.torso.position.y = this.hipY + (this.kind === "striker" ? 0.08 : 0.15) + Math.abs(Math.sin(this.phase)) * b.bob * amp;
    this.torso.rotation.x = -0.18 * amp;
    this.torso.rotation.z = Math.sin(this.phase) * 0.04 * amp;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    for (const a of this.arms) a.position.z = this.recoil * 0.12;
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt * 6);
      this.armor.emissive.setScalar(this.flashT * 1.5).add(BASE_GLOW);
      this.trim.emissive.setScalar(this.flashT * 1.5).add(BASE_GLOW);
    }
  }

  hit() { this.flashT = 1; }
  fire() { this.recoil = 1; }

  muzzle(i = 0, out = new THREE.Vector3()) {
    return this.muzzles[i % this.muzzles.length].getWorldPosition(out);
  }

  dispose() {
    this.root.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.armor.dispose(); this.trim.dispose(); this.glow.dispose();
  }
}

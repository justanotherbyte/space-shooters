// Swarm gear the LLM strategist calls for: frag grenades, smoke and spike
// traps. The server decides where each lands and what it does; this draws the
// throw, the warning on the ground, and what happens when it goes off.
import * as THREE from "three";
import type { Fx } from "./fx";
import { PALETTE, cylinder, glow, merge, outline, outlineMaterial, outlineNormals, paint, toonMaterial, toonRamp } from "./kit";
import { TICK_MS, type GearKind } from "./protocol";

// As in src/sim.py.
const FRAG_RADIUS = 5;
const SMOKE_HEIGHT = 1.2;
const TRAP_RADIUS = 1.2;
const TRAP_ARM_S = 1;

interface Item {
  kind: GearKind;
  color: number;
  root: THREE.Group;
  canister: THREE.Object3D;
  o: THREE.Vector3 | null; // where it was thrown from, while it flies
  p: THREE.Vector3;
  phase: "fly" | "live" | "out";
  t: number; // seconds into the phase
  dur: number; // the phase's length
  mats: THREE.Material[]; // owned by this item, disposed with it
  ring?: THREE.Mesh; // frag and trap: the danger zone on the ground
  light?: THREE.Mesh; // a blinking beacon
  balls?: { m: THREE.Mesh; at: THREE.Vector3; size: number; delay: number; spin: number }[];
  spikes?: THREE.Group;
  sprung?: boolean;
}

const ballGeo = new THREE.IcosahedronGeometry(1, 3);
outlineNormals(ballGeo);
const beaconGeo = new THREE.SphereGeometry(0.07, 8, 6);
const ringGeo = new THREE.RingGeometry(0.96, 1, 64);
const discGeo = new THREE.CircleGeometry(1, 48);
const spikeGeo = new THREE.ConeGeometry(0.06, 0.55, 4).translate(0, 0.275, 0);
const spikeMat = new THREE.MeshToonMaterial({ color: PALETTE.cream, gradientMap: toonRamp });
const bodyMat = toonMaterial();

export class Gear {
  private items = new Map<number, Item>();
  private canisters = new Map<string, THREE.BufferGeometry>();

  constructor(private scene: THREE.Scene, private fx: Fx) {}

  /** A unit throws gear: it arcs from `o` to `p` over `ticks`. */
  toss(id: number, kind: GearKind, color: number, o: number[], p: number[], ticks: number) {
    const item = this.make(id, kind, color, p);
    item.o = new THREE.Vector3(o[0], o[1], o[2]);
    item.phase = "fly";
    item.dur = (ticks * TICK_MS) / 1000;
    item.canister.position.copy(item.o).sub(item.p);
  }

  /** Gear landed and is live for `ticks`. Also how a joining client learns of gear already down. */
  deploy(id: number, kind: GearKind, color: number, p: number[], ticks: number) {
    const item = this.items.get(id) ?? this.make(id, kind, color, p);
    item.phase = "live";
    item.t = 0;
    item.dur = (ticks * TICK_MS) / 1000;
    item.canister.position.set(0, kind === "trap" ? 0.05 : 0.12, 0);
    item.canister.rotation.set(0, 0, kind === "trap" ? 0 : Math.PI / 2);
    if (kind === "frag") {
      item.ring = this.decal(item, PALETTE.vermilion, FRAG_RADIUS, 0.85);
      item.light = this.beacon(item, 0xff4a2a);
    } else if (kind === "smoke") {
      this.cloud(item);
      this.fx.puffs(item.p.clone().setY(item.p.y + 0.3), 10, 1.6, 0.7, 1.2);
    } else {
      item.ring = this.decal(item, color, TRAP_RADIUS, 0.55);
      item.light = this.beacon(item, color);
      item.spikes = new THREE.Group();
      for (let i = 0; i < 9; i++) {
        const s = new THREE.Mesh(spikeGeo, spikeMat);
        const a = (i / 8) * Math.PI * 2;
        if (i < 8) s.position.set(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
        s.rotation.set(i < 8 ? Math.sin(a) * 0.3 : 0, 0, i < 8 ? -Math.cos(a) * 0.3 : 0);
        item.spikes.add(s);
      }
      item.spikes.scale.set(1, 0.05, 1);
      item.root.add(item.spikes);
    }
  }

  /** Gear is done: a frag bursts, smoke clears, a trap springs on `hit` or folds away. */
  end(id: number, kind: GearKind, p: number[], hit: string | null) {
    const item = this.items.get(id);
    const at = new THREE.Vector3(p[0], p[1], p[2]);
    if (kind === "frag") {
      this.fx.explode(at.setY(at.y + 0.6), 1.3);
      this.fx.ring(at, 0xffe9b0, FRAG_RADIUS, 0.4);
      if (item) this.remove(id);
      return;
    }
    if (!item) return;
    item.phase = "out";
    item.t = 0;
    item.dur = kind === "smoke" ? 0.5 : 0.8;
    if (kind === "trap" && hit) {
      item.sprung = true;
      this.fx.burst(at.setY(at.y + 0.4), PALETTE.gold, 18, 5, 0.4, 2);
      this.fx.flash(at, item.color, 18, 0.2);
    }
  }

  /** The nearest frag, thrown or landed, whose blast would reach `p`. */
  frag(p: THREE.Vector3): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null, bestD = FRAG_RADIUS + 0.5;
    for (const it of this.items.values()) {
      const d = it.p.distanceTo(p);
      if (it.kind === "frag" && it.phase !== "out" && d < bestD) { best = it.p; bestD = d; }
    }
    return best;
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  update(dt: number) {
    const blink = (hz: number) => Math.sin(performance.now() / 1000 * hz * Math.PI * 2) > 0;
    for (const [id, it] of this.items) {
      it.t += dt;
      const k = Math.min(1, it.t / Math.max(it.dur, 1e-3));
      if (it.phase === "fly" && it.o) {
        // A lob: straight-line progress plus a parabola on top.
        const span = it.o.distanceTo(it.p);
        const c = it.canister;
        c.position.lerpVectors(it.o, it.p, k).sub(it.p);
        c.position.y += 4 * (1.2 + span * 0.12) * k * (1 - k);
        c.rotation.x += dt * 9;
        c.rotation.z += dt * 5;
        if (k >= 1) it.o = null; // landed: it waits here for the server's deploy
        continue;
      }
      if (it.phase === "live") {
        const left = it.dur - it.t;
        if (it.kind === "frag" && it.ring && it.light) {
          // The warning tightens as the fuse runs down.
          const hz = 3 + 9 * k;
          it.light.visible = blink(hz);
          (it.ring.material as THREE.MeshBasicMaterial).opacity = it.light.visible ? 0.95 : 0.45;
          const fill = it.ring.children[0] as THREE.Mesh;
          fill.scale.setScalar(Math.max(0.01, k));
        } else if (it.kind === "trap" && it.spikes && it.light) {
          const armed = it.t >= TRAP_ARM_S;
          it.spikes.scale.y = armed ? 0.32 : 0.05 + 0.27 * (it.t / TRAP_ARM_S);
          it.light.visible = !armed || blink(1.4);
        } else if (it.balls) {
          this.billow(it, Math.min(1, left / 1.5));
        }
      }
      if (it.phase === "out") {
        if (it.balls) this.billow(it, 0);
        if (it.spikes) it.spikes.scale.y = it.sprung ? Math.min(1, 0.32 + k * 4) * (1 - Math.max(0, k - 0.6) / 0.4) : 0.32 * (1 - k);
        if (it.ring) (it.ring.material as THREE.MeshBasicMaterial).opacity *= 0.9;
        if (k >= 1) this.remove(id);
      }
    }
  }

  private make(id: number, kind: GearKind, color: number, p: number[]): Item {
    this.remove(id);
    const root = new THREE.Group();
    root.position.set(p[0], p[1], p[2]);
    const canister = outline(new THREE.Mesh(this.canister(kind, color), bodyMat), 0.003, 0x10161f);
    root.add(canister);
    this.scene.add(root);
    const item: Item = { kind, color, root, canister, o: null, p: root.position.clone(), phase: "live", t: 0, dur: 0, mats: [] };
    this.items.set(id, item);
    return item;
  }

  /** A canister: navy with a band in the swarm's color, and a glowing cap that says what it is. */
  private canister(kind: GearKind, color: number) {
    const key = `${kind}-${color}`;
    let g = this.canisters.get(key);
    if (g) return g;
    const cap = kind === "frag" ? PALETTE.gold : kind === "smoke" ? PALETTE.cream : color;
    if (kind === "trap") {
      g = merge([
        paint(cylinder(0.34, 0.4, 0.1, 6).translate(0, 0.05, 0), { color: PALETTE.navy }),
        paint(cylinder(0.41, 0.41, 0.03, 6).translate(0, 0.05, 0), { color, emit: glow(color, 0.6) }),
        paint(cylinder(0.12, 0.12, 0.04, 6).translate(0, 0.12, 0), { color: 0xffffff, emit: glow(color, 1.5) }),
      ]);
    } else {
      const len = kind === "frag" ? 0.26 : 0.36;
      g = merge([
        paint(cylinder(0.1, 0.1, len, 8), { color: kind === "frag" ? PALETTE.navy : PALETTE.cream }),
        paint(cylinder(0.105, 0.105, 0.07, 8), { color }),
        paint(cylinder(0.07, 0.08, 0.05, 8).translate(0, len / 2 + 0.02, 0), { color: 0xffffff, emit: glow(cap, 1.4) }),
      ]);
    }
    this.canisters.set(key, g);
    return g;
  }

  /** A flat ring with a fill disc on the ground, `r` meters across. */
  private decal(it: Item, color: number, r: number, opacity: number) {
    const mat = new THREE.MeshBasicMaterial({ color: glow(color, 1.1), transparent: true, opacity, depthWrite: false, toneMapped: false });
    const fillMat = new THREE.MeshBasicMaterial({ color: glow(color, 1.1), transparent: true, opacity: opacity * 0.22, depthWrite: false, toneMapped: false });
    it.mats.push(mat, fillMat);
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.add(new THREE.Mesh(discGeo, fillMat));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    ring.scale.setScalar(r);
    ring.renderOrder = 2;
    it.root.add(ring);
    return ring;
  }

  private beacon(it: Item, color: number) {
    const mat = new THREE.MeshBasicMaterial({ color: glow(color, 3), toneMapped: false });
    it.mats.push(mat);
    const m = new THREE.Mesh(beaconGeo, mat);
    m.position.y = it.kind === "trap" ? 0.16 : 0.28;
    it.root.add(m);
    return m;
  }

  /** Smoke: big cel-shaded puffs that roll out from the canister and fill the cloud the server tests against. */
  private cloud(it: Item) {
    const tint = new THREE.Color(0xeef2f3).lerp(new THREE.Color(it.color), 0.08);
    // Opaque, and two-sided so a player inside the cloud sees nothing.
    const mat = new THREE.MeshToonMaterial({ color: tint, gradientMap: toonRamp, side: THREE.DoubleSide });
    it.mats.push(mat);
    it.balls = [];
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 3.6;
      const at = new THREE.Vector3(Math.cos(a) * r, SMOKE_HEIGHT + (Math.random() - 0.25) * 3.6 * (1 - r / 5), Math.sin(a) * r);
      const m = new THREE.Mesh(ballGeo, mat);
      m.add(new THREE.Mesh(ballGeo, outlineMaterial(0.0022, 0x9aa7b2)));
      m.scale.setScalar(0.001);
      it.root.add(m);
      it.balls.push({ m, at, size: 1.3 + Math.random() * 1.0, delay: (r / 3.6) * 0.7 + Math.random() * 0.2, spin: Math.random() - 0.5 });
    }
  }

  /** Grow each puff into place, churn it, and shrink it away as `fade` drops to 0. */
  private billow(it: Item, fade: number) {
    const now = performance.now() / 1000;
    for (const b of it.balls!) {
      const grow = Math.min(1, Math.max(0, (it.phase === "live" ? it.t - b.delay : 1) / 0.6));
      const ease = 1 - (1 - grow) ** 3;
      b.m.position.copy(b.at).multiplyScalar(0.3 + 0.7 * ease);
      b.m.position.y += Math.sin(now * 0.8 + b.spin * 9) * 0.15;
      b.m.rotation.y += b.spin * 0.01;
      b.m.scale.setScalar(Math.max(0.001, b.size * ease * Math.sqrt(fade)));
    }
  }

  private remove(id: number) {
    const it = this.items.get(id);
    if (!it) return;
    this.items.delete(id);
    this.scene.remove(it.root);
    for (const m of it.mats) m.dispose(); // outline materials are shared, and stay
  }
}

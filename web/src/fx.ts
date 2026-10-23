// Combat effects in an anime style: spark streaks, angular fragments, layered
// explosions (flash, fireball, speed lines, shockwave, light smoke), bolt
// projectiles and beams. Everything is pooled; Rapier tumbles the fragments.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Organism } from "./mechs";
import { TICK_MS } from "./protocol";
import { canvasTexture, glow, plate, toonRamp } from "./kit";

const additive = (color: THREE.ColorRepresentation, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

/** A pool of instanced particles, each with a position, velocity, life and size. */
class Pool {
  mesh: THREE.InstancedMesh;
  p: Float32Array; v: Float32Array; life: Float32Array; max: Float32Array; size: Float32Array;
  heat: Float32Array; // per particle: how far along its color ramp it starts
  next = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, public n: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) { this.mesh.setMatrixAt(i, zero); this.mesh.setColorAt(i, new THREE.Color(0)); }
    this.p = new Float32Array(n * 3); this.v = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n); this.size = new Float32Array(n);
    this.heat = new Float32Array(n);
  }
  spawn(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, color: THREE.Color, heat = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.p.set([p.x, p.y, p.z], i * 3);
    this.v.set([v.x, v.y, v.z], i * 3);
    this.life[i] = this.max[i] = life;
    this.size[i] = size;
    this.heat[i] = heat;
    this.mesh.setColorAt(i, color);
    this.mesh.instanceColor!.needsUpdate = true;
    return i;
  }
}

interface Bolt { group: THREE.Group; o: THREE.Vector3; v: THREE.Vector3; evTick: number; age: number; color: number; heavy: boolean }
interface Piece { mesh: THREE.Object3D; body: RAPIER.RigidBody; life: number; scale: THREE.Vector3 }
interface Timed { obj: THREE.Object3D; life: number; max: number; tick(o: THREE.Object3D, k: number): void }
interface Dying { org: Organism; t: number; color: number }

export class Fx {
  private sparks: Pool;
  private fire: Pool;
  private smoke: Pool;
  private bolts = new Map<number, Bolt>();
  private pieces: Piece[] = [];
  private timed: Timed[] = [];
  private dying: Dying[] = [];
  private lights: THREE.PointLight[] = [];
  private lightLife: number[] = [];
  private boltGeo = new THREE.OctahedronGeometry(1, 0).scale(1, 1, 4.5);
  private unitBox = new THREE.BoxGeometry(1, 1, 1);
  private shardGeo = plate(1, 0.5, 1.4, { bevel: 0.15, top: 0.6 });
  private shardMats = new Map<number, THREE.MeshToonMaterial>();
  private burstTex: THREE.Texture;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private z = new THREE.Vector3(0, 0, 1);

  constructor(private scene: THREE.Scene, private rapier: RAPIER.World) {
    this.sparks = new Pool(new THREE.OctahedronGeometry(1, 0).scale(0.022, 0.022, 0.09), new THREE.MeshBasicMaterial({ toneMapped: false }), 700);
    this.fire = new Pool(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), 260);
    this.smoke = new Pool(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshToonMaterial({ gradientMap: toonRamp }), 220);
    scene.add(this.sparks.mesh, this.fire.mesh, this.smoke.mesh);
    this.burstTex = canvasTexture(128, 128, (g) => {
      g.translate(64, 64);
      g.fillStyle = "white";
      g.beginPath();
      for (let i = 0; i < 16; i++) {
        const r = i % 2 ? 22 : 64, a = (i / 16) * Math.PI * 2;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.fill();
    });
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 14, 2);
      scene.add(l);
      this.lights.push(l);
      this.lightLife.push(0);
    }
  }

  /** Spark streaks flying out from `p`. */
  burst(p: THREE.Vector3, color: number, n: number, speed: number, life = 0.45, up = 1.5) {
    const c = glow(color, 1.6);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1, r = Math.sqrt(1 - e * e);
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.sparks.spawn(p, this.v.set(Math.cos(a) * r * sp, e * sp + up, Math.sin(a) * r * sp), life * (0.5 + Math.random() * 0.6), 1, c);
    }
  }

  /** Light, puffy smoke: anime smoke balls that swell and shrink away, never dark. */
  puffs(p: THREE.Vector3, n: number, spread: number, size: number, life = 1) {
    for (let k = 0; k < n; k++) {
      const c = new THREE.Color().setScalar(0.82 + Math.random() * 0.15);
      this.smoke.spawn(
        this.s.copy(p).add(this.v.set((Math.random() - 0.5) * spread, Math.random() * spread * 0.4, (Math.random() - 0.5) * spread)),
        this.v.set((Math.random() - 0.5) * spread, 0.6 + Math.random(), (Math.random() - 0.5) * spread),
        life * (0.7 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8), c,
      );
    }
  }

  flash(p: THREE.Vector3, color: number, intensity = 30, life = 0.12) {
    const i = this.lightLife.indexOf(Math.min(...this.lightLife));
    const l = this.lights[i];
    l.position.copy(p);
    l.color.setHex(color);
    l.userData.peak = intensity;
    l.userData.max = life;
    this.lightLife[i] = life;
  }

  /** A burst-shaped flash sprite. */
  private pop(p: THREE.Vector3, color: number, size: number, life: number) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.burstTex, color: glow(color, 2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    s.position.copy(p);
    s.material.rotation = Math.random() * Math.PI;
    this.scene.add(s);
    this.timed.push({ obj: s, life, max: life, tick: (o, k) => { o.scale.setScalar(size * (1.4 - k * 0.6)); (o as THREE.Sprite).material.opacity = k; } });
  }

  /** A flat shockwave ring across the ground. */
  ring(p: THREE.Vector3, color: number, size: number, life = 0.5) {
    // Additive light washes out on pale concrete, so the ring is a solid, thin band instead.
    const m = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 48), new THREE.MeshBasicMaterial({ color: glow(color, 1.1), transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(p).setY(0.06);
    this.scene.add(m);
    this.timed.push({ obj: m, life, max: life, tick: (o, k) => { o.scale.setScalar(size * (1.05 - k * k)); ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = k * 0.8; } });
  }

  /** An anime explosion: flash, fireball, speed lines, shockwave, light smoke. */
  explode(p: THREE.Vector3, size: number) {
    this.pop(p, 0xfff6d8, size * 3.2, 0.14);
    this.flash(p, 0xffb050, 22 * size, 0.3);
    // The fireball: a cluster of flat-shaded balls, white-hot inside, orange at the edges.
    for (let i = 0; i < 9 + size * 6; i++) {
      const r = Math.random();
      const o = this.s.set((Math.random() - 0.5), Math.random() * 0.8, (Math.random() - 0.5)).normalize().multiplyScalar(r * size * 0.9).add(p);
      const heat = r * 0.55; // the outer balls start cooler
      this.fire.spawn(o, this.v.copy(o).sub(p).multiplyScalar(2.5).add(this.s.set(0, 1 + Math.random() * 2, 0)), 0.45 + Math.random() * 0.35, size * (0.75 - r * 0.35), new THREE.Color(1, 1, 1), heat);
    }
    // Speed lines radiating out.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.random() * 0.3, e = (Math.random() - 0.3) * 1.2;
      const dir = this.v.set(Math.cos(a), e, Math.sin(a)).normalize();
      const line = new THREE.Mesh(this.unitBox, additive(glow(0xffe08a, 2.2)));
      line.position.copy(p);
      line.lookAt(p.clone().add(dir));
      this.scene.add(line);
      const d = dir.clone();
      this.timed.push({ obj: line, life: 0.28, max: 0.28, tick: (o, k) => {
        const len = size * 3.6 * (1 - k);
        o.position.copy(p).addScaledVector(d, size * 0.6 + len * 0.6);
        o.scale.set(0.05 * k * size, 0.05 * k * size, len);
      } });
    }
    this.ring(p, 0xffe9b0, size * 5, 0.45);
    this.burst(p, 0xffd27a, 20 + size * 10, 7 * size, 0.6, 2);
    this.puffs(p, 6 + size * 4, size * 1.6, size * 0.7, 1.1);
  }

  /** The player's shot: a beam from muzzle to impact, with a bolt riding it. */
  shot(a: THREE.Vector3, b: THREE.Vector3, color: number) {
    const dist = a.distanceTo(b);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    for (const [w, k, op] of [[0.03, 3.2, 1], [0.1, 1.4, 0.5]] as const) {
      const beam = new THREE.Mesh(this.unitBox, additive(glow(color, k), op));
      beam.position.copy(mid);
      beam.scale.set(w, w, dist);
      beam.lookAt(b);
      this.scene.add(beam);
      this.timed.push({ obj: beam, life: 0.1, max: 0.1, tick: (o, f) => { o.scale.x = o.scale.y = w * f; ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = op * f; } });
    }
    const head = new THREE.Mesh(this.boltGeo, additive(glow(0xffffff, 2.5)));
    head.scale.setScalar(0.05);
    head.position.copy(a);
    head.lookAt(b);
    this.scene.add(head);
    const dir = b.clone().sub(a).normalize(), travel = Math.max(0.04, dist / 280);
    this.timed.push({ obj: head, life: travel, max: travel, tick: (o, k) => { o.position.copy(a).addScaledVector(dir, dist * (1 - k)); } });
  }

  /** Where the player's shot struck something solid. */
  impact(p: THREE.Vector3, color: number) {
    this.pop(p, color, 0.7, 0.1);
    this.burst(p, color, 8, 4, 0.3, 1);
  }

  /** A hit on armor: sparks, a flash, and a chip of plating knocked loose. */
  armorHit(p: THREE.Vector3, armor: number, crit: boolean) {
    this.burst(p, 0xffe9a6, crit ? 18 : 10, crit ? 6 : 4.5, 0.4, 1.2);
    this.pop(p, 0xffffff, crit ? 1.1 : 0.7, 0.08);
    this.chip(p, armor, crit ? 2 : 1, 0.07);
  }

  /** Small armor fragments with physics. */
  private chip(p: THREE.Vector3, color: number, n: number, size: number) {
    let mat = this.shardMats.get(color);
    if (!mat) this.shardMats.set(color, (mat = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp })));
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(this.shardGeo, mat);
      mesh.scale.setScalar(size * (0.7 + Math.random() * 0.6));
      mesh.position.copy(p);
      this.scene.add(mesh);
      this.physics(mesh, size * 0.6, 3 + Math.random() * 3, 1.2 + Math.random());
    }
  }

  private physics(mesh: THREE.Object3D, half: number, kick: number, life: number, from?: THREE.Vector3) {
    const p = mesh.position;
    const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(mesh.quaternion).setLinearDamping(0.3).setAngularDamping(0.5));
    this.rapier.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(0.03, half), Math.max(0.03, half * 0.6), Math.max(0.03, half)).setRestitution(0.35).setFriction(0.8).setDensity(2), body);
    const out = from ? this.v.copy(p).sub(from).normalize() : this.v.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    body.setLinvel({ x: out.x * kick, y: 2.5 + Math.random() * kick, z: out.z * kick }, true);
    body.setAngvel({ x: (Math.random() - 0.5) * 16, y: (Math.random() - 0.5) * 16, z: (Math.random() - 0.5) * 16 }, true);
    this.pieces.push({ mesh, body, life, scale: mesh.scale.clone() });
  }

  /** A mech dropping in on thrusters: dust and sparks where it lands. */
  dropIn(p: THREE.Vector3, color: number) {
    const at = p.clone().setY(0.1);
    this.ring(at, color, 3, 0.6);
    this.puffs(at, 10, 2.2, 0.55, 0.9);
    this.burst(at.clone().setY(0.3), 0xffe2a0, 16, 4, 0.5, 1);
    this.flash(at.clone().setY(1.2), color, 25, 0.3);
  }

  /** Swarm signal: a quick flash at a mech's visor. */
  signal(p: THREE.Vector3, color: number) {
    this.pop(p, color, 0.6, 0.18);
  }

  addBolt(id: number, o: number[], v: number[], color: number, heavy: boolean, evTick: number) {
    const g = new THREE.Group();
    const k = heavy ? 0.13 : 0.08;
    const core = new THREE.Mesh(this.boltGeo, new THREE.MeshBasicMaterial({ color: glow(0xffffff, 2), toneMapped: false }));
    core.scale.setScalar(k * 0.5);
    const shell = new THREE.Mesh(this.boltGeo, additive(glow(color, 2.4), 0.9));
    shell.scale.setScalar(k);
    const trail = new THREE.Mesh(this.unitBox, additive(glow(color, 1.6), 0.6));
    trail.scale.set(k * 0.7, k * 0.7, heavy ? 2.2 : 1.6);
    trail.position.z = (heavy ? 2.2 : 1.6) / 2;
    g.add(core, shell, trail);
    const vel = new THREE.Vector3(...v);
    g.position.set(o[0], o[1], o[2]);
    g.lookAt(this.v.copy(g.position).sub(vel));
    this.scene.add(g);
    this.bolts.set(id, { group: g, o: new THREE.Vector3(...o), v: vel, evTick, age: 0, color, heavy });
  }

  /** A bolt ends: a burst where it struck, unless it hit a player (their screen shows that). */
  endBolt(id: number, p: number[], hitPlayer: boolean) {
    const b = this.bolts.get(id);
    if (!b) return;
    this.scene.remove(b.group);
    for (const m of b.group.children) ((m as THREE.Mesh).material as THREE.Material).dispose();
    this.bolts.delete(id);
    if (hitPlayer) return;
    const at = new THREE.Vector3(...p);
    this.pop(at, b.color, b.heavy ? 1.6 : 0.9, 0.12);
    this.burst(at, b.color, b.heavy ? 14 : 7, 4, 0.35, 1);
    if (b.heavy) this.puffs(at, 3, 0.8, 0.35, 0.7);
  }

  clearBolts() {
    for (const id of [...this.bolts.keys()]) this.endBolt(id, [0, 0, 0], true);
  }

  /** A mech is destroyed: its reactor flares, then it explodes and its armor flies apart. */
  destroy(org: Organism, color: number) {
    this.dying.push({ org, t: 0, color });
  }

  private blowUp(d: Dying) {
    const org = d.org;
    org.root.updateMatrixWorld(true);
    const center = org.root.position.clone().setY(org.root.position.y + org.hipY);
    const big = org.kind === "sentinel";
    this.explode(center, big ? 1.6 : 1);
    if (big) setTimeout(() => this.explode(center.clone().add(new THREE.Vector3(0.6, 0.8, -0.4)), 0.9), 160);
    for (const m of org.panels()) {
      this.scene.attach(m);
      m.geometry.computeBoundingBox();
      const size = m.geometry.boundingBox!.getSize(this.s);
      this.physics(m, Math.max(size.x, size.z) * 0.4, 3 + Math.random() * 4, 1.4 + Math.random() * 0.8, center);
    }
    this.chip(center, d.color, big ? 6 : 3, big ? 0.16 : 0.1);
    this.scene.remove(org.root);
    setTimeout(() => org.dispose(), 3000); // once its flying panels are gone
  }

  update(dt: number, nowTick: number) {
    const sp = this.sparks, f = this.fire, sm = this.smoke;
    // Sparks: streaks stretched along their velocity.
    for (let i = 0; i < sp.n; i++) {
      if (sp.life[i] <= 0) continue;
      sp.life[i] -= dt;
      const k = Math.max(0, sp.life[i] / sp.max[i]);
      sp.v[i * 3 + 1] -= 12 * dt;
      for (let a = 0; a < 3; a++) sp.p[i * 3 + a] += sp.v[i * 3 + a] * dt;
      if (sp.p[i * 3 + 1] < 0.03) { sp.p[i * 3 + 1] = 0.03; sp.v[i * 3 + 1] *= -0.3; }
      this.v.fromArray(sp.v, i * 3);
      const speed = this.v.length();
      this.q.setFromUnitVectors(this.z, this.v.normalize());
      sp.mesh.setMatrixAt(i, this.m4.compose(this.s.fromArray(sp.p, i * 3), this.q, this.v.set(k, k, k * (0.6 + Math.min(2.5, speed * 0.2)))));
    }
    sp.mesh.instanceMatrix.needsUpdate = true;
    // Fireballs: swell, then shrink, cooling from white to yellow to orange.
    const fc = new THREE.Color();
    for (let i = 0; i < f.n; i++) {
      if (f.life[i] <= 0) continue;
      f.life[i] -= dt;
      const k = Math.max(0, f.life[i] / f.max[i]), age = 1 - k;
      for (let a = 0; a < 3; a++) { f.v[i * 3 + a] *= Math.pow(0.08, dt); f.p[i * 3 + a] += f.v[i * 3 + a] * dt; }
      const s = f.size[i] * (age < 0.2 ? age / 0.2 : 1 - Math.pow((age - 0.2) / 0.8, 1.6));
      const t = Math.min(1, age + f.heat[i]);
      fc.setRGB(1, 1, 1).lerp(glow(0xffd25a, 1.3), smoothAge(t, 0.05, 0.3)).lerp(glow(0xff6a2a, 1.1), smoothAge(t, 0.35, 0.8));
      f.mesh.setColorAt(i, fc);
      f.mesh.setMatrixAt(i, this.m4.compose(this.s.fromArray(f.p, i * 3), this.q.identity(), this.v.setScalar(Math.max(0, s))));
    }
    f.mesh.instanceMatrix.needsUpdate = true;
    if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
    // Smoke: rises, swells, then shrinks away.
    for (let i = 0; i < sm.n; i++) {
      if (sm.life[i] <= 0) continue;
      sm.life[i] -= dt;
      const k = Math.max(0, sm.life[i] / sm.max[i]), age = 1 - k;
      for (let a = 0; a < 3; a++) { sm.v[i * 3 + a] *= Math.pow(0.3, dt); sm.p[i * 3 + a] += sm.v[i * 3 + a] * dt; }
      const s = sm.size[i] * Math.sin(Math.min(1, age * 1.2) * Math.PI) * (0.6 + age);
      sm.mesh.setMatrixAt(i, this.m4.compose(this.s.fromArray(sm.p, i * 3), this.q.identity(), this.v.setScalar(Math.max(0, s))));
    }
    sm.mesh.instanceMatrix.needsUpdate = true;

    // Bolts: catch up from where they were fired to the server's present.
    for (const b of this.bolts.values()) {
      b.age += dt;
      const serverAge = Math.max(0, (nowTick - b.evTick) * TICK_MS / 1000);
      const t = Math.min(serverAge, b.age * 1.6);
      b.group.position.copy(b.o).addScaledVector(b.v, t);
    }

    // Dying mechs shudder and flare for a moment, then blow apart.
    this.dying = this.dying.filter((d) => {
      d.t += dt;
      d.org.collapse(Math.min(1, d.t / 0.2));
      if (d.t < 0.2) return true;
      this.blowUp(d);
      return false;
    });

    this.rapier.timestep = Math.min(dt, 1 / 30);
    this.rapier.step();
    this.pieces = this.pieces.filter((p) => {
      p.life -= dt;
      const t = p.body.translation(), r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      if (p.life < 0.4) p.mesh.scale.copy(p.scale).multiplyScalar(Math.max(0.001, p.life / 0.4));
      if (p.life > 0) return true;
      this.scene.remove(p.mesh);
      this.rapier.removeRigidBody(p.body);
      return false;
    });

    this.timed = this.timed.filter((t) => {
      t.life -= dt;
      t.tick(t.obj, Math.max(0, t.life / t.max));
      if (t.life > 0) return true;
      this.scene.remove(t.obj);
      const m = t.obj as THREE.Mesh;
      if (m.geometry && m.geometry !== this.unitBox && m.geometry !== this.boltGeo) m.geometry.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
      return false;
    });

    this.lights.forEach((l, i) => {
      if (this.lightLife[i] <= 0) { l.intensity = 0; return; }
      this.lightLife[i] -= dt;
      l.intensity = l.userData.peak * Math.max(0, this.lightLife[i] / l.userData.max);
    });
  }
}

function smoothAge(x: number, a: number, b: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}


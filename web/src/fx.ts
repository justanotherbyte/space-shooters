// Combat effects, all biological: glowing fluid splashes, spore clouds, spore
// projectiles, luminous shots, creatures emerging from the soil and
// collapsing back into it. Particles are pooled; Rapier tumbles the fragments.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Organism, Sentinel } from "./creatures";
import { TICK_MS } from "./protocol";
import { blob, glow } from "./bio";

const MAX_DROPS = 600;
const MAX_PUFFS = 900;
const additive = (color: THREE.ColorRepresentation, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

interface Bolt { group: THREE.Group; o: THREE.Vector3; v: THREE.Vector3; evTick: number; age: number; color: number; heavy: boolean; trail: number }
interface Fragment { mesh: THREE.Mesh; body: RAPIER.RigidBody; life: number; size: number }
interface Timed { obj: THREE.Object3D; life: number; max: number; tick(o: THREE.Object3D, k: number, dt: number): void; done?(): void }
interface Dying { org: Organism; t: number; y: number; color: number; burst: boolean }

export class Fx {
  // Droplets: instanced, bright, falling and bouncing.
  private drops: THREE.InstancedMesh;
  private dp = new Float32Array(MAX_DROPS * 3);
  private dv = new Float32Array(MAX_DROPS * 3);
  private dl = new Float32Array(MAX_DROPS);
  private dm = new Float32Array(MAX_DROPS);
  private dNext = 0;
  // Puffs: soft additive points that drift, grow and fade.
  private puffGeo = new THREE.BufferGeometry();
  private pp = new Float32Array(MAX_PUFFS * 3);
  private pv = new Float32Array(MAX_PUFFS * 3);
  private pc = new Float32Array(MAX_PUFFS * 3);
  private pa = new Float32Array(MAX_PUFFS); // current alpha, written for the shader
  private ps = new Float32Array(MAX_PUFFS); // current size
  private pl = new Float32Array(MAX_PUFFS);
  private pm = new Float32Array(MAX_PUFFS);
  private pg = new Float32Array(MAX_PUFFS); // growth
  private pNext = 0;
  private bolts = new Map<number, Bolt>();
  private fragments: Fragment[] = [];
  private timed: Timed[] = [];
  private dying: Dying[] = [];
  private lights: THREE.PointLight[] = [];
  private lightLife: number[] = [];
  private orb = new THREE.IcosahedronGeometry(1, 2);
  private soft = softTexture();
  private fragGeo = blob(1, 0.8, 1, 1, 0.35, 2.5, 77);
  private fragMats = new Map<number, THREE.MeshStandardMaterial>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private rapier: RAPIER.World) {
    this.drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.045, 0), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_DROPS);
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.drops.frustumCulled = false;
    for (let i = 0; i < MAX_DROPS; i++) {
      this.drops.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
      this.drops.setColorAt(i, new THREE.Color(0));
    }
    scene.add(this.drops);

    this.puffGeo.setAttribute("position", new THREE.BufferAttribute(this.pp, 3).setUsage(THREE.DynamicDrawUsage));
    this.puffGeo.setAttribute("color", new THREE.BufferAttribute(this.pc, 3).setUsage(THREE.DynamicDrawUsage));
    this.puffGeo.setAttribute("alpha", new THREE.BufferAttribute(this.pa, 1).setUsage(THREE.DynamicDrawUsage));
    this.puffGeo.setAttribute("size", new THREE.BufferAttribute(this.ps, 1).setUsage(THREE.DynamicDrawUsage));
    const puffs = new THREE.Points(this.puffGeo, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute vec3 color; attribute float alpha; attribute float size; varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = color; vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 420.0 / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          gl_FragColor = vec4(vColor * a * a * vAlpha, 1.0);
        }`,
    }));
    puffs.frustumCulled = false;
    scene.add(puffs);

    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      scene.add(l);
      this.lights.push(l);
      this.lightLife.push(0);
    }
  }

  /** A splash of glowing fluid. */
  burst(p: THREE.Vector3, color: number, n: number, speed: number, life = 0.6, up = 2) {
    const c = glow(color, 2.4);
    for (let k = 0; k < n; k++) {
      const i = this.dNext;
      this.dNext = (this.dNext + 1) % MAX_DROPS;
      this.dp.set([p.x, p.y, p.z], i * 3);
      const a = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1, r = Math.sqrt(1 - e * e);
      const sp = speed * (0.3 + Math.random() * 0.7);
      this.dv.set([Math.cos(a) * r * sp, e * sp * 0.6 + up, Math.sin(a) * r * sp], i * 3);
      this.dl[i] = this.dm[i] = life * (0.5 + Math.random() * 0.5);
      this.drops.setColorAt(i, c);
    }
    this.drops.instanceColor!.needsUpdate = true;
  }

  /** Soft spore puffs drifting from `p`. */
  spores(p: THREE.Vector3, color: number, n: number, o: { spread?: number; rise?: number; size?: number; life?: number; k?: number; vel?: THREE.Vector3 } = {}) {
    const c = glow(color, o.k ?? 0.9);
    for (let k = 0; k < n; k++) {
      const i = this.pNext;
      this.pNext = (this.pNext + 1) % MAX_PUFFS;
      const sp = o.spread ?? 0.6;
      this.pp.set([p.x + (Math.random() - 0.5) * sp * 0.5, p.y + (Math.random() - 0.5) * sp * 0.5, p.z + (Math.random() - 0.5) * sp * 0.5], i * 3);
      this.pv.set([
        (Math.random() - 0.5) * sp + (o.vel?.x ?? 0),
        (o.rise ?? 0.4) * (0.5 + Math.random()) + (o.vel?.y ?? 0),
        (Math.random() - 0.5) * sp + (o.vel?.z ?? 0),
      ], i * 3);
      this.pc.set([c.r, c.g, c.b], i * 3);
      this.pl[i] = this.pm[i] = (o.life ?? 1.2) * (0.6 + Math.random() * 0.6);
      this.pg[i] = (o.size ?? 0.35) * (0.6 + Math.random() * 0.8);
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

  /** The player's luminous shot, streaking from `a` to `b`. */
  shot(a: THREE.Vector3, b: THREE.Vector3, color: number) {
    const dist = a.distanceTo(b);
    const bolt = new THREE.Mesh(this.orb, additive(glow(color, 3.5)));
    bolt.scale.set(0.05, 0.05, 0.6);
    bolt.position.copy(a);
    bolt.lookAt(b);
    this.scene.add(bolt);
    const dir = b.clone().sub(a).normalize();
    const travel = Math.max(0.04, dist / 260);
    this.timed.push({
      obj: bolt, life: travel, max: travel,
      tick: (o, k) => {
        o.position.copy(a).addScaledVector(dir, dist * (1 - k));
        if (Math.random() < 0.7) this.spores(o.position, color, 1, { spread: 0.08, rise: 0.05, size: 0.12, life: 0.35, k: 0.6 });
      },
    });
    // A faint, fading streak behind it.
    const streak = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), additive(glow(color, 1.5), 0.5));
    streak.position.copy(a).add(b).multiplyScalar(0.5);
    streak.scale.set(0.012, 0.012, dist);
    streak.lookAt(b);
    this.scene.add(streak);
    this.timed.push({ obj: streak, life: 0.12, max: 0.12, tick: (o, k) => { ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.5 * k; } });
  }

  /** A soft ripple across the ground. */
  ring(p: THREE.Vector3, color: number, size: number, life = 0.6) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), additive(glow(color, 1.2), 0.35));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(p).setY(p.y + 0.06);
    this.scene.add(m);
    this.timed.push({ obj: m, life, max: life, tick: (o, k) => { o.scale.setScalar(size * (1.15 - k * k)); ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = k * k * 0.35; } });
  }

  /** A creature pushing up out of the soil. */
  emerge(p: THREE.Vector3, color: number) {
    const at = p.clone().setY(0.1);
    this.ring(at, color, 3.5, 0.9);
    this.ring(at, color, 2, 0.6);
    this.burst(at.clone().setY(0.3), color, 24, 3.5, 0.9, 2.5);
    this.spores(at, color, 40, { spread: 1.4, rise: 1.6, size: 0.6, life: 1.6, k: 0.7 });
    this.flash(at.clone().setY(1.5), color, 30, 0.5);
  }

  /** Signalling spores: a swarm talking to itself. */
  signal(p: THREE.Vector3, color: number) {
    this.spores(p, color, 7, { spread: 0.5, rise: 1.1, size: 0.22, life: 0.9, k: 1.4 });
  }

  addBolt(id: number, o: number[], v: number[], color: number, heavy: boolean, evTick: number) {
    const g = new THREE.Group();
    const r = heavy ? 0.2 : 0.12;
    const core = new THREE.Mesh(this.orb, new THREE.MeshBasicMaterial({ color: glow(0xffffff, 1).lerp(glow(color, 3), 0.5), toneMapped: false }));
    core.scale.setScalar(r * 0.55);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.soft, color: glow(color, 2), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    halo.scale.setScalar(r * 5);
    g.add(core, halo);
    g.position.set(o[0], o[1], o[2]);
    this.scene.add(g);
    this.bolts.set(id, { group: g, o: new THREE.Vector3(...o), v: new THREE.Vector3(...v), evTick, age: 0, color, heavy, trail: 0 });
  }

  /** A bolt ends: splash where it struck, unless it hit a player (their screen shows that). */
  endBolt(id: number, p: number[], hitPlayer: boolean) {
    const b = this.bolts.get(id);
    if (!b) return;
    this.scene.remove(b.group);
    for (const m of b.group.children) ((m as THREE.Mesh).material as THREE.Material).dispose();
    this.bolts.delete(id);
    if (hitPlayer) return;
    const at = new THREE.Vector3(...p);
    this.burst(at, b.color, b.heavy ? 18 : 9, 3.5, 0.45, 1.2);
    this.spores(at, b.color, b.heavy ? 14 : 6, { spread: 0.8, rise: 0.4, size: b.heavy ? 0.7 : 0.4, life: 0.9 });
    this.flash(at, b.color, b.heavy ? 18 : 8, 0.1);
  }

  clearBolts() {
    for (const id of [...this.bolts.keys()]) this.endBolt(id, [0, 0, 0], true);
  }

  /** A creature (or player) collapses, bursts and sinks into the soil. Takes ownership of its root. */
  dissolve(org: Organism, color: number) {
    org.root.updateMatrixWorld(true);
    const center = org.root.position.clone().setY(org.root.position.y + org.hipY);
    const big = org.kind === "sentinel";
    this.dying.push({ org, t: 0, y: org.root.position.y, color, burst: false });
    this.burst(center, color, big ? 70 : 40, big ? 7 : 5, 1.0, 3);
    this.spores(center, color, big ? 90 : 45, { spread: big ? 2.4 : 1.4, rise: 0.7, size: big ? 1.0 : 0.6, life: 1.8 });
    this.ring(center.clone().setY(0), color, big ? 7 : 4, 0.8);
    this.flash(center, color, big ? 90 : 45, 0.4);
    // Organic fragments, tumbling under physics.
    let mat = this.fragMats.get(color);
    if (!mat) this.fragMats.set(color, (mat = new THREE.MeshStandardMaterial({ color: 0x0e121c, emissive: glow(color, 0.55), roughness: 0.35, flatShading: true })));
    for (let i = 0; i < (big ? 12 : 7); i++) {
      const size = (big ? 0.16 : 0.09) * (0.6 + Math.random() * 0.8);
      const mesh = new THREE.Mesh(this.fragGeo, mat);
      mesh.scale.setScalar(size);
      const p = center.clone().add(this.v.set((Math.random() - 0.5) * 0.8, (Math.random() - 0.3) * 0.8, (Math.random() - 0.5) * 0.8));
      mesh.position.copy(p);
      this.scene.add(mesh);
      const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinearDamping(0.5).setAngularDamping(0.8));
      this.rapier.createCollider(RAPIER.ColliderDesc.ball(size).setRestitution(0.3).setFriction(0.9).setDensity(1.5), body);
      const out = this.v.copy(p).sub(center).normalize();
      const kick = 2 + Math.random() * 4;
      body.setLinvel({ x: out.x * kick, y: 2 + Math.random() * 4, z: out.z * kick }, true);
      body.setAngvel({ x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10, z: (Math.random() - 0.5) * 10 }, true);
      this.fragments.push({ mesh, body, life: 1.8 + Math.random() * 1.2, size });
    }
  }

  update(dt: number, nowTick: number) {
    // Droplets
    for (let i = 0; i < MAX_DROPS; i++) {
      if (this.dl[i] <= 0) continue;
      this.dl[i] -= dt;
      const k = Math.max(0, this.dl[i] / this.dm[i]);
      this.dv[i * 3 + 1] -= 11 * dt;
      for (let a = 0; a < 3; a++) this.dp[i * 3 + a] += this.dv[i * 3 + a] * dt;
      if (this.dp[i * 3 + 1] < 0.03) { this.dp[i * 3 + 1] = 0.03; this.dv[i * 3 + 1] *= -0.25; this.dv[i * 3] *= 0.6; this.dv[i * 3 + 2] *= 0.6; }
      this.v.set(this.dv[i * 3], this.dv[i * 3 + 1], this.dv[i * 3 + 2]);
      const speed = this.v.length();
      this.q.setFromUnitVectors(this.s.set(0, 0, 1), this.v.normalize());
      this.drops.setMatrixAt(i, this.m4.compose(this.s.fromArray(this.dp, i * 3), this.q, this.v.set(k, k, k * (1 + Math.min(3, speed * 0.25)))));
    }
    this.drops.instanceMatrix.needsUpdate = true;

    // Puffs
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this.pl[i] <= 0) { this.pa[i] = 0; continue; }
      this.pl[i] -= dt;
      const k = Math.max(0, this.pl[i] / this.pm[i]);
      const drag = Math.pow(0.35, dt);
      for (let a = 0; a < 3; a++) { this.pv[i * 3 + a] *= drag; this.pp[i * 3 + a] += this.pv[i * 3 + a] * dt; }
      this.pa[i] = Math.sin(k * Math.PI) * 0.9;
      this.ps[i] = this.pg[i] * (1.6 - k * 0.8);
    }
    for (const name of ["position", "color", "alpha", "size"]) this.puffGeo.attributes[name].needsUpdate = true;

    // Spore bolts: catch up from where they were fired to the server's present, trailing spores.
    for (const b of this.bolts.values()) {
      b.age += dt;
      const serverAge = Math.max(0, (nowTick - b.evTick) * TICK_MS / 1000);
      const t = Math.min(serverAge, b.age * 1.6);
      b.group.position.copy(b.o).addScaledVector(b.v, t);
      const wob = 1 + Math.sin(b.age * 30) * 0.12;
      b.group.children[1].scale.setScalar((b.heavy ? 0.2 : 0.12) * 5 * wob);
      b.trail += dt;
      if (b.trail > 0.012) {
        b.trail = 0;
        this.spores(b.group.position, b.color, 1, { spread: 0.04, rise: 0.02, size: b.heavy ? 0.2 : 0.12, life: 0.3, k: 0.7 });
      }
    }

    // Dying creatures: the pose comes from the creature, the sinking from here.
    this.dying = this.dying.filter((d) => {
      d.t += dt;
      const k = Math.min(1, d.t / 1.6);
      d.org.collapse(k);
      d.org.root.position.y = d.y - Math.pow(Math.max(0, (k - 0.45) / 0.55), 2) * 1.8;
      if (!d.burst && k > 0.18 && d.org.kind === "sentinel") {
        d.burst = true;
        for (const p of (d.org as Sentinel).sacPositions()) {
          this.spores(p, d.color, 18, { spread: 1.6, rise: 0.8, size: 0.8, life: 1.6, k: 1.1 });
          this.burst(p, d.color, 10, 4, 0.7, 1.5);
        }
      }
      if (k < 0.7 && Math.random() < 0.3) this.spores(d.org.root.position.clone().setY(0.4), d.color, 1, { spread: 1, rise: 0.5, size: 0.5, life: 1.2, k: 0.5 });
      if (k < 1) return true;
      this.scene.remove(d.org.root);
      d.org.dispose();
      return false;
    });

    // Fragments
    this.rapier.timestep = Math.min(dt, 1 / 30);
    this.rapier.step();
    this.fragments = this.fragments.filter((f) => {
      f.life -= dt;
      const t = f.body.translation(), r = f.body.rotation();
      f.mesh.position.set(t.x, t.y, t.z);
      f.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      if (f.life < 0.6) f.mesh.scale.setScalar(f.size * Math.max(0, f.life / 0.6));
      if (f.life > 0) return true;
      this.scene.remove(f.mesh);
      this.rapier.removeRigidBody(f.body);
      return false;
    });

    this.timed = this.timed.filter((f) => {
      f.life -= dt;
      f.tick(f.obj, Math.max(0, f.life / f.max), dt);
      if (f.life > 0) return true;
      this.scene.remove(f.obj);
      const m = f.obj as THREE.Mesh;
      if (m.geometry && m.geometry !== this.orb) m.geometry.dispose();
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

function softTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

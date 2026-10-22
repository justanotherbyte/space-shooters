// Visual effects: sparks, energy bolts, tracers, warp-ins, and Rapier-driven debris.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Robot } from "./robots";
import { TICK_MS } from "./protocol";

const MAX_SPARKS = 700;
const additive = (color: THREE.ColorRepresentation, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

interface Bolt { group: THREE.Group; o: THREE.Vector3; v: THREE.Vector3; evTick: number; age: number }
interface Piece { mesh: THREE.Mesh; body: RAPIER.RigidBody; life: number; scale: THREE.Vector3 }
interface Timed { obj: THREE.Mesh; life: number; max: number; tick(o: THREE.Mesh, k: number): void }

export class Fx {
  private sparks: THREE.InstancedMesh;
  private sp = new Float32Array(MAX_SPARKS * 3);
  private sv = new Float32Array(MAX_SPARKS * 3);
  private sl = new Float32Array(MAX_SPARKS);
  private sm = new Float32Array(MAX_SPARKS);
  private next = 0;
  private bolts = new Map<number, Bolt>();
  private pieces: Piece[] = [];
  private timed: Timed[] = [];
  private lights: THREE.PointLight[] = [];
  private lightLife: number[] = [];
  private boltGeo = new THREE.OctahedronGeometry(0.13).scale(1, 1, 3.2);
  private boltCore = new THREE.OctahedronGeometry(0.06).scale(1, 1, 3);
  private unitBox = new THREE.BoxGeometry(1, 1, 1);
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private rapier: RAPIER.World) {
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.sparks = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.06), mat, MAX_SPARKS);
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparks.frustumCulled = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparks.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
      this.sparks.setColorAt(i, new THREE.Color(0));
    }
    scene.add(this.sparks);
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      scene.add(l);
      this.lights.push(l);
      this.lightLife.push(0);
    }
  }

  burst(p: THREE.Vector3, color: number, n: number, speed: number, life = 0.6, up = 2) {
    const c = new THREE.Color(color).multiplyScalar(2.2);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_SPARKS;
      this.sp.set([p.x, p.y, p.z], i * 3);
      const a = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1, r = Math.sqrt(1 - e * e);
      const sp = speed * (0.3 + Math.random() * 0.7);
      this.sv.set([Math.cos(a) * r * sp, e * sp + up, Math.sin(a) * r * sp], i * 3);
      this.sl[i] = this.sm[i] = life * (0.5 + Math.random() * 0.5);
      this.sparks.setColorAt(i, c);
    }
    this.sparks.instanceColor!.needsUpdate = true;
  }

  flash(p: THREE.Vector3, color: number, intensity = 30, life = 0.12) {
    const i = this.lightLife.indexOf(Math.min(...this.lightLife));
    const l = this.lights[i];
    l.position.copy(p);
    l.color.setHex(color);
    l.intensity = intensity;
    l.userData.peak = intensity;
    this.lightLife[i] = life;
    l.userData.max = life;
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3, color: number, width = 0.035) {
    const m = new THREE.Mesh(this.unitBox, additive(new THREE.Color(color).multiplyScalar(3)));
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.scale.set(width, width, a.distanceTo(b));
    m.lookAt(b);
    this.scene.add(m);
    this.timed.push({ obj: m, life: 0.09, max: 0.09, tick: (o, k) => { (o.material as THREE.MeshBasicMaterial).opacity = k; o.scale.x = o.scale.y = width * k; } });
  }

  ring(p: THREE.Vector3, color: number, size: number, life = 0.5) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 6), additive(new THREE.Color(color).multiplyScalar(2.5)));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(p).setY(p.y + 0.05);
    this.scene.add(m);
    this.timed.push({ obj: m, life, max: life, tick: (o, k) => { o.scale.setScalar(size * (1.2 - k)); (o.material as THREE.MeshBasicMaterial).opacity = k; } });
  }

  warp(p: THREE.Vector3, color: number) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 7, 6, 1, true), additive(new THREE.Color(color).multiplyScalar(1.5), 0.8));
    col.position.copy(p).setY(3.5);
    this.scene.add(col);
    this.timed.push({ obj: col, life: 0.8, max: 0.8, tick: (o, k) => { o.scale.set(k * 1.2 + 0.05, 1, k * 1.2 + 0.05); (o.material as THREE.MeshBasicMaterial).opacity = k * 0.8; } });
    this.ring(p, color, 3, 0.8);
    this.burst(p.clone().setY(1), color, 30, 4, 0.8, 3);
    this.flash(p.clone().setY(2), color, 40, 0.4);
  }

  addBolt(id: number, o: number[], v: number[], color: number, heavy: boolean, evTick: number) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(this.boltGeo, additive(new THREE.Color(color).multiplyScalar(2.5), 0.9));
    const core = new THREE.Mesh(this.boltCore, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(3), toneMapped: false }));
    g.add(shell, core);
    if (heavy) g.scale.setScalar(1.6);
    const vel = new THREE.Vector3(...v);
    g.position.set(o[0], o[1], o[2]);
    g.lookAt(this.v.copy(g.position).add(vel));
    this.scene.add(g);
    this.bolts.set(id, { group: g, o: new THREE.Vector3(...o), v: vel, evTick, age: 0 });
  }

  endBolt(id: number, p: number[], color: number, hitSomething: boolean) {
    const b = this.bolts.get(id);
    if (!b) return;
    this.scene.remove(b.group);
    for (const m of b.group.children) ((m as THREE.Mesh).material as THREE.Material).dispose();
    this.bolts.delete(id);
    if (hitSomething) return;
    const at = new THREE.Vector3(...p);
    this.burst(at, color, 10, 4, 0.35, 1);
    this.flash(at, color, 12, 0.08);
  }

  clearBolts() {
    for (const id of [...this.bolts.keys()]) this.endBolt(id, [0, 0, 0], 0, true);
  }

  // Break a robot into its armor plates, each a Rapier rigid body.
  shatter(robot: Robot, color: number) {
    robot.root.updateMatrixWorld(true);
    const center = new THREE.Vector3();
    robot.root.getWorldPosition(center).setY(center.y + robot.hipY);
    const meshes: THREE.Mesh[] = [];
    robot.root.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
    for (const m of meshes) {
      this.scene.attach(m);
      m.geometry.computeBoundingBox();
      const size = m.geometry.boundingBox!.getSize(this.s).multiply(m.scale);
      const body = this.rapier.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(m.position.x, m.position.y, m.position.z)
          .setRotation(m.quaternion)
          .setLinearDamping(0.4)
          .setAngularDamping(0.6),
      );
      this.rapier.createCollider(
        RAPIER.ColliderDesc.cuboid(Math.max(0.03, size.x / 2), Math.max(0.03, size.y / 2), Math.max(0.03, size.z / 2))
          .setRestitution(0.35).setFriction(0.8).setDensity(2),
        body,
      );
      const out = this.v.copy(m.position).sub(center).normalize();
      const kick = 3 + Math.random() * 5;
      body.setLinvel({ x: out.x * kick, y: 2.5 + Math.random() * 5, z: out.z * kick }, true);
      body.setAngvel({ x: (Math.random() - 0.5) * 14, y: (Math.random() - 0.5) * 14, z: (Math.random() - 0.5) * 14 }, true);
      this.pieces.push({ mesh: m, body, life: 2.6 + Math.random(), scale: m.scale.clone() });
    }
    this.burst(center, color, 70, 9, 1.0, 3);
    this.burst(center, 0xffffff, 25, 6, 0.5, 2);
    this.ring(center.clone().setY(0), color, robot.kind === "sentinel" ? 7 : 4, 0.6);
    this.flash(center, color, robot.kind === "sentinel" ? 120 : 60, 0.3);
  }

  update(dt: number, nowTick: number) {
    // Sparks
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sl[i] <= 0) continue;
      this.sl[i] -= dt;
      const k = Math.max(0, this.sl[i] / this.sm[i]);
      this.sv[i * 3 + 1] -= 14 * dt;
      for (let a = 0; a < 3; a++) this.sp[i * 3 + a] += this.sv[i * 3 + a] * dt;
      if (this.sp[i * 3 + 1] < 0.03) { this.sp[i * 3 + 1] = 0.03; this.sv[i * 3 + 1] *= -0.4; }
      this.q.setFromAxisAngle(this.v.set(1, 1, 0).normalize(), this.sl[i] * 12);
      this.sparks.setMatrixAt(i, this.m4.compose(this.s.fromArray(this.sp, i * 3), this.q, this.v.setScalar(k * 1.4)));
    }
    this.sparks.instanceMatrix.needsUpdate = true;

    // Bolts: catch up from where they were fired to the server's present.
    for (const b of this.bolts.values()) {
      b.age += dt;
      const serverAge = Math.max(0, (nowTick - b.evTick) * TICK_MS / 1000);
      const t = Math.min(serverAge, b.age * 1.6);
      b.group.position.copy(b.o).addScaledVector(b.v, t);
      b.group.rotation.z += dt * 10;
    }

    // Debris
    this.rapier.timestep = Math.min(dt, 1 / 30);
    this.rapier.step();
    this.pieces = this.pieces.filter((p) => {
      p.life -= dt;
      const t = p.body.translation(), r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      if (p.life < 0.5) p.mesh.scale.copy(p.scale).multiplyScalar(Math.max(0, p.life / 0.5));
      if (p.life > 0) return true;
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      this.rapier.removeRigidBody(p.body);
      return false;
    });

    this.timed = this.timed.filter((f) => {
      f.life -= dt;
      f.tick(f.obj, Math.max(0, f.life / f.max));
      if (f.life > 0) return true;
      this.scene.remove(f.obj);
      if (f.obj.geometry !== this.unitBox) f.obj.geometry.dispose();
      (f.obj.material as THREE.Material).dispose();
      return false;
    });

    this.lights.forEach((l, i) => {
      if (this.lightLife[i] <= 0) { l.intensity = 0; return; }
      this.lightLife[i] -= dt;
      l.intensity = l.userData.peak * Math.max(0, this.lightLife[i] / l.userData.max);
    });
  }
}

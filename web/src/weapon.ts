// The first-person weapon: a living energy rifle, grown rather than built.
// It lives in its own scene, drawn after the world with a cleared depth
// buffer, so walls never cut into it. Each vertex's `phase` is its distance
// along the barrel (0 at the stock, 1 at the muzzle), so a shot is a surge
// of light travelling through the veins.
import * as THREE from "three";
import { PALETTE, bioMaterial, blob, glow, merge, noise, paint, smoothstep, tube, warp } from "./bio";
import { PLAYER_COLOR } from "./protocol";

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (hex: number) => new THREE.Color(hex);
const BACK = 0.24, FRONT = -0.66;
const along = (p: THREE.Vector3) => (BACK - p.z) / (BACK - FRONT);

export class Rifle {
  root = new THREE.Group();
  private model = new THREE.Group();
  private skin = bioMaterial({ rough: 0.38, metal: 0.2, envIntensity: 1.2, vein: { color: PLAYER_COLOR, k: 1.1, freq: 60, width: 0.03 } });
  private chamberMat = bioMaterial({ rough: 0.08, transparent: true, opacity: 0.42, envIntensity: 2 });
  private core: THREE.Mesh;
  private petals: THREE.Group;
  private flash: THREE.Mesh;
  private light = new THREE.PointLight(PLAYER_COLOR, 0, 6, 2);
  private glowLight = new THREE.PointLight(PALETTE.turquoise, 0.6, 1.2, 2);
  private muzzlePoint = new THREE.Object3D();
  private kick = 0;
  private surge = 1;
  private heat = 0;
  private bob = 0;
  private sway = new THREE.Vector2();

  constructor(rig: THREE.Object3D) {
    const chitin = (p: THREE.Vector3) => {
      const ring = smoothstep(0.55, 0.9, Math.abs(Math.sin(p.z * 46)));
      return C(0x0f141f).lerp(C(0x253048), ring * 0.55 + noise(p.x * 30, p.y * 30, p.z * 30, 2) * 0.25);
    };
    const axisY = (z: number) => 0.012 * Math.sin((z - FRONT) / (BACK - FRONT) * Math.PI);
    const shell = tube([V(0, -0.015, BACK), V(0, 0.01, 0.02), V(0, 0.012, -0.3), V(0, 0, FRONT)], (t) => 0.045 + 0.028 * Math.sin(Math.min(1, t * 1.6) * Math.PI) - t * 0.012, 28, 12);
    const parts = [
      paint(shell, { color: chitin, vein: 1, phase: along }),
      // Ridged plates down the spine.
      ...[0, 1, 2, 3, 4].map((i) => paint(warp(new THREE.ConeGeometry(0.022, 0.07, 3).rotateX(-1.2), (p) => p.set(p.x, p.y + 0.075, p.z + 0.12 - i * 0.05)), { color: 0x0b0f17, emit: (p) => glow(PLAYER_COLOR, smoothstep(0.1, 0.12, p.y) * 1.2), phase: along })),
      // A grip that grows down out of the body, and a tendril wrapped round the barrel.
      paint(tube([V(0, -0.03, 0.06), V(0, -0.1, 0.1), V(0.005, -0.18, 0.15)], (t) => 0.034 - t * 0.008, 8, 8), { color: chitin, vein: 0.4, phase: along }),
      paint(tube(Array.from({ length: 14 }, (_, i) => {
        const z = 0.0 - i * 0.045, a = i * 1.15;
        return V(Math.cos(a) * 0.058, axisY(z) + Math.sin(a) * 0.058, z);
      }), () => 0.0045, 60, 4), { color: 0x0c161e, emit: () => glow(PALETTE.turquoise, 0.45), phase: along }),
    ];
    this.model.add(new THREE.Mesh(merge(parts), this.skin));
    // The translucent chamber, with a living core.
    this.model.add(new THREE.Mesh(paint(blob(0.04, 0.036, 0.07, 2, 0.1, 9, 3).translate(0, 0.058, -0.06), { color: 0x6fd8cc, emit: glow(PALETTE.turquoise, 0.3) }), this.chamberMat));
    this.core = new THREE.Mesh(paint(blob(0.025, 0.022, 0.05, 1, 0.2, 12, 4), { color: 0xffffff, emit: glow(PALETTE.turquoise, 3.2) }), this.skin);
    this.core.position.set(0, 0.06, -0.06);
    this.model.add(this.core);
    // Petals around the muzzle, which flare open on a shot.
    this.petals = new THREE.Group();
    this.petals.position.set(0, 0, FRONT + 0.02);
    for (let i = 0; i < 4; i++) {
      const petal = new THREE.ConeGeometry(0.018, 0.09, 3);
      petal.scale(1, 1, 0.35);
      petal.rotateX(-Math.PI / 2 + 0.35);
      petal.translate(0, 0.03, -0.035);
      petal.rotateZ(i * Math.PI / 2 + Math.PI / 4);
      this.petals.add(new THREE.Mesh(paint(petal, { color: 0x101622, emit: (p) => glow(PLAYER_COLOR, smoothstep(-0.02, -0.07, p.z) * 1.6), phase: 1 }), this.skin));
    }
    this.model.add(this.petals);
    this.flash = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.05, 1),
      new THREE.MeshBasicMaterial({ color: glow(PLAYER_COLOR, 4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.flash.position.set(0, 0, FRONT - 0.06);
    this.muzzlePoint.position.set(0, 0, FRONT - 0.04);
    this.light.position.set(0, 0, FRONT - 0.1);
    this.glowLight.position.set(0, 0.09, -0.06);
    this.model.add(this.flash, this.muzzlePoint, this.light, this.glowLight);
    this.root.add(this.model);
    this.root.scale.setScalar(0.75);
    this.root.position.set(0.19, -0.18, -0.32);
    this.root.rotation.set(0.03, 0.07, -0.04); // converge on the crosshair
    rig.add(this.root);
  }

  fire() {
    this.kick = 1;
    this.surge = 0;
    this.heat = Math.min(1, this.heat + 0.15);
  }

  look(dx: number, dy: number) {
    this.sway.x = THREE.MathUtils.clamp(this.sway.x - dx * 0.0004, -0.04, 0.04);
    this.sway.y = THREE.MathUtils.clamp(this.sway.y + dy * 0.0004, -0.04, 0.04);
  }

  muzzle(out: THREE.Vector3) {
    return this.muzzlePoint.getWorldPosition(out);
  }

  update(dt: number, speed: number, grounded: boolean) {
    this.kick = Math.max(0, this.kick - dt * 8);
    this.surge = Math.min(1, this.surge + dt * 7);
    this.heat = Math.max(0, this.heat - dt * 0.5);
    if (grounded) this.bob += dt * speed * 1.4;
    const bobAmp = Math.min(1, speed / 7) * (grounded ? 1 : 0.2);
    this.sway.multiplyScalar(Math.pow(0.002, dt));
    const t = performance.now() / 1000;
    const breathe = Math.sin(t * 1.6) * 0.004;
    const m = this.model;
    m.position.set(
      Math.sin(this.bob) * 0.012 * bobAmp + this.sway.x,
      Math.abs(Math.cos(this.bob)) * 0.012 * bobAmp + this.sway.y - this.kick * 0.012 + breathe,
      this.kick * 0.06,
    );
    m.rotation.x = this.kick * 0.1;
    // The surge of light rides the veins from stock to muzzle.
    const u = this.skin.userData.u;
    u.flow.value = this.surge * 1.15;
    u.flowAmp.value = this.surge < 1 ? 3.5 : 0;
    u.glow.value = 1 + this.heat * 0.8 + Math.sin(t * 2.2) * 0.12;
    // The chamber contracts as it fires, then refills.
    this.core.scale.setScalar(0.65 + 0.35 * this.surge + Math.sin(t * 4) * 0.04);
    this.chamberMat.userData.u.glow.value = 1 + (1 - this.surge) * 3 + this.heat;
    this.petals.scale.setScalar(1 + this.kick * 0.35);
    this.petals.rotation.z += dt * (0.2 + this.kick * 4);
    const flash = this.kick > 0.55 ? (this.kick - 0.55) / 0.45 : 0;
    (this.flash.material as THREE.MeshBasicMaterial).opacity = flash;
    this.flash.scale.setScalar(0.6 + flash * 1.3);
    this.light.intensity = flash * 2.5;
    this.glowLight.intensity = 0.5 + this.heat * 0.8 + (1 - this.surge) * 1.5;
  }
}

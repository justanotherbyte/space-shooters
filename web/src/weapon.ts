// The first-person weapon: a retro anime energy rifle, armored casing over
// dark mechanics, a cyan energy chamber, vents and warning decals. It lives in
// its own scene, drawn after the world with a cleared depth buffer, so walls
// never cut into it.
import * as THREE from "three";
import { PALETTE, canvasTexture, cylinder, glow, merge, outline, paint, plate, toonMaterial } from "./kit";
import { PLAYER_COLOR } from "./protocol";

const { cream: CREAM, navy: NAVY, gold: GOLD } = PALETTE;

export class Rifle {
  root = new THREE.Group();
  private model = new THREE.Group();
  private armor = toonMaterial();
  private chamber = toonMaterial();
  private flash: THREE.Sprite;
  private light = new THREE.PointLight(PLAYER_COLOR, 0, 6, 2);
  private muzzlePoint = new THREE.Object3D();
  private kick = 0;
  private charge = 1;
  private heat = 0;
  private bob = 0;
  private sway = new THREE.Vector2();
  private aimK = 0;
  /** 0 in hand, 1 put away (hidden). */
  lowered = 0;
  private hip = new THREE.Vector3(0.26, -0.25, -0.4);
  private hipRot = new THREE.Euler(0.06, 0.035, -0.04);
  // Raised to the eye, the gold sight on top lines up with the screen's center.
  private ads = new THREE.Vector3(0, -0.098, -0.3);

  constructor(rig: THREE.Object3D) {
    const one = (g: THREE.BufferGeometry, color: number, emit?: THREE.Color) => paint(g, { color, emit });
    const body = merge([
      // Receiver and a big angular barrel shroud.
      one(plate(0.12, 0.13, 0.42, { top: 0.9, bevel: 0.025 }).translate(0, 0, 0.02), CREAM),
      one(plate(0.1, 0.11, 0.4, { top: 0.82, bevel: 0.02 }).translate(0, 0.005, -0.37), CREAM),
      one(plate(0.07, 0.05, 0.44, { bevel: 0.012 }).translate(0, -0.07, -0.33), NAVY),
      one(cylinder(0.026, 0.03, 0.18, 8).rotateX(Math.PI / 2).translate(0, 0.005, -0.62), NAVY),
      one(plate(0.085, 0.065, 0.07, { bevel: 0.012 }).translate(0, 0.005, -0.72), NAVY),
      // Vents along the top of the shroud.
      ...[0, 1, 2, 3].map((i) => one(plate(0.07, 0.014, 0.022, { bevel: 0.004 }).translate(0, 0.066, -0.26 - i * 0.045), NAVY)),
      // A sight rail with a gold sight.
      one(plate(0.04, 0.025, 0.3, { bevel: 0.006 }).translate(0, 0.08, 0.0), NAVY),
      one(plate(0.03, 0.04, 0.05, { bevel: 0.006 }).translate(0, 0.11, -0.02), GOLD),
      // Grip, battery pack and stock.
      one(plate(0.05, 0.16, 0.07, { bevel: 0.012 }).rotateX(0.35).translate(0, -0.12, 0.12), NAVY),
      one(plate(0.07, 0.1, 0.12, { bevel: 0.012 }).translate(0, -0.1, -0.06), NAVY),
      one(plate(0.08, 0.1, 0.16, { top: 0.8, bevel: 0.02 }).translate(0, -0.01, 0.3), CREAM),
      // Gold warning decals on the casing.
      one(plate(0.004, 0.03, 0.09, { bevel: 0.001 }).translate(-0.061, 0.03, 0.06), GOLD),
      one(plate(0.004, 0.03, 0.09, { bevel: 0.001 }).translate(0.061, 0.03, 0.06), GOLD),
      one(plate(0.004, 0.022, 0.05, { bevel: 0.001 }).translate(0.051, -0.02, -0.36), GOLD),
    ]);
    this.model.add(outline(new THREE.Mesh(body, this.armor), 0.0035, 0x10161f));
    // The energy chamber, a window along the side of the receiver, and the muzzle ring.
    const chamber = merge([
      one(plate(0.012, 0.055, 0.17, { bevel: 0.004 }).translate(0.063, 0.0, -0.02), 0xffffff, glow(PALETTE.cyan, 2.2)),
      one(plate(0.012, 0.055, 0.17, { bevel: 0.004 }).translate(-0.063, 0.0, -0.02), 0xffffff, glow(PALETTE.cyan, 2.2)),
      one(plate(0.07, 0.012, 0.012, { bevel: 0.002 }).translate(0, 0.005, -0.757), 0xffffff, glow(PALETTE.cyan, 2.6)),
    ]);
    this.model.add(new THREE.Mesh(chamber, this.chamber));
    // A four-point star for the muzzle flash.
    const star = canvasTexture(128, 128, (g) => {
      g.translate(64, 64);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 64);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.25, "rgba(150,240,255,0.9)");
      grad.addColorStop(1, "rgba(39,221,242,0)");
      g.fillStyle = grad;
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const r = i % 2 ? 12 : 64, a = (i / 8) * Math.PI * 2;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.fill();
    });
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: star, color: glow(0xffffff, 2.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.flash.position.set(0, 0.005, -0.8);
    this.muzzlePoint.position.set(0, 0.005, -0.77);
    this.light.position.set(0, 0, -0.85);
    this.model.add(this.flash, this.muzzlePoint, this.light);
    // A key light that travels with the view, so the toon bands always read.
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
    key.position.set(-0.6, 1, 0.4);
    rig.add(key, key.target);
    this.root.add(this.model);
    this.root.scale.setScalar(0.8);
    this.root.position.copy(this.hip);
    this.root.rotation.copy(this.hipRot); // toward the crosshair, kept clear of it
    rig.add(this.root);
  }

  fire() {
    this.kick = 1;
    this.charge = 0;
    this.heat = Math.min(1, this.heat + 0.15);
    this.flash.material.rotation = Math.random() * 0.4 - 0.2;
  }

  look(dx: number, dy: number) {
    this.sway.x = THREE.MathUtils.clamp(this.sway.x - dx * 0.0004, -0.04, 0.04);
    this.sway.y = THREE.MathUtils.clamp(this.sway.y + dy * 0.0004, -0.04, 0.04);
  }

  /** How far the rifle is raised to scope in, from 0 (hip) to 1 (at the eye). */
  aim(k: number) {
    this.aimK = k;
    this.root.position.lerpVectors(this.hip, this.ads, k);
    this.root.rotation.set(this.hipRot.x * (1 - k) - this.lowered * 0.6, this.hipRot.y * (1 - k), this.hipRot.z * (1 - k));
    this.root.position.y -= this.lowered * 0.4;
    this.root.visible = k < 0.92 && this.lowered < 1; // the scope overlay takes over
  }

  muzzle(out: THREE.Vector3) {
    return this.muzzlePoint.getWorldPosition(out);
  }

  update(dt: number, speed: number, grounded: boolean) {
    this.kick = Math.max(0, this.kick - dt * 9);
    this.charge = Math.min(1, this.charge + dt * 5);
    this.heat = Math.max(0, this.heat - dt * 0.5);
    if (grounded) this.bob += dt * speed * 1.4;
    const bobAmp = Math.min(1, speed / 7) * (grounded ? 1 : 0.2) * (1 - this.aimK * 0.8);
    this.sway.multiplyScalar(Math.pow(0.002, dt));
    const m = this.model;
    m.position.set(
      Math.sin(this.bob) * 0.012 * bobAmp + this.sway.x,
      Math.abs(Math.cos(this.bob)) * 0.012 * bobAmp + this.sway.y - this.kick * 0.015,
      this.kick * 0.075,
    );
    m.rotation.x = this.kick * 0.13;
    // The chamber dims as it fires and refills, brighter as the barrel heats.
    this.chamber.userData.u.glow.value = 0.5 + this.charge * 0.8 + this.heat * 0.8 + (this.kick > 0.6 ? 2 : 0);
    const flash = this.kick > 0.55 ? (this.kick - 0.55) / 0.45 : 0;
    this.flash.material.opacity = flash;
    this.flash.scale.setScalar(0.12 + flash * 0.22);
    this.light.intensity = flash * 3;
  }
}

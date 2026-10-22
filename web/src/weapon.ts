// The first-person energy rifle. It lives in its own scene, drawn after the
// world with a cleared depth buffer, so walls never cut into it.
import * as THREE from "three";
import { PLAYER_COLOR } from "./protocol";

export class Rifle {
  root = new THREE.Group();
  private model = new THREE.Group();
  private coils: THREE.MeshBasicMaterial;
  private flashSprite: THREE.Mesh;
  private light = new THREE.PointLight(PLAYER_COLOR, 0, 8, 2);
  private muzzlePoint = new THREE.Object3D();
  private kick = 0;
  private heat = 0;
  private bob = 0;
  private sway = new THREE.Vector2();

  constructor(rig: THREE.Object3D) {
    const body = new THREE.MeshStandardMaterial({ color: 0x2a2846, metalness: 0.8, roughness: 0.28, flatShading: true });
    const plate = new THREE.MeshStandardMaterial({ color: 0x4d4880, metalness: 0.7, roughness: 0.35, flatShading: true });
    this.coils = new THREE.MeshBasicMaterial({ color: new THREE.Color(PLAYER_COLOR).multiplyScalar(2), toneMapped: false });
    const m = this.model;
    const add = (g: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const o = new THREE.Mesh(g, mat);
      o.position.set(x, y, z);
      m.add(o);
      return o;
    };
    // Receiver: a tapered hex body.
    add(new THREE.CylinderGeometry(0.055, 0.075, 0.5, 6).rotateX(Math.PI / 2).scale(1.2, 1, 1), body, 0, 0, 0);
    add(new THREE.BoxGeometry(0.1, 0.05, 0.34), plate, 0, 0.065, -0.02);
    // Barrel shroud and coils.
    add(new THREE.CylinderGeometry(0.035, 0.045, 0.42, 6).rotateX(Math.PI / 2), body, 0, 0.005, -0.42);
    for (let i = 0; i < 4; i++) add(new THREE.TorusGeometry(0.05, 0.009, 3, 6), this.coils, 0, 0.005, -0.28 - i * 0.07);
    // Prongs that frame the muzzle.
    for (const s of [-1, 1]) {
      const prong = add(new THREE.BoxGeometry(0.014, 0.03, 0.26), plate, s * 0.05, 0.0, -0.58);
      prong.rotation.y = -s * 0.12;
      add(new THREE.BoxGeometry(0.008, 0.008, 0.18), this.coils, s * 0.058, 0.018, -0.6).rotation.y = -s * 0.12;
    }
    // Glowing seams along the receiver.
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.006, 0.006, 0.36), this.coils, s * 0.052, 0.088, -0.02);
      add(new THREE.BoxGeometry(0.006, 0.02, 0.3), this.coils, s * 0.082, -0.005, -0.02);
    }
    // Energy cell on the side, sight on top, grip below.
    add(new THREE.BoxGeometry(0.04, 0.07, 0.14), this.coils, 0.085, -0.01, 0.05);
    add(new THREE.BoxGeometry(0.03, 0.05, 0.1), body, 0, 0.11, 0.02);
    add(new THREE.BoxGeometry(0.06, 0.012, 0.012), this.coils, 0, 0.14, 0.02);
    const grip = add(new THREE.BoxGeometry(0.05, 0.16, 0.07), body, 0, -0.1, 0.12);
    grip.rotation.x = 0.35;

    this.flashSprite = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.09).scale(1, 1, 2.2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PLAYER_COLOR).multiplyScalar(4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.flashSprite.position.set(0, 0.005, -0.74);
    this.muzzlePoint.position.set(0, 0.005, -0.72);
    m.add(this.flashSprite, this.muzzlePoint);
    this.light.position.set(0, 0, -0.8);
    m.add(this.light);

    this.root.add(m);
    this.root.scale.setScalar(0.75);
    this.root.position.set(0.19, -0.2, -0.42);
    this.root.rotation.set(0.02, 0.06, 0); // converge on the crosshair
    rig.add(this.root);
  }

  fire() {
    this.kick = 1;
    this.heat = Math.min(1, this.heat + 0.18);
    this.flashSprite.rotation.z = Math.random() * Math.PI;
  }

  look(dx: number, dy: number) {
    this.sway.x = THREE.MathUtils.clamp(this.sway.x - dx * 0.0004, -0.04, 0.04);
    this.sway.y = THREE.MathUtils.clamp(this.sway.y + dy * 0.0004, -0.04, 0.04);
  }

  muzzle(out: THREE.Vector3) {
    return this.muzzlePoint.getWorldPosition(out);
  }

  update(dt: number, speed: number, grounded: boolean) {
    this.kick = Math.max(0, this.kick - dt * 9);
    this.heat = Math.max(0, this.heat - dt * 0.6);
    if (grounded) this.bob += dt * speed * 1.4;
    const bobAmp = Math.min(1, speed / 7) * (grounded ? 1 : 0.2);
    this.sway.multiplyScalar(Math.pow(0.002, dt));
    const m = this.model;
    m.position.set(
      Math.sin(this.bob) * 0.012 * bobAmp + this.sway.x,
      Math.abs(Math.cos(this.bob)) * 0.012 * bobAmp + this.sway.y - this.kick * 0.012,
      this.kick * 0.07,
    );
    m.rotation.x = this.kick * 0.12;
    const flash = this.kick > 0.6 ? (this.kick - 0.6) / 0.4 : 0;
    (this.flashSprite.material as THREE.MeshBasicMaterial).opacity = flash;
    this.flashSprite.scale.setScalar(0.6 + flash);
    this.light.intensity = flash * 1.5;
    this.coils.color.setHex(PLAYER_COLOR).multiplyScalar(1.1 + this.heat * 1.4 + Math.sin(performance.now() / 120) * 0.15);
  }
}

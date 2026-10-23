// The first-person karambit: a curved claw blade with a cyan energy edge, a
// wrapped cream handle and a finger ring at the pommel. It shares the rifle's
// viewmodel rig. Q draws it with a spin around the ring; F inspects it the way
// CS:GO does, spinning it around the finger on a tilted axis; left click slashes.
import * as THREE from "three";
import { PALETTE, glow, merge, outline, paint, plate, smoothstep, toonMaterial } from "./kit";

const { cream: CREAM, navy: NAVY, gold: GOLD, cyan: CYAN } = PALETTE;
const DRAW_S = 0.6;
const SLASH_S = 0.32;
const INSPECT_S = 2.8;
const s = smoothstep;

/** A flat 2D shape (x forward, y up), extruded `depth` thick and turned so x runs along -z. */
function slab(shape: THREE.Shape, depth: number) {
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 16 })
    .translate(0, 0, -depth / 2)
    .rotateY(Math.PI / 2);
}

export class Knife {
  root = new THREE.Group();
  /** 0 in hand, 1 put away (hidden). */
  lowered = 1;
  private spinner = new THREE.Group(); // turns around the finger ring, at its origin
  private hip = new THREE.Vector3(0.19, -0.19, -0.32);
  private hipRot = new THREE.Euler(0.65, 0.55, -0.15);
  private show = new THREE.Vector3(0.07, -0.08, -0.34); // held up to look at
  private showRot = new THREE.Euler(0.45, -1.05, 0.35); // the ring's axis tipped toward the eye
  private sway = new THREE.Vector2();
  private bob = 0;
  private drawT = DRAW_S;
  private slashT = SLASH_S;
  private slashSide = 1;
  private inspectT = -1;

  constructor(rig: THREE.Object3D) {
    // The knife lies in the y-z plane: the ring at the origin (its hole along x),
    // the handle running forward (-z), and the blade hooking down at the end.
    const ring = paint(new THREE.TorusGeometry(0.017, 0.0045, 8, 28).rotateY(Math.PI / 2), { color: CREAM });
    const handle = merge([
      paint(plate(0.009, 0.022, 0.076, { bevel: 0.0025 }).translate(0, 0, -0.054), { color: CREAM }),
      ...[-0.036, -0.054, -0.072].map((z) => paint(plate(0.0105, 0.0235, 0.007, { bevel: 0.001 }).translate(0, 0, z), { color: NAVY })),
      paint(plate(0.011, 0.026, 0.006, { bevel: 0.0015 }).translate(0, 0, -0.094), { color: GOLD }),
    ]);
    const spine = new THREE.Shape();
    spine.moveTo(0, 0.01);
    spine.quadraticCurveTo(0.055, 0.017, 0.086, -0.042); // the back of the claw, to the tip
    spine.quadraticCurveTo(0.045, -0.004, 0, -0.01); // the inside curve: the edge
    const edge = new THREE.Shape();
    edge.moveTo(0, -0.01);
    edge.quadraticCurveTo(0.045, -0.004, 0.086, -0.042);
    edge.quadraticCurveTo(0.042, 0.0015, 0, -0.0045);
    const blade = merge([
      paint(slab(spine, 0.0034).translate(0, 0, -0.097), { color: 0xc9d3dc }),
      paint(slab(edge, 0.0042).translate(0, 0, -0.097), { color: 0xffffff, emit: glow(CYAN, 1.6) }),
    ]);
    this.spinner.add(outline(new THREE.Mesh(merge([ring, handle, blade]), toonMaterial()), 0.0028, 0x10161f));
    this.root.add(this.spinner);
    this.root.scale.setScalar(1.3);
    this.root.visible = false;
    rig.add(this.root);
  }

  /** Start the draw: it comes up spinning once around the ring. */
  draw() {
    this.drawT = 0;
    this.inspectT = -1;
  }

  /** Start the inspect routine; false if the knife is busy. */
  inspect() {
    if (this.inspectT >= 0 || this.drawT < DRAW_S) return false;
    this.inspectT = 0;
    return true;
  }

  slash() {
    this.slashT = 0;
    this.slashSide = -this.slashSide;
    this.inspectT = -1;
  }

  look(dx: number, dy: number) {
    this.sway.x = THREE.MathUtils.clamp(this.sway.x - dx * 0.0004, -0.04, 0.04);
    this.sway.y = THREE.MathUtils.clamp(this.sway.y + dy * 0.0004, -0.04, 0.04);
  }

  update(dt: number, speed: number, grounded: boolean) {
    this.root.visible = this.lowered < 1;
    this.drawT = Math.min(DRAW_S, this.drawT + dt);
    this.slashT = Math.min(SLASH_S, this.slashT + dt);
    if (this.inspectT >= 0) this.inspectT += dt;
    if (this.inspectT > INSPECT_S) this.inspectT = -1;
    if (grounded) this.bob += dt * speed * 1.4;
    this.sway.multiplyScalar(Math.pow(0.002, dt));

    // Spins around the ring, and how far toward the inspect pose the hand is.
    let spin = 0, pose = 0, turn = 0;
    const d = this.drawT / DRAW_S;
    if (d < 1) spin = -Math.PI * 2 * s(0, 0.85, d);
    const t = this.inspectT;
    if (t >= 0) {
      pose = s(0, 0.3, t) * (1 - s(2.4, 2.8, t));
      spin = -Math.PI * 4 * s(0.35, 1.75, t); // two turns around the finger, wound up and caught
      turn = Math.PI * s(1.85, 2.2, t) * pose; // then a look at the other side
    }
    this.spinner.rotation.x = spin;

    // Where the hand holds it: hip, raised to look at, thrust out for a slash.
    const r = this.root, h = this.hipRot, v = this.showRot;
    r.position.lerpVectors(this.hip, this.show, pose);
    r.rotation.set(h.x + (v.x - h.x) * pose, h.y + (v.y - h.y) * pose + turn, h.z + (v.z - h.z) * pose);
    const k = this.slashT / SLASH_S;
    if (k < 1) {
      const swing = s(0, 0.55, k) - 0.5; // right to left, or back
      const reach = Math.sin(k * Math.PI);
      r.position.x += -swing * 0.22 * this.slashSide;
      r.position.y += reach * 0.04;
      r.position.z -= reach * 0.14;
      r.rotation.z += swing * 1.4 * this.slashSide;
      r.rotation.x -= reach * 0.5;
    }
    const bobAmp = Math.min(1, speed / 7) * (grounded ? 1 : 0.2) * (1 - pose);
    r.position.x += Math.sin(this.bob) * 0.012 * bobAmp + this.sway.x;
    r.position.y += Math.abs(Math.cos(this.bob)) * 0.012 * bobAmp + this.sway.y - (1 - s(0, 0.5, d)) * 0.25 - this.lowered * 0.4;
  }
}

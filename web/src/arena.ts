// Builds the arena from the level the server sent: meshes, lights, and the
// Rapier colliders used for shot ray casts and debris.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Level } from "./protocol";
import { SWARM_COLORS } from "./protocol";
import type { Box, Ramp } from "./physics";

export const neon = (hex: number, k = 1) =>
  new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: false });

function gridTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = "rgba(41,240,255,0.55)";
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 509, 509);
  g.strokeStyle = "rgba(140,90,255,0.35)";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(256, 0); g.lineTo(256, 512); g.moveTo(0, 256); g.lineTo(512, 256);
  g.stroke();
  g.fillStyle = "rgba(41,240,255,0.8)";
  for (const [x, y] of [[0, 0], [512, 0], [0, 512], [512, 512]]) g.fillRect(x - 10, y - 10, 20, 20);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function panelTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#8a86b0";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 18; i++) {
    const shade = 120 + Math.floor(Math.random() * 40);
    g.fillStyle = `rgb(${shade - 10},${shade - 12},${shade + 20})`;
    const x = Math.floor(Math.random() * 4) * 64, y = Math.floor(Math.random() * 4) * 64;
    g.fillRect(x + 3, y + 3, 58 + Math.floor(Math.random() * 2) * 64, 58);
  }
  g.strokeStyle = "rgba(10,8,30,0.9)";
  g.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const metal = (color: number, map?: THREE.Texture) =>
  new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.42, flatShading: true, ...(map ? { map } : {}) });

// A copy of `base` whose texture repeats (rx, ry) times.
function tiled(base: THREE.MeshStandardMaterial, rx: number, ry: number): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.map = base.map!.clone();
  m.map.repeat.set(rx, ry);
  m.map.needsUpdate = true;
  return m;
}

function boxMesh(b: Box, mat: THREE.Material): THREE.Mesh {
  const [x0, y0, z0, x1, y1, z1] = b;
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return m;
}

// A glowing bar between two points.
function strip(a: THREE.Vector3, b: THREE.Vector3, w: number, mat: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, w, len), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b);
  return m;
}

function topEdges(b: Box, mat: THREE.Material, w = 0.07, inset = 0): THREE.Group {
  const [x0, , z0, x1, y1, z1] = b;
  const y = y1 + w / 2;
  const g = new THREE.Group();
  const c = [
    new THREE.Vector3(x0 + inset, y, z0 + inset), new THREE.Vector3(x1 - inset, y, z0 + inset),
    new THREE.Vector3(x1 - inset, y, z1 - inset), new THREE.Vector3(x0 + inset, y, z1 - inset),
  ];
  for (let i = 0; i < 4; i++) g.add(strip(c[i], c[(i + 1) % 4], w, mat));
  return g;
}

function rampGeometry(r: Ramp): THREE.BufferGeometry {
  const [x0, z0, x1, z1, axis, h0, h1] = r;
  // Height at each footprint corner, then a closed wedge.
  const h = (x: number, z: number) => (axis === "x" ? h0 + (h1 - h0) * (x - x0) / (x1 - x0) : h0 + (h1 - h0) * (z - z0) / (z1 - z0));
  const corners: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const top = corners.map(([x, z]) => new THREE.Vector3(x, h(x, z), z));
  const bot = corners.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const tri: THREE.Vector3[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => tri.push(a, b, c, a, c, d);
  quad(top[0], top[3], top[2], top[1]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(bot[i], bot[j], top[j], top[i]);
  }
  const g = new THREE.BufferGeometry().setFromPoints(tri);
  g.computeVertexNormals();
  return g;
}

export interface Arena {
  group: THREE.Group;
  rapier: RAPIER.World;
  levelColliders: Set<number>;
  gates: THREE.Object3D[];
  update(t: number): void;
}

export function buildArena(scene: THREE.Scene, level: Level, rapier: RAPIER.World): Arena {
  const group = new THREE.Group();
  const levelColliders = new Set<number>();
  const spinners: THREE.Object3D[] = [];
  const cyan = neon(0x29f0ff, 2.2);
  const magenta = neon(0xff2bd1, 2.2);
  const violet = neon(0x8a5bff, 2.0);
  const panels = panelTexture();

  // Floor
  const grid = gridTexture();
  grid.repeat.set(level.half / 2, level.half / 2);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(level.half * 2, level.half * 2),
    new THREE.MeshStandardMaterial({
      color: 0x0b0a18, metalness: 0.7, roughness: 0.35,
      emissive: 0xffffff, emissiveMap: grid, emissiveIntensity: 0.55,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);
  const floorBody = rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  levelColliders.add(rapier.createCollider(RAPIER.ColliderDesc.cuboid(level.half + 2, 0.5, level.half + 2).setTranslation(0, -0.5, 0), floorBody).handle);

  const wallMat = metal(0x2a2648, panels);
  const platMat = metal(0x24203f, panels);
  const coverMat = metal(0x302b55);
  const crateMat = metal(0x1c1934);
  const pillarMat = metal(0x221f3c);

  for (const b of level.boxes) {
    const [x0, y0, z0, x1, y1, z1, kind] = b;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0, h = y1 - y0;
    levelColliders.add(rapier.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(cx, (y0 + y1) / 2, cz), floorBody).handle);
    if (kind === "wall") {
      group.add(boxMesh(b, tiled(wallMat, Math.max(w, d) / 4, h / 4)));
      // Ribs and two glowing bands along the inner face.
      const along = w > d ? "x" : "z";
      const inner = along === "x" ? (cz > 0 ? z0 : z1) : (cx > 0 ? x0 : x1);
      const sign = along === "x" ? (cz > 0 ? -1 : 1) : (cx > 0 ? -1 : 1);
      const len = along === "x" ? w : d;
      const mat = along === "x" ? (cz > 0 ? violet : magenta) : cyan;
      for (const y of [1.0, h - 0.6]) {
        const a = along === "x" ? new THREE.Vector3(-len / 2 + 1, y, inner + sign * 0.05) : new THREE.Vector3(inner + sign * 0.05, y, -len / 2 + 1);
        const e = along === "x" ? new THREE.Vector3(len / 2 - 1, y, inner + sign * 0.05) : new THREE.Vector3(inner + sign * 0.05, y, len / 2 - 1);
        group.add(strip(a, e, y < 2 ? 0.08 : 0.14, mat));
      }
      for (let s = -len / 2 + 4; s < len / 2 - 2; s += 8) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(along === "x" ? 0.8 : 0.6, h + 0.6, along === "x" ? 0.6 : 0.8), pillarMat);
        rib.position.set(along === "x" ? s : inner + sign * 0.3, h / 2 + 0.3, along === "x" ? inner + sign * 0.3 : s);
        group.add(rib);
        const glow = new THREE.Mesh(new THREE.BoxGeometry(along === "x" ? 0.12 : 0.05, h - 2, along === "x" ? 0.05 : 0.12), mat);
        glow.position.set(along === "x" ? s : inner + sign * 0.62, h / 2, along === "x" ? inner + sign * 0.62 : s);
        group.add(glow);
      }
    } else if (kind === "platform") {
      group.add(boxMesh(b, tiled(platMat, w / 4, d / 4)), topEdges(b, cyan, 0.08));
      // Glowing side slits
      for (let y = 0.5; y < h - 0.3; y += 0.9) {
        group.add(strip(new THREE.Vector3(x0 - 0.02, y, z0 + 0.6), new THREE.Vector3(x0 - 0.02, y, z1 - 0.6), 0.04, violet));
        group.add(strip(new THREE.Vector3(x1 + 0.02, y, z0 + 0.6), new THREE.Vector3(x1 + 0.02, y, z1 - 0.6), 0.04, violet));
      }
    } else if (kind === "pillar") {
      const r = Math.max(w, d) * 0.58;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r, h, 8, 1), pillarMat);
      p.position.set(cx, h / 2, cz);
      p.rotation.y = Math.PI / 8;
      group.add(p);
      for (const y of [0.4, 3.2, h - 0.5]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.95, 0.06, 4, 8), y < 1 ? cyan : magenta);
        ring.rotation.x = Math.PI / 2;
        ring.rotation.z = Math.PI / 8;
        ring.position.set(cx, y, cz);
        group.add(ring);
      }
      const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.9, 1.2, 8), pillarMat);
      cap.position.set(cx, h + 0.6, cz);
      group.add(cap);
    } else if (kind === "cover") {
      // A barrier with a chamfered top.
      const shape = new THREE.Shape();
      const t = Math.min(w, d);
      shape.moveTo(-t / 2, 0); shape.lineTo(t / 2, 0); shape.lineTo(t / 2, h - 0.3);
      shape.lineTo(t / 4, h); shape.lineTo(-t / 4, h); shape.lineTo(-t / 2, h - 0.3); shape.closePath();
      const len = Math.max(w, d);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
      geo.translate(0, 0, -len / 2);
      const m = new THREE.Mesh(geo, coverMat);
      m.position.set(cx, 0, cz);
      if (w > d) m.rotation.y = Math.PI / 2;
      group.add(m);
      const a = w > d ? new THREE.Vector3(x0 + 0.2, h - 0.05, cz) : new THREE.Vector3(cx, h - 0.05, z0 + 0.2);
      const e = w > d ? new THREE.Vector3(x1 - 0.2, h - 0.05, cz) : new THREE.Vector3(cx, h - 0.05, z1 - 0.2);
      group.add(strip(a, e, 0.07, magenta));
    } else {
      const m = boxMesh(b, crateMat);
      group.add(m);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: new THREE.Color(0x8a5bff).multiplyScalar(2.5), toneMapped: false }));
      edges.position.copy(m.position);
      group.add(edges);
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), cyan);
      core.position.set(cx, y1 + 0.35, cz);
      spinners.push(core);
      group.add(core);
    }
  }

  for (const r of level.ramps) {
    const geo = rampGeometry(r);
    group.add(new THREE.Mesh(geo, platMat));
    const [x0, z0, x1, z1, axis, h0, h1] = r;
    const verts = geo.attributes.position.array as Float32Array;
    levelColliders.add(rapier.createCollider(RAPIER.ColliderDesc.convexHull(verts)!, floorBody).handle);
    // Chevrons up the ramp.
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const along = axis === "z" ? z0 + (z1 - z0) * t : x0 + (x1 - x0) * t;
      const y = h0 + (h1 - h0) * t + 0.03;
      const mid = axis === "z" ? (x0 + x1) / 2 : (z0 + z1) / 2;
      const span = (axis === "z" ? x1 - x0 : z1 - z0) * 0.3;
      const up = h1 > h0 ? 1 : -1;
      const tip = axis === "z" ? new THREE.Vector3(mid, y, along + up * 0.4) : new THREE.Vector3(along + up * 0.4, y, mid);
      for (const side of [-1, 1]) {
        const tail = axis === "z" ? new THREE.Vector3(mid + side * span, y, along - up * 0.4) : new THREE.Vector3(along - up * 0.4, y, mid + side * span);
        tail.y = y; tip.y = y;
        group.add(strip(tail, tip, 0.06, cyan));
      }
    }
  }

  // Spawn gates: rotating rings in each swarm's color.
  const gates: THREE.Object3D[] = [];
  for (const [swarm, list] of Object.entries(level.gates)) {
    const mat = neon(SWARM_COLORS[swarm as "alpha" | "bravo"], 2.5);
    for (const [x, z] of list) {
      const gate = new THREE.Group();
      gate.position.set(x, 0, z);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.1, 0.12, 6), metal(0x15122a));
      pad.position.y = 0.06;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.05, 3, 6), mat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.16;
      const halo = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.04, 3, 6), mat);
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 3.2;
      gate.add(pad, ring, halo);
      gate.userData.halo = halo;
      gates.push(gate);
      group.add(gate);
    }
  }

  // Megastructures beyond the walls, half lost in fog.
  const towerMat = metal(0x0d0b1c);
  const edgeMat = [0x29f0ff, 0xff2bd1, 0x8a5bff].map((c) => new THREE.LineBasicMaterial({ color: new THREE.Color(c).multiplyScalar(0.7), toneMapped: false }));
  const rnd = mulberry(7);
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rnd() * 0.1;
    const dist = 55 + rnd() * 60;
    const h = 20 + rnd() * 70;
    const r = 3 + rnd() * 6;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(r * (0.5 + rnd() * 0.5), r, h, 4 + Math.floor(rnd() * 3)), towerMat);
    tower.position.set(Math.cos(a) * dist, h / 2 - 2, Math.sin(a) * dist);
    tower.rotation.y = rnd() * Math.PI;
    group.add(tower);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(tower.geometry), edgeMat[i % 3]);
    edges.position.copy(tower.position);
    edges.rotation.copy(tower.rotation);
    group.add(edges);
  }

  // Floating dust
  const dust = new THREE.BufferGeometry();
  const pts = new Float32Array(900 * 3);
  for (let i = 0; i < 900; i++) {
    pts[i * 3] = (rnd() - 0.5) * level.half * 2;
    pts[i * 3 + 1] = rnd() * 14;
    pts[i * 3 + 2] = (rnd() - 0.5) * level.half * 2;
  }
  dust.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  const dustPoints = new THREE.Points(dust, new THREE.PointsMaterial({ color: 0x9b8cff, size: 0.06, transparent: true, opacity: 0.6, depthWrite: false }));
  group.add(dustPoints);

  // Lights
  group.add(new THREE.HemisphereLight(0x8a7cff, 0x120e2a, 1.3));
  const moon = new THREE.DirectionalLight(0xb4c4ff, 1.6);
  moon.position.set(-20, 40, 10);
  group.add(moon);
  const lights: [number, number, number, number, number][] = [
    [0x29f0ff, 0, 7, 0, 60], [0xff2bd1, 0, 6, -24, 50], [0x6d7bff, 0, 6, 24, 50],
    [0x8a5bff, 26, 7, 0, 40], [0x8a5bff, -26, 7, 0, 40],
  ];
  for (const [c, x, y, z, i] of lights) {
    const l = new THREE.PointLight(c, i, 34, 1.6);
    l.position.set(x, y, z);
    group.add(l);
  }

  scene.add(group);
  return {
    group, rapier, levelColliders, gates,
    update(t: number) {
      for (const g of gates) {
        g.rotation.y = t * 0.6;
        g.userData.halo.position.y = 3.2 + Math.sin(t * 2 + g.position.x) * 0.25;
      }
      dustPoints.rotation.y = t * 0.01;
      for (const s of spinners) s.rotation.y = t * 1.5;
    },
  };
}

// A reflection environment of neon panels, so metal picks up the arena's colors.
export function neonEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x0a0818);
  const panel = (color: number, k: number, x: number, y: number, z: number, w: number, h: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(0x9a8cff, 1.2, 0, 10, 0, 14, 14);
  panel(0x29f0ff, 3, -10, 1, 0, 3, 10);
  panel(0xff2bd1, 3, 10, 1, 2, 3, 10);
  panel(0x6d7bff, 2.5, 0, 2, -10, 10, 3);
  panel(0x8a5bff, 2, 0, 0, 10, 10, 2);
  panel(0x151030, 1, 0, -10, 0, 30, 30);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
  return tex;
}

export function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

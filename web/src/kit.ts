// The mecha toolkit: palette, noise, cel-shaded materials, outlines and
// hard-surface geometry builders.
//
// A painted geometry carries three attributes:
//   color  base color (vertex colors)
//   emit   emitted light, linear RGB scaled by intensity (0 = no glow)
//   phase  offset for pulses, and position along a part for travelling glows
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const PALETTE = {
  concrete: 0xd8d5c8, // bright concrete
  slate: 0x63748c, // structural shadows
  steel: 0x788b9a, // industrial machinery
  vermilion: 0xef5145, // primary enemy armor
  cream: 0xeae6d8, // secondary armor
  cyan: 0x27ddf2, // energy weapons
  gold: 0xffc857, // warning details
  navy: 0x273347, // dark mechanical joints
  sky: 0xa9d8ed, // atmospheric sky
  orange: 0xf08a3c, // heavy-frame markings
  gray: 0x9c968a, // warm gray armor
};

export const uTime = { value: 0 };

// Noise

function hash(x: number, y: number, z: number, seed: number) {
  let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ Math.imul(seed, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Smooth value noise in [0, 1]. */
export function noise(x: number, y: number, z: number, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A glow color: `hex` at `k` times its brightness. */
export const glow = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

// Painting

type Field<T> = T | ((p: THREE.Vector3, n: THREE.Vector3) => T);
export interface Paint {
  color: Field<THREE.ColorRepresentation | THREE.Color>;
  emit?: Field<THREE.Color | null>;
  phase?: number | ((p: THREE.Vector3) => number);
  /** Evaluate color and glow once per face, at its center: crisp decals on flat faces. */
  perFace?: boolean;
}

const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

export function paint(geo: THREE.BufferGeometry, o: Paint): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) if (name !== "position") g.deleteAttribute(name);
  g.computeVertexNormals(); // non-indexed: one normal per face, so surfaces read flat
  const pos = g.attributes.position, nor = g.attributes.normal, count = pos.count;
  const col = new Float32Array(count * 3), emi = new Float32Array(count * 3), phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    if (o.perFace) {
      const f = i - (i % 3);
      _p.set(0, 0, 0);
      for (let k = 0; k < 3; k++) _p.add(new THREE.Vector3().fromBufferAttribute(pos, f + k));
      _p.multiplyScalar(1 / 3);
    } else {
      _p.fromBufferAttribute(pos, i);
    }
    _n.fromBufferAttribute(nor, i);
    const c = typeof o.color === "function" ? o.color(_p, _n) : o.color;
    _c.set(c as THREE.ColorRepresentation);
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
    const e = typeof o.emit === "function" ? o.emit(_p, _n) : o.emit;
    if (e) { emi[i * 3] = e.r; emi[i * 3 + 1] = e.g; emi[i * 3 + 2] = e.b; }
    phase[i] = typeof o.phase === "function" ? o.phase(_p) : o.phase ?? 0;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("emit", new THREE.BufferAttribute(emi, 3));
  g.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
  return g;
}

export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(geos, false);
  if (!g) throw new Error("merge: geometries don't share attributes");
  for (const x of geos) x.dispose();
  return g;
}

/** Move every vertex through `fn`. */
export function warp(g: THREE.BufferGeometry, fn: (p: THREE.Vector3) => void): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    fn(p.fromBufferAttribute(pos, i));
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  return g;
}

// Hard-surface shapes

export interface PlateOptions {
  bevel?: number;
  /** Width and depth of the top face relative to the bottom (taper). */
  top?: number;
  topD?: number;
  /** Shift the top face along z (a raked front). */
  shear?: number;
}

/**
 * A chamfered box, centered on the origin: every corner is cut, so edges
 * catch a highlight. Built as a convex hull, so it can taper and rake too.
 */
export function plate(w: number, h: number, d: number, o: PlateOptions = {}): THREE.BufferGeometry {
  const b = o.bevel ?? Math.min(w, h, d) * 0.18;
  const pts: THREE.Vector3[] = [];
  for (const sy of [-1, 1]) {
    const hw = (w / 2) * (sy > 0 ? o.top ?? 1 : 1), hd = (d / 2) * (sy > 0 ? o.topD ?? 1 : 1);
    const zo = sy > 0 ? o.shear ?? 0 : 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const cx = sx * hw, cy = (sy * h) / 2, cz = sz * hd + zo;
      pts.push(new THREE.Vector3(cx - sx * b, cy, cz), new THREE.Vector3(cx, cy - sy * b, cz), new THREE.Vector3(cx, cy, cz - sz * b));
    }
  }
  return new ConvexGeometry(pts);
}

/** A convex shape from a 2D outline (in x, y), extruded `d` along z and chamfered. */
export function prism(outline: [number, number][], d: number, bevel = 0.02): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (const [x, y] of outline) {
    pts.push(new THREE.Vector3(x, y, -d / 2 + bevel), new THREE.Vector3(x, y, d / 2 - bevel));
    const len = Math.hypot(x, y) || 1;
    pts.push(new THREE.Vector3(x - (x / len) * bevel, y - (y / len) * bevel, -d / 2), new THREE.Vector3(x - (x / len) * bevel, y - (y / len) * bevel, d / 2));
  }
  return new ConvexGeometry(pts);
}

export function cylinder(rTop: number, rBottom: number, h: number, sides = 8) {
  return new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1);
}

// Cel shading

/** Three tones of light: the shadow tone stays light, so shaded faces keep their detail. */
export const toonRamp = (() => {
  const t = new THREE.DataTexture(new Uint8Array([120, 185, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

export interface ToonUniforms {
  glow: { value: number }; // scales emission
  flash: { value: THREE.Color }; // added emission (hit flashes)
  pulse: { value: number };
  pulseSpeed: { value: number };
  flow: { value: number }; // a travelling glow along `phase`
  flowAmp: { value: number };
}

export interface ToonOptions {
  map?: THREE.Texture;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  pulse?: number;
  pulseSpeed?: number;
}

export type ToonMaterial = THREE.MeshToonMaterial & { userData: { u: ToonUniforms } };

export function toonMaterial(o: ToonOptions = {}): ToonMaterial {
  const m = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: toonRamp,
    emissive: 0xffffff,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
    ...(o.map ? { map: o.map } : {}),
  }) as ToonMaterial;
  const u: ToonUniforms = {
    glow: { value: 1 },
    flash: { value: new THREE.Color(0) },
    pulse: { value: o.pulse ?? 0 },
    pulseSpeed: { value: o.pulseSpeed ?? 2 },
    flow: { value: -1 },
    flowAmp: { value: 0 },
  };
  m.userData.u = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime, uGlow: u.glow, uFlash: u.flash, uPulse: u.pulse, uPulseSpeed: u.pulseSpeed, uFlow: u.flow, uFlowAmp: u.flowAmp });
    sh.vertexShader = "attribute vec3 emit; attribute float phase; varying vec3 vEmit; varying float vPhase;\n" +
      sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n vEmit = emit; vPhase = phase;");
    sh.fragmentShader = `
      uniform float uTime; uniform float uGlow; uniform vec3 uFlash; uniform float uPulse; uniform float uPulseSpeed;
      uniform float uFlow; uniform float uFlowAmp; varying vec3 vEmit; varying float vPhase;
    ` + sh.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      float beat = 1.0 + uPulse * sin(uTime * uPulseSpeed + vPhase);
      float surge = uFlowAmp * exp(-pow(vPhase - uFlow, 2.0) * 60.0);
      totalEmissiveRadiance = vEmit * uGlow * (beat + surge) + uFlash;`);
  };
  m.customProgramCacheKey = () => "toon-1";
  return m;
}

// Outlines: an inverted hull, pushed out along smoothed normals by a fixed
// fraction of the view distance, so it stays about the same width on screen.

/** Average each vertex's normal over every face sharing its position, so the hull has no cracks. */
export function outlineNormals(g: THREE.BufferGeometry) {
  if (g.attributes.onormal) return;
  const pos = g.attributes.position, nor = g.attributes.normal;
  const sum = new Map<string, THREE.Vector3>();
  const key = (i: number) => `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const v = sum.get(k) ?? sum.set(k, new THREE.Vector3()).get(k)!;
    v.x += nor.getX(i); v.y += nor.getY(i); v.z += nor.getZ(i);
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = sum.get(key(i))!.clone().normalize();
    out.set([v.x, v.y, v.z], i * 3);
  }
  g.setAttribute("onormal", new THREE.BufferAttribute(out, 3));
}

const outlineMats = new Map<string, THREE.ShaderMaterial>();
export function outlineMaterial(width = 0.0028, color = 0x1a2233): THREE.ShaderMaterial {
  const k = `${width}:${color}`;
  let m = outlineMats.get(k);
  if (m) return m;
  m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { color: { value: new THREE.Color(color) }, width: { value: width } }]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec3 onormal;
      uniform float width;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * onormal);
        mvPosition.xyz += n * width * max(0.25, -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 color;
      void main() {
        gl_FragColor = vec4(color, 1.0);
        #include <fog_fragment>
      }`,
  });
  outlineMats.set(k, m);
  return m;
}

/** Give `mesh` an outline child sharing its geometry. */
export function outline<T extends THREE.Mesh>(mesh: T, width?: number, color?: number): T {
  outlineNormals(mesh.geometry);
  const o = new THREE.Mesh(mesh.geometry, outlineMaterial(width, color));
  o.userData.outline = true;
  o.raycast = () => {};
  mesh.add(o);
  return mesh;
}

/** A canvas texture drawn by `draw`. */
export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// The organic toolkit: palette, noise, one animated material for everything
// alive, and geometry builders. Every glowing or swaying surface shares
// `uTime`, so nothing needs its own update loop.
//
// A painted geometry carries five attributes:
//   color  base color (vertex colors)
//   emit   emitted light, linear RGB scaled by intensity (0 = matte)
//   vein   where the material's glowing veins show (0 to 1). The veins are
//          drawn per pixel, so they stay thin and crisp on coarse meshes.
//   sway   how far the vertex sways (0 at roots, larger at tips)
//   phase  offset for pulses and sway, so neighbors don't move in lockstep
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const PALETTE = {
  shadow: 0x10142b, // deep atmospheric shadows
  terrain: 0x173c45, // alien terrain
  cyan: 0x42e8d1, // primary bioluminescence
  violet: 0xa66bff, // secondary bioluminescence
  turquoise: 0x55ffb8, // fungal highlights
  coral: 0xff7957, // hostile organisms
  fog: 0x34365f, // ambient fog
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

/** Fractal noise in roughly [0, 1]. */
export function fbm(x: number, y: number, z: number, seed = 0, octaves = 4) {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * noise(x * f, y * f, z * f, seed + i * 17);
    norm += a;
    a *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
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

// Painting

type Field<T> = T | ((p: THREE.Vector3, n: THREE.Vector3) => T);
export interface Paint {
  color: Field<THREE.ColorRepresentation | THREE.Color>;
  emit?: Field<THREE.Color | null>;
  vein?: number | ((p: THREE.Vector3, n: THREE.Vector3) => number);
  sway?: number | ((p: THREE.Vector3) => number);
  phase?: number | ((p: THREE.Vector3) => number);
  /** Keep the index (smooth shading, fewer vertices). */
  indexed?: boolean;
}

const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/** A glow color: `hex` at `k` times its brightness. */
export const glow = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

export function paint(geo: THREE.BufferGeometry, o: Paint): THREE.BufferGeometry {
  const g = o.indexed || !geo.index ? geo : geo.toNonIndexed();
  for (const name of Object.keys(g.attributes)) if (name !== "position") g.deleteAttribute(name);
  g.computeVertexNormals();
  const pos = g.attributes.position, nor = g.attributes.normal, count = pos.count;
  const col = new Float32Array(count * 3), emi = new Float32Array(count * 3);
  const sway = new Float32Array(count), phase = new Float32Array(count), vein = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    _p.fromBufferAttribute(pos, i);
    _n.fromBufferAttribute(nor, i);
    const c = typeof o.color === "function" ? o.color(_p, _n) : o.color;
    _c.set(c as THREE.ColorRepresentation);
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
    const e = typeof o.emit === "function" ? o.emit(_p, _n) : o.emit;
    if (e) { emi[i * 3] = e.r; emi[i * 3 + 1] = e.g; emi[i * 3 + 2] = e.b; }
    sway[i] = typeof o.sway === "function" ? o.sway(_p) : o.sway ?? 0;
    phase[i] = typeof o.phase === "function" ? o.phase(_p) : o.phase ?? 0;
    vein[i] = typeof o.vein === "function" ? o.vein(_p, _n) : o.vein ?? 0;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("emit", new THREE.BufferAttribute(emi, 3));
  g.setAttribute("sway", new THREE.BufferAttribute(sway, 1));
  g.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
  g.setAttribute("vein", new THREE.BufferAttribute(vein, 1));
  return g;
}

export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(geos, false);
  if (!g) throw new Error("merge: geometries don't share attributes");
  for (const x of geos) x.dispose();
  return g;
}

// The material

export interface BioUniforms {
  glow: { value: number }; // overall marking intensity
  flash: { value: THREE.Color }; // added emission (hit flashes)
  swayAmp: { value: number };
  pulse: { value: number }; // pulse depth
  pulseSpeed: { value: number };
  flow: { value: number }; // position of a travelling glow along `phase` (the rifle's veins)
  flowAmp: { value: number };
  veinColor: { value: THREE.Color }; // light in the veins (already scaled)
  veinFreq: { value: number }; // veins per unit of object space
  veinWidth: { value: number };
}

export interface BioOptions {
  rough?: number;
  metal?: number;
  flat?: boolean;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  sway?: number;
  pulse?: number;
  pulseSpeed?: number;
  envIntensity?: number;
  /** Glowing veins: color, brightness, frequency in object space, and width. */
  vein?: { color: number; k: number; freq: number; width?: number };
}

export type BioMaterial = THREE.MeshStandardMaterial & { userData: { u: BioUniforms } };

export function bioMaterial(o: BioOptions = {}): BioMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: o.rough ?? 0.85,
    metalness: o.metal ?? 0,
    flatShading: o.flat ?? true,
    emissive: 0xffffff,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
    envMapIntensity: o.envIntensity ?? 1,
    depthWrite: !(o.transparent ?? false),
  }) as BioMaterial;
  const u: BioUniforms = {
    glow: { value: 1 },
    flash: { value: new THREE.Color(0) },
    swayAmp: { value: o.sway ?? 0 },
    pulse: { value: o.pulse ?? 0 },
    pulseSpeed: { value: o.pulseSpeed ?? 1.5 },
    flow: { value: -1 },
    flowAmp: { value: 0 },
    veinColor: { value: o.vein ? glow(o.vein.color, o.vein.k) : new THREE.Color(0) },
    veinFreq: { value: o.vein?.freq ?? 1 },
    veinWidth: { value: o.vein?.width ?? 0.04 },
  };
  m.userData.u = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uTime, uGlow: u.glow, uFlash: u.flash, uSwayAmp: u.swayAmp,
      uPulse: u.pulse, uPulseSpeed: u.pulseSpeed, uFlow: u.flow, uFlowAmp: u.flowAmp,
      uVeinColor: u.veinColor, uVeinFreq: u.veinFreq, uVeinWidth: u.veinWidth,
    });
    sh.vertexShader = `
      uniform float uTime; uniform float uSwayAmp;
      attribute vec3 emit; attribute float sway; attribute float phase; attribute float vein;
      varying vec3 vEmit; varying float vPhase; varying float vVein; varying vec3 vObj;
    ` + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      vVein = vein;
      vObj = position;
      float ph = phase;
      #ifdef USE_INSTANCING
        ph += dot(instanceMatrix[3].xyz, vec3(0.37, 0.11, 0.23));
      #endif
      vPhase = ph;
      vEmit = emit;
      transformed += sway * uSwayAmp * vec3(sin(uTime * 1.3 + ph), 0.0, cos(uTime * 1.07 + ph * 1.3));`);
    sh.fragmentShader = `
      uniform float uTime; uniform float uGlow; uniform vec3 uFlash;
      uniform float uPulse; uniform float uPulseSpeed; uniform float uFlow; uniform float uFlowAmp;
      uniform vec3 uVeinColor; uniform float uVeinFreq; uniform float uVeinWidth;
      varying vec3 vEmit; varying float vPhase; varying float vVein; varying vec3 vObj;
      // Organic vein lines: where a sum of warped sine waves crosses zero.
      float veins(vec3 p) {
        p *= uVeinFreq;
        float n = sin(p.x + sin(p.z * 1.3) * 1.7) + sin(p.y * 1.1 + sin(p.x * 0.9) * 1.9) + sin(p.z * 0.8 + sin(p.y * 1.4) * 1.5);
        return 1.0 - smoothstep(0.0, fwidth(n) * 1.2 + uVeinWidth, abs(n));
      }
    ` + sh.fragmentShader.replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
      // Flat shading takes the normal from screen derivatives, which vanish on
      // sliver triangles (a cap's apex); a NaN there would flood the bloom.
      if (any(isnan(normal))) normal = vec3(0.0, 0.0, 1.0);`).replace("#include <dithering_fragment>", `#include <dithering_fragment>
      if (any(isnan(gl_FragColor.rgb))) gl_FragColor.rgb = vec3(0.0);`).replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      float beat = 1.0 + uPulse * sin(uTime * uPulseSpeed + vPhase);
      float surge = uFlowAmp * exp(-pow(vPhase - uFlow, 2.0) * 60.0);
      vec3 light = vEmit;
      if (vVein > 0.001) light += uVeinColor * veins(vObj) * vVein;
      totalEmissiveRadiance = light * uGlow * (beat + surge) + uFlash;`);
  };
  m.customProgramCacheKey = () => "bio-3";
  return m;
}

// Geometry builders

/** A tube along `points` whose radius follows `radius(t)`, t from 0 to 1. */
export function tube(points: THREE.Vector3[], radius: (t: number) => number, segs = 10, radial = 6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, c);
    const r = radius(i / segs);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  return g;
}

/** Move every vertex through `fn` (same input, same output, so no cracks). */
export function warp(g: THREE.BufferGeometry, fn: (p: THREE.Vector3) => void): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    fn(p.fromBufferAttribute(pos, i));
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  return g;
}

/** A lumpy ellipsoid. */
export function blob(sx: number, sy: number, sz: number, detail: number, amp: number, freq: number, seed: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  return warp(g, (p) => {
    const k = 1 + (fbm(p.x * freq + 9, p.y * freq, p.z * freq, seed, 3) - 0.5) * 2 * amp;
    p.multiplyScalar(k).set(p.x * sx, p.y * sy, p.z * sz);
  });
}

/** A mushroom cap: underside at y = 0 sloping down to a drooping rim, dome above. */
export function cap(radius: number, height: number, seed: number, segments = 18) {
  const R = radius, H = height;
  const profile = [
    [0.02, 0.0], [R * 0.25, -0.02 * H], [R * 0.6, -0.08 * H], [R * 0.88, -0.2 * H], [R, -0.32 * H],
    [R * 1.03, -0.16 * H], [R * 0.97, 0.2 * H], [R * 0.82, 0.55 * H], [R * 0.55, 0.85 * H], [R * 0.22, 1.0 * H], [0.001, 1.03 * H],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(profile, segments);
  // An irregular rim and a lumpy dome.
  return warp(g, (p) => {
    const a = Math.atan2(p.z, p.x);
    const r = Math.hypot(p.x, p.z);
    const k = 1 + (noise(Math.cos(a) * 1.7 + 3, Math.sin(a) * 1.7, seed * 0.13, seed) - 0.5) * 0.35 * (r / R);
    p.x *= k;
    p.z *= k;
    p.y += (fbm(p.x * 0.6, 4, p.z * 0.6, seed, 2) - 0.5) * 0.25 * H;
  });
}

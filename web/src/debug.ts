// F3: agent telemetry. F4: tactical overlay (paths, targets, formations).
// The telemetry panel also connects straight to each SwarmAgent, whose synced
// state is its persistent tactical memory.
import * as THREE from "three";
import { AgentClient } from "agents/client";
import type { GameEvent, Order, Snapshot, Swarm } from "./protocol";
import { SWARMS, SWARM_COLORS } from "./protocol";

type Decision = Extract<GameEvent, { k: "decision" }>;

export interface Unit { id: number; swarm: Swarm; pos: THREE.Vector3; height: number; mode: string }

const FIRING = new Set(["assault", "suppress", "fallback", "hold"]);

export class Debug {
  panel = false;
  viz = false;
  decisions: Partial<Record<Swarm, Decision & { at: number; count: number }>> = {};
  orders = new Map<number, Order>();
  memory: Partial<Record<Swarm, any>> = {};
  stats: Snapshot["st"] | undefined;
  snapRate = 0;
  private snapTimes: number[] = [];
  private clients: AgentClient[] = [];
  private lines: THREE.LineSegments;
  private body = document.getElementById("debug-body")!;
  private labels = document.getElementById("labels")!;
  private labelEls = new Map<number, HTMLDivElement>();
  private lastPanel = 0;

  constructor(scene: THREE.Scene, private room: string) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6 * 4000), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(6 * 4000), 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.9, depthTest: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  togglePanel() {
    this.panel = !this.panel;
    document.getElementById("debug")!.hidden = !this.panel;
    if (this.panel && !this.clients.length) {
      for (const sw of SWARMS) {
        this.clients.push(new AgentClient({
          agent: "swarm-agent", name: `${this.room}-${sw}`, host: location.host,
          onStateUpdate: (state: any) => { this.memory[sw] = state; },
        }));
      }
    }
  }

  toggleViz() {
    this.viz = !this.viz;
    this.lines.visible = this.viz;
    this.labels.hidden = !this.viz;
  }

  onSnapshot(s: Snapshot) {
    const now = performance.now();
    this.snapTimes = this.snapTimes.filter((t) => now - t < 1000);
    this.snapTimes.push(now);
    this.snapRate = this.snapTimes.length;
    if (s.st) this.stats = s.st;
  }

  onDecision(d: Decision) {
    const prev = this.decisions[d.sw];
    this.decisions[d.sw] = { ...d, at: performance.now(), count: (prev?.count ?? 0) + 1 };
    for (const [id, o] of Object.entries(d.orders)) this.orders.set(Number(id), o);
  }

  update(units: Unit[], player: THREE.Vector3, camera: THREE.Camera, rtt: number, interpMs: number) {
    if (this.viz) this.drawViz(units, player, camera);
    const now = performance.now();
    if (!this.panel || now - this.lastPanel < 200) return;
    this.lastPanel = now;
    const st = this.stats;
    const count = (sw: Swarm) => units.filter((u) => u.swarm === sw).length;
    const rows: [string, string][] = [
      ["arena tick rate", `${st?.hz ?? "–"} Hz (target 20)`],
      ["snapshots in", `${this.snapRate}/s`],
      ["websocket rtt", `${rtt.toFixed(0)} ms`],
      ["sync latency", `${(rtt / 2 + interpMs).toFixed(0)} ms (rtt/2 + ${interpMs} ms interpolation)`],
      ["active enemies", `${units.length} (α ${count("alpha")} · β ${count("bravo")})`],
      ["arena connections", `${st?.conns ?? "–"}`],
    ];
    let html = `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`;
    for (const sw of SWARMS) {
      const d = this.decisions[sw];
      const m = this.memory[sw];
      const age = d ? ((now - d.at) / 1000).toFixed(1) : "–";
      const status = d ? `<span class="${d.status === "applied" ? "ok" : "bad"}">${d.status}</span>` : "–";
      html += `<div class="sw ${sw}"><b>SwarmAgent ${esc(this.room)}-${sw}</b>
        <table>
          <tr><td>tactic</td><td>${esc(d?.tactic ?? "–")} · ${esc(d?.formation ?? "")}</td></tr>
          <tr><td>last decision</td><td>${esc(d?.note ?? "–")}</td></tr>
          <tr><td>decision</td><td>#${d?.seq ?? "–"} ${status}, ${age}s ago, ${d?.ms ?? "–"} ms rpc, ${d?.age ?? "–"} ticks old</td></tr>
          <tr><td>rpc latency</td><td>${st?.lat?.[sw] ?? "–"} ms avg · ${st?.dropped?.[sw] ?? 0} dropped</td></tr>
          ${m && m.swarm ? `
          <tr><td>memory</td><td>${m.decisions} decisions · engage ${Number(m.engage).toFixed(1)} m</td></tr>
          <tr><td>player model</td><td>camping ${(m.profile?.camping ?? 0).toFixed(2)} · matches ${m.profile?.matches ?? 0}</td></tr>
          <tr><td>trade scores</td><td>assault ${m.scores?.assault} · flank ${m.scores?.flank}</td></tr>
          <tr><td>last seen</td><td>${m.last_player ? m.last_player.pos.map((v: number) => v.toFixed(1)).join(", ") : "–"}</td></tr>
          <tr><td>recent</td><td><ol>${(m.recent ?? []).slice(-4).reverse().map((r: any) => `<li>${esc(r.tactic)}${r.why ? ` · ${esc(r.why)}` : ""}</li>`).join("")}</ol></td></tr>`
          : `<tr><td>memory</td><td>connecting to agent…</td></tr>`}
        </table></div>`;
    }
    this.body.innerHTML = html;
  }

  private drawViz(units: Unit[], player: THREE.Vector3, camera: THREE.Camera) {
    const pos = this.lines.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.lines.geometry.attributes.color as THREE.BufferAttribute;
    let n = 0;
    const c = new THREE.Color();
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, k: number) => {
      if (n >= pos.count - 2) return;
      pos.setXYZ(n, ax, ay, az); col.setXYZ(n, c.r * k, c.g * k, c.b * k); n++;
      pos.setXYZ(n, bx, by, bz); col.setXYZ(n, c.r * k, c.g * k, c.b * k); n++;
    };
    const goals: Record<string, THREE.Vector3[]> = { alpha: [], bravo: [] };
    const seen = new Set<number>();
    for (const u of units) {
      seen.add(u.id);
      c.setHex(SWARM_COLORS[u.swarm]);
      const o = this.orders.get(u.id);
      const y = 0.12;
      if (o && o.path.length) {
        let [px, pz] = [u.pos.x, u.pos.z];
        for (const [x, z] of o.path) {
          seg(px, y, pz, x, y, z, 1.6);
          [px, pz] = [x, z];
        }
        const [gx, gz] = o.path[o.path.length - 1];
        seg(gx - 0.5, y, gz - 0.5, gx + 0.5, y, gz + 0.5, 2);
        seg(gx - 0.5, y, gz + 0.5, gx + 0.5, y, gz - 0.5, 2);
        goals[u.swarm].push(new THREE.Vector3(gx, y, gz));
      }
      if (FIRING.has(u.mode)) seg(u.pos.x, u.pos.y + u.height * 0.7, u.pos.z, player.x, player.y + 1.1, player.z, 0.45);
      this.label(u, camera, o);
    }
    // Formation outline: each swarm's goals in angular order around the player.
    for (const sw of SWARMS) {
      const g = goals[sw].sort((a, b) => Math.atan2(a.z - player.z, a.x - player.x) - Math.atan2(b.z - player.z, b.x - player.x));
      c.setHex(SWARM_COLORS[sw]);
      for (let i = 0; i + 1 < g.length; i++) seg(g[i].x, 0.1, g[i].z, g[i + 1].x, 0.1, g[i + 1].z, 0.8);
    }
    for (const [id, el] of this.labelEls) if (!seen.has(id)) { el.remove(); this.labelEls.delete(id); }
    pos.needsUpdate = col.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, n);
  }

  private label(u: Unit, camera: THREE.Camera, o: Order | undefined) {
    let el = this.labelEls.get(u.id);
    if (!el) {
      el = document.createElement("div");
      el.className = u.swarm;
      this.labels.appendChild(el);
      this.labelEls.set(u.id, el);
    }
    const p = u.pos.clone().setY(u.pos.y + u.height + 0.4).project(camera);
    const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    el.style.display = visible ? "" : "none";
    if (!visible) return;
    el.style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`;
    el.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight}px`;
    const text = `#${u.id} ${o?.role ?? "solo"} · ${u.mode}`;
    if (el.textContent !== text) el.textContent = text;
  }

  forget(id: number) {
    this.orders.delete(id);
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// Wire protocol v1 between the browser and the ArenaAgent. See README.md.
import type { Box, Ramp } from "./physics";

export const PROTOCOL = 1;
export const TICK_MS = 50;

export const KINDS = ["striker", "sentinel"] as const;
export const SWARMS = ["alpha", "bravo"] as const;
export const MODES = ["fallback", "assault", "suppress", "flank", "retreat", "regroup", "hold", "rush"] as const;
export type Kind = (typeof KINDS)[number];
export type Swarm = (typeof SWARMS)[number];
export type Mode = (typeof MODES)[number];

export interface Level {
  half: number;
  wallH: number;
  boxes: Box[];
  ramps: Ramp[];
  gates: Record<Swarm, [number, number][]>;
  spawn: [number, number, number];
}

// [id, kind, x, y, z, yaw, hp, mode, swarm, spawning]
export type EnemyRow = [number, number, number, number, number, number, number, number, number, number];
// [pid, x, y, z, yaw, hp, paused]
export type PlayerRow = [string, number, number, number, number, number, number];
// [x, y, z, vx, vy, vz, ground, hp]
export type MeRow = [number, number, number, number, number, number, number, number];

export interface Order { mode: Mode; role: string; path: [number, number][] }

export type GameEvent =
  | { k: "spawn"; id: number; kind: Kind; sw: Swarm; p: number[] }
  | { k: "death"; id: number; kind: Kind; sw: Swarm; p: number[]; by: string | null }
  | { k: "proj"; id: number; kind: Kind; sw: Swarm; src: number; o: number[]; v: number[] }
  | { k: "pend"; id: number; p: number[]; hit: string | null }
  | { k: "shot"; pid: string; o: number[]; e: number[] }
  | { k: "hit"; pid: string; id: number; dmg: number; crit: boolean; kill: boolean; p: number[] }
  | { k: "dmg"; pid: string; amt: number; hp: number; from: number[]; sw: Swarm }
  | { k: "phase"; phase: Phase; wave: number; t: number }
  | { k: "wave"; wave: number; count: number }
  | { k: "cleared"; wave: number; bonus: number }
  | { k: "over"; score: number; wave: number; kills: number; best: number }
  | { k: "reset"; match: string }
  | { k: "down"; pid: string }
  | { k: "respawn"; pid: string }
  | {
      k: "decision"; sw: Swarm; seq: number | null; status: string; tactic: string | null;
      formation: string | null; note: string | null; engage: number | null; ms: number; age: number;
      source: "llm" | "rules" | null; callout: string | null; reason: string | null;
      orders: Record<string, Order>;
    };

export type Phase = "lobby" | "intermission" | "wave" | "over";

export interface Snapshot {
  t: "s";
  tick: number;
  ack?: number;
  me?: MeRow;
  e: EnemyRow[];
  pl: PlayerRow[];
  ev: GameEvent[];
  sc: [number, number]; // score, kills
  st?: { hz: number; lat: Record<Swarm, number>; dropped: Record<Swarm, number>; conns: number };
  projectiles?: { id: number; sw: Swarm; kind: Kind; o: number[]; v: number[] }[];
  orders?: Record<string, Order>;
}

export interface Welcome {
  t: "welcome";
  v: number;
  you: string;
  room: string;
  tick: number;
  rate: number;
  level: Level;
  swarms: Swarm[];
  match: string;
  phase: Phase;
  wave: number;
  score: number;
  kills: number;
  best: number;
  tactics: Record<Swarm, string>;
  snap: Snapshot;
}

// The durable checkpoint, synced by the Agents SDK as cf_agent_state.
export interface Checkpoint {
  match: string | null;
  phase?: Phase;
  wave?: number;
  score?: number;
  kills?: number;
  best?: number;
  tick?: number;
  tactics?: Record<Swarm, string>;
}

export type ClientMessage =
  | { t: "join"; v: number; pid: string }
  | { t: "in"; f: [number, number, number, number][] }
  | { t: "fire"; d: [number, number, number]; rt: number }
  | { t: "pause"; on: boolean }
  | { t: "restart" }
  | { t: "ping"; c: number };

export const SWARM_COLORS: Record<Swarm, number> = { alpha: 0xff2bd1, bravo: 0x6d7bff };
export const PLAYER_COLOR = 0x29f0ff;

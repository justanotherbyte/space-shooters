"""The authoritative game simulation. Pure Python, no runtime imports, so it
runs (and is tested) outside Workers too.

`World.step()` advances one fixed 50 ms tick. Players move by replaying their
input frames, enemies follow swarm orders (or a local fallback when orders
are late), and everything that happened lands in `World.events` for the
arena to broadcast.
"""

import math
import random
from collections import deque

from level import GATES, HALF, PLAYER_SPAWNS
from physics import (
    Body,
    inside_solid,
    line_of_sight,
    move,
    ray_level,
    ray_sphere,
    step_player,
)

TICK_RATE = 20
DT = 1 / TICK_RATE
INPUTS_PER_TICK = 3  # the client sends 60 input frames a second
MAX_INPUT_BUDGET = 9
MAX_QUEUED_INPUTS = 30
ORDER_TTL = 40  # ticks an order stays valid without a refresh
STALE_ORDERS = 30  # orders built from an observation older than this are dropped
REWIND_TICKS = 10  # lag compensation reaches back at most 500 ms
MAX_ALIVE = 14
EYE = 1.6

PLAYER_HP = 100
REVIVE_HP = 50
PLAYER_RADIUS = 0.4
PLAYER_HEIGHT = 1.8
SHOT_INTERVAL = 0.14
SHOT_DAMAGE = 22
SHOT_RANGE = 150.0

# hit: (height of sphere center, radius, damage multiplier)
ARCHETYPES = {
    "striker": {
        "hp": 60, "speed": 6.2, "radius": 0.5, "height": 1.9, "range": 28.0,
        "cooldown": 1.7, "dmg": 4, "bolt": 28.0, "spread": 0.085, "burst": 1,
        "score": 100, "prefer": 11.0,
        "hit": ((0.95, 0.55, 1.0), (1.65, 0.32, 1.6)),
    },
    "sentinel": {
        "hp": 280, "speed": 3.0, "radius": 0.95, "height": 3.0, "range": 40.0,
        "cooldown": 3.2, "dmg": 8, "bolt": 20.0, "spread": 0.11, "burst": 3,
        "score": 350, "prefer": 20.0,
        "hit": ((1.35, 1.05, 1.0), (2.6, 0.6, 1.5)),
    },
}
KINDS = ("striker", "sentinel")
SWARMS = ("alpha", "bravo")
# Append only: clients decode the mode by its index.
MODES = ("fallback", "assault", "suppress", "flank", "retreat", "regroup", "hold", "rush")
FIRING_MODES = {"fallback", "assault", "suppress", "hold", "rush"}


def r2(v: float) -> float:
    return round(v, 2)


def finite(v, lo: float, hi: float) -> float | None:
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
        return None
    return min(max(float(v), lo), hi)


class Player:
    def __init__(self, pid: str, slot: int = 0):
        self.pid = pid
        self.slot = slot
        self.hp = PLAYER_HP
        self.respawn(PLAYER_HP)
        self.yaw = 0.0
        self.pitch = 0.0
        self.inputs: deque[tuple[int, int, float, float]] = deque()
        self.last_seq = 0  # newest input queued
        self.ack = 0  # newest input applied
        self.budget = MAX_INPUT_BUDGET
        self.shots = 2.0
        self.paused = False
        self.connected = True

    @property
    def alive(self) -> bool:
        return self.hp > 0

    @property
    def targetable(self) -> bool:
        """Enemies ignore a player who is down, gone or paused."""
        return self.alive and self.connected and not self.paused

    def respawn(self, hp: int) -> None:
        self.hp = hp
        self.body = Body(*PLAYER_SPAWNS[self.slot % len(PLAYER_SPAWNS)], PLAYER_RADIUS, PLAYER_HEIGHT)


class Enemy:
    def __init__(self, eid: int, kind: str, swarm: str, x: float, z: float):
        a = ARCHETYPES[kind]
        self.id = eid
        self.kind = kind
        self.swarm = swarm
        self.a = a
        self.body = Body(x, 0.0, z, a["radius"], a["height"])
        self.hp = a["hp"]
        self.yaw = 0.0
        self.cooldown = 1.0 + (eid % 5) * 0.3
        self.order: dict | None = None
        self.order_tick = -10**9
        self.path_idx = 0
        self.mode = "fallback"
        self.role = "none"
        self.spawning = 12  # ticks of warp-in, untouchable and passive
        self.strafe = 1 if eid % 2 else -1
        self.strafe_timer = 30
        self.detour = 0
        self.detour_dir = (0.0, 0.0)
        self.trail: deque[tuple[float, float]] = deque(maxlen=20)


class World:
    def __init__(self, seed: int = 1, match: str = "m1"):
        self.rng = random.Random(seed)
        self.match = match
        self.tick = 0
        self.players: dict[str, Player] = {}
        self.enemies: dict[int, Enemy] = {}
        self.projectiles: dict[int, dict] = {}
        self.events: list[dict] = []
        self.next_id = 1
        self.phase = "lobby"  # lobby | intermission | wave | over
        self.phase_timer = 0.0
        self.wave = 0
        self.score = 0
        self.kills = 0
        self.best = 0
        self.spawn_queue: list[tuple[str, str]] = []
        self.spawn_timer = 0.0
        self.gate_turn = {s: 0 for s in SWARMS}
        self.history: deque[tuple[int, dict[int, tuple[float, float, float]]]] = deque(
            maxlen=REWIND_TICKS + 2
        )
        # Cumulative per-swarm outcomes, read by the swarms to judge their tactics.
        self.swarm_stats = {s: {"dealt": 0, "taken": 0, "losses": 0, "spawned": 0} for s in SWARMS}
        self.tactics = {s: "none" for s in SWARMS}
        self.callouts = {s: "" for s in SWARMS}  # each swarm's last radio line, heard by the other
        self.order_seq = {s: 0 for s in SWARMS}
        self.restored_hp: dict[str, int] = {}

    # Players

    def add_player(self, pid: str) -> Player:
        player = self.players.get(pid)
        if player is None:
            player = self.players[pid] = Player(pid, slot=len(self.players))
            player.hp = self.restored_hp.pop(pid, 0) or PLAYER_HP
        player.connected = True
        player.paused = False
        if self.phase == "lobby":
            self._set_phase("intermission", 3.0)
        return player

    def remove_player(self, pid: str) -> None:
        player = self.players.get(pid)
        if player:
            player.connected = False

    def queue_inputs(self, pid: str, frames: list) -> None:
        """Queue validated input frames: [seq, keys, yaw, pitch]."""
        player = self.players.get(pid)
        if player is None:
            return
        for seq, keys, yaw, pitch in frames:
            if seq <= player.last_seq:
                continue
            if len(player.inputs) >= MAX_QUEUED_INPUTS:
                break
            player.last_seq = seq
            player.inputs.append((seq, keys, yaw, pitch))

    def active(self) -> bool:
        live = [p for p in self.players.values() if p.connected]
        return bool(live) and not all(p.paused for p in live)

    # Firing

    def fire(self, pid: str, dx: float, dy: float, dz: float, render_tick: float) -> None:
        player = self.players.get(pid)
        if player is None or not player.alive or self.phase == "over" or player.shots < 1:
            return
        n = math.sqrt(dx * dx + dy * dy + dz * dz)
        if n < 1e-6:
            return
        player.shots -= 1
        dx, dy, dz = dx / n, dy / n, dz / n
        b = player.body
        ox, oy, oz = b.x, b.y + EYE, b.z
        best = ray_level(ox, oy, oz, dx, dy, dz, SHOT_RANGE)
        rewind = self._positions_at(render_tick)
        hit, mult = None, 1.0
        for e in self.enemies.values():
            if e.spawning:
                continue
            ex, ey, ez = rewind.get(e.id, (e.body.x, e.body.y, e.body.z))
            for h, r, m in e.a["hit"]:
                t = ray_sphere(ox, oy, oz, dx, dy, dz, ex, ey + h, ez, r)
                if t is not None and t < best:
                    best, hit, mult = t, e, m
        end = [r2(ox + dx * best), r2(oy + dy * best), r2(oz + dz * best)]
        self.events.append({"k": "shot", "pid": pid, "o": [r2(ox), r2(oy), r2(oz)], "e": end})
        if hit is not None:
            dmg = round(SHOT_DAMAGE * mult)
            hit.hp -= dmg
            self.swarm_stats[hit.swarm]["taken"] += dmg
            killed = hit.hp <= 0
            self.events.append(
                {"k": "hit", "pid": pid, "id": hit.id, "dmg": dmg, "crit": mult > 1, "kill": killed, "p": end}
            )
            if killed:
                self._kill(hit, pid)

    def _positions_at(self, render_tick: float) -> dict:
        if not math.isfinite(render_tick):
            return {}
        want = round(min(max(render_tick, self.tick - REWIND_TICKS), self.tick))
        for t, positions in self.history:
            if t == want:
                return positions
        return {}

    def _kill(self, e: Enemy, pid: str | None) -> None:
        self.enemies.pop(e.id, None)
        self.kills += 1
        self.score += e.a["score"]
        self.best = max(self.best, self.score)
        self.swarm_stats[e.swarm]["losses"] += 1
        b = e.body
        self.events.append(
            {"k": "death", "id": e.id, "kind": e.kind, "sw": e.swarm, "p": [r2(b.x), r2(b.y), r2(b.z)], "by": pid}
        )

    # Swarm coordination

    def observation(self, swarm: str, seq: int) -> dict:
        """What a swarm's controller sees: its units, the players, its outcomes."""
        units = [
            {
                "id": e.id, "kind": e.kind, "hp": e.hp, "maxHp": e.a["hp"],
                "pos": [r2(e.body.x), r2(e.body.y), r2(e.body.z)],
                "mode": e.mode, "role": e.role, "spawning": e.spawning > 0,
            }
            for e in self.enemies.values()
            if e.swarm == swarm
        ]
        players = [
            {
                "id": p.pid, "hp": p.hp,
                "pos": [r2(p.body.x), r2(p.body.y), r2(p.body.z)],
                "vel": [r2(p.body.vx), r2(p.body.vz)],
            }
            for p in self.players.values()
            if p.targetable
        ]
        allies = {}
        for other in SWARMS:
            if other == swarm:
                continue
            mine = [e for e in self.enemies.values() if e.swarm == other]
            cx = sum(e.body.x for e in mine) / len(mine) if mine else 0.0
            cz = sum(e.body.z for e in mine) / len(mine) if mine else 0.0
            allies[other] = {
                "tactic": self.tactics[other], "alive": len(mine), "centroid": [r2(cx), r2(cz)],
                "callout": self.callouts[other],
            }
        return {
            "v": 1, "swarm": swarm, "seq": seq, "tick": self.tick, "match": self.match,
            "wave": self.wave, "phase": self.phase, "units": units, "players": players,
            "allies": allies, "stats": dict(self.swarm_stats[swarm]),
        }

    def apply_orders(self, swarm: str, cmd: dict) -> str:
        """Validate and apply a swarm's command. Returns "applied" or why not."""
        if not isinstance(cmd, dict) or cmd.get("swarm") != swarm:
            return "invalid"
        seq, tick = cmd.get("seq"), cmd.get("tick")
        if not isinstance(seq, int) or not isinstance(tick, int):
            return "invalid"
        if seq <= self.order_seq[swarm]:
            return "out-of-order"
        if self.tick - tick > STALE_ORDERS:
            return "stale"
        if cmd.get("match") != self.match:
            return "other-match"
        self.order_seq[swarm] = seq
        tactic = cmd.get("tactic")
        self.tactics[swarm] = tactic if isinstance(tactic, str) else "none"
        callout = cmd.get("callout")
        if isinstance(callout, str) and callout:
            self.callouts[swarm] = callout[:70]
        orders = cmd.get("orders")
        if not isinstance(orders, dict):
            return "invalid"
        for key, order in orders.items():
            e = self.enemies.get(int(key)) if str(key).isdigit() else None
            if e is None or e.swarm != swarm or not isinstance(order, dict):
                continue
            clean = self._clean_order(order)
            if clean is None:
                continue
            first_new = e.order is None or e.order["path"] != clean["path"]
            e.order, e.order_tick = clean, self.tick
            e.role = clean["role"]
            if first_new:
                e.path_idx = 0
                path = clean["path"]
                if len(path) > 1 and _dist2(e.body.x, e.body.z, *path[1]) < _dist2(*path[0], *path[1]):
                    e.path_idx = 1
        return "applied"

    @staticmethod
    def _clean_order(order: dict) -> dict | None:
        mode = order.get("mode")
        if mode not in MODES:
            return None
        path = []
        for point in order.get("path", [])[:4]:
            if not isinstance(point, list) or len(point) != 2:
                return None
            x, z = finite(point[0], -HALF + 1, HALF - 1), finite(point[1], -HALF + 1, HALF - 1)
            if x is None or z is None:
                return None
            path.append((x, z))
        if not path:
            return None
        role = order.get("role")
        target = order.get("target")
        return {
            "mode": mode,
            "path": path,
            "fire": bool(order.get("fire", mode in FIRING_MODES)),
            "role": role if isinstance(role, str) else "none",
            "target": target if isinstance(target, str) else None,
        }

    # The tick

    def step(self) -> None:
        self.tick += 1
        for p in self.players.values():
            self._step_player(p)
        self._check_over()  # an alive player may have left a squad that is all down
        if self.phase != "over":
            self._step_phase()
            for e in list(self.enemies.values()):
                self._step_enemy(e)
            self._step_projectiles()
        self.history.append(
            (self.tick, {e.id: (e.body.x, e.body.y, e.body.z) for e in self.enemies.values()})
        )

    def _step_player(self, p: Player) -> None:
        p.shots = min(2.0, p.shots + DT / SHOT_INTERVAL)
        p.budget = min(MAX_INPUT_BUDGET, p.budget + INPUTS_PER_TICK)
        while p.inputs and p.budget >= 1:
            seq, keys, yaw, pitch = p.inputs.popleft()
            p.budget -= 1
            p.ack = seq
            p.yaw, p.pitch = yaw, pitch
            if p.alive:
                step_player(p.body, keys, yaw)

    def _set_phase(self, phase: str, timer: float = 0.0) -> None:
        self.phase = phase
        self.phase_timer = timer
        self.events.append({"k": "phase", "phase": phase, "wave": self.wave, "t": timer})

    def _step_phase(self) -> None:
        if self.phase == "intermission":
            self.phase_timer -= DT
            if self.phase_timer <= 0:
                self._start_wave(self.wave + 1)
        elif self.phase == "wave":
            self._spawn_next()
            if not self.spawn_queue and not self.enemies:
                bonus = 500 * self.wave
                self.score += bonus
                self.best = max(self.best, self.score)
                for p in self.players.values():
                    if p.alive:
                        p.hp = min(PLAYER_HP, p.hp + 35)
                    else:
                        p.respawn(REVIVE_HP)
                        self.events.append({"k": "respawn", "pid": p.pid})
                self.events.append({"k": "cleared", "wave": self.wave, "bonus": bonus})
                self._set_phase("intermission", 5.0)

    def _start_wave(self, wave: int) -> None:
        self.wave = wave
        squad = max(1, sum(1 for p in self.players.values() if p.connected))
        strikers = min(4 + 2 * wave + 2 * (squad - 1), 14)
        sentinels = min(max(0, wave - 1) + (squad - 1) // 2, 5)
        kinds = ["sentinel"] * sentinels + ["striker"] * strikers
        # Alternate swarms so both get a mix, sentinels first so they lead.
        self.spawn_queue = [(k, SWARMS[i % 2]) for i, k in enumerate(kinds)]
        self.spawn_timer = 0.0
        self._set_phase("wave")
        self.events.append({"k": "wave", "wave": wave, "count": len(kinds)})

    def _spawn_next(self) -> None:
        self.spawn_timer -= DT
        if not self.spawn_queue or self.spawn_timer > 0 or len(self.enemies) >= MAX_ALIVE:
            return
        kind, swarm = self.spawn_queue[0]
        gates = GATES[swarm]
        for _ in gates:
            gx, gz = gates[self.gate_turn[swarm] % len(gates)]
            self.gate_turn[swarm] += 1
            if all(_dist2(gx, gz, e.body.x, e.body.z) > 4 for e in self.enemies.values()):
                break
        else:
            return
        self.spawn_queue.pop(0)
        self.spawn_timer = 0.45
        e = Enemy(self.next_id, kind, swarm, gx, gz)
        self.next_id += 1
        e.yaw = math.atan2(gx, gz)  # face the center
        self.enemies[e.id] = e
        self.swarm_stats[swarm]["spawned"] += 1
        self.events.append({"k": "spawn", "id": e.id, "kind": kind, "sw": swarm, "p": [r2(gx), 0, r2(gz)]})

    def _target(self, e: Enemy) -> Player | None:
        want = e.order["target"] if e.order else None
        best, best_d = None, 1e18
        for p in self.players.values():
            if not p.targetable:
                continue
            if p.pid == want:
                return p
            d = _dist2(e.body.x, e.body.z, p.body.x, p.body.z)
            if d < best_d:
                best, best_d = p, d
        return best

    def _step_enemy(self, e: Enemy) -> None:
        b = e.body
        if e.spawning:
            e.spawning -= 1
            move(b, 0.0, 0.0, DT)
            return
        target = self._target(e)
        order = e.order if e.order and self.tick - e.order_tick <= ORDER_TTL else None
        tx = target.body.x if target else 0.0
        tz = target.body.z if target else 0.0

        # Where to go
        if order:
            e.mode = order["mode"]
            path = order["path"]
            gx, gz = path[min(e.path_idx, len(path) - 1)]
            if e.path_idx < len(path) - 1 and _dist2(b.x, b.z, gx, gz) < 2.5 * 2.5:
                e.path_idx += 1
            fire_ok = order["fire"]
        else:
            # Local fallback: close to the preferred range and keep firing.
            e.mode = "fallback"
            e.role = "solo"
            dx, dz = b.x - tx, b.z - tz
            d = math.sqrt(dx * dx + dz * dz) or 1.0
            gx, gz = tx + dx / d * e.a["prefer"], tz + dz / d * e.a["prefer"]
            fire_ok = True

        dx, dz = gx - b.x, gz - b.z
        dist = math.sqrt(dx * dx + dz * dz)
        speed = e.a["speed"] * {"retreat": 1.2, "flank": 1.2, "rush": 1.3}.get(e.mode, 1.0)
        wx = wz = 0.0
        if dist > 1.2:
            wx, wz = dx / dist * speed, dz / dist * speed
        # Units holding a position (ambush, shield wall) stand still.
        if e.kind == "striker" and e.mode in ("assault", "fallback", "suppress") and target:
            # Strafe across the line to the target, harder to hit.
            e.strafe_timer -= 1
            if e.strafe_timer <= 0:
                e.strafe = -e.strafe
                e.strafe_timer = 20 + self.rng.randrange(25)
            lx, lz = tx - b.x, tz - b.z
            ln = math.sqrt(lx * lx + lz * lz) or 1.0
            s = speed * (0.75 if dist <= 1.2 else 0.45) * e.strafe
            wx += -lz / ln * s
            wz += lx / ln * s

        # Keep some space from squadmates.
        for o in self.enemies.values():
            if o is e:
                continue
            ox, oz = b.x - o.body.x, b.z - o.body.z
            d2 = ox * ox + oz * oz
            reach = b.radius + o.body.radius + 1.0
            if 1e-6 < d2 < reach * reach:
                d = math.sqrt(d2)
                push = (reach - d) / reach * speed * 1.5
                wx += ox / d * push
                wz += oz / d * push

        # Stuck against geometry: slide sideways for a moment.
        if e.detour:
            e.detour -= 1
            wx, wz = e.detour_dir[0] * speed, e.detour_dir[1] * speed
        elif len(e.trail) == e.trail.maxlen and dist > 3:
            ox, oz = e.trail[0]
            if _dist2(ox, oz, b.x, b.z) < 1.0:
                side = 1 if self.rng.random() < 0.5 else -1
                n = dist or 1.0
                e.detour_dir = (-dz / n * side, dx / n * side)
                e.detour = 15
                e.trail.clear()

        n = math.sqrt(wx * wx + wz * wz)
        if n > speed * 1.3:
            wx, wz = wx / n * speed * 1.3, wz / n * speed * 1.3
        move(b, wx, wz, DT)
        e.trail.append((b.x, b.z))

        # Facing and firing
        if target:
            e.yaw = math.atan2(-(tx - b.x), -(tz - b.z))
        elif n > 0.1:
            e.yaw = math.atan2(-wx, -wz)
        e.cooldown -= DT
        if not (fire_ok and target and e.cooldown <= 0 and self.phase == "wave"):
            return
        tb = target.body
        d = math.sqrt(_dist2(b.x, b.z, tb.x, tb.z))
        if d > e.a["range"]:
            return
        mx, my, mz = b.x, b.y + b.height * 0.72, b.z
        if not line_of_sight(mx, my, mz, tb.x, tb.y + 1.1, tb.z):
            e.cooldown = 0.25
            return
        suppress = e.mode == "suppress"
        e.cooldown = e.a["cooldown"] * (0.6 if suppress else 1.0) * (0.85 + 0.3 * self.rng.random())
        self._fire_bolts(e, target, mx, my, mz, suppress)

    def _fire_bolts(self, e: Enemy, target: Player, mx, my, mz, suppress: bool) -> None:
        tb = target.body
        a = e.a
        lead = math.sqrt(_dist2(mx, mz, tb.x, tb.z)) / a["bolt"] * 0.6
        ax, ay, az = tb.x + tb.vx * lead - mx, tb.y + 1.1 - my, tb.z + tb.vz * lead - mz
        n = math.sqrt(ax * ax + ay * ay + az * az) or 1.0
        ax, ay, az = ax / n, ay / n, az / n
        spread = a["spread"] * (1.6 if suppress else 1.0)
        for i in range(a["burst"]):
            fan = (i - (a["burst"] - 1) / 2) * 0.07
            c, s = math.cos(fan), math.sin(fan)
            dx, dz = ax * c - az * s, ax * s + az * c
            dx += self.rng.gauss(0, spread)
            dy = ay + self.rng.gauss(0, spread * 0.5)
            dz += self.rng.gauss(0, spread)
            n = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
            v = a["bolt"]
            pid = self.next_id
            self.next_id += 1
            proj = {
                "x": mx, "y": my, "z": mz,
                "vx": dx / n * v, "vy": dy / n * v, "vz": dz / n * v,
                "dmg": a["dmg"], "sw": e.swarm, "src": e.id, "ttl": 3.0,
            }
            self.projectiles[pid] = proj
            self.events.append({
                "k": "proj", "id": pid, "kind": e.kind, "sw": e.swarm, "src": e.id,
                "o": [r2(mx), r2(my), r2(mz)], "v": [r2(proj["vx"]), r2(proj["vy"]), r2(proj["vz"])],
            })

    def _step_projectiles(self) -> None:
        for pid, pr in list(self.projectiles.items()):
            pr["ttl"] -= DT
            hit_player = None
            for _ in range(3):
                pr["x"] += pr["vx"] * DT / 3
                pr["y"] += pr["vy"] * DT / 3
                pr["z"] += pr["vz"] * DT / 3
                for p in self.players.values():
                    if not p.targetable:
                        continue
                    b = p.body
                    cy = min(max(pr["y"], b.y + 0.2), b.y + 1.6)
                    if _dist2(pr["x"], pr["z"], b.x, b.z) + (pr["y"] - cy) ** 2 < 0.6 * 0.6:
                        hit_player = p
                        break
                if hit_player or inside_solid(pr["x"], pr["y"], pr["z"]):
                    break
            ended = hit_player or pr["ttl"] <= 0 or inside_solid(pr["x"], pr["y"], pr["z"])
            if not ended:
                continue
            del self.projectiles[pid]
            self.events.append({
                "k": "pend", "id": pid, "p": [r2(pr["x"]), r2(pr["y"]), r2(pr["z"])],
                "hit": hit_player.pid if hit_player else None,
            })
            if hit_player:
                self._damage(hit_player, pr)

    def _damage(self, p: Player, pr: dict) -> None:
        p.hp = max(0, p.hp - pr["dmg"])
        self.swarm_stats[pr["sw"]]["dealt"] += pr["dmg"]
        src = self.enemies.get(pr["src"])
        frm = [r2(src.body.x), r2(src.body.z)] if src else [r2(pr["x"] - pr["vx"]), r2(pr["z"] - pr["vz"])]
        self.events.append({"k": "dmg", "pid": p.pid, "amt": pr["dmg"], "hp": p.hp, "from": frm, "sw": pr["sw"]})
        if p.hp <= 0:
            self.events.append({"k": "down", "pid": p.pid})
            self._check_over()

    def _check_over(self) -> None:
        """The match ends when every connected player is down."""
        live = [p for p in self.players.values() if p.connected]
        if self.phase != "over" and live and not any(p.alive for p in live):
            self._set_phase("over")
            self.events.append({"k": "over", "score": self.score, "wave": self.wave, "kills": self.kills, "best": self.best})

    # Match lifecycle

    def restart(self, match: str) -> None:
        self.match = match
        self.enemies.clear()
        self.projectiles.clear()
        self.spawn_queue.clear()
        self.history.clear()
        self.wave = self.score = self.kills = 0
        self.tactics = {s: "none" for s in SWARMS}
        self.callouts = {s: "" for s in SWARMS}  # each swarm's last radio line, heard by the other
        self.swarm_stats = {s: {"dealt": 0, "taken": 0, "losses": 0, "spawned": 0} for s in SWARMS}
        for p in self.players.values():
            p.respawn(PLAYER_HP)
        self.events.append({"k": "reset", "match": match})
        self._set_phase("intermission", 3.0)

    def checkpoint(self) -> dict:
        """The durable part of the match. Enemies and projectiles aren't in it:
        a resumed match replays the interrupted wave from the start."""
        return {
            "match": self.match, "phase": self.phase, "wave": self.wave, "score": self.score,
            "kills": self.kills, "best": self.best, "tick": self.tick, "tactics": dict(self.tactics),
            "players": {pid: p.hp for pid, p in self.players.items()},
        }

    def restore(self, cp: dict) -> None:
        self.match = cp.get("match", self.match)
        self.tick = cp.get("tick", 0)
        self.score = cp.get("score", 0)
        self.kills = cp.get("kills", 0)
        self.best = cp.get("best", 0)
        self.order_seq = {s: 0 for s in SWARMS}
        phase = cp.get("phase", "lobby")
        if phase in ("wave", "intermission"):
            self.wave = max(0, cp.get("wave", 1) - (1 if phase == "wave" else 0))
            self.phase = "lobby"  # the first join starts the countdown again
        else:
            self.wave = cp.get("wave", 0)
            self.phase = phase
        self.restored_hp = cp.get("players", {})

    # Wire formats

    def snapshot(self, pid: str | None) -> dict:
        me = self.players.get(pid) if pid else None
        snap = {
            "t": "s", "tick": self.tick, "sc": [self.score, self.kills],
            "e": [
                [e.id, KINDS.index(e.kind), r2(e.body.x), r2(e.body.y), r2(e.body.z), r2(e.yaw), e.hp,
                 MODES.index(e.mode), SWARMS.index(e.swarm), 1 if e.spawning else 0]
                for e in self.enemies.values()
            ],
            "pl": [
                [p.pid, r2(p.body.x), r2(p.body.y), r2(p.body.z), r2(p.yaw), p.hp, 1 if p.paused else 0]
                for p in self.players.values()
                if p is not me and p.connected
            ],
        }
        if me:
            b = me.body
            snap["ack"] = me.ack
            snap["me"] = [round(b.x, 4), round(b.y, 4), round(b.z, 4), round(b.vx, 4),
                          round(b.vy, 4), round(b.vz, 4), 1 if b.ground else 0, me.hp]
        return snap

    def full_state(self, pid: str) -> dict:
        """Everything a (re)connecting client needs to rebuild the world."""
        snap = self.snapshot(pid)
        snap["projectiles"] = [
            {"id": i, "sw": pr["sw"], "kind": self.enemies[pr["src"]].kind if pr["src"] in self.enemies else "striker",
             "o": [r2(pr["x"]), r2(pr["y"]), r2(pr["z"])], "v": [r2(pr["vx"]), r2(pr["vy"]), r2(pr["vz"])]}
            for i, pr in self.projectiles.items()
        ]
        snap["orders"] = {
            str(e.id): {"mode": e.mode, "role": e.role, "path": [list(p) for p in e.order["path"]]}
            for e in self.enemies.values()
            if e.order
        }
        return {
            "match": self.match, "phase": self.phase, "wave": self.wave, "score": self.score,
            "kills": self.kills, "best": self.best, "tactics": self.tactics, "snap": snap,
        }


def _dist2(ax: float, az: float, bx: float, bz: float) -> float:
    return (ax - bx) ** 2 + (az - bz) ** 2


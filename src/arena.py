"""ArenaAgent: one per room. Owns the authoritative World, runs it at 20 Hz while
players are connected, and asks the room's SwarmAgents for tactics.

Two channels leave this agent:
- every tick, a snapshot plus that tick's events goes out with `broadcast`
  (ephemeral, never stored);
- the match checkpoint goes through `set_state` on phase changes and at most
  every 5 s. The SDK stores it in SQLite and syncs it to clients as
  `cf_agent_state`.
"""

import asyncio
import json
import logging
import math
import re
import secrets
import time

from agents import Agent, get_agent_by_name

import level
from sim import DT, SWARMS, TICK_RATE, World

PROTOCOL = 1
DECIDE_EVERY = 10  # ticks between a swarm's observations (500 ms)
CHECKPOINT_EVERY = 100
MAX_FRAME = 4096
PID = re.compile(r"^[A-Za-z0-9_-]{4,40}$")

_log = logging.getLogger("arena")


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class ArenaAgent(Agent[dict]):
    initial_state = {"match": None}

    async def on_start(self) -> None:
        self.world = World(seed=secrets.randbits(32), match=secrets.token_hex(4))
        if self.state and self.state.get("match"):
            self.world.restore(self.state)
        self.loop: asyncio.Task | None = None
        self.seq = {s: 0 for s in SWARMS}
        self.busy = {s: False for s in SWARMS}
        self.stubs: dict = {}
        self.replies: list[tuple[str, dict | None, float]] = []
        self.latency = {s: 0.0 for s in SWARMS}
        self.dropped = {s: 0 for s in SWARMS}
        self.tick_times: list[float] = []
        self.calls: set[asyncio.Task] = set()

    def validate_state_change(self, next_state, source) -> None:
        if source != "server":
            raise PermissionError("the arena's state is server-owned")

    # Connections

    async def on_message(self, connection, message) -> None:
        if not isinstance(message, str) or len(message) > MAX_FRAME:
            return
        try:
            msg = json.loads(message)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        kind = msg.get("t")
        pid = (connection.state or {}).get("pid")
        if kind == "ping" and _num(msg.get("c")):
            connection.send(json.dumps({"t": "pong", "c": msg["c"], "tick": self.world.tick}))
        elif kind == "join":
            self._join(connection, msg)
        elif pid is None:
            return
        elif kind == "in":
            frames = msg.get("f")
            if isinstance(frames, list) and len(frames) <= 12:
                self.world.queue_inputs(pid, [f for f in map(_frame, frames) if f])
        elif kind == "fire":
            d, rt = msg.get("d"), msg.get("rt")
            if isinstance(d, list) and len(d) == 3 and all(map(_num, d)) and _num(rt):
                self.world.fire(pid, d[0], d[1], d[2], rt)
        elif kind == "pause":
            player = self.world.players.get(pid)
            if player:
                player.paused = bool(msg.get("on"))
        elif kind == "restart" and self.world.phase == "over":
            self.world.restart(secrets.token_hex(4))
            self._checkpoint()

    def _join(self, connection, msg: dict) -> None:
        if msg.get("v") != PROTOCOL:
            connection.send(json.dumps({"t": "error", "code": "protocol", "want": PROTOCOL}))
            connection.close(4000, "protocol version")
            return
        pid = msg.get("pid")
        if not isinstance(pid, str) or not PID.match(pid):
            connection.send(json.dumps({"t": "error", "code": "pid"}))
            return
        connection.set_state({"pid": pid})
        # One connection per player: the newest wins. A reconnect replaces its
        # dead socket; a duplicated tab bumps the original, which takes a new id.
        for other in self.get_connections():
            if other.id != connection.id and (other.state or {}).get("pid") == pid:
                other.send(json.dumps({"t": "error", "code": "replaced"}))
                other.close(4001, "player joined from another connection")
        self.world.add_player(pid)
        connection.send(json.dumps({
            "t": "welcome", "v": PROTOCOL, "you": pid, "room": self.name, "tick": self.world.tick,
            "rate": TICK_RATE, "level": level.as_json(), "swarms": list(SWARMS),
            **self.world.full_state(pid),
        }))
        if self.loop is None or self.loop.done():
            self.loop = asyncio.ensure_future(self._run())

    async def on_close(self, connection, code, reason, was_clean) -> None:
        pid = (connection.state or {}).get("pid")
        others = [c for c in self.get_connections() if c.id != connection.id and (c.state or {}).get("pid") == pid]
        if pid and not others:
            self.world.remove_player(pid)

    # The loop

    async def _run(self) -> None:
        lease = await self.keep_alive()
        try:
            next_at = time.time()
            while any(p.connected for p in self.world.players.values()):
                if self.world.active():
                    self._tick()
                next_at += DT
                delay = next_at - time.time()
                if delay < -0.5:
                    next_at, delay = time.time(), 0.0  # fell far behind: skip, don't burst
                await asyncio.sleep(max(0.0, delay))
        except Exception:
            _log.exception("arena loop failed")
        finally:
            lease.dispose()
            self._checkpoint()

    def _tick(self) -> None:
        w = self.world
        self._apply_replies()
        w.step()
        for i, swarm in enumerate(SWARMS):
            # Staggered, so the two swarms' calls don't land on the same tick.
            if w.tick % DECIDE_EVERY == i * DECIDE_EVERY // 2:
                self._ask(swarm)
        events, w.events = w.events, []
        now = time.time()
        self.tick_times = [t for t in self.tick_times if now - t < 1.0] + [now]
        stats = None
        if w.tick % TICK_RATE == 0:
            stats = {
                "hz": len(self.tick_times), "lat": {s: round(v) for s, v in self.latency.items()},
                "dropped": self.dropped, "conns": sum(1 for _ in self.get_connections()),
            }
        for connection in self.get_connections():
            snap = w.snapshot((connection.state or {}).get("pid"))
            snap["ev"] = events
            if stats:
                snap["st"] = stats
            connection.send(json.dumps(snap, separators=(",", ":")))
        if w.tick % CHECKPOINT_EVERY == 0 or any(e["k"] in ("phase", "reset") for e in events):
            self._checkpoint()

    def _checkpoint(self) -> None:
        self.set_state(self.world.checkpoint())

    # Swarm coordination: fire-and-forget calls, applied on a later tick.

    def _ask(self, swarm: str) -> None:
        if self.busy[swarm] or not any(e.swarm == swarm for e in self.world.enemies.values()):
            return
        self.seq[swarm] += 1
        obs = self.world.observation(swarm, self.seq[swarm])
        self.busy[swarm] = True
        task = asyncio.ensure_future(self._call_swarm(swarm, obs))
        self.calls.add(task)
        task.add_done_callback(self.calls.discard)

    async def _call_swarm(self, swarm: str, obs: dict) -> None:
        sent = time.time()
        try:
            stub = self.stubs.get(swarm)
            if stub is None:
                stub = self.stubs[swarm] = await get_agent_by_name(self.env.SwarmAgent, f"{self.name}-{swarm}")
            reply = await stub.decide(json.dumps(obs, separators=(",", ":")))
            self.replies.append((swarm, json.loads(reply), (time.time() - sent) * 1000))
        except Exception:
            _log.exception("swarm %s failed to decide", swarm)
            self.stubs.pop(swarm, None)
            self.replies.append((swarm, None, (time.time() - sent) * 1000))
        finally:
            self.busy[swarm] = False

    def _apply_replies(self) -> None:
        replies, self.replies = self.replies, []
        for swarm, cmd, ms in replies:
            self.latency[swarm] = self.latency[swarm] * 0.7 + ms * 0.3
            status = "failed" if cmd is None else self.world.apply_orders(swarm, cmd)
            if status != "applied":
                self.dropped[swarm] += 1
            cmd = cmd or {}
            self.world.events.append({
                "k": "decision", "sw": swarm, "seq": cmd.get("seq"), "status": status,
                "tactic": cmd.get("tactic"), "formation": cmd.get("formation"), "note": cmd.get("note"),
                "engage": cmd.get("engage"), "ms": round(ms), "age": self.world.tick - (cmd.get("tick") or 0),
                "orders": {
                    k: {"mode": o.get("mode"), "role": o.get("role"), "path": o.get("path")}
                    for k, o in (cmd.get("orders") or {}).items() if isinstance(o, dict)
                } if status == "applied" else {},
            })


def _frame(f) -> tuple[int, int, float, float] | None:
    """An input frame [seq, keys, yaw, pitch], or None if it's malformed."""
    if not isinstance(f, list) or len(f) != 4:
        return None
    seq, keys, yaw, pitch = f
    if not isinstance(seq, int) or not isinstance(keys, int) or not 0 <= keys < 64 or seq < 1:
        return None
    if not _num(yaw) or not _num(pitch):
        return None
    return seq, keys, math.remainder(yaw, 2 * math.pi), min(max(pitch, -1.55), 1.55)

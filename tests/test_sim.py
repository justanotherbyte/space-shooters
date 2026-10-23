"""Self-check for the simulation and tactics, outside Workers.

    uv run python tests/test_sim.py
"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import physics  # noqa: E402
import tactics  # noqa: E402
from sim import DT, SWARMS, World  # noqa: E402


def test_movement():
    # Walk forward (-z) from the floor into a pillar's face: blocked.
    b = physics.Body(-13.0, 0.0, -8.0, 0.4, 1.8)
    for _ in range(120):
        physics.step_player(b, physics.FORWARD, 0.0)
    assert b.z > -11.8 + 0.39 - 1e-6, b.z
    # Walk up the north ramp onto the central platform.
    b = physics.Body(0.0, 0.0, 15.0, 0.4, 1.8)
    for _ in range(150):
        physics.step_player(b, physics.FORWARD, 0.0)
    assert abs(b.y - 2.2) < 1e-6 and b.z < 6, (b.y, b.z)
    # The ramp's side blocks a walker at floor level.
    b = physics.Body(-5.0, 0.0, 7.0, 0.4, 1.8)
    for _ in range(60):
        physics.step_player(b, physics.RIGHT, 0.0)
    assert b.x < -2.5 and b.y == 0.0, (b.x, b.y)
    # Jumping lands back on the floor.
    b = physics.Body(10.0, 0.0, 20.0, 0.4, 1.8)
    physics.step_player(b, physics.JUMP, 0.0)
    assert b.vy > 0 and not b.ground
    for _ in range(120):
        physics.step_player(b, 0, 0.0)
    assert b.ground and b.y == 0.0


def test_orders_validation():
    w = World(seed=3)
    w.add_player("p1")
    for _ in range(80):
        w.step()
    obs = w.observation("alpha", 1)
    assert obs["units"], "wave 1 spawned alpha units"
    uid = str(obs["units"][0]["id"])
    good = {"swarm": "alpha", "seq": 1, "tick": w.tick, "match": w.match, "tactic": "assault",
            "orders": {uid: {"mode": "assault", "path": [[1, 2]], "fire": True}}}
    assert w.apply_orders("alpha", good) == "applied"
    assert w.apply_orders("alpha", good) == "out-of-order"
    assert w.apply_orders("alpha", {**good, "seq": 2, "tick": w.tick - 100}) == "stale"
    assert w.apply_orders("alpha", {**good, "seq": 3, "swarm": "bravo"}) == "invalid"
    assert w.apply_orders("bravo", {**good, "swarm": "bravo", "seq": 4}) == "applied"
    # bravo can't order alpha's unit, and junk paths are dropped.
    bad = {**good, "seq": 5, "orders": {uid: {"mode": "warp", "path": [[1e309, 0]]}}}
    before = w.enemies[int(uid)].order
    w.apply_orders("alpha", bad)
    assert w.enemies[int(uid)].order is before


def test_battle():
    """A bot player fights; swarms decide every 10 ticks, one call late."""
    w = World(seed=7)
    w.add_player("p1")
    memories = {s: tactics.new_memory(s) for s in SWARMS}
    seqs = {s: 0 for s in SWARMS}
    in_flight: list[tuple[int, str, dict]] = []
    seen_tactics = {s: set() for s in SWARMS}
    events = []
    seq = 0
    for _ in range(int(240 / DT)):
        p = w.players["p1"]
        # The bot strafes in a circle and aims at the nearest enemy.
        frames = []
        for _ in range(3):
            seq += 1
            yaw = (w.tick * DT * 0.6) % (2 * math.pi)
            frames.append((seq, physics.FORWARD | physics.LEFT, yaw, 0.0))
        w.queue_inputs("p1", frames)
        live = [e for e in w.enemies.values() if not e.spawning]
        if live and w.tick % 4 == 0:
            e = min(live, key=lambda e: (e.body.x - p.body.x) ** 2 + (e.body.z - p.body.z) ** 2)
            dx, dy, dz = e.body.x - p.body.x, e.body.y + 1.0 - p.body.y - 1.6, e.body.z - p.body.z
            w.fire("p1", dx, dy, dz, w.tick)
        # Deliver last round's decisions, then send new observations.
        for due, swarm, cmd in [f for f in in_flight if f[0] <= w.tick]:
            w.apply_orders(swarm, cmd)
            in_flight.remove((due, swarm, cmd))
        for i, s in enumerate(SWARMS):
            if w.tick % 10 == i * 5:
                seqs[s] += 1
                memories[s], cmd = tactics.decide(memories[s], w.observation(s, seqs[s]))
                seen_tactics[s].add(cmd["tactic"])
                in_flight.append((w.tick + 2, s, cmd))
        w.step()
        events += w.events
        w.events.clear()
        if w.phase == "over":
            break
    kinds = {e["k"] for e in events}
    print("wave", w.wave, "kills", w.kills, "score", w.score, "hp", w.players["p1"].hp, "phase", w.phase)
    print("tactics", {s: sorted(t) for s, t in seen_tactics.items()})
    print("outcomes", {s: memories[s]["outcomes"][-2:] for s in SWARMS})
    assert {"spawn", "proj", "pend", "hit", "death", "wave", "dmg"} <= kinds, kinds
    assert w.kills >= 5
    every = set().union(*seen_tactics.values())
    assert {"assault", "flank", "retreat"} <= every, every
    engaged = every & set(tactics.ENGAGE)
    assert len(engaged) >= 6, f"the rules should vary their tactics, used {sorted(engaged)}"


def test_restore():
    w = World(seed=1)
    w.add_player("p1")
    for _ in range(100):
        w.step()
    cp = w.checkpoint()
    w2 = World(seed=2)
    w2.restore(cp)
    assert w2.wave == cp["wave"] - 1 and w2.phase == "lobby"
    w2.add_player("p1")
    assert w2.phase == "intermission"
    for _ in range(80):
        w2.step()
    assert w2.wave == cp["wave"] and w2.phase == "wave"
    w2.restart("m2")
    assert w2.match == "m2" and w2.wave == 0 and not w2.enemies and w2.phase == "intermission"
    assert w2.players["p1"].hp == 100



def test_coop():
    w = World(seed=2)
    a, b = w.add_player("a"), w.add_player("b")
    assert (a.body.x, a.body.z) != (b.body.x, b.body.z), "players spawn in separate slots"
    for _ in range(80):
        w.step()
    assert w.phase == "wave" and len(w.spawn_queue) + len(w.enemies) == 8, "a squad of two gets two extra strikers"
    # A paused player is ignored by the swarms.
    b.paused = True
    assert [p["id"] for p in w.observation("alpha", 1)["players"]] == ["a"]
    b.paused = False
    # One player down: the match goes on, and they come back when the wave is cleared.
    w._damage(a, 500, "alpha", (0, 0))
    assert not a.alive and w.phase == "wave"
    w.enemies.clear()
    w.spawn_queue.clear()
    w.step()
    assert a.hp == 50 and w.phase == "intermission"
    assert any(e["k"] == "respawn" and e["pid"] == "a" for e in w.events)
    # Everyone left in the room is down: game over, even if a player who left was alive.
    for _ in range(80):
        w.step()
    w.remove_player("b")
    w._damage(a, 500, "alpha", (0, 0))
    assert w.phase == "over"
    w.restart("m9")
    assert a.hp == 100 and b.hp == 100


def test_gear():
    w = World(seed=5)
    p = w.add_player("p1")
    for _ in range(140):
        w.step()
    w.enemies = {e.id: e for e in list(w.enemies.values())[:2]}
    a, b = sorted(w.enemies.values(), key=lambda e: e.swarm != "alpha")[:2]
    a.swarm, b.swarm = "alpha", "bravo"
    for e in (a, b):
        e.spawning = 0
        e.cooldown = 1e9  # no bolts in this test
        e.body.x, e.body.z = 9.0, 9.0
    px, pz = p.body.x, p.body.z

    def run(ticks):
        for _ in range(ticks):
            w.events.clear()
            w.step()
            yield from w.events

    # Untrusted calls change nothing.
    for bad in [None, {"kind": "nuke", "unit": a.id, "at": [px, pz]}, {"kind": "frag", "unit": b.id, "at": [px, pz]},
                {"kind": "frag", "unit": True, "at": [px, pz]}, {"kind": "frag", "unit": a.id, "at": [-28, -28]},
                {"kind": "frag", "unit": a.id, "at": ["x", 0]}]:
        w._throw("alpha", bad)
    assert not w.gear and w.stock["alpha"]["frag"] == 1
    # A frag lands, then bursts next to the player.
    hp = p.hp
    w._throw("alpha", {"kind": "frag", "unit": a.id, "at": [px, pz]})
    w._throw("alpha", {"kind": "smoke", "unit": a.id, "at": [px, pz]})  # cooling down
    assert len(w.gear) == 1 and w.stock["alpha"] == {"frag": 0, "smoke": 2, "trap": 2}
    events = list(run(80))
    kinds = [e["k"] for e in events]
    assert kinds.index("deploy") < kinds.index("gend") and not w.gear
    assert p.hp < hp - 20 and any(e["k"] == "dmg" and e["sw"] == "alpha" for e in events)
    # Smoke blocks sight through the cloud, not around it.
    w._throw("alpha", {"kind": "smoke", "unit": a.id, "at": [0.0, 15.0]})
    list(run(90))  # landed, and the swarm can throw again
    y = w.gear[next(iter(w.gear))]["p"][1]
    assert w.smoked((-10, y + 1, 15), (10, y + 1, 15)) and not w.smoked((-10, y + 1, 25), (10, y + 1, 25))
    # A spike trap at the player's feet springs once armed.
    w.gear.clear()
    hp = p.hp
    w._throw("alpha", {"kind": "trap", "unit": a.id, "at": [px, pz]})
    events = list(run(60))
    assert any(e["k"] == "gend" and e["hit"] == "p1" for e in events) and p.hp == hp - 30
    # The stock refills with the next wave.
    w._start_wave(w.wave + 1)
    assert w.stock["alpha"] == {"frag": 1, "smoke": 2, "trap": 2}


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)

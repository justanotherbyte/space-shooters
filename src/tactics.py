"""Deterministic swarm tactics: a pure function from (memory, observation) to
(memory, command). The SwarmAgent persists the memory between calls.

`select_tactic` picks what to do and `plan_orders` turns it into per-unit
orders. An LLM-backed strategist would replace `select_tactic` only; the
orders it leads to stay deterministic and the arena still validates them.
"""

import math

from level import BOXES, HALF, RALLY_POINTS

ENGAGE_MIN, ENGAGE_MAX = 9.0, 22.0
SWITCH_TICKS = 120  # assault and flank last at least 6 s
RETREAT_TICKS = 70
REGROUP_TICKS = 50
# Each swarm has a temperament, so two swarms split the work.
PREFERS = {"alpha": "assault", "bravo": "flank"}


def new_memory(swarm: str) -> dict:
    return {
        "swarm": swarm,
        "match": None,
        "decisions": 0,
        "tactic": "idle",
        "tactic_since": 0,
        "formation": "none",
        "roles": {},
        "last_player": None,
        "track": [],
        "engage": 14.0,
        "peak": 0,
        "rally": None,
        "flank_side": 1 if swarm == "alpha" else -1,
        "episode": None,
        "scores": {"assault": 0.0, "flank": 0.0},
        "outcomes": [],
        "recent": [],
        "stats": {"dealt": 0, "taken": 0, "losses": 0},
        "profile": {"camping": 0.0, "matches": 0},
    }


def decide(memory: dict, obs: dict) -> tuple[dict, dict]:
    m = memory
    tick = obs["tick"]
    if m["match"] != obs["match"]:
        # A new match: forget the fight, keep what was learned about the player.
        fresh = new_memory(m["swarm"])
        fresh["match"] = obs["match"]
        fresh["scores"] = m["scores"]
        fresh["engage"] = m["engage"]
        played = m["profile"]["matches"] + (1 if m["match"] else 0)
        fresh["profile"] = {**m["profile"], "matches": played}
        fresh["tactic_since"] = tick
        m = fresh
    m["decisions"] += 1
    units = obs["units"]
    players = obs["players"]
    stats = obs["stats"]
    d_dealt = stats["dealt"] - m["stats"]["dealt"]
    d_taken = stats["taken"] - m["stats"]["taken"]
    d_losses = stats["losses"] - m["stats"]["losses"]
    m["stats"] = {k: stats[k] for k in ("dealt", "taken", "losses")}

    if not units or not players:
        m["roles"] = {}
        if m["tactic"] != "idle":
            _switch(m, "idle", tick, "no contact")
        return m, _command(m, obs, {}, "awaiting contact")

    # Focus fire on the weakest player in reach.
    player = min(players, key=lambda p: (p["hp"], _d(p["pos"][0], p["pos"][2], *_centroid(units))))
    px, py, pz = player["pos"]
    m["last_player"] = {"id": player["id"], "pos": player["pos"], "vel": player["vel"], "tick": tick}
    m["track"] = (m["track"] + [[px, pz]])[-8:]
    if len(m["track"]) >= 6:
        ox, oz = m["track"][-6]
        moved = _d(ox, oz, px, pz)
        camping = 1.0 if moved < 4.0 else 0.0
        m["profile"]["camping"] = round(m["profile"]["camping"] * 0.85 + camping * 0.15, 3)

    # Adapt the engagement range to how trades are going.
    if d_losses and d_dealt < 10 * d_losses:
        m["engage"] = min(ENGAGE_MAX, m["engage"] + 1.5)
    elif d_dealt >= 10 and not d_losses:
        m["engage"] = max(ENGAGE_MIN, m["engage"] - 0.5)

    alive = len(units)
    m["peak"] = max(m["peak"], alive)
    tactic, why = select_tactic(m, obs, units, player)
    if tactic != m["tactic"]:
        _switch(m, tactic, tick, why)
    orders, note = plan_orders(m, obs, units, player)
    return m, _command(m, obs, orders, note)


def select_tactic(m: dict, obs: dict, units: list, player: dict) -> tuple[str, str]:
    tick = obs["tick"]
    current = m["tactic"]
    age = tick - m["tactic_since"]
    alive = len(units)
    cx, cz = _centroid(units)

    if current == "retreat":
        rx, rz = m["rally"] or (cx, cz)
        if age >= RETREAT_TICKS or _d(cx, cz, rx, rz) < 4:
            return "regroup", "reached the rally point"
        return current, ""
    if current == "regroup":
        spread = max(_d(u["pos"][0], u["pos"][2], cx, cz) for u in units)
        if age >= REGROUP_TICKS and (spread < 7 or age >= 2 * REGROUP_TICKS):
            m["peak"] = alive
            return _engage_choice(m, obs, alive), "regrouped, re-engaging"
        return current, ""

    if m["peak"] >= 3 and alive <= m["peak"] // 2:
        return "retreat", f"lost {m['peak'] - alive} of {m['peak']} units"
    health = sum(u["hp"] for u in units) / max(1, sum(u["maxHp"] for u in units))
    if alive >= 2 and health < 0.3 and m["peak"] >= 2:
        return "retreat", f"armor at {round(health * 100)}%"

    if current in ("assault", "flank") and age < SWITCH_TICKS:
        if current == "flank" and _flank_done(m, units):
            return "assault", "flankers in position"
        return current, ""
    choice = _engage_choice(m, obs, alive)
    return choice, "" if choice == current else _why(m, obs, choice)


def _engage_choice(m: dict, obs: dict, alive: int) -> str:
    if alive < 3:
        return "assault"
    others = [a["tactic"] for a in obs["allies"].values() if a["alive"]]
    score = dict(m["scores"])
    score[PREFERS[m["swarm"]]] += 20
    if "assault" in others or "suppress" in others:
        score["flank"] += 25  # someone is applying pressure: go around
    if "flank" in others:
        score["assault"] += 25  # someone is going around: apply pressure
    score["flank"] += 30 * m["profile"]["camping"]
    return max(("assault", "flank"), key=lambda t: score[t])


def _why(m: dict, obs: dict, tactic: str) -> str:
    others = {k: a["tactic"] for k, a in obs["allies"].items() if a["alive"]}
    if tactic == "flank" and any(t == "assault" for t in others.values()):
        return f"{next(iter(others))} is pressing, going around"
    if tactic == "flank" and m["profile"]["camping"] > 0.5:
        return "player is holding position"
    if tactic == "assault" and any(t == "flank" for t in others.values()):
        return "pinning the player for the flank"
    return "best trade record" if m["scores"][tactic] > 0 else "default temperament"


def _flank_done(m: dict, units: list) -> bool:
    flankers = [u for u in units if m["roles"].get(str(u["id"])) == "flanker"]
    return bool(flankers) and all(u["mode"] == "assault" for u in flankers)


def _switch(m: dict, tactic: str, tick: int, why: str) -> None:
    ep = m["episode"]
    if ep and ep["tactic"] in m["scores"]:
        dealt = m["stats"]["dealt"] - ep["dealt"]
        losses = m["stats"]["losses"] - ep["losses"]
        result = dealt - 25 * losses
        m["scores"][ep["tactic"]] = round(m["scores"][ep["tactic"]] * 0.6 + result * 0.4, 1)
        m["outcomes"] = (m["outcomes"] + [{"tactic": ep["tactic"], "dealt": dealt, "losses": losses, "ticks": tick - ep["tick"]}])[-6:]
    m["episode"] = {"tactic": tactic, "tick": tick, "dealt": m["stats"]["dealt"], "losses": m["stats"]["losses"]}
    m["tactic"] = tactic
    m["tactic_since"] = tick
    m["recent"] = (m["recent"] + [{"tick": tick, "tactic": tactic, "why": why}])[-8:]


def plan_orders(m: dict, obs: dict, units: list, player: dict) -> tuple[dict, str]:
    px, _, pz = player["pos"]
    vx, vz = player["vel"]
    # Aim maneuvers half a second ahead of the player.
    px, pz = px + vx * 0.5, pz + vz * 0.5
    cx, cz = _centroid(units)
    tactic = m["tactic"]
    engage = m["engage"]
    pid = player["id"]
    orders: dict[str, dict] = {}
    roles: dict[str, str] = {}

    def order(u, role, mode, path, fire):
        roles[str(u["id"])] = role
        orders[str(u["id"])] = {
            "role": role, "mode": mode, "fire": fire, "target": pid,
            "path": [list(_walkable(x, z, px, pz)) for x, z in path],
        }

    if tactic in ("retreat", "regroup"):
        if m["rally"] is None or tactic == "retreat" and m["formation"] != "fallback":
            m["rally"] = list(max(RALLY_POINTS, key=lambda r: _d(*r, px, pz) - 0.6 * _d(*r, cx, cz)))
        rx, rz = m["rally"]
        if tactic == "retreat":
            m["formation"] = "fallback"
            for u in units:
                cover = u["kind"] == "sentinel"
                order(u, "rearguard" if cover else "withdraw", "retreat", [[rx, rz]], cover)
            note = f"falling back to ({rx:.0f}, {rz:.0f})"
        else:
            m["formation"] = "ring"
            for i, u in enumerate(units):
                a = 2 * math.pi * i / len(units)
                order(u, "defender", "regroup", [[rx + 2.5 * math.cos(a), rz + 2.5 * math.sin(a)]], True)
            note = f"regrouping {len(units)} units, defending the rally point"
    elif tactic == "flank":
        m["formation"] = "pincer"
        dx, dz = cx - px, cz - pz
        n = math.hypot(dx, dz) or 1.0
        dx, dz = dx / n, dz / n
        side = _flank_side(m, obs, px, pz, dx, dz, engage)
        perp_x, perp_z = -dz * side, dx * side
        strikers = sorted((u for u in units if u["kind"] == "striker"), key=lambda u: _d(u["pos"][0], u["pos"][2], px, pz))
        pin_count = max(1, len(units) // 3) - sum(1 for u in units if u["kind"] == "sentinel")
        pinners = [u for u in units if u["kind"] == "sentinel"] + strikers[: max(0, pin_count)]
        flankers = [u for u in strikers if u not in pinners]
        for i, u in enumerate(pinners):
            lat = (i - (len(pinners) - 1) / 2) * 3.0
            order(u, "pin", "suppress", [[px + dx * engage - perp_x * lat, pz + dz * engage - perp_z * lat]], True)
        fx, fz = px + perp_x * engage * 0.9 - dx * engage * 0.35, pz + perp_z * engage * 0.9 - dz * engage * 0.35
        wx, wz = cx + perp_x * engage, cz + perp_z * engage
        for i, u in enumerate(flankers):
            lat = (i - (len(flankers) - 1) / 2) * 2.5
            gx, gz = fx + dx * lat, fz + dz * lat
            arrived = _d(u["pos"][0], u["pos"][2], gx, gz) < 4.0 or u["mode"] == "assault" and m["roles"].get(str(u["id"])) == "flanker"
            if arrived:
                order(u, "flanker", "assault", [[gx, gz]], True)
            else:
                order(u, "flanker", "flank", [[wx, wz], [gx, gz]], False)
        word = "right" if side > 0 else "left"
        note = f"{len(flankers)} flanking {word}, {len(pinners)} pinning"
    else:
        m["formation"] = "encircle"
        base = math.atan2(cz - pz, cx - px)
        arc = min(math.radians(300), math.radians(55) * (len(units) - 1))
        slots = [base + (arc * (i / (len(units) - 1) - 0.5) if len(units) > 1 else 0) for i in range(len(units))]
        by_angle = sorted(units, key=lambda u: _wrap(math.atan2(u["pos"][2] - pz, u["pos"][0] - px) - base))
        for u, a in zip(by_angle, slots):
            heavy = u["kind"] == "sentinel"
            r = engage + 8 if heavy else engage
            order(u, "suppressor" if heavy else "assault", "suppress" if heavy else "assault",
                  [[px + math.cos(a) * r, pz + math.sin(a) * r]], True)
        note = f"{len(units)} converging from {round(math.degrees(arc))}° arc"
    m["roles"] = roles
    return orders, note


def _flank_side(m: dict, obs: dict, px, pz, dx, dz, engage) -> int:
    """Go around the side away from the other swarm, so the two close a pincer."""
    if m["tactic_since"] != obs["tick"]:
        return m["flank_side"]  # keep the side chosen when the flank began
    others = [a for a in obs["allies"].values() if a["alive"]]
    best = m["flank_side"]
    if others:
        ox, oz = others[0]["centroid"]
        scores = {}
        for side in (1, -1):
            fx, fz = px - dz * side * engage, pz + dx * side * engage
            inside = abs(fx) < HALF - 3 and abs(fz) < HALF - 3
            scores[side] = _d(fx, fz, ox, oz) + (0 if inside else -50)
        best = max((1, -1), key=lambda s: (scores[s], s == m["flank_side"]))
    m["flank_side"] = best
    return best


def _command(m: dict, obs: dict, orders: dict, note: str) -> dict:
    return {
        "v": 1, "swarm": m["swarm"], "seq": obs["seq"], "tick": obs["tick"], "match": obs["match"],
        "tactic": m["tactic"], "formation": m["formation"], "note": note,
        "engage": m["engage"], "orders": orders,
    }


def _walkable(x: float, z: float, px: float, pz: float) -> tuple[float, float]:
    """Move a goal out of solid geometry, toward the player, and inside the arena."""
    lim = HALF - 1.5
    x, z = min(max(x, -lim), lim), min(max(z, -lim), lim)
    for _ in range(12):
        if not any(b[0] - 1 <= x <= b[3] + 1 and b[2] - 1 <= z <= b[5] + 1 for b in BOXES if b[4] > 0.6 and b[6] != "wall"):
            break
        dx, dz = px - x, pz - z
        n = math.hypot(dx, dz) or 1.0
        x, z = x + dx / n * 1.5, z + dz / n * 1.5
    return round(x, 2), round(z, 2)


def _centroid(units: list) -> tuple[float, float]:
    return (
        sum(u["pos"][0] for u in units) / len(units),
        sum(u["pos"][2] for u in units) / len(units),
    )


def _d(ax, az, bx, bz) -> float:
    return math.hypot(ax - bx, az - bz)


def _wrap(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi

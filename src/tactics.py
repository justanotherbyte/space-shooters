"""Deterministic swarm tactics: a pure function from (memory, observation) to
(memory, command). The SwarmAgent persists the memory between calls.

`select_tactic` picks what to do and `plan_orders` turns it into per-unit
orders, one planner per tactic. When the SwarmAgent's LLM strategist has left
a fresh directive in memory (see `strategist`), it steers `select_tactic` and
may call for gear, which `_gear` aims. The hard rules and the per-unit orders
stay deterministic, and the arena still validates them.
"""

import math

import strategist
from level import BOXES, HALF, RALLY_POINTS
from strategist import ENGAGE

ENGAGE_MIN, ENGAGE_MAX = 9.0, 22.0
SWITCH_TICKS = 120  # the rules keep an engagement tactic at least 6 s
LLM_HOLD = 60  # a strategist directive can't replace a tactic younger than 3 s
RETREAT_TICKS = 70
REGROUP_TICKS = 50
HARASS_WAVE = 80  # ticks each hit-and-run wave spends going in
# Each swarm has a temperament, so two swarms split the work.
PREFERS = {"alpha": ("assault", "crossfire", "rush", "phalanx"), "bravo": ("flank", "ambush", "bait", "harass")}
PRESSURE = {"assault", "crossfire", "phalanx", "rush", "kite", "harass"}
MANEUVER = {"flank", "ambush", "bait"}
COVER_KINDS = {"cover", "crate", "pillar", "platform"}


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
        "bait": None,
        "episode": None,
        "scores": {t: 0.0 for t in ENGAGE},
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
        fresh["scores"] = {**fresh["scores"], **m["scores"]}
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
    d_losses = stats["losses"] - m["stats"]["losses"]
    m["stats"] = {k: stats[k] for k in ("dealt", "taken", "losses")}

    if not units or not players:
        m["roles"] = {}
        if m["tactic"] != "idle":
            _switch(m, "idle", tick, "no contact")
        return m, _command(m, obs, {}, "awaiting contact")

    # Focus fire on the weakest player in reach.
    player = min(players, key=lambda p: (p["hp"], _d(p["pos"][0], p["pos"][2], *_centroid(units))))
    px, _, pz = player["pos"]
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

    directive = _directive(m, tick)
    if directive:
        m["engage"] = directive["engage_range"]
    alive = len(units)
    m["peak"] = max(m["peak"], alive)
    tactic, why = select_tactic(m, obs, units, player)
    if tactic != m["tactic"]:
        _switch(m, tactic, tick, why)
    orders, note = plan_orders(m, obs, units, player)
    return m, _command(m, obs, orders, note, _gear(m, obs, units, player))


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
            return _choose(m, obs, units, player)[0], "regrouped, re-engaging"
        return current, ""

    if m["peak"] >= 3 and alive <= m["peak"] // 2:
        return "retreat", f"lost {m['peak'] - alive} of {m['peak']} units"
    health = sum(u["hp"] for u in units) / max(1, sum(u["maxHp"] for u in units))
    if alive >= 2 and health < 0.3 and m["peak"] >= 2:
        return "retreat", f"armor at {round(health * 100)}%"

    d = _directive(m, tick)
    # The strategist may call a retreat, but only for a swarm that has bled.
    if d and d["tactic"] == "retreat" and alive < m["peak"]:
        return "retreat", d["reason"]
    # A directive newer than the current tactic may change it, once that tactic
    # has had a moment to show (no flip-flopping on back-to-back replies).
    fresh_order = d is not None and d["tick"] > m["tactic_since"] and age >= LLM_HOLD
    still_possible = current in strategist.available(units)
    if current in ENGAGE and still_possible and age < SWITCH_TICKS and not fresh_order:
        if current == "flank" and _flank_done(m, units):
            return "assault", "flankers in position"
        return current, ""
    choice, why = _choose(m, obs, units, player)
    return choice, "" if choice == current else why


def _directive(m: dict, tick: int) -> dict | None:
    """The strategist's directive, while it is fresh."""
    d = m.get("directive")
    return d if d and tick - d["tick"] <= strategist.TTL else None


def _choose(m: dict, obs: dict, units: list, player: dict) -> tuple[str, str]:
    """An engagement tactic: the strategist's pick when it has one, else the rules'."""
    d = _directive(m, obs["tick"])
    if d and d["tactic"] in ENGAGE:
        if d["tactic"] in strategist.available(units):
            return d["tactic"], d["reason"]
        return _engage_choice(m, obs, units, player)[0], f"too few units to {d['tactic']}"
    return _engage_choice(m, obs, units, player)


def _engage_choice(m: dict, obs: dict, units: list, player: dict) -> tuple[str, str]:
    """Score every tactic the swarm can field on its record and the situation."""
    others = [a["tactic"] for a in obs["allies"].values() if a["alive"]]
    ally = next((k for k, a in obs["allies"].items() if a["alive"]), "ally")
    camping = m["profile"]["camping"]
    speed = math.hypot(*player["vel"])
    last = m["outcomes"][-1]["tactic"] if m["outcomes"] else None
    ep = m["episode"] or {"tick": obs["tick"], "dealt": m["stats"]["dealt"]}
    stalled = obs["tick"] - ep["tick"] > 200 and m["stats"]["dealt"] == ep["dealt"]
    best, best_score, best_why = "assault", -1e9, ""
    for t in strategist.available(units):
        record = m["scores"].get(t, 0.0)
        reasons = [(record, "best trade record" if record > 0 else "")]
        if t in PREFERS[m["swarm"]]:
            reasons.append((15, "default temperament"))
        if t in MANEUVER and any(o in PRESSURE for o in others):
            reasons.append((25, f"{ally} is pressing, going around"))
        if t in PRESSURE and any(o in MANEUVER for o in others):
            reasons.append((25, f"pinning the player for {ally}"))
        if t in ("flank", "bait"):
            reasons.append((30 * camping, "player is holding position"))
        if t == "ambush" and speed > 4:
            reasons.append((20, "player is on the move"))
        if t == "rush" and player["hp"] <= 35:
            reasons.append((45, "player is nearly down"))
        if t == "kite" and m["engage"] >= 17:
            reasons.append((25, "losing close trades"))
        if t in ("crossfire", "harass") and len(units) >= 5:
            reasons.append((15, "numbers to split"))
        if t == last:
            reasons.append((-20, ""))  # vary the approach
        if t == m["tactic"] and stalled:
            reasons.append((-40, ""))  # 10 s without landing a hit: try something else
        score = sum(r for r, _ in reasons)
        if score > best_score:
            best, best_score = t, score
            top = max(reasons, key=lambda r: r[0])
            best_why = top[1] if top[0] > 0 and top[1] else "varying the approach"
    return best, best_why


def _flank_done(m: dict, units: list) -> bool:
    flankers = [u for u in units if m["roles"].get(str(u["id"])) == "flanker"]
    return bool(flankers) and all(u["mode"] == "assault" for u in flankers)


def _switch(m: dict, tactic: str, tick: int, why: str) -> None:
    ep = m["episode"]
    if ep and ep["tactic"] in ENGAGE:
        dealt = m["stats"]["dealt"] - ep["dealt"]
        losses = m["stats"]["losses"] - ep["losses"]
        result = dealt - 25 * losses
        m["scores"][ep["tactic"]] = round(m["scores"].get(ep["tactic"], 0.0) * 0.6 + result * 0.4, 1)
        m["outcomes"] = (m["outcomes"] + [{"tactic": ep["tactic"], "dealt": dealt, "losses": losses, "ticks": tick - ep["tick"]}])[-6:]
    m["episode"] = {"tactic": tactic, "tick": tick, "dealt": m["stats"]["dealt"], "losses": m["stats"]["losses"]}
    m["tactic"] = tactic
    m["tactic_since"] = tick
    m["recent"] = (m["recent"] + [{"tick": tick, "tactic": tactic, "why": why}])[-8:]


class _Plan:
    """What every planner needs: the target, the swarm, and `order` to issue orders."""

    def __init__(self, m: dict, obs: dict, units: list, player: dict):
        self.m, self.obs, self.units = m, obs, units
        vx, vz = player["vel"]
        # Aim maneuvers half a second ahead of the player.
        self.px, self.pz = player["pos"][0] + vx * 0.5, player["pos"][2] + vz * 0.5
        self.cx, self.cz = _centroid(units)
        dx, dz = self.cx - self.px, self.cz - self.pz
        n = math.hypot(dx, dz) or 1.0
        self.dx, self.dz = dx / n, dz / n  # unit vector from the player toward the swarm
        self.engage = m["engage"]
        self.pid = player["id"]
        self.orders: dict[str, dict] = {}
        self.roles: dict[str, str] = {}

    def order(self, u: dict, role: str, mode: str, path: list, fire: bool) -> None:
        self.roles[str(u["id"])] = role
        self.orders[str(u["id"])] = {
            "role": role, "mode": mode, "fire": fire, "target": self.pid,
            "path": [list(_walkable(x, z, self.px, self.pz)) for x, z in path],
        }

    def at(self, angle: float, r: float, lat: float = 0.0) -> list[float]:
        """The point `r` from the target at `angle`, shifted `lat` sideways."""
        return [
            self.px + math.cos(angle) * r - math.sin(angle) * lat,
            self.pz + math.sin(angle) * r + math.cos(angle) * lat,
        ]

    def bearing(self) -> float:
        return math.atan2(self.dz, self.dx)

    def arc(self, units: list, base: float, arc: float) -> list[tuple[dict, float]]:
        """Spread `units` over an arc centered on `base`, in angular order so paths don't cross."""
        n = len(units)
        slots = [base + (arc * (i / (n - 1) - 0.5) if n > 1 else 0.0) for i in range(n)]
        ordered = sorted(units, key=lambda u: _wrap(math.atan2(u["pos"][2] - self.pz, u["pos"][0] - self.px) - base))
        return list(zip(ordered, slots))


def plan_orders(m: dict, obs: dict, units: list, player: dict) -> tuple[dict, str]:
    p = _Plan(m, obs, units, player)
    note = PLANNERS[m["tactic"]](p)
    m["roles"] = p.roles
    return p.orders, note


def _heavy(u: dict) -> bool:
    return u["kind"] == "sentinel"


def _retreat(p: _Plan) -> str:
    m = p.m
    if m["rally"] is None or m["formation"] != "fallback":
        m["rally"] = list(max(RALLY_POINTS, key=lambda r: _d(*r, p.px, p.pz) - 0.6 * _d(*r, p.cx, p.cz)))
    rx, rz = m["rally"]
    m["formation"] = "fallback"
    for u in p.units:
        p.order(u, "rearguard" if _heavy(u) else "withdraw", "retreat", [[rx, rz]], _heavy(u))
    return f"falling back to ({rx:.0f}, {rz:.0f})"


def _regroup(p: _Plan) -> str:
    m = p.m
    if m["rally"] is None:
        m["rally"] = [p.cx, p.cz]
    rx, rz = m["rally"]
    m["formation"] = "ring"
    for i, u in enumerate(p.units):
        a = 2 * math.pi * i / len(p.units)
        p.order(u, "defender", "regroup", [[rx + 2.5 * math.cos(a), rz + 2.5 * math.sin(a)]], True)
    return f"regrouping {len(p.units)} units, defending the rally point"


def _assault(p: _Plan) -> str:
    p.m["formation"] = "encircle"
    arc = min(math.radians(300), math.radians(55) * (len(p.units) - 1))
    for u, a in p.arc(p.units, p.bearing(), arc):
        heavy = _heavy(u)
        p.order(u, "suppressor" if heavy else "assault", "suppress" if heavy else "assault",
                [p.at(a, p.engage + 8 if heavy else p.engage)], True)
    return f"{len(p.units)} converging from {round(math.degrees(arc))}° arc"


def _flank(p: _Plan) -> str:
    m, units, engage = p.m, p.units, p.engage
    m["formation"] = "pincer"
    px, pz, dx, dz = p.px, p.pz, p.dx, p.dz
    side = _flank_side(m, p.obs, px, pz, dx, dz, engage)
    perp_x, perp_z = -dz * side, dx * side
    strikers = sorted((u for u in units if not _heavy(u)), key=lambda u: _d(u["pos"][0], u["pos"][2], px, pz))
    pin_count = max(1, len(units) // 3) - sum(1 for u in units if _heavy(u))
    pinners = [u for u in units if _heavy(u)] + strikers[: max(0, pin_count)]
    flankers = [u for u in strikers if u not in pinners]
    for i, u in enumerate(pinners):
        lat = (i - (len(pinners) - 1) / 2) * 3.0
        p.order(u, "pin", "suppress", [[px + dx * engage - perp_x * lat, pz + dz * engage - perp_z * lat]], True)
    fx, fz = px + perp_x * engage * 0.9 - dx * engage * 0.35, pz + perp_z * engage * 0.9 - dz * engage * 0.35
    wx, wz = p.cx + perp_x * engage, p.cz + perp_z * engage
    for i, u in enumerate(flankers):
        lat = (i - (len(flankers) - 1) / 2) * 2.5
        gx, gz = fx + dx * lat, fz + dz * lat
        arrived = _d(u["pos"][0], u["pos"][2], gx, gz) < 4.0 or u["mode"] == "assault" and m["roles"].get(str(u["id"])) == "flanker"
        if arrived:
            p.order(u, "flanker", "assault", [[gx, gz]], True)
        else:
            p.order(u, "flanker", "flank", [[wx, wz], [gx, gz]], False)
    word = "left" if side > 0 else "right"  # as the swarm faces the player
    return f"{len(flankers)} flanking {word}, {len(pinners)} pinning"


def _crossfire(p: _Plan) -> str:
    p.m["formation"] = "crossfire"
    base = p.bearing()
    ordered = [u for u, _ in p.arc(p.units, base, 0.0)]
    half = len(ordered) // 2
    teams = ((ordered[:half], base - math.pi / 4), (ordered[half:], base + math.pi / 4))
    for team, angle in teams:
        for i, u in enumerate(team):
            lat = (i - (len(team) - 1) / 2) * 2.5
            heavy = _heavy(u)
            p.order(u, "fire team", "suppress" if heavy else "assault",
                    [p.at(angle, p.engage + (6 if heavy else 0), lat)], True)
    return f"two fire teams of {len(teams[0][0])} and {len(teams[1][0])}, 90° apart"


def _phalanx(p: _Plan) -> str:
    p.m["formation"] = "line"
    base = p.bearing()
    front = [u for u in p.units if not _heavy(u)]
    back = [u for u in p.units if _heavy(u)]
    # Sort along the line, so nobody crosses the wall to reach a slot.
    along = lambda u: -(u["pos"][0] - p.px) * p.dz + (u["pos"][2] - p.pz) * p.dx  # noqa: E731
    for rank, spacing, r, role, mode in ((front, 3.0, p.engage, "shield", "hold"), (back, 4.0, p.engage + 5, "gunner", "suppress")):
        for i, u in enumerate(sorted(rank, key=along)):
            p.order(u, role, mode, [p.at(base, r, (i - (len(rank) - 1) / 2) * spacing)], True)
    return f"shield wall: {len(front)} holding the line, {len(back)} gunners behind"


def _rush(p: _Plan) -> str:
    p.m["formation"] = "swarm"
    for u in p.units:
        # Straight in from wherever each unit stands.
        angle = math.atan2(u["pos"][2] - p.pz, u["pos"][0] - p.px)
        p.order(u, "charger", "rush", [p.at(angle, 9.0 if _heavy(u) else 4.0)], True)
    return f"{len(p.units)} charging to point-blank range"


def _kite(p: _Plan) -> str:
    p.m["formation"] = "skirmish line"
    r = max(p.engage, 22.0)
    arc = min(math.radians(240), math.radians(50) * (len(p.units) - 1))
    for u, a in p.arc(p.units, p.bearing(), arc):
        p.order(u, "skirmisher", "suppress", [p.at(a, 30.0 if _heavy(u) else r)], True)
    return f"holding at {r:.0f} m, suppressing"


def _harass(p: _Plan) -> str:
    p.m["formation"] = "waves"
    wave = (p.obs["tick"] // HARASS_WAVE) % 2
    arc = min(math.radians(300), math.radians(55) * (len(p.units) - 1))
    by_id = sorted(p.units, key=lambda u: u["id"])
    inbound = {u["id"] for i, u in enumerate(by_id) if i % 2 == wave}
    for u, a in p.arc(p.units, p.bearing(), arc):
        if u["id"] in inbound:
            p.order(u, "raider", "rush", [p.at(a, 6.0)], True)
        else:
            p.order(u, "cover", "suppress", [p.at(a, p.engage + 6)], True)
    return f"wave {'AB'[wave]} going in, wave {'BA'[wave]} covering"


def _ambush(p: _Plan) -> str:
    p.m["formation"] = "hidden"
    spots = []
    for b in BOXES:
        if b[6] not in COVER_KINDS:
            continue
        bx, bz = (b[0] + b[3]) / 2, (b[2] + b[5]) / 2
        hx, hz = (b[3] - b[0]) / 2, (b[5] - b[2]) / 2
        vx, vz = bx - p.px, bz - p.pz
        dist = math.hypot(vx, vz)
        if not 6.0 <= dist <= 26.0:
            continue
        ux, uz = vx / dist, vz / dist
        # From the box center to its edge along the line of sight, then out of view behind it.
        edge = min(hx / abs(ux) if abs(ux) > 1e-6 else 1e9, hz / abs(uz) if abs(uz) > 1e-6 else 1e9)
        sx, sz = bx + ux * (edge + 1.4), bz + uz * (edge + 1.4)
        if max(abs(sx), abs(sz)) < HALF - 2:  # behind a gallery is inside the wall
            spots.append((-b[4], dist, [sx, sz]))
    if not spots:
        note = _kite(p)
        p.m["formation"] = "skirmish line"
        return f"no cover nearby: {note}"
    spots = [s[2] for s in sorted(spots)]  # tallest cover first
    free = list(spots)
    for u in sorted(p.units, key=lambda u: u["id"]):
        if not free:
            free = list(spots)  # more units than cover: double up
        spot = min(free, key=lambda s: _d(s[0], s[1], u["pos"][0], u["pos"][2]))
        free.remove(spot)
        p.order(u, "ambusher", "hold", [spot], True)
    return f"{len(p.units)} lying in wait behind cover"


def _bait(p: _Plan) -> str:
    m = p.m
    m["formation"] = "trap"
    base = p.bearing()
    trap = p.at(base, p.engage + 4)
    by_id = {u["id"]: u for u in p.units}
    bait = m.get("bait")
    if not bait or bait["id"] not in by_id:
        runner = max(p.units, key=lambda u: (not _heavy(u), u["hp"]))
        bait = m["bait"] = {"id": runner["id"], "phase": "lure"}
    lure = by_id[bait["id"]]
    lx, lz = lure["pos"][0], lure["pos"][2]
    if bait["phase"] == "lure" and _d(lx, lz, p.px, p.pz) < 7.0:
        bait["phase"] = "return"
    elif bait["phase"] == "return" and _d(lx, lz, trap[0], trap[1]) < 4.0:
        bait["phase"] = "lure"
    if bait["phase"] == "lure":
        p.order(lure, "bait", "rush", [p.at(base, 5.0)], True)
    else:
        p.order(lure, "bait", "retreat", [trap], False)
    rest = [u for u in p.units if u["id"] != bait["id"]]
    for u, a in p.arc(rest, base, math.radians(80)):
        p.order(u, "trap", "hold", [p.at(a, p.engage + 4)], True)
    return f"#{bait['id']} baiting, {len(rest)} waiting in the kill zone"


PLANNERS = {
    "retreat": _retreat, "regroup": _regroup, "assault": _assault, "flank": _flank,
    "crossfire": _crossfire, "phalanx": _phalanx, "rush": _rush, "kite": _kite,
    "harass": _harass, "ambush": _ambush, "bait": _bait,
}
assert set(ENGAGE) | {"retreat", "regroup"} == set(PLANNERS)


def _flank_side(m: dict, obs: dict, px, pz, dx, dz, engage) -> int:
    """Go around the side away from the other swarm, so the two close a pincer."""
    d = _directive(m, obs["tick"])
    starting = m["tactic_since"] == obs["tick"]
    if d and d["flank_side"] != "auto" and (starting or d["tick"] >= m["tactic_since"]):
        # The strategist's side, even mid-flank when it changes its mind.
        m["flank_side"] = 1 if d["flank_side"] == "left" else -1
        return m["flank_side"]
    if not starting:
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


def _gear(m: dict, obs: dict, units: list, player: dict) -> dict | None:
    """The strategist's gear call, thrown once per directive by the nearest unit in range.

    Until a unit is in range (and the swarm's last throw has cooled down), the
    call waits, for as long as its directive stays fresh.
    """
    d = _directive(m, obs["tick"])
    kit = obs.get("gear")
    if not d or d["gear"] == "none" or not kit or m.get("gear_for") == d["tick"]:
        return None
    kind = d["gear"]
    if kit["left"].get(kind, 0) <= 0 or not kit["ready"]:
        return None
    px, py, pz = player["pos"]
    vx, vz = player["vel"]
    cx, cz = _centroid(units)
    if kind == "frag":
        x, z = px + vx * 0.6, pz + vz * 0.6  # about where the player will be when it lands
    elif kind == "smoke":
        x, z = (px + cx) / 2, (pz + cz) / 2  # a screen between the swarm and the player
    else:
        speed = math.hypot(vx, vz)
        if speed > 2:
            x, z = px + vx / speed * 4.5, pz + vz / speed * 4.5  # ahead of the player
        else:
            n = _d(cx, cz, px, pz) or 1.0
            x, z = px + (cx - px) / n * 4.0, pz + (cz - pz) / n * 4.0  # where they'd step to chase
        if any(b[0] <= x <= b[3] and b[2] <= z <= b[5] and b[4] > py + 0.6 for b in BOXES):
            x, z = px, pz  # that spot is on top of something: lay it where they stand
    lim = HALF - 1.5
    x, z = min(max(x, -lim), lim), min(max(z, -lim), lim)
    near = [u for u in units if not u["spawning"] and _d(u["pos"][0], u["pos"][2], x, z) <= kit["range"] - 1]
    if not near:
        return None
    thrower = min(near, key=lambda u: _d(u["pos"][0], u["pos"][2], x, z))
    m["gear_for"] = d["tick"]
    return {"kind": kind, "unit": thrower["id"], "at": [round(x, 2), round(z, 2)]}


def _command(m: dict, obs: dict, orders: dict, note: str, gear: dict | None = None) -> dict:
    d = _directive(m, obs["tick"])
    if d and d["tactic"] != m["tactic"]:
        d = None  # the rules overrode it (a forced retreat, too few units): credit them
    extra = {"gear": gear} if gear else {}
    return {
        "v": 1, "swarm": m["swarm"], "seq": obs["seq"], "tick": obs["tick"], "match": obs["match"],
        "tactic": m["tactic"], "formation": m["formation"], "note": note,
        "engage": m["engage"], "orders": orders,
        "source": "llm" if d else "rules",
        "callout": d["callout"] if d else "",
        "reason": d["reason"] if d else "",
        **extra,
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

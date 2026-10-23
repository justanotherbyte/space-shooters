"""The LLM strategist's prompt and its untrusted reply. Pure: the SwarmAgent
makes the Workers AI call; this module builds what goes in and checks what
comes back.

The model picks a strategy every few seconds; `tactics` still turns it into
per-unit orders and keeps its hard rules (retreat at half strength, regroup
timing), so a bad or missing reply only costs strategy, never the game.
"""

import json
import math

# Tactics the swarm fights with, and the fewest units each needs.
ENGAGE = ("assault", "flank", "crossfire", "phalanx", "rush", "kite", "harass", "ambush", "bait")
TACTICS = ENGAGE + ("retreat",)
MIN_UNITS = {"flank": 3, "crossfire": 4, "phalanx": 3, "harass": 4, "bait": 3}
SIDES = ("left", "right", "auto")
GEAR = ("none", "frag", "smoke", "trap")
ENGAGE_MIN, ENGAGE_MAX = 9.0, 22.0
TTL = 240  # ticks (12 s) a directive stays in force

HELP = {
    "assault": "units take spaced slots on an arc around the target and close to the engagement range, all firing. Sentinels hold further back and suppress.",
    "flank": "a third of the units pin the target from the current side while the rest swing wide, holding fire, and hit from the side.",
    "crossfire": "two fire teams set up 90 degrees apart so their fire crosses on the target.",
    "phalanx": "a shield wall: Strikers hold a line at the engagement range, Sentinels suppress from behind it. Needs a Sentinel and two Strikers.",
    "rush": "everyone charges to point-blank range, firing. Best to finish a weak target; costly against a healthy one.",
    "kite": "hold at long range in a wide arc with loose, fast suppressing fire, backing off as the target advances.",
    "harass": "two waves take turns: one darts in close and fires while the other holds back and covers, swapping every 4 seconds.",
    "ambush": "units hide behind cover near the target and hold still, opening fire when the target walks into view.",
    "bait": "one fast unit charges the target and runs back to the others waiting in a firing line.",
    "retreat": "everyone falls back to a rally point and regroups. Use it to save a battered swarm, not to stall.",
}


def available(units: list) -> list[str]:
    """The engagement tactics this swarm has the units for."""
    alive = len(units)
    heavy = sum(1 for u in units if u["kind"] == "sentinel")
    return [
        t for t in ENGAGE
        if alive >= MIN_UNITS.get(t, 1) and (t != "phalanx" or (heavy and alive - heavy >= 2))
    ]


SYSTEM_PROMPT = """You command one robot swarm in a neon arena shooter. The \
enemies are human players. A second swarm, your ally, fights the same players \
under its own commander. Every few seconds you get a battle report and choose \
your swarm's strategy.

Tactics:
""" + "\n".join(f"- {t}: {HELP[t]}" for t in TACTICS) + """

Choose only from available_tactics in the report, or retreat. Coordinate with \
your ally: if it is pressing the player, go around or set a trap; if it is \
maneuvering, pin the player for it. Read its callout. Adapt to the player: a \
player who holds still invites a flank or bait, a player on the move walks \
into ambushes, a player who wins close trades calls for kiting, and a nearly \
dead player calls for a rush. Vary your approach when a tactic keeps losing \
units.

Gear: your swarm carries a few grenades and traps per wave (gear_left in the \
report), thrown by whichever unit is within 24 m of the spot. Set gear to use \
one now, or none to save it:
- frag: a grenade at the player's feet that bursts a second after it lands. \
It flushes a player who holds still behind cover; a moving player dodges it.
- smoke: a smoke cloud between your units and the player for 10 seconds. \
Nobody sees or shoots through it, so it covers an advance, a flank or a \
retreat, but it also blinds your own fire.
- trap: a spike trap on the player's path, armed for 40 seconds. It wounds \
the player who steps on it. Lay it where they are heading, or where a bait \
will lure them.
Gear with none left is ignored. Save some for later in the wave.

The report's event, when there is one, is what just happened: react to it, \
and let your callout show it.

Reply with JSON only. flank_side is from your swarm's point of view facing \
the target and only matters for flank. engage_range is in meters, 9 to 22. \
callout is one short radio line to your ally, in character, under 70 \
characters. reason is one plain sentence on why."""

PROPERTIES = {
    "tactic": {"type": "string", "enum": list(TACTICS)},
    "flank_side": {"type": "string", "enum": list(SIDES)},
    "engage_range": {"type": "number"},
    "gear": {"type": "string", "enum": list(GEAR)},
    "callout": {"type": "string"},
    "reason": {"type": "string"},
}
SCHEMA = {
    "type": "object",
    "properties": PROPERTIES,
    "required": list(PROPERTIES),
    "additionalProperties": False,
}


def battle_report(memory: dict, obs: dict, event: str | None = None) -> str:
    """A compact JSON summary of what the swarm sees and remembers."""
    units: dict[str, dict] = {}
    for u in obs["units"]:
        k = units.setdefault(u["kind"], {"count": 0, "hp": 0, "max_hp": 0})
        k["count"] += 1
        k["hp"] += u["hp"]
        k["max_hp"] += u["maxHp"]
    players = [
        {
            "id": p["id"][-4:],
            "pos": [round(p["pos"][0]), round(p["pos"][1], 1), round(p["pos"][2])],
            "hp": p["hp"],
            "speed": round(math.hypot(*p["vel"]), 1),
        }
        for p in obs["players"]
    ]
    allies = {
        name: {"tactic": a["tactic"], "units": a["alive"], "callout": a.get("callout", "")}
        for name, a in obs["allies"].items()
    }
    report = {
        "you": obs["swarm"],
        "wave": obs["wave"],
        "units": units,
        "available_tactics": available(obs["units"]),
        "peak_units": memory["peak"],
        "players": players,
        "player_camping": memory["profile"]["camping"],
        "allies": allies,
        "current": {
            "tactic": memory["tactic"],
            "seconds": round((obs["tick"] - memory["tactic_since"]) / 20),
            "engage_range": memory["engage"],
        },
        "gear_left": obs["gear"]["left"],
        "trade_scores": memory["scores"],
        "recent_outcomes": memory["outcomes"][-3:],
        "event": event or "none",
    }
    return json.dumps(report, separators=(",", ":"))


def messages(memory: dict, obs: dict, event: str | None = None) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": battle_report(memory, obs, event)},
    ]


LOW_HP = 35


def detect_event(seen: dict, prev_losses: int, memory: dict, obs: dict) -> str | None:
    """What just happened that the strategist should react to, if anything.

    `seen` keeps what was last observed (the wave, the other swarm's tactic,
    whether the player was low), so each event fires once, when it happens.
    """
    events = []
    if obs["phase"] == "wave" and seen.get("wave") != obs["wave"]:
        events.append(f"wave {obs['wave']} started")
        seen["wave"] = obs["wave"]
    lost = obs["stats"]["losses"] - prev_losses
    if lost > 0:
        events.append(f"lost {lost} unit{'s' if lost > 1 else ''}")
    allies = seen.setdefault("allies", {})
    for name, a in obs["allies"].items():
        if a["tactic"] in TACTICS and allies.get(name) not in (None, a["tactic"]):
            events.append(f"{name} switched to {a['tactic']}")
        allies[name] = a["tactic"]
    low = any(p["hp"] <= LOW_HP for p in obs["players"])
    if low and not seen.get("low"):
        events.append("the player is nearly down")
    seen["low"] = low
    if memory["tactic"] == "retreat" and memory["tactic_since"] == obs["tick"]:
        events.append("forced to retreat")
    return "; ".join(events) or None


def reply_text(result) -> str | None:
    """The text of a Workers AI reply, in either of its shapes."""
    if not isinstance(result, dict):
        return None
    response = result.get("response")
    if isinstance(response, dict):
        return json.dumps(response)  # json_schema replies can arrive parsed
    if isinstance(response, str):
        return response
    choices = result.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        content = (choices[0].get("message") or {}).get("content")
        return content if isinstance(content, str) else None
    return None


def parse_directive(text: str | None, tick: int) -> dict | None:
    """Validate the model's reply. Model output is untrusted, like client input."""
    if not isinstance(text, str):
        return None
    try:
        d = json.loads(text)
    except ValueError:
        return None
    if not isinstance(d, dict) or d.keys() != PROPERTIES.keys():
        return None
    tactic, side, rng = d["tactic"], d["flank_side"], d["engage_range"]
    if tactic not in TACTICS or side not in SIDES or d["gear"] not in GEAR:
        return None
    if isinstance(rng, bool) or not isinstance(rng, (int, float)) or not math.isfinite(rng):
        return None
    if not isinstance(d["callout"], str) or not isinstance(d["reason"], str):
        return None
    return {
        "tactic": tactic,
        "flank_side": side,
        "engage_range": round(min(max(float(rng), ENGAGE_MIN), ENGAGE_MAX), 1),
        "gear": d["gear"],
        "callout": " ".join(d["callout"].split())[:70],
        "reason": " ".join(d["reason"].split())[:120],
        "tick": tick,
    }

"""Self-check for the LLM strategist's validation and how directives steer the rules.

    uv run python tests/test_strategist.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import physics  # noqa: E402
import strategist  # noqa: E402
import tactics  # noqa: E402
from sim import MODES, World  # noqa: E402

GOOD = {"tactic": "flank", "flank_side": "left", "engage_range": 15, "callout": "Bravo, going left.", "reason": "Player is camping."}


def reply(**changes):
    return json.dumps({**GOOD, **changes})


def test_parse_directive():
    d = strategist.parse_directive(reply(), 100)
    assert d == {**GOOD, "engage_range": 15.0, "tick": 100}
    for bad in [None, "", "not json", "[]", reply(tactic="charge"), reply(flank_side="up"),
                reply(engage_range="far"), reply(engage_range=True), reply(callout=7),
                json.dumps({**GOOD, "extra": 1}), json.dumps({k: v for k, v in GOOD.items() if k != "reason"})]:
        assert strategist.parse_directive(bad, 1) is None, bad
    assert strategist.parse_directive('{"tactic":"assault","flank_side":"auto","engage_range":1e308,"callout":"x","reason":"y"}', 1)["engage_range"] == 22.0
    clamped = strategist.parse_directive(reply(engage_range=2, callout="a\n" * 100, reason="b " * 200), 1)
    assert clamped["engage_range"] == 9.0 and len(clamped["callout"]) <= 70 and len(clamped["reason"]) <= 120
    assert "\n" not in clamped["callout"]


def test_reply_text_shapes():
    assert strategist.reply_text({"response": "x"}) == "x"
    assert json.loads(strategist.reply_text({"response": {"a": 1}})) == {"a": 1}
    assert strategist.reply_text({"choices": [{"message": {"content": "y"}}]}) == "y"
    assert strategist.reply_text({"choices": [{"message": {"content": None}}]}) is None
    assert strategist.reply_text("nope") is None


def battle(units: int, wave: int = 1):
    """A world with `units` live alpha units, and alpha's memory after one decision."""
    w = World(seed=4)
    w.add_player("p1")
    w._start_wave(wave)
    for _ in range(140):
        w.step()
    for e in [e for e in w.enemies.values() if e.swarm == "alpha"][units:]:
        del w.enemies[e.id]
    for e in w.enemies.values():
        e.spawning = 0
    m, _ = tactics.decide(tactics.new_memory("alpha"), w.observation("alpha", 1))
    return w, m


def test_directive_steers_rules():
    w, m = battle(3)
    m["tactic_since"] = w.tick - 200  # past the minimum time on a tactic
    m["directive"] = strategist.parse_directive(reply(tactic="flank", flank_side="right", engage_range=20), w.tick)
    m, cmd = tactics.decide(m, w.observation("alpha", 2))
    assert cmd["tactic"] == "flank" and cmd["source"] == "llm" and cmd["callout"] == "Bravo, going left."
    assert m["engage"] == 20.0 and m["flank_side"] == -1  # right, as the swarm faces the player
    # A directive requested before the flank began still sets its side.
    w, m = battle(3)
    m["tactic_since"] = w.tick - 200
    m["directive"] = strategist.parse_directive(reply(tactic="flank", flank_side="left"), w.tick - 40)
    m, cmd = tactics.decide(m, w.observation("alpha", 2))
    assert cmd["tactic"] == "flank" and m["flank_side"] == 1 and "left" in cmd["note"]
    # Too few units to flank: the rules assault instead and take the credit.
    w, m = battle(2)
    m["tactic_since"] = w.tick - 200
    m["directive"] = strategist.parse_directive(reply(tactic="flank"), w.tick)
    m, cmd = tactics.decide(m, w.observation("alpha", 2))
    assert cmd["tactic"] == "assault" and cmd["source"] == "rules" and cmd["callout"] == ""


def test_expired_directive_is_ignored():
    w, m = battle(3)
    m["tactic_since"] = w.tick - 200
    m["directive"] = strategist.parse_directive(reply(tactic="flank"), w.tick - strategist.TTL - 1)
    _, cmd = tactics.decide(m, w.observation("alpha", 2))
    assert cmd["source"] == "rules"


def test_hard_rules_win():
    # Half the swarm is gone: retreat, whatever the directive says.
    w, m = battle(2)
    m["peak"] = 4
    m["directive"] = strategist.parse_directive(reply(tactic="assault"), w.tick)
    _, cmd = tactics.decide(m, w.observation("alpha", 2))
    assert cmd["tactic"] == "retreat" and cmd["source"] == "rules"
    # A directive can't order a retreat for a swarm that hasn't lost anyone.
    w, m = battle(3)
    m["tactic_since"] = w.tick - 200
    m["directive"] = strategist.parse_directive(reply(tactic="retreat"), w.tick)
    _, cmd = tactics.decide(m, w.observation("alpha", 2))
    assert cmd["tactic"] != "retreat"


def test_battle_report_is_small():
    w, m = battle(3)
    w.callouts["bravo"] = "Alpha, pin him at the north cover."
    obs = w.observation("alpha", 2)
    report = strategist.battle_report(m, obs)
    data = json.loads(report)
    assert data["allies"]["bravo"]["callout"] == "Alpha, pin him at the north cover."
    assert "flank" in data["available_tactics"] and "harass" not in data["available_tactics"]  # 3 units
    assert len(report) < 1500, len(report)
    assert [msg["role"] for msg in strategist.messages(m, obs)] == ["system", "user"]


def test_every_tactic_plans_valid_orders():
    w, m = battle(6, wave=3)
    units = w.observation("alpha", 1)["units"]
    assert any(u["kind"] == "sentinel" for u in units) and len(units) == 6
    assert strategist.available(units) == list(strategist.ENGAGE)
    for seq, tactic in enumerate((*strategist.ENGAGE, "retreat", "regroup"), start=2):
        m["tactic"] = tactic
        obs = w.observation("alpha", seq)
        player = obs["players"][0]
        orders, note = tactics.plan_orders(m, obs, obs["units"], player)
        assert note and len(orders) == len(units), (tactic, note)
        assert all(o["mode"] in MODES and 1 <= len(o["path"]) <= 4 for o in orders.values()), tactic
        cmd = {"swarm": "alpha", "seq": seq, "tick": w.tick, "match": w.match, "tactic": tactic, "orders": orders}
        assert w.apply_orders("alpha", cmd) == "applied", tactic


def test_ambush_hides_units():
    w, m = battle(4)
    m["tactic"] = "ambush"
    obs = w.observation("alpha", 2)
    p = obs["players"][0]["pos"]
    orders, note = tactics.plan_orders(m, obs, obs["units"], obs["players"][0])
    hidden = []
    for o in orders.values():
        gx, gz = o["path"][-1]
        if not physics.line_of_sight(p[0], p[1] + 1.6, p[2], gx, 1.2, gz):
            hidden.append(o)
    assert "lying in wait" in note and hidden, note


def test_unavailable_directive_falls_back():
    w, m = battle(2)
    m["tactic_since"] = w.tick - 200
    m["directive"] = strategist.parse_directive(reply(tactic="crossfire"), w.tick)
    obs = w.observation("alpha", 2)
    tactic, why = tactics._choose(m, obs, obs["units"], obs["players"][0])
    assert tactic in strategist.available(obs["units"]) and why == "too few units to crossfire"
    _, cmd = tactics.decide(m, obs)
    assert cmd["tactic"] != "crossfire" and cmd["source"] == "rules"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)

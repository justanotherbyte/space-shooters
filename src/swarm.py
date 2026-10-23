"""SwarmAgent: one per swarm per room, named "{room}-{swarm}".

The arena calls `decide` over Durable Object RPC with an observation and gets
a command back. The agent's state is its tactical memory: the SDK stores it in
SQLite after every decision and syncs it to any client watching (the debug
overlay connects here directly).

`decide` also starts the LLM strategist in the background when a new strategy
is due. Its directive lands in memory a few seconds later and steers the
following decisions; `decide` itself never waits on the model.
"""

import asyncio
import json
import time

from agents import Agent

import strategist
import tactics

ASK_EVERY = 70  # ticks (3.5 s) between scheduled strategist calls
EVENT_GAP = 20  # ticks (1 s): the least time between calls when events come in quick succession


class SwarmAgent(Agent[dict]):
    initial_state = {}

    def __init__(self, ctx, env) -> None:
        # Here, not in on_start: the arena calls decide() over a cached stub,
        # which reaches a freshly evicted-and-rebuilt agent without on_start.
        super().__init__(ctx, env)
        self.asking = False
        self.calls: set[asyncio.Task] = set()

    def validate_state_change(self, next_state, source) -> None:
        if source != "server":
            raise PermissionError("a swarm's memory is server-owned")

    async def decide(self, observation: str) -> str:
        obs = json.loads(observation)
        prev = self.state or {}
        prev_losses = prev.get("stats", {}).get("losses", 0) if prev.get("match") == obs["match"] else 0
        memory = self.state if self.state and self.state.get("swarm") == obs["swarm"] else tactics.new_memory(obs["swarm"])
        # A deep copy: tactics mutates the memory it's given.
        memory, command = tactics.decide(json.loads(json.dumps(memory)), obs)
        memory["last"] = {
            "seq": command["seq"], "tick": command["tick"], "tactic": command["tactic"],
            "formation": command["formation"], "note": command["note"], "units": len(command["orders"]),
            "source": command["source"], "gear": (command.get("gear") or {}).get("kind"),
        }
        model = self.env.STRATEGIST_MODEL
        llm = memory.setdefault("llm", {"model": model, "calls": 0, "failures": 0, "ms": None, "asked": None, "error": None})
        # Something just happened: ask now rather than on the schedule. Events that
        # arrive while a call is in flight wait for the next one.
        event = strategist.detect_event(llm.setdefault("seen", {}), prev_losses, memory, obs)
        if event:
            llm["pending"] = (llm.get("pending", []) + [event])[-3:]
        if model and self._due(memory, obs):
            self.asking = True
            llm["asked"] = obs["tick"]
            pending = llm.pop("pending", [])
            llm["trigger"] = "; ".join(pending) or "schedule"
            task = asyncio.ensure_future(self._ask(model, strategist.messages(memory, obs, "; ".join(pending) or None), obs))
            self.calls.add(task)
            task.add_done_callback(self.calls.discard)
        self.set_state(memory)
        return json.dumps(command, separators=(",", ":"))

    def _due(self, memory: dict, obs: dict) -> bool:
        if self.asking or obs["phase"] != "wave" or not obs["units"] or not obs["players"]:
            return False
        llm = memory["llm"]
        asked = llm["asked"]
        if asked is None:
            return True
        if llm.get("pending"):
            return obs["tick"] - asked >= EVENT_GAP
        return obs["tick"] - asked >= ASK_EVERY

    async def _ask(self, model: str, messages: list, obs: dict) -> None:
        start = time.time()
        directive, error = None, None
        try:
            result = await self.env.AI.run(model, {
                "messages": messages,
                "response_format": {"type": "json_schema", "json_schema": {"name": "directive", "schema": strategist.SCHEMA, "strict": True}},
                "max_tokens": 600,
                # A strategy pick needs no hidden reasoning (the reply says why), and
                # with it on the model spends the whole token budget thinking.
                "chat_template_kwargs": {"enable_thinking": False},
            })
            if hasattr(result, "to_py"):
                result = result.to_py()
            text = strategist.reply_text(result)
            directive = strategist.parse_directive(text, obs["tick"])
            if directive is None:
                error = f"invalid reply: {(text if text is not None else repr(result))[-300:]}"
        except Exception as e:  # a failed call costs strategy only; the rules carry on
            error = str(e)[:160]
        finally:
            self.asking = False
        state = json.loads(json.dumps(self.state or {}))
        if state.get("match") != obs["match"]:
            return  # a new match began while the model was thinking
        llm = state["llm"]
        llm.update(model=model, calls=llm["calls"] + 1, ms=round((time.time() - start) * 1000), error=error)
        if directive:
            state["directive"] = directive
        else:
            llm["failures"] += 1
        self.set_state(state)

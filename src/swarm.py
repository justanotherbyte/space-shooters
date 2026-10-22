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

ASK_EVERY = 120  # ticks (6 s) between strategist calls


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
        memory = self.state if self.state and self.state.get("swarm") == obs["swarm"] else tactics.new_memory(obs["swarm"])
        # A deep copy: tactics mutates the memory it's given.
        memory, command = tactics.decide(json.loads(json.dumps(memory)), obs)
        memory["last"] = {
            "seq": command["seq"], "tick": command["tick"], "tactic": command["tactic"],
            "formation": command["formation"], "note": command["note"], "units": len(command["orders"]),
            "source": command["source"],
        }
        model = self.env.STRATEGIST_MODEL
        llm = memory.setdefault("llm", {"model": model, "calls": 0, "failures": 0, "ms": None, "asked": None, "error": None})
        if model and self._due(memory, obs):
            self.asking = True
            llm["asked"] = obs["tick"]
            task = asyncio.ensure_future(self._ask(model, strategist.messages(memory, obs), obs))
            self.calls.add(task)
            task.add_done_callback(self.calls.discard)
        self.set_state(memory)
        return json.dumps(command, separators=(",", ":"))

    def _due(self, memory: dict, obs: dict) -> bool:
        if self.asking or obs["phase"] != "wave" or not obs["units"] or not obs["players"]:
            return False
        asked = memory["llm"]["asked"]
        # Ask on schedule, and right away when the rules just forced a retreat.
        forced = memory["tactic"] == "retreat" and memory["tactic_since"] == obs["tick"]
        return forced or asked is None or obs["tick"] - asked >= ASK_EVERY

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

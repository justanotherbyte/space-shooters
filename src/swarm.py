"""SwarmAgent: one per swarm per room, named "{room}-{swarm}".

The arena calls `decide` over Durable Object RPC with an observation and gets
a command back. The agent's state is its tactical memory: the SDK stores it in
SQLite after every decision and syncs it to any client watching (the debug
overlay connects here directly).
"""

import json

from agents import Agent

import tactics


class SwarmAgent(Agent[dict]):
    initial_state = {}

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
        }
        self.set_state(memory)
        return json.dumps(command, separators=(",", ":"))

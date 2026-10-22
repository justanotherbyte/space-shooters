from agents import route_agent_request
from arena import ArenaAgent
from env import Env
from swarm import SwarmAgent
from workers import Response, WorkerEntrypoint

__all__ = ("ArenaAgent", "Default", "SwarmAgent")


class Default(WorkerEntrypoint[Env]):
    async def fetch(self, request):
        # Static assets are served before the Worker runs; only /agents/* lands here.
        response = await route_agent_request(request, self.env)
        return response or Response("Not found", status=404)

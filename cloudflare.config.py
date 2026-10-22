from wynd.config import Assets, Config, Worker, bindings, exports

config = Config(
    worker=Worker(
        name="space-shooters",
        entrypoint="src/main.py",
        compatibility_date="2026-09-08",
        assets=Assets(
            directory="dist",
            not_found_handling="single-page-application",
            run_worker_first=["/agents/*"],
        ),
        env={
            "ArenaAgent": bindings.DurableObject("ArenaAgent"),
            "SwarmAgent": bindings.DurableObject("SwarmAgent"),
            "AI": bindings.AI(),
            # The Workers AI model the SwarmAgents' strategist calls; "" turns it off.
            "STRATEGIST_MODEL": bindings.Text("@cf/zai-org/glm-4.7-flash"),
        },
        exports={
            "ArenaAgent": exports.DurableObject(),
            "SwarmAgent": exports.DurableObject(),
        },
    ),
)

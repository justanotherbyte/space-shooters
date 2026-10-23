# Crosswind Swarm

A browser FPS set in a bioluminescent alien forest. The creatures hunting you are run by Python agents on Cloudflare Workers. Each room has one `ArenaAgent` and two `SwarmAgent`s, all Durable Objects built with the [Crosswind Python Agents SDK](https://crosswind.viswa.space) (`cf-agents`). The `ArenaAgent` runs the authoritative game at 20 Hz. Each `SwarmAgent` commands half the creatures. The browser sends inputs and draws what the server says happened.

## Run it locally

You need [uv](https://docs.astral.sh/uv/) and Node.js 22 or newer.

```sh
npm install
uv sync
npm run worker   # the Python agents on http://localhost:8787
npm run dev      # in a second terminal: Vite on http://localhost:5173
```

Open http://localhost:5173 and click **Deploy**. Vite proxies `/agents/*`, WebSockets included, to the worker. Edits to `src/*.py` reload the worker. Edits to `web/` hot-reload the page.

To serve the built page from the worker itself, as in production, run `npm run build` and open http://localhost:8787.

The URL carries the room (`?room=r-abc123`). Reloading rejoins the same `ArenaAgent`.

## Play together

Anyone who opens the same room URL joins your squad. **Copy invite link** on the start screen copies it. The first five players get their own spawn slot on the central platform. Each player after the first adds two Strikers to every wave, and every two extra players add a Sentinel.

- Score, waves and kills are shared. Allies show as explorers in cyan-lit suits, with a callsign and their health.
- A player who goes down stays down until the squad clears the wave, then comes back with 50 integrity. The match ends when every connected player is down.
- The world pauses only when every player has paused. A paused player can't be targeted or hit, so pausing in co-op takes you out of the fight without stopping it.
- Each tab is one player. A duplicated tab copies the original's player id, so when it joins, the server hands that player to the new tab and the original takes a fresh id.

Controls: WASD to move, the mouse to aim, left click to fire, Space to jump, Shift to sprint, Esc to pause. F3 opens agent telemetry. F4 toggles the tactical overlay.

## Deploy to Cloudflare

```sh
npx wrangler login      # once
npm run deploy          # vite build, then wynd deploy
```

`wynd deploy` stages `cloudflare.config.py` as a Wrangler config, vendors the Python packages, and uploads the Worker, the static assets in `dist/` and both Durable Object classes. The first deploy creates the `ArenaAgent` and `SwarmAgent` SQLite-backed namespaces. `uv run wynd deploy --dry-run` shows the upload without deploying. The current upload is 889 KiB (192 KiB gzipped).

`run_worker_first: ["/agents/*"]` in `cloudflare.config.py` sends only agent traffic to Python. Everything else is a static asset.

## How the agents work

```
browser ──WebSocket──▶ ArenaAgent "{room}"            (Durable Object, Python)
  inputs, fire            │  World.step() every 50 ms
  ◀── snapshot + events   │
                          ├─ RPC decide(obs) ──▶ SwarmAgent "{room}-alpha"
                          │  every 500 ms   ◀── command (tactic + per-unit orders)
                          └─ RPC decide(obs) ──▶ SwarmAgent "{room}-bravo"
                                                      │ every ~6 s, in the background
                                                      └─▶ Workers AI (env.AI): battle report in,
                                                          strategy directive + radio callout out
debug overlay ──WebSocket──▶ SwarmAgent (read-only view of its memory)
```

### ArenaAgent (`src/arena.py`, `src/sim.py`)

`ArenaAgent` owns a `World`, which holds every player in the room. The `World` is plain Python with no runtime imports, so the tests run it natively. It holds players, enemies, projectiles, waves, score and the match lifecycle. When a player joins, the agent starts an asyncio loop. The loop holds an SDK `keep_alive()` lease and calls `World.step()` every 50 ms on a fixed schedule. It skips ticks rather than bursting when it falls behind. It stops when the last player disconnects.

Every message from a client is untrusted:

- The server ignores frames over 4 KB, non-JSON frames, unknown message types, input batches over 12 frames, non-integer sequence numbers, key masks outside 0–63, and non-finite numbers.
- Movement is replayed from input frames, never from client positions. A player gets 3 frames per tick, with a 9-frame jitter budget. A client that floods frames moves no faster than one that doesn't (`tests/e2e.mjs` checks this).
- A player id has at most one connection. A newer `join` with the same id closes the older socket with code 4001, after an `error` of `replaced`.
- Shots carry only an aim direction. The server casts the ray from its own copy of the player's eye. Lag compensation rewinds enemies to the tick the client was viewing, at most 500 ms back.
- `validate_state_change` rejects any SDK state change that doesn't come from the server. A client sending `cf_agent_state` can't touch the checkpoint.

### SwarmAgent (`src/swarm.py`, `src/tactics.py`)

The arena calls each swarm in turn, every 10 ticks, staggered so the two calls don't land on the same tick. A call is native Durable Object RPC through `get_agent_by_name(env.SwarmAgent, ...)`. The observation holds the swarm's units, the players, the other swarm's tactic and centroid, and the swarm's cumulative damage and losses. `tactics.decide(memory, observation)` returns a command: a tactic, a formation, a note, and an order per unit (role, mode, waypoint path, target, fire or hold).

The swarm never writes to the world. Its command is applied only through `World.apply_orders`, which drops a command if any of these hold:

- It is for another match.
- It is out of order: its `seq` is not newer than the last applied.
- It is stale: built from an observation more than 30 ticks old.
- It is malformed.

Within an accepted command, the arena drops orders for units the swarm doesn't own, and clamps every path point into the arena. Calls are fire-and-forget. A reply is applied at the start of the next tick, and a swarm with a call in flight is skipped. A slow or failed swarm never blocks the loop. A unit whose orders are more than 2 s old falls back to local behavior: it closes to its preferred range, strafes and fires.

Each swarm fights with nine engagement tactics, plus retreat and regroup. `plan_orders` in `src/tactics.py` has one planner per tactic, and every planner is deterministic:

| Tactic | Units needed | What the units do |
|---|---|---|
| Coordinated assault | 1 | Units take slots spread over an arc of up to 300° around the player, assigned in angular order so paths don't cross. Sentinels hold 8 m further out and suppress. |
| Flank | 3 | Sentinels and the nearest third of the Strikers pin from the current side with faster, looser fire. The rest swing wide via a waypoint without firing, on the side away from the other swarm, so the two close a pincer. When they arrive they switch to assault. |
| Crossfire | 4 | Two fire teams set up 90° apart, so their fire crosses on the player. |
| Shield wall | 3, at least one a Sentinel | Strikers hold a still line at the engagement range. Sentinels suppress from 5 m behind it. |
| Rush | 1 | Every unit charges straight in to point-blank range at 1.3× speed, firing. |
| Kite | 1 | Units hold at 22 m or more (Sentinels at 30 m) in a wide arc with suppressing fire. Their slots move with the player, so they back off as it advances. |
| Hit and run | 4 | Two waves alternate every 4 s: one darts in to 6 m while the other covers from range. |
| Ambush | 1 | Units hide behind the tallest cover 6–26 m from the player and stand still. They fire only when the player walks into view. |
| Bait | 3 | The healthiest Striker charges the player and runs back to the rest, waiting in a firing line. |
| Retreat | | The swarm is down to half its peak strength, or its armor is under 30%. All units fall back to the rally point farthest from the player. Sentinels give covering fire. |
| Regroup | | After a retreat, units ring the rally point and defend it, then re-engage with their strength baseline reset. |

The rules score every tactic the swarm has the units for:

- **Record:** each tactic's trade score from past episodes (damage dealt minus 25 per unit lost).
- **Temperament:** alpha leans toward assault, crossfire, rush and shield wall. Bravo leans toward flank, ambush, bait and hit and run.
- **The other swarm:** while it applies pressure, maneuvers (flank, ambush, bait) score higher. While it maneuvers, pressure tactics score higher.
- **The player:** a camping player invites a flank or bait. A moving player walks into ambushes. A player at 35 health or less invites a rush. Losing close trades favors kiting.
- **Variety:** the tactic that just ended scores lower. So does one that has landed nothing for 10 s.

A tactic is kept for at least 6 s, unless the swarm loses the units it needs.

The SwarmAgent's SDK state is its memory: last known player position and track, a camping score, preferred engagement range (it widens after bad trades and narrows after good ones), current formation and roles, recent decisions with reasons, and a trade score per tactic built from past outcomes, which tips later choices. The memory is stored after every decision. Starting a new match clears the fight but keeps the learned trade scores, range and player model.

`select_tactic` is separate from `plan_orders`, and that is where the LLM strategist plugs in.

### LLM strategist (`src/strategist.py`)

Each SwarmAgent asks a Workers AI model for a strategy about every 6 s while a wave is on, and right away when the rules force a retreat. `decide` starts the call in the background and returns at once, so the arena never waits on the model. The model gets a compact battle report:

- its units by kind and health, and which tactics it has the units for
- the players' positions, health and speed, and how much they camp
- its trade record per tactic and recent outcomes
- the other swarm's tactic and its last radio callout

It answers with JSON constrained by a schema: a tactic (any of the nine above, or retreat), a flank side, an engagement range, a callout to the other swarm, and a one-line reason. `parse_directive` treats that reply as untrusted. It rejects anything off-schema, clamps the range to 9–22 m and trims the text. The validated directive goes into the swarm's memory and steers `select_tactic` for 12 s.

The rules stay in charge of safety:

- A swarm at half strength or under 30% armor retreats whatever the model says.
- The model can call a retreat only for a swarm that has lost units.
- A tactic the swarm lacks the units for falls back to the rules' choice.
- Per-unit orders are still computed by `plan_orders` and validated by the arena.

A missing, late, failed or invalid reply only means the rules choose, as they did before the strategist existed. Each decision event says whether the directive or the rules picked the tactic (`source`). The HUD shows the model's callout with an `LLM` badge when its directive is in force. F3 shows the model, call count, failures, latency, the last error, and the directive with its reason.

The model is `@cf/zai-org/glm-4.7-flash`, set by `STRATEGIST_MODEL` in `cloudflare.config.py`. Set it to `""` to turn the strategist off. In local dev, restart `npm run worker` after changing it. Workers AI runs on Cloudflare even in local dev, so `npm run worker` needs `npx wrangler login`, and calls count against your Workers AI usage. Its thinking mode is turned off: with it on, the model spent its whole token budget reasoning and never answered. A reply takes about 2 s. Each call is about 400 input and 100 output tokens, two swarms at one call per 6 s each.

`@cf/zai-org/glm-5.3-flash` is stronger but not available on the Workers Free plan. Any Workers AI model that supports `response_format: json_schema` works.

### What is stored, and what isn't

| Data | Where | How often |
|---|---|---|
| Snapshots and events | `broadcast()`, never stored | 20 Hz |
| Match checkpoint (match id, phase, wave, score, kills, best, player HP, tick) | `ArenaAgent.set_state`, SQLite, synced to clients as `cf_agent_state` | On every phase change and every 5 s |
| Tactical memory, including the strategist's directive and call stats | `SwarmAgent.set_state`, SQLite | Once per decision (2 Hz per swarm), and when a strategist reply lands |

When a Durable Object is evicted, the arena restores the checkpoint on its next start. The match id, score and tick carry over, and the interrupted wave restarts when the player rejoins. Enemies and projectiles aren't checkpointed. Saving them would mean a SQLite write per tick.

## Art direction

The arena is a clearing in a bioluminescent forest. The server's level is unchanged: its boxes and ramps stay the collision truth, and the client draws organic stand-ins over them.

| Collision | Drawn as |
|---|---|
| Perimeter walls | Layered cliffs (part of one terrain heightfield), weathered rock formations, hanging vines |
| Platforms | Rock mesas with flat walkable tops, roots spilling over the rims, shelf fungi |
| Pillars | Giant mushrooms with glowing gills under their caps and hanging tendrils, each lit from below |
| Low cover | Fallen logs sunk into the soil |
| Crates | Boulders crusted with crystals |
| Ramps | Earth slopes that follow the walkable plane exactly, with roots down their sides |

Everything alive uses one material (`bioMaterial` in `web/src/bio.ts`), a `MeshStandardMaterial` with a patched shader:

- **Painted geometry:** each painted geometry carries per-vertex emission, sway and pulse phase.
- **Shared clock:** grass, ferns and tendrils sway and glow pulses breathe off one `uTime` uniform, with no per-plant update loop.
- **Veins drawn per pixel:** glowing veins and cracks are drawn per pixel, as the anti-aliased zero-crossings of warped sine waves in object space. They stay crisp on coarse meshes, where per-vertex patterns smear into blobs.
- **Instancing:** vegetation is six instanced meshes.

The whole scene is about 90 draw calls and 620k triangles a frame.

The palette keeps surfaces dark and matte (`#10142B`, `#173C45`). Saturated color is reserved for living light: cyan and turquoise for the forest and the player, orchid violet for some fungi and for swarm bravo, coral for swarm alpha and every hostile eye.

Swarm coordination shows on the creatures, driven by the server's `decision` events. When a swarm's agent changes tactic, its creatures pulse and release signalling spores in a pattern that matches the new tactic:

- **Maneuvers** (flank, bait, crossfire, hit and run) pulse one creature at a time.
- **Pressure tactics** pulse all at once.
- **A retreat** ripples outward from the player.
- **An ambush** goes dark, its markings dimmed to a quarter.

Sentinel spore sacs swell between volleys and flare when they fire, timed from each Sentinel's own last shot.

## Protocol (v1)

All messages are JSON over one WebSocket at `/agents/arena-agent/{room}`. The client uses `AgentClient` from the Agents SDK (`agents/client`). It reconnects on its own and sends `join` on every open.

Client to server:

| `t` | Fields | Meaning |
|---|---|---|
| `join` | `v`, `pid` | Join or rejoin as `pid`. Answered with `welcome`, a full resync. A wrong `v` gets `error` and a close. |
| `in` | `f: [[seq, keys, yaw, pitch], ...]` | Input frames at 60 per second, sent in batches every 33 ms. |
| `fire` | `d: [x, y, z]`, `rt` | Aim direction, plus the interpolated tick the client was rendering. |
| `pause` | `on` | The world freezes when every connected player is paused. |
| `restart` | | Start a new match after game over. |
| `ping` | `c` | Answered with `pong` carrying the same `c`. |

Server to client:

| `t` | Contents |
|---|---|
| `welcome` | The level geometry, match state, a full snapshot including projectiles in flight, and current orders. |
| `s` | Per tick: `tick`, `ack` (the last input frame applied), `me` (your position, velocity and HP), `e` (enemy rows), `pl` (other players: id, position, yaw, HP, paused), `sc` (score, kills), `ev` (events), and `st` (server stats, once a second). |
| `pong` | Answer to `ping`. |
| `error` | `code`: `protocol` (wrong version), `pid` (bad player id) or `replaced` (this player joined from another connection). |

The `ev` events are `spawn`, `death`, `proj` (a bolt was fired), `pend` (a bolt ended), `shot`, `hit`, `dmg` (a player took damage), `down`, `respawn`, `phase`, `wave`, `cleared`, `over`, `reset` and `decision` (a swarm command, with its status, RPC latency and age).

The client predicts its own movement with `web/src/physics.ts`, a line-for-line port of `src/physics.py` (`tests/test_mirror.py` checks they agree). On each snapshot it resets to the server's state and replays the input frames the server hasn't applied. Any visual error decays over about 100 ms. Enemies and other players are drawn 100 ms in the past, interpolated between snapshots. Enemy bolts start at the muzzle and catch up to the server's present.

Rapier handles the client's collision queries against the level, such as where a shot lands, and the fragments thrown off when a creature dies. Player movement uses the mirrored Python code instead of Rapier's character controller: the server can't run Rapier, and two different collision models would disagree on every wall and force constant corrections.

## Tests

```sh
uv run python tests/test_sim.py     # movement, order validation, a 4-minute bot battle, checkpoint restore, co-op
uv run python tests/test_mirror.py  # physics.ts matches physics.py over 100 s of random input
uv run python tests/test_strategist.py  # reply validation, directives steering the rules, safety rules winning
node tests/e2e.mjs                  # against a running worker: tick rate, hostile input, rate limit, reconnect, two players
```

## Files

```
cloudflare.config.py   Worker, assets and Durable Object bindings (Wynd)
src/main.py            Entry: routes /agents/* with route_agent_request
src/arena.py           ArenaAgent: loop, protocol, swarm calls, checkpoints
src/sim.py             The authoritative World
src/swarm.py           SwarmAgent: decide() over RPC, memory in SDK state
src/tactics.py         Deterministic swarm tactics, steered by the strategist's directive
src/strategist.py      LLM strategist: prompt, battle report, reply validation
src/physics.py         Movement, collision and ray casts
src/level.py           Arena geometry, sent to clients in welcome
web/src/main.ts        Game loop: prediction, reconciliation, interpolation, events
web/src/net.ts         AgentClient connection
web/src/bio.ts         Palette, noise, the shared animated material, organic geometry builders
web/src/arena.ts       The forest over the level's collision boxes, vegetation, lights, Rapier colliders
web/src/creatures.ts   Procedural Striker, Sentinel and explorer bodies, and their animation
web/src/weapon.ts      First-person organic energy rifle
web/src/fx.ts          Fluid splashes, spore clouds, spore bolts, shots, emergence, death
web/src/debug.ts       F3 telemetry (connects to the SwarmAgents) and F4 overlay
web/src/audio.ts       Synthesized sound
```

## Limits

- Rooms are joined by URL. There is no lobby, matchmaking or player cap. Players past the fifth share spawn slots.
- Players don't collide with each other.
- Enemies steer toward waypoints and slide along walls. There is no navmesh, so a unit can briefly hug a pillar before its detour kicks in.
- Workers freeze the clock during computation, so the server can't time its own ticks. Telemetry shows the achieved tick rate and the RPC latency instead.

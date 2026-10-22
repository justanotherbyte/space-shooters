# Crosswind Swarm

A browser FPS in a neon arena. The enemies are run by Python agents on Cloudflare Workers. Each room has one `ArenaAgent` and two `SwarmAgent`s, all Durable Objects built with the [Crosswind Python Agents SDK](https://crosswind.viswa.space) (`cf-agents`). The `ArenaAgent` runs the authoritative game at 20 Hz. Each `SwarmAgent` commands half the robots. The browser sends inputs and draws what the server says happened.

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

- Score, waves and kills are shared. Allies show as cyan robots with a callsign and their health.
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

The tactics are deterministic:

| Tactic | When | What the units do |
|---|---|---|
| Coordinated assault | Default for alpha. Chosen when the other swarm is flanking, or when the swarm has fewer than 3 units. | Units take slots spread over an arc of up to 300° around the player, assigned in angular order so paths don't cross. Sentinels hold 8 m further out and suppress. |
| Flank | Default for bravo. Chosen when the other swarm is pressing, or when the player is camping. Needs at least 3 units. | Sentinels and the nearest third of the Strikers pin from the current side with faster, looser fire. The rest swing wide via a waypoint without firing, on the side away from the other swarm, so the two close a pincer. When they arrive they switch to assault. |
| Retreat | The swarm is down to half its peak strength, or its armor is under 30%. | All units fall back to the rally point farthest from the player. Sentinels give covering fire. |
| Regroup | After a retreat. | Units ring the rally point and defend it, then re-engage with their strength baseline reset. |

The SwarmAgent's SDK state is its memory: last known player position and track, a camping score, preferred engagement range (it widens after bad trades and narrows after good ones), current formation and roles, recent decisions with reasons, and a trade score per tactic built from past outcomes, which tips later choices. The memory is stored after every decision. Starting a new match clears the fight but keeps the learned trade scores, range and player model.

`select_tactic` is separate from `plan_orders`. An LLM strategist could replace `select_tactic` alone; the per-unit orders it leads to stay deterministic, and the arena still validates them.

### What is stored, and what isn't

| Data | Where | How often |
|---|---|---|
| Snapshots and events | `broadcast()`, never stored | 20 Hz |
| Match checkpoint (match id, phase, wave, score, kills, best, player HP, tick) | `ArenaAgent.set_state`, SQLite, synced to clients as `cf_agent_state` | On every phase change and every 5 s |
| Tactical memory | `SwarmAgent.set_state`, SQLite | Once per decision (2 Hz per swarm) |

When a Durable Object is evicted, the arena restores the checkpoint on its next start. The match id, score and tick carry over, and the interrupted wave restarts when the player rejoins. Enemies and projectiles aren't checkpointed. Saving them would mean a SQLite write per tick.

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

Rapier handles the client's collision queries against the level, such as where a tracer ends, and the debris when a robot breaks apart. Player movement uses the mirrored Python code instead of Rapier's character controller: the server can't run Rapier, and two different collision models would disagree on every wall and force constant corrections.

## Tests

```sh
uv run python tests/test_sim.py     # movement, order validation, a 4-minute bot battle, checkpoint restore, co-op
uv run python tests/test_mirror.py  # physics.ts matches physics.py over 100 s of random input
node tests/e2e.mjs                  # against a running worker: tick rate, hostile input, rate limit, reconnect, two players
```

## Files

```
cloudflare.config.py   Worker, assets and Durable Object bindings (Wynd)
src/main.py            Entry: routes /agents/* with route_agent_request
src/arena.py           ArenaAgent: loop, protocol, swarm calls, checkpoints
src/sim.py             The authoritative World
src/swarm.py           SwarmAgent: decide() over RPC, memory in SDK state
src/tactics.py         Deterministic swarm tactics
src/physics.py         Movement, collision and ray casts
src/level.py           Arena geometry, sent to clients in welcome
web/src/main.ts        Game loop: prediction, reconciliation, interpolation, events
web/src/net.ts         AgentClient connection
web/src/arena.ts       Arena meshes, lights and Rapier colliders
web/src/robots.ts      Procedural Striker and Sentinel models
web/src/weapon.ts      First-person energy rifle
web/src/fx.ts          Sparks, bolts, tracers, warp-ins, Rapier debris
web/src/debug.ts       F3 telemetry (connects to the SwarmAgents) and F4 overlay
web/src/audio.ts       Synthesized sound
```

## Limits

- Rooms are joined by URL. There is no lobby, matchmaking or player cap. Players past the fifth share spawn slots.
- Players don't collide with each other.
- Enemies steer toward waypoints and slide along walls. There is no navmesh, so a unit can briefly hug a pillar before its detour kicks in.
- Workers freeze the clock during computation, so the server can't time its own ticks. Telemetry shows the achieved tick rate and the RPC latency instead.

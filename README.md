# Crosswind Swarm

A browser FPS in a sunlit mecha-anime testing range. The mech squads hunting you are run by Python agents on Cloudflare Workers. Each room has one `ArenaAgent` and two `SwarmAgent`s, all Durable Objects built with the [Crosswind Python Agents SDK](https://crosswind.viswa.space) (`cf-agents`). The `ArenaAgent` runs the authoritative game at 20 Hz. Each `SwarmAgent` commands half the mechs. The browser sends inputs and draws what the server says happened.

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

- Score, waves and kills are shared. Allies show as cream-and-cyan mechs, with a callsign and their health.
- A player who goes down stays down until the squad clears the wave, then comes back with 50 integrity. The match ends when every connected player is down.
- The world pauses only when every player has paused. A paused player can't be targeted or hit, so pausing in co-op takes you out of the fight without stopping it.
- Each tab is one player. A duplicated tab copies the original's player id, so when it joins, the server hands that player to the new tab and the original takes a fresh id.

Controls: WASD to move, the mouse to aim, left click to fire, hold right click to scope in (about 2.8× zoom, with slower mouse aim), Q to switch between the rifle and a karambit (left click stabs), F to inspect the karambit, Space to jump, Shift to sprint, Esc to pause. F3 opens agent telemetry. F4 toggles the tactical overlay.

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
                                                      │ every ~3.5 s, in the background
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

Each SwarmAgent asks a Workers AI model for a strategy while a wave is on. It asks right away when something happens, and otherwise every 3.5 s. The events that trigger a call are:

- a wave starting
- the swarm losing a unit
- the other swarm switching tactic, which gives the two swarms their back-and-forth on the radio
- the player dropping to 35 health or less
- the rules forcing a retreat

There is one call in flight at a time and at least 1 s between event-driven calls. An event that arrives during a call waits for the next one. `decide` starts the call in the background and returns at once, so the arena never waits on the model. The model gets a compact battle report:

- its units by kind and health, and which tactics it has the units for
- the players' positions, health and speed, and how much they camp
- its trade record per tactic and recent outcomes
- the other swarm's tactic and its last radio callout
- the event that triggered the call, which the model is told to react to in its callout

It answers with JSON constrained by a schema: a tactic (any of the nine above, or retreat), a flank side, an engagement range, a piece of gear to use (or `none`), a callout to the other swarm, and a one-line reason. `parse_directive` treats that reply as untrusted. It rejects anything off-schema, clamps the range to 9–22 m and trims the text. The validated directive goes into the swarm's memory and steers `select_tactic` for 12 s.

The rules stay in charge of safety:

- A swarm at half strength or under 30% armor retreats whatever the model says.
- The model can call a retreat only for a swarm that has lost units.
- A tactic the swarm lacks the units for falls back to the rules' choice.
- A directive can't replace a tactic younger than 3 s, so back-to-back replies don't make a swarm flip-flop. The directive takes effect once the 3 s are up.
- Per-unit orders are still computed by `plan_orders` and validated by the arena.

A missing, late, failed or invalid reply only means the rules choose, as they did before the strategist existed. Each decision event says whether the directive or the rules picked the tactic (`source`). The HUD shows the model's callout with an `LLM` badge when its directive is in force. F3 shows the model, call count, failures, latency, what triggered the last call, the last error, and the directive with its reason.

The model is `@cf/zai-org/glm-4.7-flash`, set by `STRATEGIST_MODEL` in `cloudflare.config.py`. Set it to `""` to turn the strategist off. In local dev, restart `npm run worker` after changing it. Workers AI runs on Cloudflare even in local dev, so `npm run worker` needs `npx wrangler login`, and calls count against your Workers AI usage. Its thinking mode is turned off: with it on, the model spent its whole token budget reasoning and never answered. A reply takes about 2 s. Each call is about 400 input and 100 output tokens, two swarms calling every 3.5 s or sooner on events. In a 45 s test wave that came to one call every 2.5–3 s per swarm.

`@cf/zai-org/glm-5.3-flash` is stronger but not available on the Workers Free plan. Any Workers AI model that supports `response_format: json_schema` works.

### Swarm gear

Only the strategist uses gear. The rules never throw any, so with the LLM off the swarms fight with their guns alone. Each swarm's stock refills at the start of every wave:

| Gear | Stock | What it does |
| --- | --- | --- |
| `frag` | 1 | Lands at the player's feet, leading a moving player by 0.6 s, and bursts 0.9 s later. It deals up to 30 damage within 5 m, falling to 9 at the edge, and walls block the blast. |
| `smoke` | 2 | Lands halfway between the swarm and the player and makes a 4.5 m cloud for 10 s. Enemies can't see or fire through it, their own swarm's included. Players can still shoot into it. |
| `trap` | 2 | Lands 4.5 m ahead of a moving player, or 4 m toward the swarm from a still one, and arms after 1 s. The first player to step within 1.2 m takes 30 damage. It folds away after 40 s. |

`tactics._gear` aims the call and picks the nearest unit within 24 m of the spot to throw it. A call that no unit can reach yet waits, for as long as its directive stays fresh. Each directive gets one throw. The arena validates every throw like any other order: the unit must belong to the swarm and be past its warp-in, the swarm must have stock left, the spot must be inside the arena and within 24 m of the thrower, and each swarm waits 4 s between throws.

On screen, gear arcs from the thrower's hands. A frag shows a red blast ring that blinks faster as its fuse runs down. When a frag that will reach you is in the air or on the ground, the HUD shows a blinking `GRENADE` tag and an arrow pointing to it. A trap shows its trigger ring and a beacon in the swarm's color. The kill feed names each throw.

In two test matches against a player who stood still, the first gear call came within 9 s of the wave starting. Every call was a frag or a spike trap, and neither swarm chose smoke.

### What is stored, and what isn't

| Data | Where | How often |
|---|---|---|
| Snapshots and events | `broadcast()`, never stored | 20 Hz |
| Match checkpoint (match id, phase, wave, score, kills, best, player HP, tick) | `ArenaAgent.set_state`, SQLite, synced to clients as `cf_agent_state` | On every phase change and every 5 s |
| Tactical memory, including the strategist's directive and call stats | `SwarmAgent.set_state`, SQLite | Once per decision (2 Hz per swarm), and when a strategist reply lands |

When a Durable Object is evicted, the arena restores the checkpoint on its next start. The match id, score and tick carry over, and the interrupted wave restarts when the player rejoins. Enemies and projectiles aren't checkpointed. Saving them would mean a SQLite write per tick.

## Art direction

A retro-futurist mecha anime look: a sunlit concrete weapons-testing range inside a military megastructure, fought over by squads of brightly painted combat frames. It is built to stay readable on a phone and in compressed video.

The server's level is unchanged: its boxes and ramps stay the collision truth, and the client dresses them.

| Collision | Drawn as |
|---|---|
| Perimeter walls | Buttressed concrete with panel seams, a hazard band, a parapet, wall lamps, and a hangar door behind every spawn gate (lit in that swarm's color) |
| Pillars | Steel columns on concrete footings, holding a gantry with the reactor ring hung over the central deck |
| Platforms | The central command deck (with a painted emblem) and the two raised walkways along the sides, with vents and gold railings |
| Low cover | Segmented concrete jersey barriers |
| Crates | Cargo units with frames, stencilled panels and status lights |
| Ramps | Steel ramps with grip bars and gold kerbs |

Beyond the walls are hangars, cooling towers, striped stacks, antenna masts and cranes, and a city skyline in the haze under an anime sky with flat, crisp clouds.

How it renders (`web/src/kit.ts`):

- **Cel shading:** everything uses `MeshToonMaterial` with a three-step light ramp. The shadow tone stays at about half brightness, so shaded faces keep their detail. Hard-surface parts are chamfered convex hulls (`plate`, `prism`), so every edge catches a highlight.
- **Outlines:** mechs, the rifle and the architecture get an inverted-hull outline. It is pushed out along smoothed normals by a fixed fraction of the view distance, so it stays about the same width on screen, and it fades with the haze.
- **Lighting:** a strong sun with a 2048 shadow map, a bright sky fill, light distance haze only, a light bloom that only energy and fire reach, and neutral tone mapping. There is no vignette and no dark grading.
- **Cost:** about 145 draw calls and 160k triangles a frame with six mechs on the field.

Palette: warm ivory concrete (`#D8D5C8`), slate shadows (`#63748C`), steel machinery (`#788B9A`), navy joints (`#273347`), cyan energy (`#27DDF2`) and gold warnings (`#FFC857`). Swarm alpha's armor is vermilion (`#EF5145`), swarm bravo's is azure (`#2E86FF`), each with cream as the second color. Allies are cream and cyan.

The mechs (`web/src/mechs.ts`):

- **Striker (Assault Frame):** a humanoid frame with a raked helmet, a single cyan visor slit and a gold V-fin.
  - Its legs turn toward the direction of travel while its torso keeps aiming, so strafing reads.
  - It leans into strafes, recoils when it fires, staggers when hit, and fires its rear thrusters in flanks, rushes, retreats and sudden sidesteps.
- **Sentinel (Heavy Siege Frame):** navy and warm gray with orange markings, very broad shoulders in the swarm's color, twin cannons on each shoulder, oversized forearms and an amber reactor. Its cannons and reactor charge visibly between volleys, and it walks with heavy footfalls.
- **Enemy chevron:** every enemy carries a chevron in its swarm's color, a constant size on screen. It flashes white when that mech fires, and hides during an ambush.

Effects (`web/src/fx.ts`):

- **Enemy fire:** stretched bolts with a white core and a colored trail.
- **Player shots:** a cyan beam with a bolt riding it, and a star-shaped muzzle flash.
- **Armor hits:** sparks, a flash, and chips of plating knocked loose.
- **Destruction:** the reactor flares, then the mech explodes. The explosion layers a flash, flat-shaded fireball shapes that cool from white to orange, radial speed lines, a shockwave and light-gray smoke, while the armor panels fly apart under Rapier physics.
- **Spawns:** new mechs drop in on their thrusters.

Swarm coordination shows on the mechs, driven by the server's `decision` events. When a swarm's agent changes tactic, its visors flash in sequence and the Strikers raise their rifles together; in an ambush the markings go dark. Flanking, rushing and retreating units fire their thrusters, and regrouping Strikers raise their shields.

The HUD is a retro military display:

- Navy glass panels with thin cyan borders, amber labels and mono numerals.
- A segmented health bar and targeting brackets.
- A wave readout with one pip per active hostile, colored by swarm.

## Protocol (v1)

All messages are JSON over one WebSocket at `/agents/arena-agent/{room}`. The client uses `AgentClient` from the Agents SDK (`agents/client`). It reconnects on its own and sends `join` on every open.

Client to server:

| `t` | Fields | Meaning |
|---|---|---|
| `join` | `v`, `pid` | Join or rejoin as `pid`. Answered with `welcome`, a full resync. A wrong `v` gets `error` and a close. |
| `in` | `f: [[seq, keys, yaw, pitch], ...]` | Input frames at 60 per second, sent in batches every 33 ms. |
| `fire` | `d: [x, y, z]`, `rt` | Aim direction, plus the interpolated tick the client was rendering. |
| `stab` | `d: [x, y, z]`, `rt` | A knife thrust, as `fire` but with 2.6 m of reach and 45 damage (crits ×1.6). The server allows one every 0.45 s. |
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

The `ev` events are `spawn`, `death`, `proj` (a bolt was fired), `pend` (a bolt ended), `shot`, `hit`, `dmg` (a player took damage), `down`, `respawn`, `phase`, `wave`, `cleared`, `over`, `reset`, `decision` (a swarm command, with its status, RPC latency and age), and three for gear: `throw` (with the flight time in ticks), `deploy` (landed and live, with how many ticks it stays live) and `gend` (a frag burst, smoke cleared, or a trap sprang or folded, with the player it hit). The welcome snapshot lists gear already on the ground.

The client predicts its own movement with `web/src/physics.ts`, a line-for-line port of `src/physics.py` (`tests/test_mirror.py` checks they agree). On each snapshot it resets to the server's state and replays the input frames the server hasn't applied. Any visual error decays over about 100 ms. Enemies and other players are drawn 100 ms in the past, interpolated between snapshots. Enemy bolts start at the muzzle and catch up to the server's present.

The server uses numpy (Pyodide's build, pinned to 2.4.6, the only version on its package index) for queries that test many things at once: a ray against every level box, a shot against every enemy hit sphere, every bolt against every player and solid, and the spacing between squadmates. `move` stays scalar Python because it must match `physics.ts` line for line and resolves boxes one after another. numpy is slower than plain Python for these small arrays. A worst-case tick (14 enemies, 9 bolts) takes 0.37 ms natively instead of 0.23 ms, and a line-of-sight check takes 15 µs instead of 6 µs. Both are far inside the 50 ms tick. With numpy the upload is 7.8 MB, or 2.1 MB gzipped, under the 3 MB Free plan limit.

Rapier handles the client's collision queries against the level, such as where a shot lands, and the armor panels and fragments thrown off when a mech is hit or destroyed. Player movement uses the mirrored Python code instead of Rapier's character controller: the server can't run Rapier, and two different collision models would disagree on every wall and force constant corrections.

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
src/physics.py         Movement and collision (scalar), ray and point queries (numpy)
src/level.py           Arena geometry, sent to clients in welcome
web/src/main.ts        Game loop: prediction, reconciliation, interpolation, events
web/src/net.ts         AgentClient connection
web/src/kit.ts         Palette, noise, toon materials, outlines, hard-surface geometry builders
web/src/arena.ts       The facility over the level's collision boxes, the skyline, the sun, Rapier colliders
web/src/mechs.ts       Procedural Striker and Sentinel frames (and allies), and their animation
web/src/weapon.ts      First-person anime energy rifle
web/src/fx.ts          Sparks, explosions, bolts, beams, drop-ins, destruction
web/src/gear.ts        Swarm gear: thrown canisters, frag warnings, smoke clouds, spike traps
web/src/knife.ts       The karambit: draw, slash and inspect animations
web/src/debug.ts       F3 telemetry (connects to the SwarmAgents) and F4 overlay
web/src/audio.ts       Synthesized sound
```

## Limits

- Rooms are joined by URL. There is no lobby, matchmaking or player cap. Players past the fifth share spawn slots.
- Players don't collide with each other.
- Enemies steer toward waypoints and slide along walls. There is no navmesh, so a unit can briefly hug a pillar before its detour kicks in.
- A thrown canister's arc isn't tested against walls, so a throw can pass through a pillar on its way to the spot.
- Workers freeze the clock during computation, so the server can't time its own ticks. Telemetry shows the achieved tick rate and the RPC latency instead.

"""Checks web/src/physics.ts against src/physics.py on random input.

    uv run python tests/test_mirror.py   (needs Node 23.6+)
"""

import json
import random
import subprocess
import sys
from pathlib import Path

root = Path(__file__).parent.parent
sys.path.insert(0, str(root / "src"))

import level  # noqa: E402
import physics  # noqa: E402

rng = random.Random(4)
frames, keys, yaw = [], 0, 0.0
for i in range(6000):
    if i % 40 == 0:
        keys = rng.randrange(64)
    yaw += rng.uniform(-0.05, 0.05)
    frames.append([keys, yaw])
start = list(level.PLAYER_SPAWN)
body = physics.Body(*start, 0.4, 1.8)
expected = []
for k, y in frames:
    physics.step_player(body, k, y)
    expected.append([body.x, body.y, body.z])
got = json.loads(subprocess.run(
    ["node", str(root / "tests/mirror.mjs")], input=json.dumps({"level": level.as_json(), "frames": frames, "start": start}),
    capture_output=True, text=True, check=True,
).stdout)
worst = max(abs(a - b) for e, g in zip(expected, got) for a, b in zip(e, g))
print("frames", len(got), "max divergence", worst)
assert len(got) == len(expected) and worst < 1e-6

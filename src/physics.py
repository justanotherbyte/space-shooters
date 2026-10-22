"""Movement, collision and ray casts against the level.

web/src/physics.ts mirrors `move` line for line, so the client predicts its own
movement exactly as the server will apply it. Change both together.
"""

import math

from level import BOXES, RAMPS

GRAVITY = 22.0
JUMP_SPEED = 7.5
WALK_SPEED = 7.0
SPRINT_SPEED = 11.0
AIR_CONTROL = 6.0
STEP = 0.55

# Input bits, sent by the client with every input frame.
FORWARD, BACK, LEFT, RIGHT, JUMP, SPRINT = 1, 2, 4, 8, 16, 32
INPUT_DT = 1 / 60


class Body:
    """A vertical cylinder that walks on the level: players and enemies."""

    __slots__ = ("x", "y", "z", "vx", "vy", "vz", "ground", "radius", "height")

    def __init__(self, x: float, y: float, z: float, radius: float, height: float):
        self.x, self.y, self.z = x, y, z
        self.vx = self.vy = self.vz = 0.0
        self.ground = True
        self.radius = radius
        self.height = height


def ramp_height(rx0, rz0, rx1, rz1, axis, h0, h1, x, z):
    if x < rx0 or x > rx1 or z < rz0 or z > rz1:
        return None
    t = (x - rx0) / (rx1 - rx0) if axis == "x" else (z - rz0) / (rz1 - rz0)
    return h0 + (h1 - h0) * t


def floor_at(x: float, z: float, feet: float) -> float:
    """The highest walkable surface under (x, z) that a body at `feet` can stand on."""
    best = 0.0
    for b in BOXES:
        if b[0] <= x <= b[3] and b[2] <= z <= b[5] and b[4] <= feet + STEP and b[4] > best:
            best = b[4]
    for r in RAMPS:
        h = ramp_height(*r, x, z)
        if h is not None and h <= feet + STEP and h > best:
            best = h
    return best


def ramp_blocks(x: float, z: float, feet: float) -> bool:
    for r in RAMPS:
        h = ramp_height(*r, x, z)
        if h is not None and h > feet + STEP:
            return True
    return False


def push_out(body: Body) -> None:
    """Push the body's circle out of every box it can't step onto."""
    r = body.radius
    for b in BOXES:
        if b[4] <= body.y + STEP or b[1] >= body.y + body.height:
            continue
        cx = min(max(body.x, b[0]), b[3])
        cz = min(max(body.z, b[2]), b[5])
        dx, dz = body.x - cx, body.z - cz
        d2 = dx * dx + dz * dz
        if d2 >= r * r:
            continue
        if d2 > 1e-12:
            d = math.sqrt(d2)
            body.x += dx / d * (r - d)
            body.z += dz / d * (r - d)
        else:
            # Center inside the box: leave by the nearest face.
            exits = (
                (body.x - b[0] + r, -1.0, 0.0),
                (b[3] - body.x + r, 1.0, 0.0),
                (body.z - b[2] + r, 0.0, -1.0),
                (b[5] - body.z + r, 0.0, 1.0),
            )
            depth, ex, ez = min(exits)
            body.x += ex * depth
            body.z += ez * depth


def move(body: Body, wx: float, wz: float, dt: float, jump: bool = False) -> None:
    """Advance the body one step, wanting to move at velocity (wx, wz)."""
    if body.ground:
        body.vx, body.vz = wx, wz
        if jump:
            body.vy = JUMP_SPEED
            body.ground = False
    else:
        k = min(1.0, AIR_CONTROL * dt)
        body.vx += (wx - body.vx) * k
        body.vz += (wz - body.vz) * k
    body.vy -= GRAVITY * dt

    nx = body.x + body.vx * dt
    if not ramp_blocks(nx, body.z, body.y):
        body.x = nx
    nz = body.z + body.vz * dt
    if not ramp_blocks(body.x, nz, body.y):
        body.z = nz
    push_out(body)

    floor = floor_at(body.x, body.z, body.y)
    ny = body.y + body.vy * dt
    if ny <= floor:
        body.y = floor
        body.vy = 0.0
        body.ground = True
    elif body.ground and body.vy <= 0 and body.y - floor <= STEP:
        # Walking down a ramp or off a low ledge: stay on the ground.
        body.y = floor
        body.vy = 0.0
    else:
        body.y = ny
        body.ground = False


def input_velocity(keys: int, yaw: float) -> tuple[float, float]:
    """The velocity a player's keys ask for. Yaw 0 looks down -z, as in three.js."""
    f = (1 if keys & FORWARD else 0) - (1 if keys & BACK else 0)
    s = (1 if keys & RIGHT else 0) - (1 if keys & LEFT else 0)
    sin, cos = math.sin(yaw), math.cos(yaw)
    wx = -sin * f + cos * s
    wz = -cos * f - sin * s
    n = math.sqrt(wx * wx + wz * wz)
    if n < 1e-9:
        return 0.0, 0.0
    speed = SPRINT_SPEED if keys & SPRINT and f > 0 else WALK_SPEED
    return wx / n * speed, wz / n * speed


def step_player(body: Body, keys: int, yaw: float) -> None:
    wx, wz = input_velocity(keys, yaw)
    move(body, wx, wz, INPUT_DT, bool(keys & JUMP))


def ray_box(ox, oy, oz, dx, dy, dz, b, max_t):
    """Distance along the ray to box `b`, or None (slab test)."""
    t0, t1 = 0.0, max_t
    for o, d, lo, hi in ((ox, dx, b[0], b[3]), (oy, dy, b[1], b[4]), (oz, dz, b[2], b[5])):
        if abs(d) < 1e-12:
            if o < lo or o > hi:
                return None
            continue
        a, c = (lo - o) / d, (hi - o) / d
        if a > c:
            a, c = c, a
        t0, t1 = max(t0, a), min(t1, c)
        if t0 > t1:
            return None
    return t0


def ray_level(ox, oy, oz, dx, dy, dz, max_t: float) -> float:
    """Distance to the first level surface along a unit ray (max_t if none)."""
    best = max_t
    if dy < 0:
        best = min(best, -oy / dy)  # the floor
    for b in BOXES:
        t = ray_box(ox, oy, oz, dx, dy, dz, b, best)
        if t is not None and t < best:
            best = t
    return best


def ray_sphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r):
    lx, ly, lz = cx - ox, cy - oy, cz - oz
    t = lx * dx + ly * dy + lz * dz
    if t < 0:
        return None
    d2 = lx * lx + ly * ly + lz * lz - t * t
    if d2 > r * r:
        return None
    return t - math.sqrt(r * r - d2)


def line_of_sight(ax, ay, az, bx, by, bz) -> bool:
    dx, dy, dz = bx - ax, by - ay, bz - az
    n = math.sqrt(dx * dx + dy * dy + dz * dz)
    if n < 1e-9:
        return True
    return ray_level(ax, ay, az, dx / n, dy / n, dz / n, n) >= n - 1e-6


def inside_solid(x: float, y: float, z: float) -> bool:
    if y <= 0:
        return True
    for b in BOXES:
        if b[0] <= x <= b[3] and b[1] <= y <= b[4] and b[2] <= z <= b[5]:
            return True
    for r in RAMPS:
        h = ramp_height(*r, x, z)
        if h is not None and y <= h:
            return True
    return False

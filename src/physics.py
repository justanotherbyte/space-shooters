"""Movement, collision and ray casts against the level.

web/src/physics.ts mirrors `move` line for line, so the client predicts its own
movement exactly as the server will apply it. Change both together. `move`
stays scalar Python on purpose: `push_out` resolves boxes one after another
(each push moves the body before the next box is tested), and for one body a
loop over ~25 boxes beats numpy's per-call overhead. The queries below test
many boxes, spheres or points at once, and use numpy.
"""

import math

import numpy as np

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


# The level as arrays, for queries that test many boxes, spheres or points at once.
BOX_LO = np.array([b[0:3] for b in BOXES], dtype=float)
BOX_HI = np.array([b[3:6] for b in BOXES], dtype=float)
_RAMPS = np.array([[r[0], r[1], r[2], r[3], r[4] == "x", r[5], r[6]] for r in RAMPS], dtype=float)


def ray_level(ox, oy, oz, dx, dy, dz, max_t: float) -> float:
    """Distance to the first level surface along a unit ray (max_t if none).

    One slab test against every box at once.
    """
    o, d = np.array([ox, oy, oz]), np.array([dx, dy, dz])
    flat = np.abs(d) < 1e-12  # parallel to a pair of slabs
    step = np.where(flat, 1.0, d)
    a, c = (BOX_LO - o) / step, (BOX_HI - o) / step
    near = np.where(flat, -np.inf, np.minimum(a, c)).max(axis=1)
    far = np.where(flat, np.inf, np.maximum(a, c)).min(axis=1)
    outside = (flat & ((o < BOX_LO) | (o > BOX_HI))).any(axis=1)
    entry = np.maximum(near, 0.0)
    hit = ~outside & (entry <= np.minimum(far, max_t))
    best = float(entry[hit].min()) if hit.any() else max_t
    if dy < 0:
        best = min(best, -oy / dy)  # the floor
    return best


def ray_spheres(o: np.ndarray, d: np.ndarray, centers: np.ndarray, radii: np.ndarray) -> np.ndarray:
    """Distance along a unit ray to each sphere (inf where it misses)."""
    rel = centers - o
    t = rel @ d
    d2 = (rel * rel).sum(axis=1) - t * t
    r2 = radii * radii
    hit = (t >= 0) & (d2 <= r2)
    return np.where(hit, t - np.sqrt(np.maximum(r2 - d2, 0.0)), np.inf)


def line_of_sight(ax, ay, az, bx, by, bz) -> bool:
    dx, dy, dz = bx - ax, by - ay, bz - az
    n = math.sqrt(dx * dx + dy * dy + dz * dz)
    if n < 1e-9:
        return True
    return ray_level(ax, ay, az, dx / n, dy / n, dz / n, n) >= n - 1e-6


def inside_solid(points: np.ndarray) -> np.ndarray:
    """For each point (an (n, 3) array), whether it is inside the floor, a box or a ramp."""
    p = np.atleast_2d(points)
    solid = p[:, 1] <= 0
    solid |= ((p[:, None, :] >= BOX_LO) & (p[:, None, :] <= BOX_HI)).all(axis=2).any(axis=1)
    x, y, z = p[:, 0:1], p[:, 1:2], p[:, 2:3]
    rx0, rz0, rx1, rz1, along_x, h0, h1 = _RAMPS.T
    over = (x >= rx0) & (x <= rx1) & (z >= rz0) & (z <= rz1)
    t = np.where(along_x > 0, (x - rx0) / (rx1 - rx0), (z - rz0) / (rz1 - rz0))
    solid |= (over & (y <= h0 + (h1 - h0) * t)).any(axis=1)
    return solid

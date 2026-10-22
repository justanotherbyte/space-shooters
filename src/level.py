"""The arena's geometry. The server is the only source: clients get it in `welcome`."""

HALF = 32.0  # the floor spans [-HALF, HALF] on x and z
WALL_H = 9.0

# Solid boxes: (min x, min y, min z, max x, max y, max z, kind).
BOXES: list[tuple[float, float, float, float, float, float, str]] = [
    # perimeter
    (-HALF - 1, 0, -HALF - 1, HALF + 1, WALL_H, -HALF, "wall"),
    (-HALF - 1, 0, HALF, HALF + 1, WALL_H, HALF + 1, "wall"),
    (-HALF - 1, 0, -HALF, -HALF, WALL_H, HALF, "wall"),
    (HALF, 0, -HALF, HALF + 1, WALL_H, HALF, "wall"),
    # central platform
    (-6, 0, -6, 6, 2.2, 6, "platform"),
    # side galleries
    (22, 0, -12, HALF, 3.5, 12, "platform"),
    (-HALF, 0, -12, -22, 3.5, 12, "platform"),
    # pillars
    (-14.2, 0, -14.2, -11.8, WALL_H, -11.8, "pillar"),
    (11.8, 0, -14.2, 14.2, WALL_H, -11.8, "pillar"),
    (-14.2, 0, 11.8, -11.8, WALL_H, 14.2, "pillar"),
    (11.8, 0, 11.8, 14.2, WALL_H, 14.2, "pillar"),
    # low cover
    (-3, 0, 20, 3, 1.3, 21, "cover"),
    (-3, 0, -21, 3, 1.3, -20, "cover"),
    (15.5, 0, -2.5, 16.5, 1.3, 2.5, "cover"),
    (-16.5, 0, -2.5, -15.5, 1.3, 2.5, "cover"),
    (-22, 0, 22, -18, 1.3, 23, "cover"),
    (18, 0, -23, 22, 1.3, -22, "cover"),
    (7, 0, 24, 8, 1.3, 28, "cover"),
    (-8, 0, -28, -7, 1.3, -24, "cover"),
    # crates
    (-10, 0, 4, -8.5, 1.5, 5.5, "crate"),
    (8.5, 0, -5.5, 10, 1.5, -4, "crate"),
    (20, 0, 18, 21.6, 1.6, 19.6, "crate"),
    (-21.6, 0, -19.6, -20, 1.6, -18, "crate"),
    (24, 0, -26, 26, 2.0, -24, "crate"),
    (-26, 0, 24, -24, 2.0, 26, "crate"),
]

# Walkable ramps: (min x, min z, max x, max z, axis, height at min, height at max).
# The height runs linearly along `axis` ("x" or "z").
RAMPS: list[tuple[float, float, float, float, str, float, float]] = [
    (-2.5, 6, 2.5, 13, "z", 2.2, 0.0),
    (-2.5, -13, 2.5, -6, "z", 0.0, 2.2),
    (24, 12, 29, 20, "z", 3.5, 0.0),
    (-29, -20, -24, -12, "z", 0.0, 3.5),
]

# One slot per player, on the central platform.
PLAYER_SPAWNS = [(0.0, 2.2, 0.0), (3.0, 2.2, 3.0), (-3.0, 2.2, 3.0), (3.0, 2.2, -3.0), (-3.0, 2.2, -3.0)]
PLAYER_SPAWN = PLAYER_SPAWNS[0]

# Enemy spawn gates, by swarm. Each swarm enters from its own side.
GATES = {
    "alpha": [(-27.0, -27.0), (27.0, -27.0), (0.0, -29.0)],
    "bravo": [(-27.0, 27.0), (27.0, 27.0), (0.0, 29.0)],
}

# Where a beaten swarm falls back to regroup.
RALLY_POINTS = [
    (-27.5, -27.5), (27.5, -27.5), (-27.5, 27.5), (27.5, 27.5),
    (-17.0, 0.0), (17.0, 0.0), (0.0, -24.0), (0.0, 24.0),
]


def as_json() -> dict:
    return {
        "half": HALF,
        "wallH": WALL_H,
        "boxes": [list(b) for b in BOXES],
        "ramps": [list(r) for r in RAMPS],
        "gates": {k: [list(g) for g in v] for k, v in GATES.items()},
        "spawn": list(PLAYER_SPAWN),
    }

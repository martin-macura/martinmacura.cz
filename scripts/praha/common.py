"""Shared by the bake steps: the projection of the world onto the map and readers of the cached OpenStreetMap data."""
import glob, json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")

# world: x east, z south, 1 unit = M metres; (0, 0) is at the Charles Bridge unless the anchor is moved
LAT0, LON0 = 50.0865, 14.4112
M = 6.0
ISLE_X, ISLE_Z = 640, 480
KX = 111320 * math.cos(math.radians(50.08)) / M
KZ = 111200 / M


def project(lat, lon):
    return (lon - LON0) * KX, -(lat - LAT0) * KZ


def unproject(x, z):
    return LAT0 - z / KZ, LON0 + x / KX


def load(name):
    with open(os.path.join(CACHE, name + ".json")) as f:
        return json.load(f)["elements"]


def load_many(pattern):
    out = []
    for p in sorted(glob.glob(os.path.join(CACHE, pattern))):
        with open(p) as f:
            out += json.load(f)["elements"]
    return out


def pts(geom):
    return [project(g["lat"], g["lon"]) for g in geom]


def rings(el):
    """outer and inner rings of a way or a multipolygon relation, in world coordinates: (outers, inners)"""
    if el["type"] == "way":
        return ([pts(el["geometry"])], []) if "geometry" in el else ([], [])
    segs = {"outer": [], "inner": []}
    for m in el.get("members", []):
        if m.get("type") == "way" and m.get("geometry") and m.get("role") in segs:
            segs[m["role"]].append(pts(m["geometry"]))
    return join(segs["outer"]), join(segs["inner"])


def join(lines):
    """stitches open ways end to end into closed rings"""
    rs = []
    lines = [l[:] for l in lines if len(l) > 1]
    eq = lambda a, b: abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6
    while lines:
        cur = lines.pop()
        grew = True
        while grew and not eq(cur[0], cur[-1]):
            grew = False
            for i, l in enumerate(lines):
                if eq(cur[-1], l[0]):
                    cur += l[1:]
                elif eq(cur[-1], l[-1]):
                    cur += l[::-1][1:]
                elif eq(cur[0], l[-1]):
                    cur = l[:-1] + cur
                elif eq(cur[0], l[0]):
                    cur = l[::-1][:-1] + cur
                else:
                    continue
                lines.pop(i)
                grew = True
                break
        if len(cur) > 3:
            rs.append(cur)
    return rs

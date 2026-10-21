#!/usr/bin/env python3
"""Step 2b: the streets as lines, for drawing them straight up close and for the cars: public/vlaky/praha-roads.dat (gzip).

The raster in praha.dat stays: it draws the streets from afar and says where the lamps and the trees may go.
Here every street is cut at its junctions into edges between shared nodes, so that the edges make a graph.

layout of the decompressed data, all numbers LEB128 varints (signed ones zigzagged), coordinates in quarter units:
  nodes count, then for every node: dx, dz from the previous node (the first from 0, 0)
  edges count, then for every edge, sorted by its first node:
    flags (bits0-1 class: 1 street, 2 avenue, 3 motorway; bit2 one way; bit3 bridge)
    a - previous a, b - a (the nodes it joins), count of the points between them, then each point as dx, dz from the last one
Data: (c) OpenStreetMap contributors, ODbL."""
import gzip, math, os
from common import *

OUT = os.path.join(HERE, "..", "..", "public", "vlaky", "praha-roads.dat")
STREET = {"residential", "living_street", "pedestrian", "unclassified"}
AVENUE = {"primary", "secondary", "tertiary", "primary_link", "secondary_link", "tertiary_link", "trunk", "trunk_link"}
MOTOR = {"motorway", "motorway_link"}
TOL = 0.35  # Douglas-Peucker tolerance, units (about 2 m)


def cls_of(t):
    h = t.get("highway")
    return 1 if h in STREET else 2 if h in AVENUE else 3 if h in MOTOR else 0


ways, seen = [], set()
for e in layer("highways"):
    if e["id"] in seen or "geometry" not in e or "nodes" not in e:
        continue
    seen.add(e["id"])
    t = e.get("tags", {})
    c = cls_of(t)
    if not c or t.get("tunnel") in ("yes", "building_passage") or len(e["nodes"]) != len(e["geometry"]):
        continue
    ids, p = e["nodes"], pts(e["geometry"])
    ow = t.get("oneway")
    one = ow in ("yes", "1", "true", "-1") or (ow is None and (t.get("highway") in MOTOR or t.get("junction") in ("roundabout", "circular")))
    if ow == "-1":
        ids, p = ids[::-1], p[::-1]
    br = t.get("bridge") in ("yes", "viaduct", "movable")
    if any(GX0 < x < GX0 + GW and GZ0 < z < GZ0 + GH for x, z in p):
        ways.append((c, one, br, ids, p))

# a node shared by two ways, or the end of one, is a junction: the edges meet there
uses = {}
for _, _, _, ids, _ in ways:
    for i, n in enumerate(ids):
        uses[n] = uses.get(n, 0) + (2 if i in (0, len(ids) - 1) else 1)


def simplify(p):
    if len(p) < 3:
        return p
    (ax, az), (bx, bz) = p[0], p[-1]
    dx, dz = bx - ax, bz - az
    L = math.hypot(dx, dz) or 1e-9
    best, bi = -1, 0
    for i in range(1, len(p) - 1):
        d = abs((p[i][0] - ax) * dz - (p[i][1] - az) * dx) / L
        if d > best:
            best, bi = d, i
    if best <= TOL:
        return [p[0], p[-1]]
    return simplify(p[: bi + 1])[:-1] + simplify(p[bi:])


q = lambda v: int(round(v * 4))
node_of, node_pos, edges = {}, [], []
def node(n, xy):
    if n not in node_of:
        node_of[n] = len(node_pos)
        node_pos.append((q(xy[0]), q(xy[1])))
    return node_of[n]

for c, one, br, ids, p in ways:
    start = 0
    for i in range(1, len(ids)):
        if uses[ids[i]] >= 2 or i == len(ids) - 1:
            seg = simplify(p[start : i + 1])
            if ids[start] != ids[i] or len(seg) > 2:
                edges.append((node(ids[start], p[start]), node(ids[i], p[i]), c | (4 if one else 0) | (8 if br else 0), [(q(x), q(z)) for x, z in seg[1:-1]]))
            start = i

# nodes in reading order, so that their deltas are small
order = sorted(range(len(node_pos)), key=lambda i: (node_pos[i][1] // 64, node_pos[i][0]))
renum = {o: i for i, o in enumerate(order)}
node_pos = [node_pos[o] for o in order]
edges = sorted(((renum[a], renum[b], f, mid) for a, b, f, mid in edges), key=lambda e: e[0])

out = bytearray()
def uv(v):
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return
sv = lambda v: uv(v * 2 if v >= 0 else -v * 2 - 1)

uv(len(node_pos))
px = pz = 0
for x, z in node_pos:
    sv(x - px); sv(z - pz)
    px, pz = x, z
uv(len(edges))
pa = 0
npts = 0
for a, b, f, mid in edges:
    uv(f); uv(a - pa); sv(b - a); uv(len(mid))
    pa = a
    lx, lz = node_pos[a]
    for x, z in mid:
        sv(x - lx); sv(z - lz)
        lx, lz = x, z
    npts += len(mid)

data = gzip.compress(bytes(out), 9)
open(OUT, "wb").write(data)
print(f"{len(node_pos)} nodes, {len(edges)} edges, {npts} points between them; {len(out) / 1e6:.2f} MB -> {len(data) / 1e3:.0f} kB")

#!/usr/bin/env python3
"""Step 2: turns the cache into public/vlaky/praha.dat (gzip), the one file the /vlaky/praha scene loads.

layout of the decompressed data (little endian):
  u16 width, u16 height            the grid, one cell per unit, (0, 0) is the middle
  width*height bytes               per cell: bit0 water, bits1-2 road (0 none, 1 street, 2 avenue, 3 motorway), bit3 bridge, bits4-5 green (0 none, 1 park, 2 wood)
  (width/2)*(height/2) bytes       terrain, for every 2 x 2 cells: steps of 8 m above the river
  u32 count, then count * 10 bytes buildings: i16 x*4, i16 z*4, u8 w*8, u8 d*8, u8 angle (0..255 = 0..pi), u8 metres, u8 kind (1 church, 2 flat roof, 4 big)
Data: (c) OpenStreetMap contributors, ODbL; terrain: terrain tiles (terrarium) built from public elevation data."""
import gzip, io, math, os, struct
import numpy as np
from PIL import Image, ImageDraw
from common import *

OUT = os.path.join(HERE, "..", "..", "public", "vlaky", "praha.dat")
GW, GH = ISLE_X * 2, ISLE_Z * 2
cell = lambda p: (p[0] + ISLE_X, p[1] + ISLE_Z)

# --- water
water = Image.new("L", (GW, GH), 0)
wd = ImageDraw.Draw(water)
holes = []
for el in load("water"):
    t = el.get("tags", {})
    if t.get("natural") != "water" and t.get("waterway") != "riverbank":
        continue
    outs, ins = rings(el)
    for r in outs:
        wd.polygon([cell(p) for p in r], fill=1)
    holes += ins
for r in holes:
    wd.polygon([cell(p) for p in r], fill=0)

# --- roads
STREET = {"residential", "living_street", "pedestrian", "unclassified"}
AVENUE = {"primary", "secondary", "tertiary", "primary_link", "secondary_link", "tertiary_link", "trunk", "trunk_link"}
road = Image.new("L", (GW, GH), 0)
bridge = Image.new("L", (GW, GH), 0)
rd, bd = ImageDraw.Draw(road), ImageDraw.Draw(bridge)
ways = [e for e in load("highways") if "geometry" in e and e["tags"].get("tunnel") not in ("yes", "building_passage")]
for cls, width, names in ((1, 1, STREET), (2, 2, AVENUE), (3, 3, {"motorway", "motorway_link"})):
    for e in ways:
        if e["tags"]["highway"] in names:
            line = [cell(p) for p in pts(e["geometry"])]
            rd.line(line, fill=cls, width=width)
            if e["tags"].get("bridge") in ("yes", "viaduct", "movable"):
                bd.line(line, fill=1, width=width + 1)

# --- green
green = Image.new("L", (GW, GH), 0)
gd = ImageDraw.Draw(green)
greens = load("green")
def is_wood(t): return t.get("landuse") == "forest" or t.get("natural") in ("wood", "scrub")
for wood in (False, True):
    for el in greens:
        t = el.get("tags", {})
        if is_wood(t) != wood:
            continue
        outs, ins = rings(el)
        for r in outs: gd.polygon([cell(p) for p in r], fill=2 if wood else 1)
        for r in ins: gd.polygon([cell(p) for p in r], fill=0)

W8, R8, B8, G8 = (np.array(i, dtype=np.uint8) for i in (water, road, bridge, green))
cells = (W8 & 1) | ((R8 & 3) << 1) | ((B8 & 1) << 3) | ((G8 & 3) << 4)
# a road over water is always a bridge, even where the map forgot to say so
cells = np.where((W8 == 1) & (R8 > 0), cells | 8, cells).astype(np.uint8)

# --- terrain, from the tiles: decoded, then looked up for the middle of every 2 x 2 cells
Z = 13
tiles = {}
for f in os.listdir(CACHE):
    if f.startswith("terrarium-"):
        _, z, tx, ty = f[:-4].split("-")
        a = np.array(Image.open(os.path.join(CACHE, f)).convert("RGB"), dtype=np.float64)
        tiles[(int(tx), int(ty))] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
def dem(lat, lon):
    n = 2**Z
    fx = (lon + 180) / 360 * n
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    tx, ty = int(fx), int(fy)
    t = tiles.get((tx, ty))
    if t is None:
        return None
    return t[min(255, int((fy - ty) * 256)), min(255, int((fx - tx) * 256))]
hx, hz = GW // 2, GH // 2
elev = np.zeros((hz, hx))
for j in range(hz):
    for i in range(hx):
        lat, lon = unproject(i * 2 + 1 - ISLE_X, j * 2 + 1 - ISLE_Z)
        elev[j, i] = dem(lat, lon) or 0
wat = W8.reshape(hz, 2, hx, 2).max(axis=(1, 3)) == 1
base = float(np.median(elev[wat & (elev > 100)]))
print("river level", base)
steps = np.clip(np.floor((elev - base + 3) / 8), 0, 255).astype(np.uint8)
steps[wat] = 0

# --- buildings: every footprint becomes its smallest enclosing rectangle
def min_rect(poly):
    p = np.array(poly)
    best = None
    for k in range(len(p) - 1):
        dx, dy = p[k + 1] - p[k]
        L = math.hypot(dx, dy)
        if L < 1e-6:
            continue
        c, s = dx / L, dy / L
        u = p[:, 0] * c + p[:, 1] * s
        v = -p[:, 0] * s + p[:, 1] * c
        area = (u.max() - u.min()) * (v.max() - v.min())
        if best is None or area < best[0]:
            best = (area, c, s, u.min(), u.max(), v.min(), v.max())
    if best is None:
        return None
    _, c, s, u0, u1, v0, v1 = best
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    return cu * c - cv * s, cu * s + cv * c, u1 - u0, v1 - v0, math.atan2(s, c)

def metres(t, area):
    def num(s):
        try: return float(str(s).split()[0].replace(",", "."))
        except Exception: return None
    h = num(t["height"]) if "height" in t else None
    if h is None and "building:levels" in t:
        lv = num(t["building:levels"])
        h = lv * 3.2 + 2 if lv else None
    if h is None:
        h = 6 if area < 80 else 16 if area < 900 else 14
    return max(3, min(250, h))

recs, seen = [], set()
for el in load_many("buildings-*"):
    if (el["type"], el["id"]) in seen:
        continue
    seen.add((el["type"], el["id"]))
    t = el.get("tags", {})
    outs, _ = rings(el)
    for ring in outs:
        if len(ring) < 4:
            continue
        r = min_rect(ring)
        if r is None:
            continue
        x, z, w, d, ang = r
        if w < d:
            w, d, ang = d, w, ang + math.pi / 2
        if w * d < 0.7 or abs(x) > ISLE_X or abs(z) > ISLE_Z:  # under 25 m2
            continue
        ang %= math.pi
        kind = 0
        if t.get("building") in ("church", "cathedral", "chapel", "monastery") or t.get("amenity") == "place_of_worship": kind |= 1
        if t.get("roof:shape") == "flat": kind |= 2
        if t.get("building") in ("industrial", "commercial", "retail", "warehouse", "office"): kind |= 4
        recs.append((int(round(x * 4)), int(round(z * 4)), min(255, int(round(w * 8))), min(255, int(round(d * 8))), min(255, int(ang / math.pi * 256)), int(round(metres(t, w * d * M * M))), kind))
print(len(recs), "buildings")

buf = io.BytesIO()
buf.write(struct.pack("<HH", GW, GH))
buf.write(cells.tobytes())
buf.write(steps.tobytes())
buf.write(struct.pack("<I", len(recs)))
for r in recs:
    buf.write(struct.pack("<hhBBBBB", *r) + b"\0")  # padded to 10 bytes
os.makedirs(os.path.dirname(OUT), exist_ok=True)
data = gzip.compress(buf.getvalue(), 9)
open(OUT, "wb").write(data)
print(f"{len(buf.getvalue()) / 1e6:.2f} MB -> {len(data) / 1e3:.0f} kB")

# a picture of the result, for looking at
pic = np.zeros((GH, GW, 3), dtype=np.uint8)
pic[:] = (225, 222, 205)
g = (cells >> 4) & 3
pic[g == 1] = (170, 205, 150); pic[g == 2] = (110, 160, 100)
hh = np.kron(steps, np.ones((2, 2), dtype=np.uint8))
pic = np.clip(pic.astype(int) - hh[..., None] * 5, 0, 255).astype(np.uint8)
pic[cells & 1 == 1] = (110, 160, 215)
rc = (cells >> 1) & 3
pic[rc == 1] = (150, 150, 150); pic[rc >= 2] = (80, 80, 80); pic[(cells >> 3) & 1 == 1] = (200, 120, 40)
im = Image.fromarray(pic); dr = ImageDraw.Draw(im)
for x, z, w, d, a, h, k in recs:
    dr.rectangle([x / 4 + ISLE_X - w / 16, z / 4 + ISLE_Z - d / 16, x / 4 + ISLE_X + w / 16, z / 4 + ISLE_Z + d / 16], fill=(190, 80, 60) if k & 1 == 0 else (250, 230, 0))
im.save("/private/tmp/claude-501/-Users-macik/3cf9040c-d8a1-43f6-8e39-2ddd66f438e3/scratchpad/baked.png")

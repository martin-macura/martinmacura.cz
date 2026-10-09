#!/usr/bin/env python3
"""Step 1 of the Prague bake: download the OpenStreetMap layers and the terrain tiles into scripts/praha/.cache.

OpenStreetMap data: (c) OpenStreetMap contributors, ODbL. Terrain: Mapzen/AWS terrain tiles (terrarium), see https://registry.opendata.aws/terrain-tiles/
Run once; later steps read the cache, so the network is not needed again."""
import json, math, os, sys, time, urllib.parse, urllib.request

from common import CACHE, FULL, S, N, W, E

os.makedirs(CACHE, exist_ok=True)
UA = "martinmacura.cz-praha-bake/1.0 (personal site; https://martinmacura.cz)"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]



def overpass(name, query):
    path = os.path.join(CACHE, name + ".json")
    if os.path.exists(path):
        return path
    data = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(6):
        ep = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                body = r.read()
            json.loads(body)  # must be valid
            with open(path, "wb") as f:
                f.write(body)
            print(f"{name}: {len(body) / 1e6:.1f} MB", flush=True)
            time.sleep(3)
            return path
        except Exception as e:
            print(f"{name}: attempt {attempt} failed: {e}", flush=True)
            time.sleep(10 + attempt * 10)
    sys.exit(f"could not fetch {name}")


def bbox(s, n, w, e):
    return f"({s},{w},{n},{e})"


HW = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian|service"
Q = {
    "water": lambda b: f'[out:json][timeout:250];(way["natural"="water"]{b};relation["natural"="water"]{b};way["waterway"="riverbank"]{b};relation["waterway"="riverbank"]{b};way["waterway"~"^(river|canal)$"]{b};);out geom;',
    "highways": lambda b: f'[out:json][timeout:250];way["highway"~"^({HW})$"]{b};out geom;',
    "green": lambda b: f'[out:json][timeout:250];(way["leisure"~"^(park|garden|pitch|golf_course|recreation_ground)$"]{b};relation["leisure"~"^(park|garden)$"]{b};way["landuse"~"^(forest|grass|meadow|recreation_ground|cemetery|allotments|village_green|vineyard|orchard)$"]{b};relation["landuse"~"^(forest|grass|meadow|cemetery)$"]{b};way["natural"~"^(wood|scrub|grassland)$"]{b};relation["natural"="wood"]{b};);out geom;',
    "rail": lambda b: f'[out:json][timeout:250];(way["railway"~"^(rail|light_rail|subway|tram)$"]{b};node["railway"~"^(station|halt|level_crossing)$"]{b};);out geom;',
    "buildings": lambda b: f'[out:json][timeout:250];(way["building"]{b};relation["building"]{b};);out geom;',
}


def tiled(layer, tx, ty, name=None):
    """the layer in tx x ty pieces, to stay inside the server's limits"""
    for i in range(tx):
        for j in range(ty):
            s = S + (N - S) * j / ty
            n = S + (N - S) * (j + 1) / ty
            w = W + (E - W) * i / tx
            e = W + (E - W) * (i + 1) / tx
            overpass(f"{name or layer}-{i}-{j}", Q[layer](bbox(s, n, w, e)))


if FULL:
    # the whole city: 35 x 27 km, in tiles of 5-7 km (the layers) and 3.5 km (the 250,000 buildings); a few minutes of waiting
    for layer in ("water", "highways", "green"):
        tiled(layer, 5, 4)
    tiled("buildings", 10, 8)
else:
    for layer in ("water", "highways", "green", "rail"):
        overpass(layer, Q[layer](bbox(S, N, W, E)))
    tiled("buildings", 4, 3)  # buildings in tiles


# terrain: terrarium tiles at zoom 13
def tile_xy(lat, lon, z):
    n = 2**z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


Z = 13
x0, y1 = tile_xy(S, W, Z)
x1, y0 = tile_xy(N, E, Z)
for tx in range(int(x0), int(x1) + 1):
    for ty in range(int(y0), int(y1) + 1):
        path = os.path.join(CACHE, f"terrarium-{Z}-{tx}-{ty}.png")
        if not os.path.exists(path):
            url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png"
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
                f.write(r.read())
            print("tile", tx, ty, flush=True)
print("done")

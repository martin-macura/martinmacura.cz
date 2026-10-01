#!/usr/bin/env python3
"""Step 1 of the Prague bake: download the OpenStreetMap layers and the terrain tiles into scripts/praha/.cache.

OpenStreetMap data: (c) OpenStreetMap contributors, ODbL. Terrain: Mapzen/AWS terrain tiles (terrarium), see https://registry.opendata.aws/terrain-tiles/
Run once; later steps read the cache, so the network is not needed again."""
import json, math, os, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
os.makedirs(CACHE, exist_ok=True)
UA = "martinmacura.cz-praha-bake/1.0 (personal site; https://martinmacura.cz)"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

# a little wider than the world, so that the anchor can still move a bit
S, N, W, E = 50.0580, 50.1150, 14.3500, 14.4750


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
overpass("water", f'[out:json][timeout:250];(way["natural"="water"]{bbox(S, N, W, E)};relation["natural"="water"]{bbox(S, N, W, E)};way["waterway"="riverbank"]{bbox(S, N, W, E)};relation["waterway"="riverbank"]{bbox(S, N, W, E)};way["waterway"~"^(river|canal)$"]{bbox(S, N, W, E)};);out geom;')
overpass("highways", f'[out:json][timeout:250];way["highway"~"^({HW})$"]{bbox(S, N, W, E)};out geom;')
overpass("green", f'[out:json][timeout:250];(way["leisure"~"^(park|garden|pitch|golf_course|recreation_ground)$"]{bbox(S, N, W, E)};relation["leisure"~"^(park|garden)$"]{bbox(S, N, W, E)};way["landuse"~"^(forest|grass|meadow|recreation_ground|cemetery|allotments|village_green|vineyard|orchard)$"]{bbox(S, N, W, E)};relation["landuse"~"^(forest|grass|meadow|cemetery)$"]{bbox(S, N, W, E)};way["natural"~"^(wood|scrub|grassland)$"]{bbox(S, N, W, E)};relation["natural"="wood"]{bbox(S, N, W, E)};);out geom;')
overpass("rail", f'[out:json][timeout:250];(way["railway"~"^(rail|light_rail|subway|tram)$"]{bbox(S, N, W, E)};node["railway"~"^(station|halt|level_crossing)$"]{bbox(S, N, W, E)};);out geom;')
# buildings in tiles, to stay inside the server's limits
TX, TY = 4, 3
for i in range(TX):
    for j in range(TY):
        s = S + (N - S) * j / TY
        n = S + (N - S) * (j + 1) / TY
        w = W + (E - W) * i / TX
        e = W + (E - W) * (i + 1) / TX
        overpass(f"buildings-{i}-{j}", f'[out:json][timeout:250];(way["building"]{bbox(s, n, w, e)};relation["building"]{bbox(s, n, w, e)};);out geom;')


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

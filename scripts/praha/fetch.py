#!/usr/bin/env python3
"""Step 1 of the Prague bake: download the OpenStreetMap layers and the terrain tiles into scripts/praha/.cache.

OpenStreetMap data: (c) OpenStreetMap contributors, ODbL. Terrain: Mapzen/AWS terrain tiles (terrarium), see https://registry.opendata.aws/terrain-tiles/
Finer terrain: DMR 4G, ČÚZK open data (into .cache*/dmr; bake.py prefers it to the tiles where it has it).
Timetable: PID / ROPID, CC BY 4.0, https://pid.cz/o-systemu/opendata/ (into .cache*/gtfs, for bake_trams.py)
Run once; later steps read the cache, so the network is not needed again.
The steps after it: bake.py (praha.dat), bake_roads.py (praha-roads.dat), bake_trams.py (praha-tram.dat)."""
import io, json, math, os, re, sys, time, urllib.parse, urllib.request, zipfile

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
    "subway": lambda b: f'[out:json][timeout:250];way["railway"="subway"]{b};out geom;',
    "railtunnels": lambda b: f'[out:json][timeout:250];way["railway"~"^(rail|light_rail|subway)$"]["tunnel"="yes"]{b};out geom;',
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
    overpass("subway", Q["subway"](bbox(S, N, W, E)))  # the metro, for the stretches of it out in the open
    overpass("railtunnels", Q["railtunnels"](bbox(S, N, W, E)))  # the tunnels of the railway: the hill stays over them
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

# the terrain, finer: DMR 4G of ČÚZK (a 5 m grid of the bare ground, from the airborne laser scan), in sheets of 2.5 x 2 km,
# the ones that touch the map; about 0.7 MB each. Open data of ČÚZK, https://geoportal.cuzk.gov.cz
DMR = os.path.join(CACHE, "dmr")
os.makedirs(DMR, exist_ok=True)
feed = os.path.join(DMR, "feed.xml")
if not os.path.exists(feed):
    req = urllib.request.Request("https://atom.cuzk.gov.cz/DMR4G-SJTSK-TIFF/DMR4G-SJTSK-TIFF.xml", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r, open(feed, "wb") as f:
        f.write(r.read())
for entry in open(feed, encoding="utf-8").read().split("<entry>")[1:]:
    poly = list(map(float, re.search(r"<georss:polygon>([^<]*)", entry).group(1).split()))
    lats, lons = poly[0::2], poly[1::2]
    if min(lats) >= N or max(lats) <= S or min(lons) >= E or max(lons) <= W:
        continue
    sheet = re.search(r"TIFF_(\w+)\.xml", entry).group(1)
    path = os.path.join(DMR, sheet + ".zip")
    if not os.path.exists(path):
        url = f"https://openzu.cuzk.gov.cz/opendata/DMR4G-TIFF/epsg-5514/{sheet}.zip"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
        print("terrain sheet", sheet, flush=True)

# the storeys and the roofs of the houses: Podlažnosti of IPR Praha (CC BY 4.0, data base © IPR Praha), about 150 MB
ipr = os.path.join(CACHE, "ipr", "podlaznosti.geojson")
if not os.path.exists(ipr):
    os.makedirs(os.path.dirname(ipr), exist_ok=True)
    url = "https://opendata.geoportalpraha.cz/api/download/v1/items/669fb3aca4bf4129b252eac8552f6054/geojson?layers=0"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=900) as r:
        data = r.read()
    with open(ipr, "wb") as f:
        f.write(data)
    print("storeys of IPR Praha", flush=True)

# the timetable of the trams: the whole PID feed, about 50 MB, of which the trams are a small part
gtfs = os.path.join(CACHE, "gtfs")
if not os.path.exists(os.path.join(gtfs, "stop_times.txt")):
    req = urllib.request.Request("https://data.pid.cz/PID_GTFS.zip", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r:
        zipfile.ZipFile(io.BytesIO(r.read())).extractall(gtfs)
    print("timetable", flush=True)
print("done")

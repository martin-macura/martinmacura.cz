#!/usr/bin/env python3
"""Step 2c: the trams of Prague by the timetable: public/vlaky/praha-tram.dat (gzip).

Reads the PID timetable (GTFS) unzipped into .cache-full/gtfs (or .cache/gtfs), from https://data.pid.cz/PID_GTFS.zip.
The feed covers two weeks; the scene must work long after that, so one real day of the feed is baked for each kind of
day (a working day, Saturday, Sunday) and the page picks by the weekday of today in Prague.

layout of the decompressed data, all numbers LEB128 varints (signed ones zigzagged):
  routes count, then per route: its name length, the name (ascii)
  tracks count, then per track: points count, then dx, dz (quarter units) from the last point; the rails, each street once
  stops count, then per stop: dx, dz (quarter units) from the last stop, the heading (0..63 = 0..2 pi)
  shapes count, then per shape: points count, then dx, dz (quarter units), d metres from the last point
  patterns count, then per pattern: route, shape, stops count, then per stop: arrival (s after the start), dwell (s), metres along the shape
  trips count, then per trip, sorted by start: start - previous start (s after midnight, can pass 24 h), pattern, day mask (1 working day, 2 Saturday, 4 Sunday)
Timetable: PID / ROPID, CC BY 4.0."""
import csv, datetime, gzip, math, os, sys
from common import *

sys.setrecursionlimit(100000)

GTFS = os.path.join(CACHE, "gtfs")
OUT = os.path.join(HERE, "..", "..", "public", "vlaky", "praha-tram.dat")
rows = lambda name: csv.DictReader(open(os.path.join(GTFS, name), encoding="utf-8-sig", newline=""))
secs = lambda t: (lambda h, m, s: h * 3600 + m * 60 + s)(*map(int, t.split(":")))

# --- which services run on one working day, one Saturday and one Sunday of the feed
cal = {r["service_id"]: r for r in rows("calendar.txt")}
exc = {}
for r in rows("calendar_dates.txt"):
    exc.setdefault(r["date"], {})[r["service_id"]] = r["exception_type"]
feed = next(rows("feed_info.txt"))
d0 = datetime.datetime.strptime(feed["feed_start_date"], "%Y%m%d").date()
d1 = datetime.datetime.strptime(feed["feed_end_date"], "%Y%m%d").date()
DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

def running(day):
    ds = day.strftime("%Y%m%d")
    on = {s for s, r in cal.items() if r[DAYS[day.weekday()]] == "1" and r["start_date"] <= ds <= r["end_date"]}
    for s, t in exc.get(ds, {}).items():
        (on.add if t == "1" else on.discard)(s)
    return on

def pick(weekdays):
    """the first day of that kind with no exceptions in it (no holiday), else the first one"""
    days = [d0 + datetime.timedelta(i) for i in range((d1 - d0).days + 1)]
    days = [d for d in days if d.weekday() in weekdays]
    return next((d for d in days if d.strftime("%Y%m%d") not in exc), days[0])

chosen = [pick({1, 2, 3}), pick({5}), pick({6})]
print("days:", *chosen)
services = [running(d) for d in chosen]

# --- the tram lines, their trips, their stops and their shapes
routes = {r["route_id"]: r["route_short_name"] for r in rows("routes.txt") if r["route_type"] == "0"}
trips = {}
for r in rows("trips.txt"):
    if r["route_id"] in routes:
        mask = sum(1 << k for k in range(3) if r["service_id"] in services[k])
        if mask:
            trips[r["trip_id"]] = (r["route_id"], r["shape_id"], mask)
print(len(routes), "tram lines,", len(trips), "trips")

times = {}
for r in rows("stop_times.txt"):
    if r["trip_id"] in trips:
        times.setdefault(r["trip_id"], []).append((int(r["stop_sequence"]), secs(r["arrival_time"]), secs(r["departure_time"]), float(r["shape_dist_traveled"] or 0) * 1000, r["stop_id"]))

want = {s for _, s, _ in trips.values()}
shapes = {}
for r in rows("shapes.txt"):
    if r["shape_id"] in want:
        shapes.setdefault(r["shape_id"], []).append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"]), float(r["shape_dist_traveled"] or 0) * 1000))
stop_pos = {r["stop_id"]: project(float(r["stop_lat"]), float(r["stop_lon"])) for r in rows("stops.txt")}

q = lambda v: int(round(v * 4))

def simplify(p, tol=0.12):
    """Douglas-Peucker on (x, z, metres) points, by x and z"""
    if len(p) < 3:
        return p
    (ax, az, _), (bx, bz, _) = p[0], p[-1]
    dx, dz = bx - ax, bz - az
    L = math.hypot(dx, dz)
    best, bi = -1, 0
    for i in range(1, len(p) - 1):
        d = abs((p[i][0] - ax) * dz - (p[i][1] - az) * dx) / L if L > 1e-9 else math.hypot(p[i][0] - ax, p[i][1] - az)
        if d > best:
            best, bi = d, i
    if best <= tol:
        return [p[0], p[-1]]
    return simplify(p[: bi + 1], tol)[:-1] + simplify(p[bi:], tol)

shape_ids = sorted(shapes)
shape_idx = {s: i for i, s in enumerate(shape_ids)}
shape_pts = []
for s in shape_ids:
    pts_ = sorted(shapes[s])
    shape_pts.append(simplify([(*project(lat, lon), m) for _, lat, lon, m in pts_]))

# --- patterns: trips that share the shape and the times between the stops
route_ids = sorted(routes, key=lambda r: (len(routes[r]), routes[r]))
route_idx = {r: i for i, r in enumerate(route_ids)}
patterns, pattern_idx, trip_recs, stop_heading = [], {}, [], {}
def heading_at(pts_, m):
    for i in range(1, len(pts_)):
        if pts_[i][2] >= m:
            return math.atan2(pts_[i][1] - pts_[i - 1][1], pts_[i][0] - pts_[i - 1][0])
    return 0.0

for tid, (rid, sid, mask) in trips.items():
    st = sorted(times.get(tid, []))
    if len(st) < 2 or sid not in shape_idx:
        continue
    t0 = st[0][1]
    key = (route_idx[rid], shape_idx[sid], tuple((a - t0, d - a, int(round(m))) for _, a, d, m, _ in st))
    if key not in pattern_idx:
        pattern_idx[key] = len(patterns)
        patterns.append(key)
        for _, _, _, m, stop in st:
            if stop not in stop_heading and stop in stop_pos:
                stop_heading[stop] = heading_at(shape_pts[shape_idx[sid]], m)
    trip_recs.append((t0, pattern_idx[key], mask))
trip_recs.sort()
print(len(patterns), "patterns,", len(trip_recs), "trips baked")

# --- the rails: the shapes, each stretch of street once (a stretch already laid by another line is skipped)
laid = set()
cellk = lambda x, z: (int(math.floor(x * 2)), int(math.floor(z * 2)))
def covered(x, z):
    i, j = cellk(x, z)
    return any((i + a, j + b) in laid for a in (-1, 0, 1) for b in (-1, 0, 1))
tracks = []
for pts_ in shape_pts:
    cur = []
    for k in range(len(pts_) - 1):
        (x1, z1, _), (x2, z2, _) = pts_[k], pts_[k + 1]
        L = math.hypot(x2 - x1, z2 - z1)
        n = max(1, int(L / 0.5))
        samples = [(x1 + (x2 - x1) * t / n, z1 + (z2 - z1) * t / n) for t in range(n + 1)]
        new = not all(covered(x, z) for x, z in samples[1:-1] or samples)
        if new:
            if not cur:
                cur = [(x1, z1)]
            cur.append((x2, z2))
        elif len(cur) > 1:
            tracks.append(cur)
            cur = []
        else:
            cur = []
    if len(cur) > 1:
        tracks.append(cur)
    for (x1, z1, _), (x2, z2, _) in zip(pts_, pts_[1:]):
        L = math.hypot(x2 - x1, z2 - z1)
        n = max(1, int(L / 0.5))
        for t in range(n + 1):
            laid.add(cellk(x1 + (x2 - x1) * t / n, z1 + (z2 - z1) * t / n))

# --- written out
out = bytearray()
def uv(v):
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return
sv = lambda v: uv(v * 2 if v >= 0 else -v * 2 - 1)

uv(len(route_ids))
for r in route_ids:
    name = routes[r].encode("ascii", "replace")
    uv(len(name)); out.extend(name)
uv(len(tracks))
for t in tracks:
    uv(len(t))
    lx = lz = 0
    for x, z in t:
        sv(q(x) - lx); sv(q(z) - lz)
        lx, lz = q(x), q(z)
stops = sorted(stop_heading, key=lambda s: (stop_pos[s][1], stop_pos[s][0]))
uv(len(stops))
lx = lz = 0
for s in stops:
    x, z = stop_pos[s]
    sv(q(x) - lx); sv(q(z) - lz)
    lx, lz = q(x), q(z)
    uv(int(round(stop_heading[s] % (2 * math.pi) / (2 * math.pi) * 64)) % 64)
uv(len(shape_pts))
for pts_ in shape_pts:
    uv(len(pts_))
    lx = lz = lm = 0
    for x, z, m in pts_:
        sv(q(x) - lx); sv(q(z) - lz); sv(int(round(m)) - lm)
        lx, lz, lm = q(x), q(z), int(round(m))
uv(len(patterns))
for r, s, st in patterns:
    uv(r); uv(s); uv(len(st))
    for a, dwell, m in st:
        uv(a); uv(dwell); uv(m)
uv(len(trip_recs))
lt = 0
for t0, p, mask in trip_recs:
    uv(t0 - lt); uv(p); uv(mask)
    lt = t0

data = gzip.compress(bytes(out), 9)
open(OUT, "wb").write(data)
print(f"{len(tracks)} tracks, {len(stops)} stops, {len(shape_pts)} shapes ({sum(map(len, shape_pts))} points); {len(out) / 1e6:.2f} MB -> {len(data) / 1e3:.0f} kB")

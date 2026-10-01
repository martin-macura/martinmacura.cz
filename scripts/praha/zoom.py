import sys, numpy as np, gzip, struct
from PIL import Image, ImageDraw
from common import *
x0, x1, z0, z1, sc = [float(a) for a in sys.argv[1:6]]
raw = gzip.decompress(open("../../public/vlaky/praha.dat", "rb").read())
GW, GH = struct.unpack("<HH", raw[:4])
cells = np.frombuffer(raw, np.uint8, GW * GH, 4).reshape(GH, GW)
steps = np.frombuffer(raw, np.uint8, (GW // 2) * (GH // 2), 4 + GW * GH).reshape(GH // 2, GW // 2)
W, H = int((x1 - x0) * sc), int((z1 - z0) * sc)
img = Image.new("RGB", (W, H)); px = img.load()
for j in range(H):
    for i in range(W):
        x, z = x0 + i / sc, z0 + j / sc
        gx, gz = int(x + ISLE_X), int(z + ISLE_Z)
        c = cells[gz, gx]; h = int(steps[gz // 2, gx // 2])
        col = (225 - h * 10, 222 - h * 9, 205 - h * 10)
        if (c >> 4) & 3: col = (170 - h * 8, 205 - h * 6, 150 - h * 8)
        if c & 1: col = (110, 160, 215)
        if (c >> 1) & 3: col = (90, 90, 90) if not (c >> 3) & 1 else (220, 130, 40)
        px[i, j] = tuple(max(0, v) for v in col)
d = ImageDraw.Draw(img)
P = lambda p: ((p[0] - x0) * sc, (p[1] - z0) * sc)
for el in load("rail"):
    if el["type"] == "way" and el["tags"].get("railway") == "rail":
        d.line([P(p) for p in pts(el["geometry"])], fill=(220, 20, 20), width=2)
    elif el["type"] == "node" and el["tags"].get("railway") in ("station", "halt"):
        x, z = P(project(el["lat"], el["lon"])); d.ellipse([x-5, z-5, x+5, z+5], outline=(0,0,0), width=2); d.text((x+7, z-5), el["tags"].get("name", "?"), fill=(0,0,0))
step = 50
for gx in range(int(x0 // step * step), int(x1) + 1, step):
    d.line([P((gx, z0)), P((gx, z1))], fill=(255, 255, 255)); d.text((P((gx, z0))[0] + 2, 2), str(gx), fill=(0, 0, 0))
for gz in range(int(z0 // step * step), int(z1) + 1, step):
    d.line([P((x0, gz)), P((x1, gz))], fill=(255, 255, 255)); d.text((2, P((x0, gz))[1] + 2), str(gz), fill=(0, 0, 0))
if len(sys.argv) > 7:
    import json
    for name, pl, closed in json.load(open(sys.argv[7])):
        q = [P(p) for p in pl]
        d.line(q + ([q[0]] if closed else []), fill=(0, 120, 0) if name == "R" else (150, 0, 200), width=3)
        for i, p in enumerate(q): d.text((p[0] + 4, p[1] - 4), f"{name}{i}", fill=(0, 100, 0))
img.save(sys.argv[6])

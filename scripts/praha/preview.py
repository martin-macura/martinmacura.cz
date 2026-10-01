import sys, math
from PIL import Image, ImageDraw
from common import *

SC = 2  # pixels per unit
W, H = ISLE_X * 2 * SC, ISLE_Z * 2 * SC
img = Image.new("RGB", (W, H), (236, 232, 220))
d = ImageDraw.Draw(img)
P = lambda p: ((p[0] + ISLE_X) * SC, (p[1] + ISLE_Z) * SC)

for el in load("water"):
    if el.get("tags", {}).get("natural") != "water" and el.get("tags", {}).get("waterway") != "riverbank":
        continue
    outs, ins = rings(el)
    for r in outs: d.polygon([P(p) for p in r], fill=(120, 170, 220))
    for r in ins: d.polygon([P(p) for p in r], fill=(236, 232, 220))
for el in load("highways"):
    t = el["tags"]["highway"]
    if t in ("service", "residential", "living_street", "pedestrian", "unclassified"): w, c = 1, (190, 190, 190)
    else: w, c = 2, (120, 120, 120)
    d.line([P(p) for p in pts(el["geometry"])], fill=c, width=w)
for el in load("rail"):
    if el["type"] == "way" and el["tags"].get("railway") == "rail":
        d.line([P(p) for p in pts(el["geometry"])], fill=(200, 30, 30), width=3)
    elif el["type"] == "node" and el["tags"].get("railway") in ("station", "halt"):
        x, z = P(project(el["lat"], el["lon"]))
        d.ellipse([x - 6, z - 6, x + 6, z + 6], outline=(0, 0, 0), width=2)
        d.text((x + 8, z - 5), el["tags"].get("name", "?"), fill=(0, 0, 0))
LM = {"castle": (50.0909, 14.4005), "petrin": (50.0834, 14.3954), "OTsq": (50.0875, 14.4213), "museum": (50.0792, 14.4306), "hl.n.": (50.0828, 14.4358), "vysehrad": (50.0643, 14.4198), "zizkov": (50.0805, 14.4503), "letna": (50.0960, 14.4248), "dancing": (50.0755, 14.4140), "charles": (50.0865, 14.4112)}
for n, (la, lo) in LM.items():
    x, z = P(project(la, lo)); d.rectangle([x - 5, z - 5, x + 5, z + 5], fill=(255, 140, 0)); d.text((x + 8, z), n, fill=(160, 60, 0))
if len(sys.argv) > 1:
    sys.path.insert(0, "../../src/scripts/vlaky")
for i in range(0, ISLE_X * 2, 100):
    d.line([(i * SC, 0), (i * SC, H)], fill=(225, 225, 235)); d.text((i * SC + 2, 2), str(i - ISLE_X), fill=(120, 120, 160))
for i in range(0, ISLE_Z * 2, 100):
    d.line([(0, i * SC), (W, i * SC)], fill=(225, 225, 235)); d.text((2, i * SC + 2), str(i - ISLE_Z), fill=(120, 120, 160))
img.save("/private/tmp/claude-501/-Users-macik/3cf9040c-d8a1-43f6-8e39-2ddd66f438e3/scratchpad/preview.png")
print("ok")

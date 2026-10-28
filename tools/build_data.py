"""Az ArtifactData exportjából (out_dir) elkészíti a data.json-t.

Használat: python3 tools/build_data.py <export-mappa>
Az export-mappában a digests/, watchlist/ és calendar/ almappák JSON-fájljai vannak.
"""
import datetime
import glob
import json
import os
import sys

exp = sys.argv[1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(path):
    d = json.load(open(path, encoding="utf-8"))
    return d["data"] if isinstance(d, dict) and "data" in d else d


digests = sorted((load(p) for p in glob.glob(os.path.join(exp, "digests", "*.json"))),
                 key=lambda d: d["date"], reverse=True)[:60]
watchlist = []
for p in glob.glob(os.path.join(exp, "watchlist", "*.json")):
    w = load(p)
    w["id"] = os.path.splitext(os.path.basename(p))[0]
    watchlist.append(w)
watchlist.sort(key=lambda w: w.get("order", 0))
calendar = []
for p in glob.glob(os.path.join(exp, "calendar", "*.json")):
    e = load(p)
    e["id"] = os.path.splitext(os.path.basename(p))[0]
    calendar.append(e)
calendar.sort(key=lambda e: (e.get("date", ""), e.get("time") or "99:99"))

if not digests or not watchlist:
    sys.exit("Hiányzó adat: a digests vagy a watchlist üres, a data.json nem módosult.")

with open(os.path.join(root, "data.json"), "w", encoding="utf-8") as f:
    # builtAt: a feltöltés ideje; ebből látja az oldal és a Worker, ha a frissítési lánc elakadt
    built = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    json.dump({"builtAt": built, "digests": digests, "watchlist": watchlist, "calendar": calendar}, f, ensure_ascii=False, indent=1)
print(f"data.json kész: {len(digests)} kiadás, {len(watchlist)} tétel, {len(calendar)} naptáresemény")

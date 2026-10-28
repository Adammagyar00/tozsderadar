"""Letölti a Yahoo Finance hírfolyamait, és a yahoo_news.json-ba írja (az elmúlt 48 óra hírei).

A GitHub Actions futtatja 30 percenként (.github/workflows/news.yml). A hírek fordítását,
kiválogatását és kategorizálását a napi és napközbeni Claude-frissítés végzi ebből a fájlból.
"""
import datetime
import email.utils
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "Mozilla/5.0 (TozsdeRadar news fetcher)"}
KEEP_HOURS = 48
MAX_ITEMS = 250


def watch_symbols():
    """A figyelőlista tételei Yahoo-jelöléssel (kriptónál -USD, európai ETF-nél a tőzsdei jelölés)."""
    data = json.load(open(os.path.join(ROOT, "data.json"), encoding="utf-8"))
    try:
        ucits = json.load(open(os.path.join(ROOT, "tools", "ucits.json"), encoding="utf-8"))
    except (OSError, ValueError):
        ucits = {}
    out = {}
    for w in data.get("watchlist", []):
        sym = str(w.get("symbol", "")).upper()
        if not sym:
            continue
        if str(w.get("type", "")).lower().startswith("kripto"):
            out[sym + "-USD"] = sym
        elif sym in ucits:
            out[ucits[sym]] = sym
        else:
            out[sym.replace(".", "-")] = sym
    return out


def feeds():
    yield "https://finance.yahoo.com/news/rssindex", None
    # A fő indexek és a figyelőlista hírei; a Yahoo egy kérésben több jelölést is elfogad
    yield "https://feeds.finance.yahoo.com/rss/2.0/headline?" + urllib.parse.urlencode({"s": "^GSPC,^IXIC,^DJI,GC=F,CL=F,EURUSD=X", "region": "US", "lang": "en-US"}), None
    syms = watch_symbols()
    keys = list(syms)
    for i in range(0, len(keys), 8):
        chunk = keys[i:i + 8]
        yield "https://feeds.finance.yahoo.com/rss/2.0/headline?" + urllib.parse.urlencode({"s": ",".join(chunk), "region": "US", "lang": "en-US"}), [syms[k] for k in chunk]


def text(el, tag):
    x = el.find(tag)
    return (x.text or "").strip() if x is not None and x.text else ""


def clean(s, n=400):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n]


def parse(xml_bytes, symbols):
    out = []
    root = ET.fromstring(xml_bytes)
    for it in root.iter("item"):
        title, link = clean(text(it, "title"), 300), text(it, "link")
        if not title or not link:
            continue
        pub = text(it, "pubDate")
        try:
            ts = email.utils.parsedate_to_datetime(pub).astimezone(datetime.timezone.utc)
        except (TypeError, ValueError):
            ts = datetime.datetime.now(datetime.timezone.utc)
        src = it.find("source")
        publisher = (src.text or "").strip() if src is not None and src.text else ""
        out.append({
            "title": title,
            "link": link.split("?")[0] if "finance.yahoo.com" in link else link,
            "published": ts.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "publisher": publisher,
            "summary": clean(text(it, "description")),
            "symbols": symbols or [],
        })
    return out


def main():
    path = os.path.join(ROOT, "yahoo_news.json")
    try:
        old = json.load(open(path, encoding="utf-8")).get("items", [])
    except (OSError, ValueError):
        old = []
    items = {x["link"]: x for x in old}
    ok = 0
    for url, symbols in feeds():
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                got = parse(r.read(), symbols)
            ok += 1
        except Exception as e:  # egy hibás hírfolyam ne állítsa le a többit
            print(f"{url}: {e}", file=sys.stderr)
            continue
        for x in got:
            prev = items.get(x["link"])
            if prev:
                prev["symbols"] = sorted(set(prev.get("symbols", [])) | set(x["symbols"]))
            else:
                items[x["link"]] = x
    if not ok:
        sys.exit("Egyetlen Yahoo Finance hírfolyamot sem sikerült letölteni.")
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=KEEP_HOURS)).isoformat().replace("+00:00", "Z")
    keep = sorted((x for x in items.values() if x["published"] >= cutoff), key=lambda x: x["published"], reverse=True)[:MAX_ITEMS]
    if keep == old:
        print("Nincs új hír.")
        return
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"source": "Yahoo Finance RSS", "updatedAt": now, "items": keep}, f, ensure_ascii=False, indent=1)
    print(f"yahoo_news.json kész: {len(keep)} hír")


if __name__ == "__main__":
    main()

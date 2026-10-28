"""Letölti a Yahoo Finance és az Investing.com hírfolyamait (az elmúlt 48 óra hírei):
yahoo_news.json és investing_news.json. Az Investing.com-hírekből kimarad, ami a Yahoo-hírfolyamban
már szerepel (ugyanaz a cikk vagy szinte azonos cím), hogy ugyanaz a hír ne kerüljön be kétszer.

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


def parse_time(pub):
    """RFC 822 (Yahoo) vagy "ÉÉÉÉ-HH-NN ÓÓ:PP:MM" (Investing.com, UTC) formátum."""
    try:
        return email.utils.parsedate_to_datetime(pub).astimezone(datetime.timezone.utc)
    except (TypeError, ValueError):
        pass
    try:
        return datetime.datetime.strptime(pub.strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return datetime.datetime.now(datetime.timezone.utc)


def parse(xml_bytes, symbols):
    out = []
    root = ET.fromstring(xml_bytes)
    for it in root.iter("item"):
        title, link = clean(text(it, "title"), 300), text(it, "link")
        if not title or not link:
            continue
        pub = text(it, "pubDate")
        ts = parse_time(pub)
        src = it.find("source")
        publisher = (src.text or "").strip() if src is not None and src.text else text(it, "author")
        out.append({
            "title": title,
            "link": link.split("?")[0] if "finance.yahoo.com" in link else link,
            "published": ts.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "publisher": publisher,
            "summary": clean(text(it, "description")),
            "symbols": symbols or [],
        })
    return out


INVESTING_FEEDS = [
    "https://www.investing.com/rss/news.rss",       # minden hír
    "https://www.investing.com/rss/news_25.rss",    # tőzsde
    "https://www.investing.com/rss/news_14.rss",    # gazdaság
    "https://www.investing.com/rss/news_95.rss",    # makroadatok
    "https://www.investing.com/rss/news_1.rss",     # deviza
    "https://www.investing.com/rss/news_11.rss",    # nyersanyagok
    "https://www.investing.com/rss/news_301.rss",   # kripto
]
BROWSER_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"}


def collect(path, feed_list, headers, source):
    """A hírfolyamok összefésülése a meglévő fájllal (link szerint egyedi), 48 órára visszamenőleg."""
    try:
        old = json.load(open(path, encoding="utf-8")).get("items", [])
    except (OSError, ValueError):
        old = []
    items = {x["link"]: x for x in old}
    ok = 0
    for url, symbols in feed_list:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
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
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=KEEP_HOURS)).isoformat().replace("+00:00", "Z")
    keep = sorted((x for x in items.values() if x["published"] >= cutoff), key=lambda x: x["published"], reverse=True)[:MAX_ITEMS]
    return ok, old, keep


def words(title):
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if len(w) > 2}


def same_story(a, b):
    """Szinte azonos cím (a szavak legalább 60%-a közös): ugyanaz a hír, más kiadónál."""
    wa, wb = words(a), words(b)
    return bool(wa and wb) and len(wa & wb) / min(len(wa), len(wb)) >= 0.6


def write(path, source, old, keep):
    if keep == old:
        print(f"{os.path.basename(path)}: nincs új hír.")
        return
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"source": source, "updatedAt": now, "items": keep}, f, ensure_ascii=False, indent=1)
    print(f"{os.path.basename(path)} kész: {len(keep)} hír")


def main():
    ypath = os.path.join(ROOT, "yahoo_news.json")
    ok, old, ykeep = collect(ypath, feeds(), UA, "Yahoo Finance RSS")
    if not ok:
        sys.exit("Egyetlen Yahoo Finance hírfolyamot sem sikerült letölteni.")
    write(ypath, "Yahoo Finance RSS", old, ykeep)
    # Investing.com: ami a Yahoo-hírek között már megvan (ugyanaz a link vagy szinte azonos cím), az kimarad
    ipath = os.path.join(ROOT, "investing_news.json")
    iok, iold, ikeep = collect(ipath, ((u, None) for u in INVESTING_FEEDS), BROWSER_UA, "Investing.com RSS")
    if not iok:
        print("Az Investing.com hírfolyamai most nem érhetők el.", file=sys.stderr)
        return
    ylinks = {x["link"] for x in ykeep}
    ytitles = [x["title"] for x in ykeep]
    ikeep = [x for x in ikeep if x["link"] not in ylinks and not any(same_story(x["title"], t) for t in ytitles)]
    write(ipath, "Investing.com RSS", iold, ikeep)


if __name__ == "__main__":
    main()

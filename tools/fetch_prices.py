"""Lekéri a részvény- és ETF-árakat a Finnhubtól, és a prices.json-ba írja.

A GitHub Actions futtatja 15 percenként (.github/workflows/prices.yml).
Az API-kulcsot a FINNHUB_API_KEY környezeti változóból olvassa (repó-titok);
ha nincs megadva, nem csinál semmit.

A szimbólumokat a data.json-ból veszi: a figyelőlista részvényei és ETF-jei,
valamint a futószalag "Részvény" csoportja. A kriptókat a böngésző kéri le a
CoinGeckótól. Az európai tőzsdék UCITS ETF-jeit az ingyenes Finnhub nem adja,
ezeket a tools/ucits.json listája alapján a Yahoo Finance nyilvános árfolyam-
adataiból vesszük, dollárba váltva.
"""
import datetime
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get("FINNHUB_API_KEY", "").strip()
# Budapesti tőzsde: az ingyenes Finnhub nem adja
SKIP = {"OTP", "MOL", "RICHTER"}


def symbols():
    data = json.load(open(os.path.join(ROOT, "data.json"), encoding="utf-8"))
    out = []
    for w in data.get("watchlist", []):
        t = (w.get("type") or "").lower()
        if t.startswith("kripto") or "lse" in t or "xetra" in t:
            continue
        out.append(w["symbol"])
    digests = sorted(data.get("digests", []), key=lambda d: d.get("date", ""), reverse=True)
    if digests:
        out += [m["name"] for m in digests[0].get("markets", []) if m.get("group") == "Részvény"]
    seen, result = set(), []
    for s in out:
        s = s.upper()
        if s not in seen and s not in SKIP:
            seen.add(s)
            result.append(s)
    return result


def quote(sym):
    url = "https://finnhub.io/api/v1/quote?" + urllib.parse.urlencode({"symbol": sym, "token": KEY})
    with urllib.request.urlopen(url, timeout=15) as r:
        q = json.load(r)
    # Ismeretlen szimbólumra a Finnhub csupa nullát ad vissza
    if not q or not q.get("c"):
        return None
    return {"price": q["c"], "change": q.get("dp"), "prevClose": q.get("pc"), "t": q.get("t")}


def yahoo(ticker):
    url = "https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(ticker) + "?range=1d&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (TozsdeRadar price fetcher)"})
    with urllib.request.urlopen(req, timeout=15) as r:
        meta = json.load(r)["chart"]["result"][0]["meta"]
    return meta.get("regularMarketPrice"), meta.get("chartPreviousClose"), meta.get("currency"), meta.get("regularMarketTime")


def ucits_quotes():
    try:
        mapping = json.load(open(os.path.join(ROOT, "tools", "ucits.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    # Árfolyam dollárban: a londoni papírok gyakran pennyben (GBp) jegyzettek
    fx = {"USD": 1.0}
    for cur, pair in (("GBP", "GBPUSD=X"), ("EUR", "EURUSD=X")):
        try:
            fx[cur] = yahoo(pair)[0]
        except Exception as e:
            print(f"{pair}: {e}", file=sys.stderr)
    out = {}
    for sym, ticker in mapping.items():
        if sym.startswith("_"):
            continue
        try:
            price, prev, cur, t = yahoo(ticker)
        except Exception as e:
            print(f"{ticker}: {e}", file=sys.stderr)
            continue
        scale = 0.01 if cur in ("GBp", "GBX") else 1.0
        rate = fx.get("GBP" if cur in ("GBp", "GBX") else cur)
        if not price or not rate:
            continue
        usd = round(price * scale * rate, 4)
        q = {"price": usd, "change": round((price / prev - 1) * 100, 2) if prev else None,
             "prevClose": round(prev * scale * rate, 4) if prev else None, "t": t,
             "listing": ticker, "currency": cur, "local": price, "source": "Yahoo Finance (" + ticker + ")"}
        out[sym.upper()] = q
        time.sleep(0.5)
    return out


def main():
    path = os.path.join(ROOT, "prices.json")
    try:
        old = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        old = {}
    quotes = ucits_quotes()
    for s in (symbols() if KEY else []):
        if s in quotes:
            continue
        try:
            q = quote(s)
        except Exception as e:  # egy hibás szimbólum ne állítsa le a többit
            print(f"{s}: {e}", file=sys.stderr)
            q = None
        if q:
            quotes[s] = q
        time.sleep(1.1)  # ingyenes keret: 60 kérés/perc
    if not KEY:
        print("Nincs FINNHUB_API_KEY, csak az UCITS ETF-ek ára frissül.")
    if not quotes:
        sys.exit("Egyetlen árat sem sikerült lekérni.")
    if quotes == old.get("quotes"):
        print("Nincs változás.")
        return
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"source": "Finnhub", "updatedAt": now, "quotes": quotes}, f, ensure_ascii=False, indent=1)
    print(f"prices.json kész: {len(quotes)} ár")


if __name__ == "__main__":
    main()

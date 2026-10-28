// TőzsdeRadar élő árfolyam-közvetítő (Cloudflare Worker).
//
// A Finnhub ingyenes élő adatfolyamához API-kulcs kell, ami a nyilvános oldalon
// látszana. Ez a Worker titokban tartja a kulcsot: egyetlen Durable Object
// tart egy közös kapcsolatot a Finnhubbal, és szétosztja a kötéseket az összes
// megnyitott oldalnak. Ha senki nem nézi az oldalt, a kapcsolatot bezárja.

// Csak innen engedünk csatlakozni, hogy más ne használja a kulcsunkat
const ALLOWED_ORIGINS = [
  "https://adammagyar00.github.io",
  "https://www.tozsderadar.hu",
  "https://tozsderadar.hu",
];
const SYMBOL_RE = /^[A-Z][A-Z.]{0,6}$/;
const MAX_SYMBOLS = 50; // a Finnhub ingyenes kerete

// A Portfolio oldal árlekérései: szimbólumonként 60 mp-ig tároljuk az árat,
// hogy sok néző se lépje túl a Finnhub ingyenes keretét (60 kérés/perc)
const QUOTE_TTL = 60000;
const MAX_QUOTES = 20;
const quoteCache = new Map();

async function quote(symbol, env) {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < (hit.q ? QUOTE_TTL : 10 * QUOTE_TTL)) return hit.q;
  const res = await fetch("https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(symbol) + "&token=" + encodeURIComponent(env.FINNHUB_API_KEY));
  if (!res.ok) return hit ? hit.q : null;
  const j = await res.json();
  // Ismeretlen szimbólumra a Finnhub csupa nullát ad vissza
  const q = j && j.c ? { price: j.c, change: j.dp, prevClose: j.pc, t: j.t } : null;
  quoteCache.set(symbol, { q, at: Date.now() });
  return q;
}

async function quotes(url, env, origin) {
  const syms = [...new Set((url.searchParams.get("symbols") || "").toUpperCase().split(","))].filter((s) => SYMBOL_RE.test(s)).slice(0, MAX_QUOTES);
  const out = {};
  await Promise.all(syms.map(async (s) => {
    try { const q = await quote(s, env); if (q) out[s] = q; } catch { /* a többi szimbólum attól még menjen */ }
  }));
  return new Response(JSON.stringify({ source: "Finnhub", quotes: out }), {
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin, vary: "Origin" },
  });
}

// A futószalag tőzsdén kívüli tételei (deviza, nyersanyag, index, hozam, budapesti részvény)
// a Yahoo Finance nyilvános árfolyam-adataiból; a böngésző ezt közvetlenül nem kérheti le
const Y_RE = /^[A-Z0-9^=.\-]{1,20}$/;
const MAX_MARKET = 40;
const marketCache = new Map();

async function yahoo(ticker) {
  const hit = marketCache.get(ticker);
  if (hit && Date.now() - hit.at < (hit.q ? QUOTE_TTL : 10 * QUOTE_TTL)) return hit.q;
  const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker) + "?range=1d&interval=1d", {
    headers: { "User-Agent": "Mozilla/5.0 (TozsdeRadar)" },
  });
  if (!res.ok) return hit ? hit.q : null;
  const j = await res.json();
  const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  const q = m && typeof m.regularMarketPrice === "number"
    ? { price: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? null, t: m.regularMarketTime ?? null, currency: m.currency ?? null }
    : null;
  marketCache.set(ticker, { q, at: Date.now() });
  return q;
}

async function market(url, origin) {
  const tickers = [...new Set((url.searchParams.get("y") || "").toUpperCase().split(","))].filter((s) => Y_RE.test(s)).slice(0, MAX_MARKET);
  const out = {};
  await Promise.all(tickers.map(async (t) => {
    try { const q = await yahoo(t); if (q) out[t] = q; } catch { /* a többi jelölés attól még menjen */ }
  }));
  return new Response(JSON.stringify({ source: "Yahoo Finance", quotes: out }), {
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin, vary: "Origin" },
  });
}

// Árfolyam-előzmények a grafikonokhoz (figyelőlista-görbék, portfolio-grafikon)
const RANGES = { "1d": "5m", "5d": "60m", "1mo": "1d", "3mo": "1d", "1y": "1d" };
const historyCache = new Map();

async function yahooHistory(ticker, range) {
  const key = ticker + "|" + range;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60000) return hit.h;
  const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker) + "?range=" + range + "&interval=" + RANGES[range], {
    headers: { "User-Agent": "Mozilla/5.0 (TozsdeRadar)" },
  });
  if (!res.ok) return hit ? hit.h : null;
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = (r && r.timestamp) || [];
  const cl = (r && r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const t = [], c = [];
  ts.forEach((x, i) => { if (typeof cl[i] === "number") { t.push(x); c.push(+cl[i].toFixed(6)); } });
  const h = t.length ? { t, c, currency: r.meta && r.meta.currency } : null;
  historyCache.set(key, { h, at: Date.now() });
  return h;
}

async function history(url, origin) {
  const range = RANGES[url.searchParams.get("range")] ? url.searchParams.get("range") : "5d";
  const tickers = [...new Set((url.searchParams.get("y") || "").toUpperCase().split(","))].filter((s) => Y_RE.test(s)).slice(0, MAX_MARKET);
  const out = {};
  await Promise.all(tickers.map(async (t) => {
    try { const h = await yahooHistory(t, range); if (h) out[t] = h; } catch { /* a többi jelölés attól még menjen */ }
  }));
  return new Response(JSON.stringify({ source: "Yahoo Finance", range, series: out }), {
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin, vary: "Origin", "cache-control": "max-age=300" },
  });
}

// Kereső a Piacok oldalhoz: részvény, ETF, kriptó, deviza, index, határidős (nyersanyag) a Yahoo Finance-ből
const searchCache = new Map();
async function search(url, origin) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 40);
  let out = [];
  if (q) {
    const hit = searchCache.get(q.toLowerCase());
    if (hit && Date.now() - hit.at < 10 * 60000) out = hit.out;
    else {
      const res = await fetch("https://query2.finance.yahoo.com/v1/finance/search?quotesCount=20&newsCount=0&listsCount=0&q=" + encodeURIComponent(q), {
        headers: { "User-Agent": "Mozilla/5.0 (TozsdeRadar)" },
      });
      if (res.ok) {
        const j = await res.json();
        out = (j.quotes || []).filter((x) => x.symbol && x.quoteType).map((x) => ({
          symbol: x.symbol, name: x.shortname || x.longname || x.symbol, type: x.quoteType, exch: x.exchDisp || x.exchange || "",
        }));
        searchCache.set(q.toLowerCase(), { out, at: Date.now() });
      }
    }
  }
  return new Response(JSON.stringify({ source: "Yahoo Finance", results: out }), {
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin, vary: "Origin" },
  });
}

const allowed = (origin) => ALLOWED_ORIGINS.includes(origin) || origin.startsWith("http://localhost");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/quote") {
      const origin = request.headers.get("Origin") || "";
      if (!allowed(origin)) return new Response("Nem engedélyezett oldal", { status: 403 });
      return quotes(url, env, origin);
    }
    if (url.pathname === "/search") {
      const origin = request.headers.get("Origin") || "";
      if (!allowed(origin)) return new Response("Nem engedélyezett oldal", { status: 403 });
      return search(url, origin);
    }
    if (url.pathname === "/history") {
      const origin = request.headers.get("Origin") || "";
      if (!allowed(origin)) return new Response("Nem engedélyezett oldal", { status: 403 });
      return history(url, origin);
    }
    if (url.pathname === "/market") {
      const origin = request.headers.get("Origin") || "";
      if (!allowed(origin)) return new Response("Nem engedélyezett oldal", { status: 403 });
      return market(url, origin);
    }
    if (url.pathname !== "/ws" && url.pathname !== "/yws") {
      return new Response("TőzsdeRadar élő árfolyam-közvetítő", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket-kapcsolat kell", { status: 426 });
    }
    const origin = request.headers.get("Origin") || "";
    if (!allowed(origin)) {
      return new Response("Nem engedélyezett oldal", { status: 403 });
    }
    // /ws: Finnhub (amerikai részvények), /yws: Yahoo Finance (európai ETF-ek, devizák, indexek, budapesti részvények)
    const hub = env.HUB.get(env.HUB.idFromName(url.pathname === "/yws" ? "yahoo" : "hub"));
    return hub.fetch(request);
  },
};

// A két élő forrás eltérései: cím, feliratkozás és mely üzeneteket továbbítunk
const SOURCES = {
  finnhub: {
    re: SYMBOL_RE,
    max: MAX_SYMBOLS,
    connect: (env) => fetch("https://ws.finnhub.io?token=" + encodeURIComponent(env.FINNHUB_API_KEY), { headers: { Upgrade: "websocket" } }),
    subscribe: (hub, symbol) => hub.sendUpstream({ type: "subscribe", symbol }),
    resubscribe: (hub) => { for (const symbol of hub.symbols) hub.sendUpstream({ type: "subscribe", symbol }); },
    // Csak a kötéseket továbbítjuk, a Finnhub ping üzeneteit nem
    forward: (data) => data.includes('"trade"'),
  },
  yahoo: {
    re: Y_RE,
    max: 120,
    connect: () => fetch("https://streamer.finance.yahoo.com/?version=2", {
      headers: { Upgrade: "websocket", Origin: "https://finance.yahoo.com", "User-Agent": "Mozilla/5.0 (TozsdeRadar)" },
    }),
    subscribe: (hub) => hub.sendUpstream({ subscribe: [...hub.symbols] }),
    resubscribe: (hub) => { if (hub.symbols.size) hub.sendUpstream({ subscribe: [...hub.symbols] }); },
    // Az árüzenetek base64-be csomagolt protobufok; a böngésző bontja ki őket
    forward: (data) => data.includes("pricing") || !data.startsWith("{"),
  },
};

export class Hub {
  constructor(state, env) {
    this.env = env;
    this.mode = null;
    this.clients = new Set();
    this.symbols = new Set();
    this.upstream = null;
    this.connecting = null;
  }

  async fetch(request) {
    if (!this.mode) this.mode = new URL(request.url).pathname === "/yws" ? "yahoo" : "finnhub";
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.clients.add(server);

    server.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg && msg.type === "subscribe" && typeof msg.symbol === "string") this.subscribe(msg.symbol.toUpperCase());
    });
    const drop = () => {
      this.clients.delete(server);
      if (this.clients.size === 0) this.closeUpstream();
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    this.ensureUpstream();
    return new Response(null, { status: 101, webSocket: client });
  }

  subscribe(symbol) {
    const src = SOURCES[this.mode];
    if (!src.re.test(symbol) || this.symbols.has(symbol) || this.symbols.size >= src.max) return;
    this.symbols.add(symbol);
    src.subscribe(this, symbol);
  }

  sendUpstream(msg) {
    if (!this.upstream) return;
    try { this.upstream.send(JSON.stringify(msg)); } catch { /* újracsatlakozáskor újra feliratkozunk */ }
  }

  async ensureUpstream() {
    if (this.upstream || this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const src = SOURCES[this.mode];
        const res = await src.connect(this.env);
        const ws = res.webSocket;
        if (!ws) throw new Error(this.mode + ": nem nyílt WebSocket-kapcsolat (" + res.status + ")");
        ws.accept();
        this.upstream = ws;
        src.resubscribe(this);
        ws.addEventListener("message", (event) => {
          if (typeof event.data !== "string" || !src.forward(event.data)) return;
          for (const c of this.clients) {
            try { c.send(event.data); } catch { this.clients.delete(c); }
          }
        });
        const reconnect = () => {
          this.upstream = null;
          if (this.clients.size) setTimeout(() => this.ensureUpstream(), 5000);
        };
        ws.addEventListener("close", reconnect);
        ws.addEventListener("error", reconnect);
      } catch (err) {
        console.log(String(err));
        if (this.clients.size) setTimeout(() => this.ensureUpstream(), 15000);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  closeUpstream() {
    try { if (this.upstream) this.upstream.close(1000, "nincs néző"); } catch { /* már zárva */ }
    this.upstream = null;
    this.symbols.clear();
  }
}

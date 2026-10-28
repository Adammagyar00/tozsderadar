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

const allowed = (origin) => ALLOWED_ORIGINS.includes(origin) || origin.startsWith("http://localhost");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/quote") {
      const origin = request.headers.get("Origin") || "";
      if (!allowed(origin)) return new Response("Nem engedélyezett oldal", { status: 403 });
      return quotes(url, env, origin);
    }
    if (url.pathname === "/market") {
      const origin = request.headers.get("Origin") || "";
      if (!allowed(origin)) return new Response("Nem engedélyezett oldal", { status: 403 });
      return market(url, origin);
    }
    if (url.pathname !== "/ws") {
      return new Response("TőzsdeRadar élő árfolyam-közvetítő", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket-kapcsolat kell", { status: 426 });
    }
    const origin = request.headers.get("Origin") || "";
    if (!allowed(origin)) {
      return new Response("Nem engedélyezett oldal", { status: 403 });
    }
    const hub = env.HUB.get(env.HUB.idFromName("hub"));
    return hub.fetch(request);
  },
};

export class Hub {
  constructor(state, env) {
    this.env = env;
    this.clients = new Set();
    this.symbols = new Set();
    this.upstream = null;
    this.connecting = null;
  }

  async fetch() {
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
    if (!SYMBOL_RE.test(symbol) || this.symbols.has(symbol) || this.symbols.size >= MAX_SYMBOLS) return;
    this.symbols.add(symbol);
    this.sendUpstream({ type: "subscribe", symbol });
  }

  sendUpstream(msg) {
    if (!this.upstream) return;
    try { this.upstream.send(JSON.stringify(msg)); } catch { /* újracsatlakozáskor újra feliratkozunk */ }
  }

  async ensureUpstream() {
    if (this.upstream || this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const res = await fetch("https://ws.finnhub.io?token=" + encodeURIComponent(this.env.FINNHUB_API_KEY), {
          headers: { Upgrade: "websocket" },
        });
        const ws = res.webSocket;
        if (!ws) throw new Error("A Finnhub nem nyitott WebSocket-kapcsolatot (" + res.status + ")");
        ws.accept();
        this.upstream = ws;
        for (const symbol of this.symbols) this.sendUpstream({ type: "subscribe", symbol });
        ws.addEventListener("message", (event) => {
          // Csak a kötéseket továbbítjuk, a Finnhub ping üzeneteit nem
          if (typeof event.data !== "string" || !event.data.includes('"trade"')) return;
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

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
const RANGES = { "1d": "5m", "5d": "60m", "1mo": "1d", "3mo": "1d", "6mo": "1d", "1y": "1d", "2y": "1d", "5y": "1wk", "10y": "1wk" };
// Gyertyás grafikonhoz külön idősík is kérhető
const INTERVALS = new Set(["5m", "15m", "60m", "1d", "1wk"]);
const historyCache = new Map();

async function yahooHistory(ticker, range, iv, ohlc) {
  iv = INTERVALS.has(iv) ? iv : RANGES[range];
  const key = ticker + "|" + range + "|" + iv + "|" + (ohlc ? 1 : 0);
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60000) return hit.h;
  const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker) + "?range=" + range + "&interval=" + iv, {
    headers: { "User-Agent": "Mozilla/5.0 (TozsdeRadar)" },
  });
  if (!res.ok) return hit ? hit.h : null;
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = (r && r.timestamp) || [];
  const qq = (r && r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const cl = qq.close || [];
  const t = [], c = [], o = [], hi = [], lo = [], v = [];
  ts.forEach((x, i) => {
    if (typeof cl[i] !== "number") return;
    t.push(x); c.push(+cl[i].toFixed(6));
    if (ohlc) {
      o.push(+(qq.open && typeof qq.open[i] === "number" ? qq.open[i] : cl[i]).toFixed(6));
      hi.push(+(qq.high && typeof qq.high[i] === "number" ? qq.high[i] : cl[i]).toFixed(6));
      lo.push(+(qq.low && typeof qq.low[i] === "number" ? qq.low[i] : cl[i]).toFixed(6));
      v.push(qq.volume && typeof qq.volume[i] === "number" ? qq.volume[i] : 0);
    }
  });
  const h = t.length ? (ohlc ? { t, o, h: hi, l: lo, c, v, currency: r.meta && r.meta.currency } : { t, c, currency: r.meta && r.meta.currency }) : null;
  historyCache.set(key, { h, at: Date.now() });
  return h;
}

async function history(url, origin) {
  const range = RANGES[url.searchParams.get("range")] ? url.searchParams.get("range") : "5d";
  const iv = url.searchParams.get("iv") || "";
  const ohlc = url.searchParams.get("ohlc") === "1";
  const tickers = [...new Set((url.searchParams.get("y") || "").toUpperCase().split(","))].filter((s) => Y_RE.test(s)).slice(0, MAX_MARKET);
  const out = {};
  await Promise.all(tickers.map(async (t) => {
    try { const h = await yahooHistory(t, range, iv, ohlc); if (h) out[t] = h; } catch { /* a többi jelölés attól még menjen */ }
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


// Hírek egy eszközről (Piacok oldal): a Yahoo Finance keresőjének hírtalálatai, angolul
const newsCache = new Map();
async function news(url, origin) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 40);
  let out = [];
  if (q) {
    const hit = newsCache.get(q.toLowerCase());
    if (hit && Date.now() - hit.at < 15 * 60000) out = hit.out;
    else {
      const res = await fetch("https://query2.finance.yahoo.com/v1/finance/search?quotesCount=0&newsCount=10&listsCount=0&q=" + encodeURIComponent(q), {
        headers: { "User-Agent": "Mozilla/5.0 (TozsdeRadar)" },
      });
      if (res.ok) {
        const j = await res.json();
        out = (j.news || []).filter((x) => x.title && x.link).map((x) => ({
          title: x.title, publisher: x.publisher || "", link: x.link, time: x.providerPublishTime || null, tickers: x.relatedTickers || [],
        }));
        newsCache.set(q.toLowerCase(), { out, at: Date.now() });
      }
    }
  }
  return json({ source: "Yahoo Finance", news: out }, origin);
}

// A CNN „Fear & Greed” részvénypiaci hangulatindexe (a böngésző közvetlenül nem kérheti le)
let fngCache = null;
async function fng(origin) {
  if (!fngCache || Date.now() - fngCache.at > 30 * 60000) {
    let v = null;
    try {
      const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "application/json", Referer: "https://edition.cnn.com/" },
      });
      if (res.ok) {
        const j = await res.json();
        const f = j && j.fear_and_greed;
        if (f && typeof f.score === "number") v = { score: f.score, rating: f.rating, t: f.timestamp, prev: f.previous_close, week: f.previous_1_week, month: f.previous_1_month };
      }
    } catch { /* nincs adat */ }
    fngCache = { v, at: Date.now() - (v ? 0 : 25 * 60000) };
  }
  return json({ source: "CNN", fng: fngCache.v }, origin);
}

const json = (obj, origin, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin || "*", vary: "Origin" },
});

const allowed = (origin) => ALLOWED_ORIGINS.includes(origin) || origin.startsWith("http://localhost");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/tg" && request.method === "POST") {
      // Telegram webhook: a titkos fejléc a bot tokenjéből származik, így más nem küldhet ide
      if (!env.TELEGRAM_BOT_TOKEN || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== await tgSecret(env.TELEGRAM_BOT_TOKEN)) return new Response("tiltott", { status: 403 });
      return store(env).fetch("https://store/tg", { method: "POST", body: await request.text() });
    }
    if (["/news", "/fng", "/sync", "/tginfo", "/tgtest"].includes(url.pathname)) {
      const origin = request.headers.get("Origin") || "";
      if (!allowed(origin)) return new Response("Nem engedélyezett oldal", { status: 403 });
      if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
      if (url.pathname === "/news") return news(url, origin);
      if (url.pathname === "/fng") return fng(origin);
      const res = await store(env).fetch("https://store" + url.pathname + url.search, { method: request.method, body: request.method === "POST" ? await request.text() : undefined });
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin, vary: "Origin" } });
    }
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
  // Percenként: a szerveroldali riasztások (Telegram) és az esti összefoglaló
  async scheduled(event, env, ctx) {
    ctx.waitUntil(store(env).fetch("https://store/cron", { method: "POST" }));
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

// ---------- Szinkron, Telegram-riasztás és esti összefoglaló ----------
// A böngészők egy véletlen szinkronkóddal (id) tárolják itt a beállításaikat (portfolio, kedvencek,
// riasztások, rajzok). A kód maga a kulcs: aki ismeri, az látja és írja ezeket az adatokat.
const SYNC_ID_RE = /^[a-z0-9]{20,40}$/;
const SYNC_KEY_RE = /^[a-zA-Z0-9:._^=\-]{1,60}$/;
const MAX_KEYS = 400;
const MAX_VALUE = 200000;
const SITE = "https://adammagyar00.github.io/tozsderadar/";

const store = (env) => env.STORE.get(env.STORE.idFromName("main"));

async function tgSecret(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tozsderadar:" + token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function tgSend(env, chat, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const res = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return res.ok;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const huNum = (v, dec) => v.toLocaleString("hu-HU", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fpx = (v) => huNum(v, Math.abs(v) >= 1 ? 2 : 4);
const pct = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + huNum(Math.abs(v), 2) + "%";
const budapest = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: p.year + "-" + p.month + "-" + p.day, hour: Number(p.hour), minute: Number(p.minute) };
};

// Friss Yahoo-árak (a cron nem használ gyorsítótárat)
async function freshQuotes(tickers) {
  const out = {};
  await Promise.all([...new Set(tickers)].slice(0, 40).map(async (t) => {
    try {
      const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(t) + "?range=1d&interval=1d", { headers: { "User-Agent": "Mozilla/5.0 (TozsdeRadar)" } });
      if (!res.ok) return;
      const j = await res.json();
      const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (m && typeof m.regularMarketPrice === "number") out[t] = { price: m.regularMarketPrice, prev: m.chartPreviousClose ?? null, t: m.regularMarketTime ?? null, cur: m.currency || "USD" };
    } catch { /* kimarad */ }
  }));
  return out;
}

export class Store {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.botName = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    try {
      if (url.pathname === "/cron") { await this.cron(); return reply({ ok: true }); }
      if (url.pathname === "/tg") { await this.telegram(JSON.parse(await request.text() || "{}")); return reply({ ok: true }); }
      const id = request.method === "POST" ? null : url.searchParams.get("id");
      if (url.pathname === "/sync" && request.method === "GET") {
        if (!SYNC_ID_RE.test(id || "")) return reply({ error: "hibás kód" }, 400);
        return reply({ keys: await this.keys(id) });
      }
      if (url.pathname === "/sync" && request.method === "POST") {
        const body = JSON.parse(await request.text() || "{}");
        if (!SYNC_ID_RE.test(body.id || "")) return reply({ error: "hibás kód" }, 400);
        return reply({ keys: await this.merge(body.id, body.keys || {}) });
      }
      if (url.pathname === "/tginfo") {
        if (!SYNC_ID_RE.test(id || "")) return reply({ error: "hibás kód" }, 400);
        return reply({ enabled: !!this.env.TELEGRAM_BOT_TOKEN, bot: await this.bot(), linked: !!(await this.state.storage.get("chat:" + id)) });
      }
      if (url.pathname === "/tgtest" && request.method === "POST") {
        const body = JSON.parse(await request.text() || "{}");
        if (!SYNC_ID_RE.test(body.id || "")) return reply({ error: "hibás kód" }, 400);
        const chat = await this.state.storage.get("chat:" + body.id);
        if (!chat) return reply({ ok: false, error: "nincs összekapcsolva" });
        const last = (await this.state.storage.get("tgtest:" + body.id)) || 0;
        if (Date.now() - last < 30000) return reply({ ok: false, error: "várj fél percet" });
        await this.state.storage.put("tgtest:" + body.id, Date.now());
        if (body.what === "summary") return reply({ ok: await this.summary(body.id, chat, true) });
        return reply({ ok: await tgSend(this.env, chat, "✅ <b>TőzsdeRadar</b>: a Telegram-értesítések működnek.") });
      }
      return reply({ error: "ismeretlen" }, 404);
    } catch (e) {
      return reply({ error: String(e && e.message || e) }, 500);
    }
  }

  async bot() {
    if (this.botName || !this.env.TELEGRAM_BOT_TOKEN) return this.botName;
    try {
      const r = await fetch("https://api.telegram.org/bot" + this.env.TELEGRAM_BOT_TOKEN + "/getMe");
      const j = await r.json();
      this.botName = j && j.result && j.result.username || null;
    } catch { /* később újra */ }
    return this.botName;
  }

  async keys(id) {
    const m = await this.state.storage.list({ prefix: "k:" + id + ":" });
    const out = {};
    for (const [k, v] of m) out[k.slice(id.length + 3)] = v;
    return out;
  }

  // Kulcsonként az újabb nyer (t: a módosítás ideje a böngészőben, ms)
  async merge(id, incoming) {
    const cur = await this.keys(id);
    const puts = {};
    let n = Object.keys(cur).length;
    for (const [k, e] of Object.entries(incoming)) {
      if (!SYNC_KEY_RE.test(k) || !e || typeof e.t !== "number") continue;
      if (cur[k] && cur[k].t >= e.t) continue;
      if (!cur[k] && ++n > MAX_KEYS) break;
      const v = e.v === undefined ? null : e.v;
      if (JSON.stringify(v).length > MAX_VALUE) continue;
      cur[k] = { t: Math.min(e.t, Date.now() + 60000), v };
      puts["k:" + id + ":" + k] = cur[k];
    }
    const entries = Object.entries(puts);
    for (let i = 0; i < entries.length; i += 100) await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
    return cur;
  }

  async linked() { return (await this.state.storage.get("linked")) || []; }

  async telegram(upd) {
    const m = upd && (upd.message || upd.edited_message);
    if (!m || !m.chat || typeof m.text !== "string") return;
    const chat = m.chat.id, text = m.text.trim();
    const [cmd, arg] = text.split(/\s+/);
    if (cmd === "/start" && arg && SYNC_ID_RE.test(arg)) {
      const old = await this.state.storage.get("chatOf:" + chat);
      const list = (await this.linked()).filter((x) => x !== old);
      list.push(arg);
      await this.state.storage.put({ ["chat:" + arg]: chat, ["chatOf:" + chat]: arg, linked: [...new Set(list)] });
      if (old && old !== arg) await this.state.storage.delete("chat:" + old);
      await tgSend(this.env, chat, "✅ <b>Összekapcsolva a TőzsdeRadarral.</b>\nIde érkeznek a riasztásaid (percenkénti ellenőrzéssel, akkor is, ha az oldal nincs megnyitva), és este 9-kor az összefoglaló.\n\nParancsok: /riasztasok · /osszegzes · /stop");
      return;
    }
    const id = await this.state.storage.get("chatOf:" + chat);
    if (!id) { await tgSend(this.env, chat, "Ez a bot a TőzsdeRadar értesítéseit küldi. Az összekapcsoláshoz nyisd meg az oldalon a fent lévő ⚙ <b>Beállítások</b> gombot, és kattints a „Telegram összekapcsolása” gombra.\n" + SITE + "#beallitasok"); return; }
    if (cmd === "/stop") {
      await this.state.storage.delete(["chat:" + id, "chatOf:" + chat]);
      await this.state.storage.put("linked", (await this.linked()).filter((x) => x !== id));
      await tgSend(this.env, chat, "Leválasztva: több értesítés nem jön. Újra az oldalon a ⚙ Beállításoknál kapcsolhatod össze.");
      return;
    }
    if (cmd === "/osszegzes" || cmd === "/summary") { await this.summary(id, chat, true); return; }
    if (cmd === "/riasztasok") {
      const k = await this.keys(id);
      const al = ((k.alerts && k.alerts.v) || []).filter((a) => a && a.y);
      await tgSend(this.env, chat, al.length ? "<b>Riasztásaid</b>\n" + al.map((a) => (a.off ? "🔕 " : "🔔 ") + esc(a.label || a.y) + ": " + esc(alertText(a))).join("\n") : "Nincs szinkronizált riasztásod. Az oldalon a Piacok menüben állíthatsz be.");
      return;
    }
    await tgSend(this.env, chat, "Parancsok: /riasztasok · /osszegzes · /stop");
  }

  async cron() {
    const ids = await this.linked();
    if (!ids.length) return;
    const users = [];
    for (const id of ids) {
      const chat = await this.state.storage.get("chat:" + id);
      if (!chat) continue;
      const k = await this.keys(id);
      users.push({ id, chat, alerts: ((k.alerts && k.alerts.v) || []).filter((a) => a && a.y && !a.off), srv: (k.srv && k.srv.v) || {} });
    }
    // Riasztások: percenként egyszer kérjük le az érintett árakat
    const q = await freshQuotes(users.flatMap((u) => u.alerts.map((a) => a.y)));
    const now = Date.now();
    for (const u of users) {
      if (!u.alerts.length) continue;
      const st = (await this.state.storage.get("st:" + u.id)) || {};
      let changed = false;
      for (const a of u.alerts) {
        const x = q[a.y];
        if (!x) continue;
        const ch = x.prev ? (x.price / x.prev - 1) * 100 : null;
        const metric = a.type === "move" ? (ch == null ? null : Math.abs(ch)) : x.price;
        if (metric == null) continue;
        const side = metric >= a.value ? "hi" : "lo";
        const s = st[a.id] || {};
        if (s.side === side) continue;
        const prev = s.side;
        st[a.id] = { ...s, side }; changed = true;
        if (!prev) continue;
        const hit = a.type === "above" || a.type === "move" ? side === "hi" : a.type === "below" ? side === "lo" : true;
        if (!hit || (s.last && now - s.last < 60000)) continue;
        st[a.id].last = now;
        const dir = a.type === "move" ? "" : side === "hi" ? " ↑ fölé ment" : " ↓ alá ment";
        await tgSend(this.env, u.chat, "🔔 <b>" + esc(a.label || a.y) + "</b>: " + esc(alertText(a)) + dir + "\nMost: <b>" + fpx(x.price) + " " + esc(x.cur || "") + "</b>" + (ch != null ? " (" + pct(ch) + " ma)" : ""));
      }
      // a törölt riasztások állapotát kidobjuk
      for (const k of Object.keys(st)) if (!u.alerts.some((a) => a.id === k)) { delete st[k]; changed = true; }
      if (changed) await this.state.storage.put("st:" + u.id, st);
    }
    // Esti összefoglaló 21:00-kor (budapesti idő)
    const b = budapest();
    if (b.hour === 21 && b.minute < 10) {
      for (const u of users) {
        if (u.srv.summary === false) continue;
        const key = "sum:" + u.id;
        if ((await this.state.storage.get(key)) === b.date) continue;
        await this.state.storage.put(key, b.date);
        await this.summary(u.id, u.chat, false);
      }
    }
  }

  // Esti összefoglaló: portfolio értéke és napi változása, a legnagyobb mozgások, a holnapi fontos események
  async summary(id, chat, manual) {
    const k = await this.keys(id);
    const srv = (k.srv && k.srv.v) || {};
    const pf = (srv.pf || []).filter((h) => h && h.y && h.qty > 0);
    const favs = (srv.favs || []).filter(Boolean).slice(0, 25);
    const fx = ["EURUSD=X", "GBPUSD=X", "USDHUF=X"];
    const q = await freshQuotes([...fx, ...pf.map((h) => h.y), ...favs]);
    const usd = (v, cur) => {
      if (cur === "USD") return v;
      if (cur === "GBp" || cur === "GBX") return q["GBPUSD=X"] ? v / 100 * q["GBPUSD=X"].price : null;
      if (cur === "GBP") return q["GBPUSD=X"] ? v * q["GBPUSD=X"].price : null;
      if (cur === "EUR") return q["EURUSD=X"] ? v * q["EURUSD=X"].price : null;
      if (cur === "HUF") return q["USDHUF=X"] ? v / q["USDHUF=X"].price : null;
      return null;
    };
    const lines = ["🌙 <b>TőzsdeRadar esti összefoglaló</b> · " + budapest().date.replace(/-/g, ".")];
    const rows = [];
    let total = 0, base = 0;
    for (const h of pf) {
      const x = q[h.y];
      if (!x) continue;
      const v = usd(x.price * h.qty, x.cur);
      if (v == null) continue;
      const ch = x.prev ? (x.price / x.prev - 1) * 100 : null;
      total += v; base += ch == null ? v : v / (1 + ch / 100);
      rows.push({ sym: h.symbol, ch, v });
    }
    if (rows.length) {
      const d = total - base;
      const huf = q["USDHUF=X"] ? " (" + huNum(Math.round(total * q["USDHUF=X"].price), 0) + " Ft)" : "";
      lines.push("", "<b>Portfolio</b>: " + huNum(total, 2) + " $" + huf, "Mai változás: " + (d >= 0 ? "+" : "−") + huNum(Math.abs(d), 2) + " $ (" + pct(base ? d / base * 100 : 0) + ")");
      const mv = rows.filter((r) => r.ch != null).sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch)).slice(0, 4);
      if (mv.length) lines.push(mv.map((r) => (r.ch >= 0 ? "🟢 " : "🔴 ") + esc(r.sym) + " " + pct(r.ch)).join("\n"));
    }
    const fv = favs.map((t) => { const x = q[t]; return x && x.prev ? { t, ch: (x.price / x.prev - 1) * 100 } : null; }).filter(Boolean).sort((a, b) => b.ch - a.ch);
    if (fv.length >= 2) {
      const top = fv.slice(0, 3), bot = fv.slice(-3).reverse().filter((x) => !top.includes(x));
      lines.push("", "<b>Kedvenceid</b>", "Legjobb: " + top.map((x) => esc(x.t) + " " + pct(x.ch)).join(", "), bot.length ? "Leggyengébb: " + bot.map((x) => esc(x.t) + " " + pct(x.ch)).join(", ") : "");
    }
    // Holnapi események a napi kiadás naptárából
    try {
      const r = await fetch(SITE + "data.json?t=" + Date.now());
      const j = r.ok ? await r.json() : {};
      const tm = budapest(new Date(Date.now() + 86400000)).date;
      const syms = new Set(pf.map((h) => String(h.symbol).toUpperCase()));
      const ev = (j.calendar || []).filter((e) => e.date === tm && ((e.importance || 1) >= 2 || (e.symbols || []).some((s) => syms.has(String(s).toUpperCase()))))
        .sort((a, b) => String(a.time || "99").localeCompare(String(b.time || "99"))).slice(0, 8);
      lines.push("", "<b>Holnap</b> (" + tm.slice(5).replace("-", ".") + ".)");
      lines.push(ev.length ? ev.map((e) => "• " + (e.time || "egész nap") + " " + esc(e.country || "") + " — " + esc(e.event || "")).join("\n") : "Nincs kiemelt esemény a naptárban.");
    } catch { /* naptár nélkül */ }
    if (!rows.length && fv.length < 2 && !manual) return false;
    lines.push("", "<a href=\"" + SITE + "\">TőzsdeRadar megnyitása</a>");
    return tgSend(this.env, chat, lines.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n"));
  }
}

const AL_TYPES_TXT = { above: "≥ ", below: "≤ ", cross: "átlépi: " };
function alertText(a) {
  return a.type === "move" ? "napi változás ≥ ±" + huNum(a.value, 2) + "%" : (AL_TYPES_TXT[a.type] || "") + fpx(a.value);
}

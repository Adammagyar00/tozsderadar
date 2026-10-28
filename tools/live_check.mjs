// Ellenőrzi, hogy az élő árfolyam-közvetítő mindkét adatfolyama ad-e árat (GitHub Actionsből futtatva).
const cfg = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../live.json", import.meta.url)));
const check = (path, symbols) => new Promise((resolve) => {
  const ws = new WebSocket(cfg.wsUrl.replace(/\/ws$/, path), { headers: { Origin: "https://adammagyar00.github.io" } });
  let n = 0;
  const done = (why) => { try { ws.close(); } catch {} resolve(`${path}: ${n} üzenet (${why}) ${first}`); };
  ws.onopen = () => { for (const s of symbols) ws.send(JSON.stringify({ type: "subscribe", symbol: s })); };
  let first = "";
  ws.onmessage = (e) => { n++; if (n === 1) first = String(e.data).slice(0, 80); };
  ws.onerror = (e) => done("hiba: " + (e.message || e.type));
  setTimeout(() => done("30 mp"), 30000);
});
// Az eredmény ::notice::-ként a futás összefoglalójában is látszik
console.log("::notice::" + await check("/yws", ["EURUSD=X", "EURHUF=X", "BTC-USD", "VUAA.L", "^GDAXI", "NVDA"]));
console.log("::notice::" + await check("/ws", ["AAPL", "NVDA", "MSFT"]));
const base = cfg.wsUrl.replace(/^wss:/, "https:").replace(/\/ws$/, "");
try {
  const r = await fetch(base + "/history?range=5d&y=VUAA.L,NVDA,%5EGDAXI", { headers: { Origin: "https://adammagyar00.github.io" } });
  const j = await r.json();
  console.log("::notice::/history: " + r.status + " " + Object.entries(j.series || {}).map(([k, v]) => k + "=" + v.c.length + " pont").join(", "));
} catch (e) { console.log("::notice::/history hiba: " + e.message); }
for (const q of ["gold", "nvidia", "bitcoin", "VWCE"]) {
  try {
    const r = await fetch(base + "/search?q=" + q, { headers: { Origin: "https://adammagyar00.github.io" } });
    const j = await r.json();
    console.log("::notice::/search " + q + ": " + r.status + " " + (j.results || []).slice(0, 4).map((x) => x.symbol + "(" + x.type + ")").join(", "));
  } catch (e) { console.log("::notice::/search hiba: " + e.message); }
}
try {
  const r = await fetch(base + "/history?range=1d&y=BTC-USD,GC%3DF", { headers: { Origin: "https://adammagyar00.github.io" } });
  const j = await r.json();
  console.log("::notice::/history 1d: " + Object.entries(j.series || {}).map(([k, v]) => k + "=" + v.c.length).join(", "));
} catch (e) { console.log("::notice::/history 1d hiba: " + e.message); }
try {
  const r = await fetch(base + "/history?range=2y&iv=1d&ohlc=1&y=DFEN.DE,VUAA.L", { headers: { Origin: "https://adammagyar00.github.io" } });
  const j = await r.json();
  console.log("::notice::/history ohlc: " + Object.entries(j.series || {}).map(([k, v]) => k + "=" + v.c.length + " gyertya, utolsó O/H/L/C " + [v.o, v.h, v.l, v.c].map((a) => a && a[a.length - 1]).join("/")).join(" | "));
} catch (e) { console.log("::notice::/history ohlc hiba: " + e.message); }
// Új végpontok: hírek, CNN-hangulatindex, szinkron, Telegram-állapot
const O = { Origin: "https://adammagyar00.github.io" };
// (lépésenként legfeljebb 10 annotáció látszik, ezért ezek egy sorba kerülnek)
const extra = [];
const note = async (label, fn) => { try { extra.push(label + ": " + await fn()); } catch (e) { extra.push(label + " hiba: " + e.message); } };
await note("/news NVDA", async () => { const r = await fetch(base + "/news?q=NVDA", { headers: O }); const j = await r.json(); return r.status + " " + (j.news || []).length + " hír, első: " + ((j.news || [])[0] || {}).title; });
await note("/fng", async () => { const r = await fetch(base + "/fng", { headers: O }); return r.status + " " + JSON.stringify((await r.json()).fng); });
const sid = "livecheck" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");
await note("/sync", async () => {
  const w = await fetch(base + "/sync", { method: "POST", headers: O, body: JSON.stringify({ id: sid, keys: { test: { t: Date.now(), v: { ok: 1 } } } }) });
  const r = await fetch(base + "/sync?id=" + sid, { headers: O });
  return w.status + "/" + r.status + " " + JSON.stringify((await r.json()).keys);
});
await note("/tginfo", async () => { const r = await fetch(base + "/tginfo?id=" + sid, { headers: O }); return r.status + " " + JSON.stringify(await r.json()); });
// A böngészőből közvetlenül hívott külső adatforrások: válaszolnak-e, és engedik-e az oldalunkat (CORS)
for (const u of ["https://api.alternative.me/fng/?limit=2", "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT", "https://api.binance.com/api/v3/ticker/24hr?symbols=" + encodeURIComponent(JSON.stringify(["BTCUSDT", "TONUSDT", "SUIUSDT", "ONDOUSDT", "APTUSDT", "PEPEUSDT"]))]) {
  await note("külső " + new URL(u).host, async () => { const r = await fetch(u, { headers: O }); const t = await r.text(); return r.status + " CORS=" + r.headers.get("access-control-allow-origin") + " " + t.slice(0, 120); });
}
console.log("::notice::" + extra.join(" || ").replace(/\n/g, " "));
process.exit(0);

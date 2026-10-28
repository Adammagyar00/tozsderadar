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
process.exit(0);

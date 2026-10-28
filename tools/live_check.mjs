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
process.exit(0);

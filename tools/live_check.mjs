// Ellenőrzi, hogy az élő árfolyam-közvetítő mindkét adatfolyama ad-e árat (GitHub Actionsből futtatva).
const cfg = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../live.json", import.meta.url)));
const check = (path, symbols) => new Promise((resolve) => {
  const ws = new WebSocket(cfg.wsUrl.replace(/\/ws$/, path), { headers: { Origin: "https://adammagyar00.github.io" } });
  let n = 0;
  const done = (why) => { try { ws.close(); } catch {} resolve(`${path}: ${n} üzenet (${why})`); };
  ws.onopen = () => { for (const s of symbols) ws.send(JSON.stringify({ type: "subscribe", symbol: s })); };
  ws.onmessage = (e) => { n++; if (n <= 2) console.log(path, String(e.data).slice(0, 160)); };
  ws.onerror = (e) => done("hiba: " + (e.message || e.type));
  setTimeout(() => done("időkorlát"), 45000);
});
console.log(await check("/yws", ["EURUSD=X", "EURHUF=X", "BTC-USD", "VUAA.L", "^GDAXI", "NVDA"]));
console.log(await check("/ws", ["BINANCE:BTCUSDT", "AAPL", "NVDA"]));

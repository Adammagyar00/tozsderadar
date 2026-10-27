# TőzsdeRadar

Napi gazdasági és tőzsdei összefoglaló: piacok, jegybankok, forint, nyersanyagok és egy figyelőlista.

- `index.html` – maga az oldal (GitHub Pages szolgálja ki).
- `data.json` – a kiadások és a figyelőlista; minden reggel automatikusan frissül.

Az oldal 5 percenként újraolvassa a `data.json`-t, a kriptoárakat pedig percenként közvetlenül a CoinGeckótól kéri le.
Csak forrással alátámasztott, ellenőrzött hír és adat kerül bele.

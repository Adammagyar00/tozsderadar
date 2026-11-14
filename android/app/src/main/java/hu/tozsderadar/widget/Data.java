package hu.tozsderadar.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.NumberFormat;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Közös adatréteg: a szinkronkód, a Worker címe, a letöltött widget-adat és a frissítés. */
final class Data {
    static final String SITE = "https://adammagyar00.github.io/tozsderadar/";
    static final String FALLBACK_WORKER = "https://tozsderadar-live.magyaradam928.workers.dev";
    static final String ACTION_REFRESH = "hu.tozsderadar.widget.REFRESH";
    private static final Pattern ID_RE = Pattern.compile("([a-z0-9]{20,40})");
    static final Locale HU = new Locale("hu", "HU");

    private Data() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("tozsderadar", Context.MODE_PRIVATE);
    }

    static String syncId(Context c) {
        return prefs(c).getString("id", null);
    }

    /** Elfogadja a puszta kódot és a teljes szinkronlinket (…#sync=kód) is. */
    static String parseId(String s) {
        if (s == null) return null;
        String t = s.trim();
        int i = t.indexOf("sync=");
        if (i >= 0) t = t.substring(i + 5);
        i = t.indexOf("id=");
        if (i >= 0) t = t.substring(i + 3);
        Matcher m = ID_RE.matcher(t);
        return m.find() ? m.group(1) : null;
    }

    static JSONObject cached(Context c) {
        try {
            String s = prefs(c).getString("data", null);
            return s == null ? null : new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    static String get(String url) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(15000);
        con.setReadTimeout(30000);
        con.setRequestProperty("User-Agent", "TozsdeRadarWidget/1");
        try {
            if (con.getResponseCode() / 100 != 2) throw new Exception("HTTP " + con.getResponseCode());
            InputStream in = con.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            con.disconnect();
        }
    }

    /** A Worker címe az oldal live.json-jából (ha változna), különben a beépített. */
    static String worker(Context c) {
        try {
            JSONObject j = new JSONObject(get(SITE + "live.json?t=" + System.currentTimeMillis()));
            String ws = j.optString("wsUrl", "");
            if (ws.startsWith("wss://")) {
                String base = "https://" + ws.substring(6).replaceAll("/ws$", "");
                prefs(c).edit().putString("worker", base).apply();
                return base;
            }
        } catch (Exception ignored) {
            // marad a korábbi
        }
        return prefs(c).getString("worker", FALLBACK_WORKER);
    }

    /** Letölti a friss adatot (háttérszálon hívandó). Hiba esetén a régi marad, és megjegyzi a hibát. */
    static void fetch(Context c) {
        String id = syncId(c);
        if (id == null) return;
        try {
            String body = get(worker(c) + "/widget?id=" + id);
            JSONObject j = new JSONObject(body);
            if (j.has("error")) throw new Exception(j.optString("error"));
            prefs(c).edit().putString("data", body).putString("err", null).apply();
        } catch (Exception e) {
            prefs(c).edit().putString("err", "Nem sikerült frissíteni").apply();
        }
    }

    /** Frissíti mindkét widgetfajta összes példányát a tárolt adatból. */
    static void redrawAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] p = m.getAppWidgetIds(new ComponentName(c, PortfolioWidget.class));
        for (int id : p) PortfolioWidget.draw(c, m, id);
        int[] n = m.getAppWidgetIds(new ComponentName(c, NewsWidget.class));
        for (int id : n) NewsWidget.draw(c, m, id);
        if (n.length > 0) m.notifyAppWidgetViewDataChanged(n, R.id.list);
    }

    /** Háttérben letölt, majd újrarajzol. */
    static void refreshAsync(Context c, Runnable done) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                fetch(app);
                redrawAll(app);
            } finally {
                if (done != null) done.run();
            }
        }).start();
    }

    static String money(double v, String cur) {
        NumberFormat f = NumberFormat.getNumberInstance(HU);
        if ("HUF".equals(cur)) {
            f.setMaximumFractionDigits(0);
            return f.format(Math.round(v)) + " Ft";
        }
        f.setMinimumFractionDigits(2);
        f.setMaximumFractionDigits(2);
        return f.format(v) + ("EUR".equals(cur) ? " €" : " $");
    }

    static String signedMoney(double v, String cur) {
        return (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v), cur);
    }

    static String pct(double v) {
        NumberFormat f = NumberFormat.getNumberInstance(HU);
        f.setMinimumFractionDigits(2);
        f.setMaximumFractionDigits(2);
        return (v > 0 ? "+" : v < 0 ? "−" : "") + f.format(Math.abs(v)) + "%";
    }

    static String time(long ms) {
        return new SimpleDateFormat("HH:mm", HU).format(new Date(ms));
    }
}

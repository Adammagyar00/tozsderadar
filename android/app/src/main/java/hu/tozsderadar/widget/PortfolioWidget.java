package hu.tozsderadar.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

public class PortfolioWidget extends AppWidgetProvider {
    static final int UP = 0xFF5BD08A, DOWN = 0xFFF0776E, MUTED = 0xFF93A49D;

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) draw(c, m, id);
        final PendingResult r = goAsync();
        Data.refreshAsync(c, r::finish);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle o) {
        draw(c, m, id);
    }

    @Override
    public void onReceive(Context c, Intent i) {
        if (Data.ACTION_REFRESH.equals(i.getAction())) {
            final PendingResult r = goAsync();
            Data.refreshAsync(c, r::finish);
            return;
        }
        super.onReceive(c, i);
    }

    static PendingIntent refreshIntent(Context c, Class<?> cls, int req) {
        Intent i = new Intent(c, cls).setAction(Data.ACTION_REFRESH);
        return PendingIntent.getBroadcast(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** A widgetre koppintva a TőzsdeRadar app nyílik meg a megfelelő oldalon. */
    static PendingIntent openIntent(Context c, String target, int req) {
        Intent i = new Intent(c, MainActivity.class)
                .putExtra(MainActivity.EXTRA_HASH, Data.syncId(c) == null ? "#beallitasok" : target)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void draw(Context c, AppWidgetManager m, int id) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_portfolio);
        v.setOnClickPendingIntent(R.id.root, openIntent(c, "#portfolio", 1));
        v.setOnClickPendingIntent(R.id.refresh, refreshIntent(c, PortfolioWidget.class, 2));
        JSONObject d = Data.cached(c);
        String err = Data.prefs(c).getString("err", null);
        if (Data.syncId(c) == null) {
            v.setTextViewText(R.id.total, "–");
            v.setTextViewText(R.id.day, "Koppints a beállításhoz");
            v.setTextColor(R.id.day, MUTED);
            v.setTextViewText(R.id.sub, "");
            v.setTextViewText(R.id.movers, "");
            v.setTextViewText(R.id.updated, "");
        } else if (d == null) {
            v.setTextViewText(R.id.total, "–");
            v.setTextViewText(R.id.day, err != null ? err : "Betöltés…");
            v.setTextColor(R.id.day, MUTED);
        } else {
            JSONObject p = d.optJSONObject("portfolio");
            String cur = d.optString("currency", "USD");
            if (p == null || p.optInt("count") == 0) {
                v.setTextViewText(R.id.total, "–");
                v.setTextViewText(R.id.day, "A portfoliód üres");
                v.setTextColor(R.id.day, MUTED);
            } else {
                v.setTextViewText(R.id.total, Data.money(p.optDouble("total"), cur));
                double day = p.optDouble("day", 0);
                String dp = p.isNull("dayPct") ? "" : " (" + Data.pct(p.optDouble("dayPct")) + ")";
                v.setTextViewText(R.id.day, "Ma: " + Data.signedMoney(day, cur) + dp);
                v.setTextColor(R.id.day, day > 0 ? UP : day < 0 ? DOWN : MUTED);
                String sub = "";
                if (!"HUF".equals(cur) && !p.isNull("totalHuf")) sub = Data.money(p.optDouble("totalHuf"), "HUF");
                JSONArray miss = p.optJSONArray("missing");
                if (miss != null && miss.length() > 0) sub += (sub.isEmpty() ? "" : " · ") + miss.length() + " tétel ár nélkül";
                v.setTextViewText(R.id.sub, sub);
                v.setTextViewText(R.id.movers, movers(p.optJSONArray("movers"), rows(m, id)));
            }
            v.setTextViewText(R.id.updated, (err != null ? "⚠ " : "") + Data.time(d.optLong("updated")));
        }
        m.updateAppWidget(id, v);
    }

    /** Hány sor fér el a widget aktuális magasságában. */
    static int rows(AppWidgetManager m, int id) {
        Bundle o = m.getAppWidgetOptions(id);
        int h = o == null ? 0 : o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        if (h <= 0) return 3;
        return Math.max(0, Math.min(5, (h - 120) / 20));
    }

    static CharSequence movers(JSONArray a, int max) {
        SpannableStringBuilder b = new SpannableStringBuilder();
        if (a == null) return b;
        for (int i = 0; i < Math.min(a.length(), max); i++) {
            JSONObject r = a.optJSONObject(i);
            if (r == null) continue;
            if (b.length() > 0) b.append("\n");
            String sym = r.optString("sym");
            b.append(String.format(Data.HU, "%-6s", sym.length() > 6 ? sym.substring(0, 6) : sym)).append(" ");
            int s = b.length();
            double ch = r.optDouble("ch", 0);
            b.append(Data.pct(ch));
            b.setSpan(new ForegroundColorSpan(ch > 0 ? UP : ch < 0 ? DOWN : MUTED), s, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        return b;
    }
}

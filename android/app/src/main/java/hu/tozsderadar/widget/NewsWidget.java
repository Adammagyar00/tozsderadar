package hu.tozsderadar.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

import org.json.JSONObject;

public class NewsWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) draw(c, m, id);
        final PendingResult r = goAsync();
        Data.refreshAsync(c, r::finish);
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

    static void draw(Context c, AppWidgetManager m, int id) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_news);
        Intent svc = new Intent(c, NewsService.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
        v.setRemoteAdapter(R.id.list, svc);
        v.setEmptyView(R.id.list, R.id.empty);
        // egy hírre koppintva a TőzsdeRadar app nyílik meg a Watchlist News oldalon
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        v.setPendingIntentTemplate(R.id.list, PendingIntent.getActivity(c, 10, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE));
        v.setOnClickPendingIntent(R.id.head, PortfolioWidget.openIntent(c, "#watchlist-news", 11));
        v.setOnClickPendingIntent(R.id.empty, PortfolioWidget.openIntent(c, "#watchlist-news", 12));
        v.setOnClickPendingIntent(R.id.refresh, PortfolioWidget.refreshIntent(c, NewsWidget.class, 13));
        JSONObject d = Data.cached(c);
        String err = Data.prefs(c).getString("err", null);
        if (Data.syncId(c) == null) v.setTextViewText(R.id.empty, "Koppints a beállításhoz");
        else if (d == null) v.setTextViewText(R.id.empty, err != null ? err : "Betöltés…");
        else v.setTextViewText(R.id.empty, "Nincs friss hír a figyelőlistádról");
        v.setTextViewText(R.id.updated, d == null ? "" : (err != null ? "⚠ " : "") + Data.time(d.optLong("updated")));
        m.updateAppWidget(id, v);
    }
}

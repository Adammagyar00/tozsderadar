package hu.tozsderadar.widget;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** A Portfolio widget listája: minden tétel a napi változással és az értékével. */
public class PortfolioService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static final class Factory implements RemoteViewsFactory {
        private final Context c;
        private final List<JSONObject> items = new ArrayList<>();
        private String cur = "USD";

        Factory(Context c) { this.c = c; }

        @Override public void onCreate() { load(); }
        @Override public void onDataSetChanged() { load(); }
        @Override public void onDestroy() { items.clear(); }
        @Override public int getCount() { return items.size(); }
        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }

        private void load() {
            items.clear();
            JSONObject d = Data.cached(c);
            if (d == null) return;
            cur = d.optString("currency", "USD");
            JSONObject p = d.optJSONObject("portfolio");
            JSONArray a = p == null ? null : p.optJSONArray("movers");
            if (a == null) return;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o != null) items.add(o);
            }
        }

        @Override
        public RemoteViews getViewAt(int pos) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.pf_item);
            if (pos >= items.size()) return v;
            JSONObject o = items.get(pos);
            v.setTextViewText(R.id.sym, o.optString("sym"));
            v.setTextViewText(R.id.value, o.has("value") ? Data.money(o.optDouble("value"), cur) : "");
            if (o.isNull("ch")) {
                v.setTextViewText(R.id.pct, "–");
                v.setTextColor(R.id.pct, PortfolioWidget.MUTED);
            } else {
                double ch = o.optDouble("ch", 0);
                v.setTextViewText(R.id.pct, Data.pct(ch));
                v.setTextColor(R.id.pct, ch > 0 ? PortfolioWidget.UP : ch < 0 ? PortfolioWidget.DOWN : PortfolioWidget.MUTED);
            }
            v.setOnClickFillInIntent(R.id.item, new Intent().putExtra(MainActivity.EXTRA_HASH, "#portfolio"));
            return v;
        }
    }
}

package hu.tozsderadar.widget;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class NewsService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static final class Factory implements RemoteViewsFactory {
        private final Context c;
        private final List<JSONObject> items = new ArrayList<>();
        private String site = Data.SITE;

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
            site = d.optString("site", Data.SITE);
            JSONArray a = d.optJSONArray("news");
            if (a == null) return;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o != null) items.add(o);
            }
        }

        @Override
        public RemoteViews getViewAt(int pos) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.news_item);
            if (pos >= items.size()) return v;
            JSONObject o = items.get(pos);
            String impact = o.optString("impact", "semleges");
            int color = "pozitív".equals(impact) ? PortfolioWidget.UP : "negatív".equals(impact) ? PortfolioWidget.DOWN : PortfolioWidget.MUTED;
            SpannableStringBuilder meta = new SpannableStringBuilder();
            meta.append("●");
            meta.setSpan(new ForegroundColorSpan(color), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            JSONArray s = o.optJSONArray("syms");
            StringBuilder syms = new StringBuilder();
            if (s != null) for (int i = 0; i < s.length(); i++) syms.append(i > 0 ? ", " : "").append(s.optString(i));
            meta.append(" ").append(syms).append(" · ").append(o.optString("source"));
            String date = o.optString("date");
            if (date.length() == 10) meta.append(" · ").append(date.substring(5).replace('-', '.')).append(".");
            v.setTextViewText(R.id.meta, meta);
            v.setTextViewText(R.id.title, o.optString("title"));
            String url = o.isNull("url") ? site + "#watchlist-news" : o.optString("url");
            v.setOnClickFillInIntent(R.id.item, new Intent().setData(Uri.parse(url)));
            return v;
        }
    }
}

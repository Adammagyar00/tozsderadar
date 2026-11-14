package hu.tozsderadar.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Beállítás: a TőzsdeRadar szinkronkódjának megadása (bemásolva vagy az oldal gombjával). */
public class MainActivity extends Activity {
    private TextView status;
    private EditText input;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        int pad = dp(20);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad * 2, pad, pad);
        root.setBackgroundColor(0xFF0E1513);

        TextView h = text("TőzsdeRadar widget", 24, 0xFFE4ECE8);
        h.setTypeface(h.getTypeface(), android.graphics.Typeface.BOLD);
        root.addView(h);
        root.addView(text("Két widget a kezdőképernyőre: a portfoliód értéke és napi változása, valamint a figyelőlistád friss hírei. Az adatok a TőzsdeRadar szinkronjából jönnek; a widget félóránként és a ↻ gombra frissül.", 15, 0xFF93A49D));

        root.addView(text("1. Szinkronkód", 17, 0xFF4CC39D));
        root.addView(text("A TőzsdeRadar oldalon: ⚙ Beállítások → „Android widget” → „Kód átadása a widgetnek”. Vagy másold be ide a szinkronlinket vagy a kódot:", 14, 0xFF93A49D));
        input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(0xFF5B6A65);
        input.setHint("…#sync=abc123…");
        input.setSingleLine(true);
        root.addView(input);
        Button save = new Button(this);
        save.setText("Mentés és frissítés");
        save.setOnClickListener(v -> save(input.getText().toString()));
        root.addView(save);

        status = text("", 14, 0xFFE4ECE8);
        root.addView(status);

        root.addView(text("2. Widget kirakása", 17, 0xFF4CC39D));
        root.addView(text("Nyomd hosszan a kezdőképernyőt → Widgetek → TőzsdeRadar widget → húzd ki a Portfolio vagy a Watchlist News widgetet. Méretezhetők.", 14, 0xFF93A49D));
        if (Build.VERSION.SDK_INT >= 26) {
            AppWidgetManager m = getSystemService(AppWidgetManager.class);
            if (m != null && m.isRequestPinAppWidgetSupported()) {
                Button p1 = new Button(this);
                p1.setText("Portfolio widget kirakása");
                p1.setOnClickListener(v -> m.requestPinAppWidget(new ComponentName(this, PortfolioWidget.class), null, null));
                Button p2 = new Button(this);
                p2.setText("Watchlist News widget kirakása");
                p2.setOnClickListener(v -> m.requestPinAppWidget(new ComponentName(this, NewsWidget.class), null, null));
                root.addView(p1);
                root.addView(p2);
            }
        }

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(0xFF0E1513);
        sv.addView(root);
        setContentView(sv);
        handle(getIntent());
        showStatus();
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        handle(i);
    }

    private void handle(Intent i) {
        Uri u = i == null ? null : i.getData();
        if (u != null && "tozsderadar".equals(u.getScheme())) save(u.toString());
    }

    private void save(String raw) {
        String id = Data.parseId(raw);
        if (id == null) {
            status.setText("Ez nem érvényes szinkronkód vagy -link.");
            return;
        }
        Data.prefs(this).edit().putString("id", id).remove("data").remove("err").apply();
        input.setText("");
        status.setText("Mentve. Frissítés…");
        Data.refreshAsync(this, () -> runOnUiThread(this::showStatus));
    }

    private void showStatus() {
        String id = Data.syncId(this);
        if (id == null) {
            status.setText("Még nincs megadva szinkronkód.");
            return;
        }
        String err = Data.prefs(this).getString("err", null);
        org.json.JSONObject d = Data.cached(this);
        String s = "✓ Összekapcsolva (kód: " + id.substring(0, 6) + "…)";
        if (d != null) {
            org.json.JSONObject p = d.optJSONObject("portfolio");
            int n = p == null ? 0 : p.optInt("count");
            s += "\nUtolsó frissítés: " + Data.time(d.optLong("updated")) + " · " + n + " portfolio-tétel · " + (d.optJSONArray("news") == null ? 0 : d.optJSONArray("news").length()) + " hír";
        }
        if (err != null) s += "\n⚠ " + err;
        status.setText(s);
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setPadding(0, dp(8), 0, dp(4));
        t.setGravity(Gravity.START);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}

package hu.tozsderadar.widget;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/** A TőzsdeRadar alkalmazás: az oldal saját ablakban, a widgetek innen kapják a szinkronkódot. */
public class MainActivity extends Activity {
    static final String EXTRA_HASH = "hash";
    private static final String HOST = Uri.parse(Data.SITE).getHost();
    private WebView web;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(0xFF0E1513);
        getWindow().setNavigationBarColor(0xFF0E1513);
        FrameLayout box = new FrameLayout(this);
        box.setBackgroundColor(0xFF0E1513);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0E1513);
        box.addView(web, new FrameLayout.LayoutParams(-1, -1));
        // Android 15-től a tartalom a rendszersávok alá kerülne: a sávok és a billentyűzet helyét kihagyjuk
        if (Build.VERSION.SDK_INT >= 30) {
            box.setOnApplyWindowInsetsListener((View v, WindowInsets in) -> {
                android.graphics.Insets s = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(s.left, s.top, s.right, s.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(box);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " TozsdeRadarApp/1");
        web.addJavascriptInterface(new Bridge(), "TRApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("tozsderadar".equals(u.getScheme())) {
                    open(u);
                    return true;
                }
                if (HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/tozsderadar")) return false;
                // minden más (cikkek, Telegram, GitHub) a rendes böngészőben vagy a saját appjában nyílik
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                    // nincs mivel megnyitni
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                readSyncId();
            }
        });

        if (b != null) web.restoreState(b);
        else open(getIntent());
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        open(i);
    }

    @Override
    protected void onPause() {
        super.onPause();
        readSyncId();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private void open(Intent i) {
        Uri u = i == null ? null : i.getData();
        if (u != null && "tozsderadar".equals(u.getScheme())) {
            open(u);
            return;
        }
        String hash = i == null ? null : i.getStringExtra(EXTRA_HASH);
        go(hash == null ? "" : hash);
    }

    /** tozsderadar://widget?id=KÓD → csatlakozás a szinkronhoz ebben az appban is. */
    private void open(Uri u) {
        String id = Data.parseId(u.toString());
        if (id != null) {
            Data.setSyncId(this, id);
            go("#sync=" + id);
        } else go("");
    }

    /** Ha az oldal már be van töltve, csak a #részt váltjuk (nem töltjük újra). */
    private void go(String hash) {
        String cur = web.getUrl();
        if (cur != null && cur.startsWith(Data.SITE) && !hash.isEmpty()) {
            web.evaluateJavascript("location.hash=" + org.json.JSONObject.quote(hash) + ";window.scrollTo(0,0)", null);
        } else if (cur == null || !cur.startsWith(Data.SITE)) {
            web.loadUrl(Data.SITE + hash);
        }
    }

    /** A widget az oldal szinkronkódjával kéri le az adatokat. */
    private void readSyncId() {
        web.evaluateJavascript("(function(){try{return localStorage.getItem('tozsderadar-sync-id')||''}catch(e){return ''}})()", v -> {
            String id = Data.parseId(v);
            if (id != null && !id.equals(Data.syncId(this))) Data.setSyncId(this, id);
        });
    }

    /** Az oldalból hívható: window.TRApp.* */
    final class Bridge {
        @JavascriptInterface
        public void setSyncId(String id) {
            String p = Data.parseId(id);
            if (p != null && !p.equals(Data.syncId(MainActivity.this))) Data.setSyncId(MainActivity.this, p);
        }

        @JavascriptInterface
        public boolean canPin() {
            AppWidgetManager m = getSystemService(AppWidgetManager.class);
            return m != null && m.isRequestPinAppWidgetSupported();
        }

        @JavascriptInterface
        public void pinWidget(String kind) {
            runOnUiThread(() -> {
                AppWidgetManager m = getSystemService(AppWidgetManager.class);
                if (m == null || !m.isRequestPinAppWidgetSupported()) return;
                Class<?> c = "news".equals(kind) ? NewsWidget.class : PortfolioWidget.class;
                m.requestPinAppWidget(new ComponentName(MainActivity.this, c), null, null);
            });
        }

        @JavascriptInterface
        public String widgetStatus() {
            org.json.JSONObject d = Data.cached(MainActivity.this);
            String err = Data.prefs(MainActivity.this).getString("err", null);
            if (Data.syncId(MainActivity.this) == null) return "nincs kód";
            if (d == null) return err != null ? err : "betöltés…";
            return "frissítve " + Data.time(d.optLong("updated")) + (err != null ? " · " + err : "");
        }

        @JavascriptInterface
        public void refreshWidgets() {
            Data.refreshAsync(MainActivity.this, null);
        }
    }
}

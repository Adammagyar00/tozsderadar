package hu.tozsderadar.widget;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** A hírlista elemeire koppintva megnyitja a cikket a böngészőben, majd bezárul. */
public class OpenActivity extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Uri u = getIntent().getData();
        if (u != null && ("https".equals(u.getScheme()) || "http".equals(u.getScheme()))) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                // nincs böngésző
            }
        }
        finish();
    }
}

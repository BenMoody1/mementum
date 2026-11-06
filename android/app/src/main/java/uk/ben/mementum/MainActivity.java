package uk.ben.mementum;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HealthConnectPlugin.class);
        registerPlugin(RunPlugin.class);
        registerPlugin(FilesPlugin.class);
        super.onCreate(savedInstanceState);
        // keep the page's JavaScript running at full priority when the screen is off mid-run
        try {
            getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        } catch (Exception ignored) {}
        // Back button and gesture: let the page step back first (close a dialog, leave a
        // settings page, return from Settings). Only when it has nothing to do does Android
        // handle it as usual.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                if (wv == null) { passOn(); return; }
                wv.evaluateJavascript("(window.mmBack && window.mmBack()) ? 'yes' : 'no'", result -> {
                    if (!"\"yes\"".equals(result)) passOn();
                });
            }
            private void passOn() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}

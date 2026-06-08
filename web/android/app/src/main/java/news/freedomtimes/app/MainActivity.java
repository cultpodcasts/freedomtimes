package news.freedomtimes.app;

import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private static final String TAG = "FTAndroidApp";
	private static final String APP_UA_MARKER = "FreedomTimesCapacitorApp/Android";

	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(NativeAppConfigPlugin.class);
		super.onCreate(savedInstanceState);
		appendUserAgentMarker();
	}

	private void appendUserAgentMarker() {
		if (getBridge() == null) {
			Log.w(TAG, "Bridge unavailable; skipping UA marker append");
			return;
		}

		WebView webView = getBridge().getWebView();
		if (webView == null) {
			Log.w(TAG, "WebView unavailable; skipping UA marker append");
			return;
		}

		WebSettings settings = webView.getSettings();
		String existingUserAgent = settings.getUserAgentString();
		if (existingUserAgent == null) {
			Log.w(TAG, "Existing UA null; skipping UA marker append");
			return;
		}
		if (existingUserAgent.contains(APP_UA_MARKER)) {
			Log.i(TAG, "UA marker already present");
			return;
		}

		settings.setUserAgentString(existingUserAgent + " " + APP_UA_MARKER);
		Log.i(TAG, "UA marker appended: " + APP_UA_MARKER);
	}
}

package news.freedomtimes.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

/**
 * Capacitor shell. Warm App Links must reach the WebView even when the current
 * document is EmDash login (no Layout.astro bridge). Prefer the JS hook
 * {@code window.__ftHandleAppUrlOpen}; if absent, {@code loadUrl} the HTTPS intent.
 */
public class MainActivity extends BridgeActivity {
	private static final String TAG = "FTAndroidApp";
	private static final String APP_UA_MARKER = "FreedomTimesCapacitorApp/Android";

	private AppEnvironment activeEnvironment;
	private boolean environmentSwitchable;

	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(NativeAppConfigPlugin.class);
		// #149: create the bridge for the editor's chosen site (default production).
		AppEnvironmentConfig.Resolution environment = AppEnvironmentConfig.resolve(this);
		config = environment.config;
		activeEnvironment = environment.active;
		environmentSwitchable = environment.switchable;
		super.onCreate(savedInstanceState);
		appendUserAgentMarker();
		// #150: native pull-to-refresh around the WebView (reloads the current origin).
		WebViewPullToRefresh.install(this, getBridge());
		// #149: native STAGING strip over the WebView whenever staging is on screen.
		StagingIndicator.install(this, getBridge(), activeEnvironment, environmentSwitchable);
		// Cold-start VIEW intent: JS may not be ready yet → HTTPS loadUrl fallback.
		deliverViewIntent(getIntent());
	}

	@Override
	protected void onNewIntent(Intent intent) {
		super.onNewIntent(intent);
		setIntent(intent);
		deliverViewIntent(intent);
	}

	/** #149: the site this bridge was created for; null on a custom (local dev) build. */
	AppEnvironment getActiveEnvironment() {
		return activeEnvironment;
	}

	boolean isEnvironmentSwitchable() {
		return environmentSwitchable;
	}

	private void deliverViewIntent(Intent intent) {
		if (intent == null) {
			return;
		}

		Uri data = intent.getData();
		if (data == null) {
			return;
		}

		String scheme = data.getScheme();
		if (scheme == null) {
			return;
		}

		final String url = data.toString();
		if ("https".equalsIgnoreCase(scheme)) {
			String host = data.getHost();
			if (!isAppLinkHost(host)) {
				return;
			}
			deliverHttpsAppLink(url);
			return;
		}

		// Custom scheme (Auth0 / magic-link): only JS can map to HTTPS verify.
		deliverViaJsHook(url, false);
	}

	private static boolean isAppLinkHost(String host) {
		return "freedomtimes.news".equalsIgnoreCase(host)
			|| "staging.freedomtimes.news".equalsIgnoreCase(host);
	}

	private void deliverHttpsAppLink(String url) {
		deliverViaJsHook(url, true);
	}

	/**
	 * @param loadUrlIfNoJs when true and {@code __ftHandleAppUrlOpen} is missing,
	 *                      load the HTTPS URL in the WebView (warm EmDash login).
	 */
	private void deliverViaJsHook(String url, boolean loadUrlIfNoJs) {
		if (getBridge() == null) {
			Log.w(TAG, "Bridge unavailable; cannot deliver VIEW intent");
			return;
		}

		WebView webView = getBridge().getWebView();
		if (webView == null) {
			Log.w(TAG, "WebView unavailable; cannot deliver VIEW intent");
			return;
		}

		String quotedUrl;
		try {
			quotedUrl = JSONObject.quote(url);
		} catch (Exception e) {
			Log.w(TAG, "Failed to quote VIEW intent URL", e);
			return;
		}

		String js =
			"(function(){try{var fn=window.__ftHandleAppUrlOpen;"
				+ "if(typeof fn==='function'){return fn(" + quotedUrl + ")?'js':'dup';}"
				+ "return 'none';}catch(e){return 'err';}})()";

		webView.post(() -> webView.evaluateJavascript(js, value -> {
			String result = value == null ? "null" : value.replace("\"", "");
			Log.i(TAG, "VIEW intent JS delivery=" + result + " loadFallback=" + loadUrlIfNoJs);
			if (loadUrlIfNoJs && ("none".equals(result) || "err".equals(result) || "null".equals(result))) {
				// Mirror JS claimCapacitorLaunchUrl so a later getLaunchUrl on Layout/EmDash
				// does not re-GET the same single-use magic-link URL.
				String claimJs =
					"try{sessionStorage.setItem('ft_capacitor_launch_url_handled',"
						+ quotedUrl
						+ ");}catch(e){}";
				webView.evaluateJavascript(claimJs, ignored -> {
					Log.i(TAG, "Loading HTTPS App Link in WebView (no JS hook)");
					webView.loadUrl(url);
				});
			}
		}));
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

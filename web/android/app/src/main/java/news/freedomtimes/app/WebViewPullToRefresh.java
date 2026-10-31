package news.freedomtimes.app;

import android.app.Activity;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.MotionEvent;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Native pull-to-refresh for the Capacitor WebView (#150).
 *
 * <p>Wraps Capacitor's WebView in a {@link SwipeRefreshLayout} (the standard Material spinner). A
 * pull only starts when the WebView is at the top AND the page guard
 * ({@code res/raw/ft_pull_to_refresh_guard.js}) reported, for this touch, that the page was at the
 * top and the touch was not inside scrolled, editable, embedded or self-handled content. A pull
 * reloads the current URL on its own origin (so it follows the staging/production switch, #149).
 * When offline it keeps the page and shows a message.
 */
final class WebViewPullToRefresh {
	private static final String TAG = "FTAndroidApp";
	static final String JS_INTERFACE = "FTPullToRefresh";
	/** Stop the spinner even if the page never reports loaded (e.g. a form resubmission refused). */
	private static final long REFRESH_TIMEOUT_MS = 15000;
	private static final String[] KNOWN_ORIGINS = {
		"https://freedomtimes.news",
		"https://staging.freedomtimes.news",
	};

	private final Activity activity;
	private final Bridge bridge;
	private final WebView webView;
	private final GuardedSwipeRefreshLayout swipe;
	private final Handler mainHandler = new Handler(Looper.getMainLooper());
	private final AtomicInteger gestureState = new AtomicInteger(PullToRefreshPolicy.GESTURE_UNKNOWN);
	private final Runnable refreshTimeout;
	private final String guardScript;

	private WebViewPullToRefresh(Activity activity, Bridge bridge, WebView webView, String guardScript) {
		this.activity = activity;
		this.bridge = bridge;
		this.webView = webView;
		this.guardScript = guardScript;
		this.swipe = new GuardedSwipeRefreshLayout(activity);
		this.refreshTimeout = () -> {
			Log.w(TAG, "Pull-to-refresh: page did not report loaded in time; stopping the spinner");
			swipe.setRefreshing(false);
		};
	}

	/** Installs pull-to-refresh, or logs and does nothing if the WebView isn't where we expect it. */
	static WebViewPullToRefresh install(Activity activity, Bridge bridge) {
		if (activity == null || bridge == null || bridge.getWebView() == null) {
			Log.w(TAG, "Pull-to-refresh: bridge or WebView unavailable; not installed");
			return null;
		}
		WebView webView = bridge.getWebView();
		if (!(webView.getParent() instanceof ViewGroup)) {
			Log.w(TAG, "Pull-to-refresh: WebView has no parent layout; not installed");
			return null;
		}
		String script = readGuardScript(activity);
		if (script == null) {
			Log.w(TAG, "Pull-to-refresh: guard script missing; not installed");
			return null;
		}
		WebViewPullToRefresh controller = new WebViewPullToRefresh(activity, bridge, webView, script);
		controller.attach();
		return controller;
	}

	private void attach() {
		ViewGroup parent = (ViewGroup) webView.getParent();
		int index = parent.indexOfChild(webView);
		ViewGroup.LayoutParams params = webView.getLayoutParams();
		parent.removeView(webView);
		swipe.addView(webView, new ViewGroup.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT,
			ViewGroup.LayoutParams.MATCH_PARENT
		));
		parent.addView(swipe, index, params);

		swipe.setColorSchemeColors(activity.getColor(R.color.notification_icon_color));
		swipe.setOnChildScrollUpCallback((layout, child) -> PullToRefreshPolicy.childCanScrollUp(
			webView.canScrollVertically(-1),
			webView.getScrollY(),
			gestureState.get(),
			swipe.isEvaluatingDown()
		));
		swipe.setOnRefreshListener(this::onPullToRefresh);

		webView.addJavascriptInterface(new GuardBridge(gestureState), JS_INTERFACE);
		installGuardAtDocumentStart();
		bridge.addWebViewListener(new WebViewListener() {
			@Override
			public void onPageCommitVisible(WebView view, String url) {
				injectGuard(view);
				finishRefresh();
			}

			@Override
			public void onPageLoaded(WebView view) {
				injectGuard(view);
				finishRefresh();
			}
		});
		// The first page may already be loading; make sure it gets the guard too.
		injectGuard(webView);
		Log.i(TAG, "Pull-to-refresh installed");
	}

	private void installGuardAtDocumentStart() {
		if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
			return;
		}
		Set<String> origins = new LinkedHashSet<>();
		for (String origin : KNOWN_ORIGINS) {
			origins.add(origin);
		}
		String serverOrigin = PullToRefreshPolicy.originOf(bridge.getServerUrl());
		if (serverOrigin != null) {
			origins.add(serverOrigin);
		}
		String appOrigin = PullToRefreshPolicy.originOf(bridge.getAppUrl());
		if (appOrigin != null) {
			origins.add(appOrigin);
		}
		try {
			WebViewCompat.addDocumentStartJavaScript(webView, guardScript, origins);
		} catch (RuntimeException e) {
			// The after-load injection below still covers every page.
			Log.w(TAG, "Pull-to-refresh: document-start guard not installed", e);
		}
	}

	private void injectGuard(WebView view) {
		if (view == null) {
			return;
		}
		// Idempotent: the script installs once per document (window.__ftPullToRefreshGuard).
		view.post(() -> view.evaluateJavascript(guardScript, null));
	}

	private void onPullToRefresh() {
		String currentUrl = webView.getUrl();
		String appUrl = bridge.getAppUrl();
		PullToRefreshPolicy.Action action = PullToRefreshPolicy.decide(isOnline(), currentUrl, appUrl);
		Log.i(TAG, "Pull-to-refresh action=" + action);
		switch (action) {
			case RELOAD:
				scheduleTimeout();
				webView.reload();
				break;
			case LOAD_APP_URL:
				scheduleTimeout();
				webView.loadUrl(appUrl);
				break;
			case OFFLINE:
				swipe.setRefreshing(false);
				Toast.makeText(activity, R.string.pull_to_refresh_offline, Toast.LENGTH_LONG).show();
				break;
			default:
				swipe.setRefreshing(false);
				break;
		}
	}

	private void scheduleTimeout() {
		mainHandler.removeCallbacks(refreshTimeout);
		mainHandler.postDelayed(refreshTimeout, REFRESH_TIMEOUT_MS);
	}

	private void finishRefresh() {
		if (!swipe.isRefreshing()) {
			return;
		}
		mainHandler.removeCallbacks(refreshTimeout);
		swipe.setRefreshing(false);
	}

	private boolean isOnline() {
		try {
			ConnectivityManager cm = activity.getSystemService(ConnectivityManager.class);
			if (cm == null) {
				return true;
			}
			Network network = cm.getActiveNetwork();
			if (network == null) {
				return false;
			}
			NetworkCapabilities caps = cm.getNetworkCapabilities(network);
			return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
		} catch (RuntimeException e) {
			// Can't tell: try the reload; the WebView shows its own error if it fails.
			Log.w(TAG, "Pull-to-refresh: connectivity check failed", e);
			return true;
		}
	}

	private static String readGuardScript(Context context) {
		try (InputStream in = context.getResources().openRawResource(R.raw.ft_pull_to_refresh_guard)) {
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			byte[] buffer = new byte[4096];
			int read;
			while ((read = in.read(buffer)) != -1) {
				out.write(buffer, 0, read);
			}
			return out.toString(StandardCharsets.UTF_8.name());
		} catch (IOException | RuntimeException e) {
			Log.w(TAG, "Pull-to-refresh: could not read the guard script", e);
			return null;
		}
	}

	/** Called by the page guard from the WebView's JS thread. Only ever stores allowed/blocked. */
	static final class GuardBridge {
		private final AtomicInteger state;

		GuardBridge(AtomicInteger state) {
			this.state = state;
		}

		@JavascriptInterface
		public void reportGesture(boolean allowed) {
			state.set(allowed ? PullToRefreshPolicy.GESTURE_ALLOWED : PullToRefreshPolicy.GESTURE_BLOCKED);
		}
	}

	/** Resets the guard state at each new touch and flags the ACTION_DOWN evaluation. */
	private final class GuardedSwipeRefreshLayout extends SwipeRefreshLayout {
		private boolean evaluatingDown;

		GuardedSwipeRefreshLayout(@NonNull Context context) {
			super(context);
		}

		boolean isEvaluatingDown() {
			return evaluatingDown;
		}

		@Override
		public boolean dispatchTouchEvent(MotionEvent event) {
			if (event.getActionMasked() != MotionEvent.ACTION_DOWN) {
				return super.dispatchTouchEvent(event);
			}
			// A new touch: forget the last report until the page guard sees this touchstart.
			gestureState.set(PullToRefreshPolicy.GESTURE_UNKNOWN);
			evaluatingDown = true;
			try {
				return super.dispatchTouchEvent(event);
			} finally {
				evaluatingDown = false;
			}
		}
	}
}

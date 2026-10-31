package news.freedomtimes.app;

import java.util.Locale;

/**
 * Pure pull-to-refresh decisions for the Android shell (#150). No Android types, so the
 * rules are covered by plain JUnit tests (PullToRefreshPolicyTest).
 */
final class PullToRefreshPolicy {
	/** No report from the page guard for this touch yet (or the touch is in a cross-origin frame). */
	static final int GESTURE_UNKNOWN = 0;
	/** The page guard says this touch started at the top, outside scrolled or embedded content. */
	static final int GESTURE_ALLOWED = 1;
	/** The page guard says the page or the touched content must keep this gesture. */
	static final int GESTURE_BLOCKED = 2;

	enum Action {
		/** Reload the current document from its own origin (fresh, within normal HTTP cache rules). */
		RELOAD,
		/** Nothing loaded yet (or a non-http document): load the app's start URL. */
		LOAD_APP_URL,
		/** No network: keep the current page and tell the user. */
		OFFLINE,
		/** Nothing sensible to load: just stop the spinner. */
		NONE,
	}

	private PullToRefreshPolicy() {}

	/**
	 * SwipeRefreshLayout's "can the child scroll up?" callback. {@code true} means the WebView keeps
	 * the gesture and no pull-to-refresh starts.
	 *
	 * @param webViewCanScrollUp {@code WebView.canScrollVertically(-1)}
	 * @param webViewScrollY {@code WebView.getScrollY()}
	 * @param gestureState the page guard's report for this touch ({@code GESTURE_*})
	 * @param evaluatingDown {@code true} while SwipeRefreshLayout handles ACTION_DOWN. The page guard
	 *     can't have reported yet, and refusing the DOWN would make SwipeRefreshLayout drop the
	 *     pointer for the whole gesture, so only the native scroll position counts here. The MOVE
	 *     events that would start a pull still need GESTURE_ALLOWED.
	 */
	static boolean childCanScrollUp(
		boolean webViewCanScrollUp,
		int webViewScrollY,
		int gestureState,
		boolean evaluatingDown
	) {
		if (webViewCanScrollUp || webViewScrollY > 0) {
			return true;
		}
		if (evaluatingDown) {
			return false;
		}
		return gestureState != GESTURE_ALLOWED;
	}

	/**
	 * What a completed pull should do. Uses the WebView's current URL, so whichever origin the app
	 * is on (staging or production, #149) is the one that reloads.
	 */
	static Action decide(boolean online, String currentUrl, String appUrl) {
		if (!online) {
			return Action.OFFLINE;
		}
		if (isHttpUrl(currentUrl)) {
			return Action.RELOAD;
		}
		if (isHttpUrl(appUrl)) {
			return Action.LOAD_APP_URL;
		}
		return Action.NONE;
	}

	static boolean isHttpUrl(String url) {
		if (url == null) {
			return false;
		}
		String value = url.trim().toLowerCase(Locale.ROOT);
		return value.startsWith("https://") || value.startsWith("http://");
	}

	/** {@code scheme://host[:port]} for an http(s) URL, or {@code null}. */
	static String originOf(String url) {
		if (!isHttpUrl(url)) {
			return null;
		}
		String value = url.trim();
		int schemeEnd = value.indexOf("://");
		int pathStart = value.length();
		for (char c : new char[] { '/', '?', '#' }) {
			int at = value.indexOf(c, schemeEnd + 3);
			if (at >= 0 && at < pathStart) {
				pathStart = at;
			}
		}
		if (pathStart <= schemeEnd + 3) {
			return null;
		}
		return value.substring(0, schemeEnd).toLowerCase(Locale.ROOT)
			+ "://"
			+ value.substring(schemeEnd + 3, pathStart).toLowerCase(Locale.ROOT);
	}
}

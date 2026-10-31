package news.freedomtimes.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;

/**
 * Native, non-dismissable STAGING strip above the WebView (#149).
 *
 * <p>It is a native view outside the WebView, so no page (reader, admin, the Secure Access wall,
 * EmDash login) can hide or restyle it. The page area is moved down by the strip's height, so it
 * covers nothing. It follows the URL actually loading ({@link AppEnvironmentPolicy}), so it also
 * appears when an App Link opens staging on a production-set app. Production shows nothing. A tap
 * offers "Switch to production" (always allowed: it is the safe direction and an escape hatch if a
 * staging sign-in is stuck). Nothing on the page can hide it.
 */
final class StagingIndicator {
	private static final String TAG = "FTAndroidApp";
	static final int BACKGROUND = Color.parseColor("#B3261E");

	private final Activity activity;
	private final Bridge bridge;
	private final AppEnvironment active;
	private final boolean switchable;
	private final TextView banner;
	private final View page;

	private StagingIndicator(Activity activity, Bridge bridge, AppEnvironment active, boolean switchable, TextView banner, View page) {
		this.activity = activity;
		this.bridge = bridge;
		this.active = active;
		this.switchable = switchable;
		this.banner = banner;
		this.page = page;
	}

	static StagingIndicator install(Activity activity, Bridge bridge, AppEnvironment active, boolean switchable) {
		if (activity == null || bridge == null || bridge.getWebView() == null) {
			Log.w(TAG, "Staging indicator: bridge or WebView unavailable; not installed");
			return null;
		}
		ViewGroup content = activity.findViewById(android.R.id.content);
		if (!(content instanceof FrameLayout) || content.getChildCount() == 0) {
			Log.w(TAG, "Staging indicator: no content frame; not installed");
			return null;
		}
		View page = content.getChildAt(0);
		TextView banner = buildBanner(activity);
		content.addView(banner, new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT,
			ViewGroup.LayoutParams.WRAP_CONTENT,
			Gravity.TOP
		));

		StagingIndicator indicator = new StagingIndicator(activity, bridge, active, switchable, banner, page);
		banner.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> indicator.applyPageOffset());
		banner.setOnClickListener(v -> indicator.offerProduction());
		bridge.addWebViewListener(new WebViewListener() {
			@Override
			public void onPageStarted(WebView view) {
				indicator.update(view.getUrl());
			}

			@Override
			public void onPageCommitVisible(WebView view, String url) {
				indicator.update(url);
			}

			@Override
			public void onPageLoaded(WebView view) {
				indicator.update(view.getUrl());
			}
		});
		// Before the first page starts: follow the active environment.
		indicator.update(null);
		return indicator;
	}

	private static TextView buildBanner(Activity activity) {
		TextView banner = new TextView(activity);
		banner.setText(R.string.staging_indicator_label);
		banner.setContentDescription(activity.getString(R.string.staging_indicator_description));
		banner.setTextColor(Color.WHITE);
		banner.setBackgroundColor(BACKGROUND);
		banner.setTypeface(Typeface.DEFAULT_BOLD);
		banner.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
		banner.setLetterSpacing(0.12f);
		banner.setGravity(Gravity.CENTER);
		int padV = dp(activity, 4);
		banner.setPadding(dp(activity, 12), padV, dp(activity, 12), padV);
		banner.setMinHeight(dp(activity, 24));
		banner.setElevation(dp(activity, 16));
		banner.setClickable(true);
		banner.setVisibility(View.GONE);
		return banner;
	}

	void update(String url) {
		boolean show = AppEnvironmentPolicy.shouldShowStagingIndicator(active, url);
		activity.runOnUiThread(() -> {
			int visibility = show ? View.VISIBLE : View.GONE;
			if (banner.getVisibility() != visibility) {
				banner.setVisibility(visibility);
			}
			applyPageOffset();
		});
	}

	private void applyPageOffset() {
		if (!(page.getLayoutParams() instanceof ViewGroup.MarginLayoutParams)) {
			return;
		}
		ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) page.getLayoutParams();
		int top = banner.getVisibility() == View.VISIBLE ? banner.getHeight() : 0;
		if (params.topMargin != top) {
			params.topMargin = top;
			page.setLayoutParams(params);
		}
	}

	private void offerProduction() {
		if (active != AppEnvironment.STAGING) {
			// The app is set to production and a link opened a staging page: just go back.
			WebView webView = bridge.getWebView();
			if (webView != null) {
				webView.loadUrl(AppEnvironment.PRODUCTION.origin + "/");
			}
			return;
		}
		if (!switchable) {
			return;
		}
		AppEnvironmentSwitcher.confirmAndSwitch(activity, AppEnvironment.PRODUCTION, (switched, reason) ->
			Log.i(TAG, "Staging indicator: switch to production " + reason));
	}

	private static int dp(Activity activity, int value) {
		return Math.round(value * activity.getResources().getDisplayMetrics().density);
	}
}

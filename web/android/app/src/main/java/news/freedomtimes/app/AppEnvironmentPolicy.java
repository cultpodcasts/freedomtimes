package news.freedomtimes.app;

import java.net.URI;

/**
 * Decisions for the staging/production switch (#149), kept free of Android types so they are
 * unit-tested ({@code AppEnvironmentPolicyTest}).
 */
final class AppEnvironmentPolicy {
	/** The editor-only page on the site (server-gated to Auth0 admin/editor) that hosts the switch. */
	static final String SWITCHER_PATH = "/app-environment";

	private AppEnvironmentPolicy() {
	}

	/**
	 * The build can switch only when its baked {@code server.url} is one of the two Freedom Times
	 * origins. A local dev build (e.g. {@code http://10.0.2.2:4321}) keeps its URL and no switch.
	 */
	static boolean isSwitchableBuild(String bakedServerUrl) {
		return AppEnvironment.forUrl(bakedServerUrl) != null;
	}

	/** The server URL the bridge should load: the stored choice (default production) on a switchable build. */
	static String resolveServerUrl(String bakedServerUrl, AppEnvironment stored) {
		if (!isSwitchableBuild(bakedServerUrl)) {
			return bakedServerUrl;
		}
		return (stored == null ? AppEnvironment.PRODUCTION : stored).origin;
	}

	/**
	 * Whether the native STAGING indicator shows. It follows the page actually on screen: a staging
	 * URL always shows it and a production URL never does, whatever the app setting. Anything else
	 * (blank, about:, an error page, another host) falls back to the app's active environment, so
	 * staging is never shown unmarked while a page is loading or failed.
	 */
	static boolean shouldShowStagingIndicator(AppEnvironment active, String currentUrl) {
		AppEnvironment onScreen = AppEnvironment.forUrl(currentUrl);
		if (onScreen != null) {
			return onScreen == AppEnvironment.STAGING;
		}
		return active == AppEnvironment.STAGING;
	}

	/**
	 * A switch request from the WebView (NativeAppConfig.requestEnvironmentSwitch) is accepted only
	 * from the editor-only switcher page on the app's own active origin. The server renders that page
	 * only after verifying an Auth0 admin/editor ID token, so a reader page (or script on one) can't
	 * trigger it. The native confirm dialog still needs a tap.
	 */
	static boolean isSwitchRequestAllowed(String pageUrl, AppEnvironment active, AppEnvironment target) {
		if (active == null || target == null) {
			return false;
		}
		if (AppEnvironment.forUrl(pageUrl) != active) {
			return false;
		}
		try {
			String path = new URI(pageUrl.trim()).getPath();
			return SWITCHER_PATH.equals(path) || (SWITCHER_PATH + "/").equals(path);
		} catch (Exception e) {
			return false;
		}
	}
}

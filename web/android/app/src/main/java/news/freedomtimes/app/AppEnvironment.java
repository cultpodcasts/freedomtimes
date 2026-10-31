package news.freedomtimes.app;

import java.net.URI;
import java.util.Locale;

/**
 * The two Freedom Times sites the Android app can show (#149). Production is the default; only an
 * editor can choose staging (see {@link AppEnvironmentPolicy}). Pure Java so it is unit-tested.
 */
enum AppEnvironment {
	PRODUCTION("production", "freedomtimes.news"),
	STAGING("staging", "staging.freedomtimes.news");

	final String id;
	final String host;
	final String origin;

	AppEnvironment(String id, String host) {
		this.id = id;
		this.host = host;
		this.origin = "https://" + host;
	}

	/** Exact id match ("production" / "staging", any case), else null. */
	static AppEnvironment fromId(String id) {
		if (id == null) {
			return null;
		}
		String wanted = id.trim().toLowerCase(Locale.ROOT);
		for (AppEnvironment env : values()) {
			if (env.id.equals(wanted)) {
				return env;
			}
		}
		return null;
	}

	/** A stored choice, or production when nothing (or something unknown) is stored. */
	static AppEnvironment fromStoredOrDefault(String id) {
		AppEnvironment env = fromId(id);
		return env == null ? PRODUCTION : env;
	}

	/** Exact host match (no subdomains, no www), else null. */
	static AppEnvironment forHost(String host) {
		if (host == null) {
			return null;
		}
		for (AppEnvironment env : values()) {
			if (env.host.equalsIgnoreCase(host)) {
				return env;
			}
		}
		return null;
	}

	/** The environment an https URL belongs to, else null (http, other hosts, junk). */
	static AppEnvironment forUrl(String url) {
		String host = httpsHost(url);
		return host == null ? null : forHost(host);
	}

	/** Host of an https URL, else null. */
	static String httpsHost(String url) {
		if (url == null || url.trim().isEmpty()) {
			return null;
		}
		try {
			URI uri = new URI(url.trim());
			if (!"https".equalsIgnoreCase(uri.getScheme())) {
				return null;
			}
			return uri.getHost();
		} catch (Exception e) {
			return null;
		}
	}
}

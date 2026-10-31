package news.freedomtimes.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Persists the editor's staging/production choice across restarts (#149). Default: production. */
final class AppEnvironmentStore {
	private static final String PREFS = "ft_app_environment";
	private static final String KEY = "environment";

	private AppEnvironmentStore() {
	}

	static AppEnvironment get(Context context) {
		SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
		return AppEnvironment.fromStoredOrDefault(prefs.getString(KEY, null));
	}

	/** Synchronous so the choice is on disk before the activity restarts. */
	static boolean set(Context context, AppEnvironment env) {
		return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
			.edit()
			.putString(KEY, env.id)
			.commit();
	}
}

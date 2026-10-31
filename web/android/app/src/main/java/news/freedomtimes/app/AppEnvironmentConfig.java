package news.freedomtimes.app;

import android.content.Context;
import android.util.Log;

import com.getcapacitor.CapConfig;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Points the Capacitor bridge at the chosen site before it is created (#149).
 *
 * <p>Capacitor injects its native bridge only into the configured {@code server.url} origin, so the
 * switch can't just navigate: the bridge must be created for the chosen origin. This copies the
 * synced {@code assets/capacitor.config.json} with only {@code server.url} replaced and loads that
 * copy. Everything else (allowNavigation, user agent, plugin config) is unchanged.
 */
final class AppEnvironmentConfig {
	private static final String TAG = "FTAndroidApp";
	private static final String ASSET = "capacitor.config.json";
	private static final String DIR = "ft-app-environment";

	/** What MainActivity runs with. {@code config} null means "use the synced default as-is". */
	static final class Resolution {
		final CapConfig config;
		final AppEnvironment active;
		final boolean switchable;

		Resolution(CapConfig config, AppEnvironment active, boolean switchable) {
			this.config = config;
			this.active = active;
			this.switchable = switchable;
		}
	}

	private AppEnvironmentConfig() {
	}

	static Resolution resolve(Context context) {
		String baked = null;
		try {
			JSONObject json = new JSONObject(readAsset(context));
			JSONObject server = json.optJSONObject("server");
			baked = server == null ? null : server.optString("url", null);
			if (!AppEnvironmentPolicy.isSwitchableBuild(baked)) {
				Log.i(TAG, "App environment: build server URL is not a Freedom Times origin; no switch");
				return new Resolution(null, AppEnvironment.forUrl(baked), false);
			}

			AppEnvironment stored = AppEnvironmentStore.get(context);
			String target = AppEnvironmentPolicy.resolveServerUrl(baked, stored);
			if (target.equals(baked)) {
				Log.i(TAG, "App environment: " + stored.id + " (build default)");
				return new Resolution(null, stored, true);
			}

			server.put("url", target);
			File dir = new File(context.getNoBackupFilesDir(), DIR);
			if (!dir.isDirectory() && !dir.mkdirs()) {
				throw new IllegalStateException("cannot create " + dir);
			}
			try (FileOutputStream out = new FileOutputStream(new File(dir, ASSET))) {
				out.write(json.toString().getBytes(StandardCharsets.UTF_8));
			}
			CapConfig config = CapConfig.loadFromFile(context, dir.getAbsolutePath());
			if (!target.equals(config.getServerUrl())) {
				throw new IllegalStateException("rewritten config did not load");
			}
			Log.i(TAG, "App environment: " + stored.id);
			return new Resolution(config, stored, true);
		} catch (Exception e) {
			// Fall back to the synced config. The indicator follows the page host, so a staging
			// page is still marked STAGING if this ever happens.
			Log.e(TAG, "App environment: could not apply the stored choice; using the build URL", e);
			return new Resolution(null, AppEnvironment.forUrl(baked), false);
		}
	}

	private static String readAsset(Context context) throws Exception {
		try (InputStream in = context.getAssets().open(ASSET)) {
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			byte[] buffer = new byte[4096];
			int read;
			while ((read = in.read(buffer)) != -1) {
				out.write(buffer, 0, read);
			}
			return out.toString(StandardCharsets.UTF_8.name());
		}
	}
}

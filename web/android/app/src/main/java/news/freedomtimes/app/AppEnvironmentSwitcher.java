package news.freedomtimes.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Confirms and performs a staging/production switch (#149).
 *
 * <p>Push never crosses environments: staging and production share one Firebase project, so the same
 * FCM token would be valid for both sites' subscription databases. Before switching we delete this
 * install's FCM token. The old site's row is then dead (FCM answers UNREGISTERED and the scheduler
 * deactivates it) and, if notifications are allowed, the new site's page load registers a fresh
 * token with that site only. If the token can't be deleted (e.g. offline) the switch is cancelled.
 */
final class AppEnvironmentSwitcher {
	private static final String TAG = "FTAndroidApp";
	private static final long TOKEN_RESET_TIMEOUT_MS = 15000;

	interface Listener {
		/** Called on the main thread once: true right before the restart, false if nothing changed. */
		void onDone(boolean switched, String reason);
	}

	private AppEnvironmentSwitcher() {
	}

	static void confirmAndSwitch(Activity activity, AppEnvironment target, Listener listener) {
		if (activity == null || activity.isFinishing() || target == null) {
			listener.onDone(false, "unavailable");
			return;
		}
		boolean toStaging = target == AppEnvironment.STAGING;
		new AlertDialog.Builder(activity)
			.setTitle(toStaging ? R.string.app_environment_to_staging_title : R.string.app_environment_to_production_title)
			.setMessage(toStaging ? R.string.app_environment_to_staging_message : R.string.app_environment_to_production_message)
			.setPositiveButton(toStaging ? R.string.app_environment_to_staging_confirm : R.string.app_environment_to_production_confirm,
				(dialog, which) -> switchNow(activity, target, listener))
			.setNegativeButton(android.R.string.cancel, (dialog, which) -> listener.onDone(false, "cancelled"))
			.setOnCancelListener(dialog -> listener.onDone(false, "cancelled"))
			.show();
	}

	private static void switchNow(Activity activity, AppEnvironment target, Listener listener) {
		resetPushToken(activity.getApplicationContext(), ok -> {
			if (!ok) {
				Toast.makeText(activity, R.string.app_environment_push_reset_failed, Toast.LENGTH_LONG).show();
				listener.onDone(false, "push_reset_failed");
				return;
			}
			if (!AppEnvironmentStore.set(activity, target)) {
				Toast.makeText(activity, R.string.app_environment_save_failed, Toast.LENGTH_LONG).show();
				listener.onDone(false, "save_failed");
				return;
			}
			Log.i(TAG, "App environment: switched to " + target.id + "; restarting");
			listener.onDone(true, "switched");
			restart(activity);
		});
	}

	interface Result {
		void onResult(boolean ok);
	}

	/** Deletes this install's FCM token (no-op success when Firebase isn't configured in this build). */
	static void resetPushToken(Context context, Result result) {
		Handler main = new Handler(Looper.getMainLooper());
		AtomicBoolean done = new AtomicBoolean(false);
		Result once = ok -> {
			if (done.compareAndSet(false, true)) {
				main.post(() -> result.onResult(ok));
			}
		};
		if (FirebaseApp.getApps(context).isEmpty()) {
			Log.i(TAG, "App environment: Firebase not configured; no push token to reset");
			once.onResult(true);
			return;
		}
		main.postDelayed(() -> {
			if (!done.get()) {
				Log.w(TAG, "App environment: push token reset timed out");
			}
			once.onResult(false);
		}, TOKEN_RESET_TIMEOUT_MS);
		try {
			FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(task -> {
				if (!task.isSuccessful()) {
					Log.w(TAG, "App environment: push token reset failed", task.getException());
				}
				once.onResult(task.isSuccessful());
			});
		} catch (Exception e) {
			Log.w(TAG, "App environment: push token reset threw", e);
			once.onResult(false);
		}
	}

	/** A fresh task with no VIEW intent, so the bridge is created for the new origin and nothing old is replayed. */
	private static void restart(Activity activity) {
		Intent intent = new Intent(activity, MainActivity.class);
		intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
		activity.startActivity(intent);
		activity.finish();
	}
}

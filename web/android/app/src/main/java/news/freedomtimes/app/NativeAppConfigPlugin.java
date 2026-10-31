package news.freedomtimes.app;

import android.app.Activity;
import android.content.Context;
import android.content.res.Resources;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeAppConfig")
public class NativeAppConfigPlugin extends Plugin {
  private static final String TAG = "FTAndroidApp";

  @PluginMethod
  public void getFirebaseStatus(PluginCall call) {
    boolean firebaseConfigured = isFirebaseConfigured(getContext());
    Log.i(TAG, "NativeAppConfig.getFirebaseStatus firebaseConfigured=" + firebaseConfigured);
    JSObject result = new JSObject();
    result.put("firebaseConfigured", firebaseConfigured);
    call.resolve(result);
  }

  /** #149: the app's active environment, for the editor-only switcher page. */
  @PluginMethod
  public void getEnvironment(PluginCall call) {
    MainActivity activity = mainActivity();
    AppEnvironment active = activity == null ? null : activity.getActiveEnvironment();
    JSObject result = new JSObject();
    result.put("environment", active == null ? "custom" : active.id);
    result.put("switchable", activity != null && activity.isEnvironmentSwitchable());
    call.resolve(result);
  }

  /**
   * #149: switch staging/production after a native confirm. Accepted only from the server-gated
   * switcher page on the active origin ({@link AppEnvironmentPolicy#isSwitchRequestAllowed}).
   * Resolves {@code {switched, reason}}; on success the app restarts on the new site.
   */
  @PluginMethod
  public void requestEnvironmentSwitch(PluginCall call) {
    AppEnvironment target = AppEnvironment.fromId(call.getString("environment"));
    MainActivity activity = mainActivity();
    if (target == null) {
      call.reject("Unknown environment", "invalid_environment");
      return;
    }
    if (activity == null || !activity.isEnvironmentSwitchable()) {
      call.reject("This app build can't switch environments", "not_switchable");
      return;
    }
    activity.runOnUiThread(() -> {
      WebView webView = getBridge().getWebView();
      String pageUrl = webView == null ? null : webView.getUrl();
      AppEnvironment active = activity.getActiveEnvironment();
      if (!AppEnvironmentPolicy.isSwitchRequestAllowed(pageUrl, active, target)) {
        Log.w(TAG, "NativeAppConfig.requestEnvironmentSwitch refused outside the switcher page");
        call.reject("Switching is only available from the app environment page", "not_allowed");
        return;
      }
      if (active == target) {
        JSObject same = new JSObject();
        same.put("switched", false);
        same.put("reason", "already_active");
        call.resolve(same);
        return;
      }
      AppEnvironmentSwitcher.confirmAndSwitch(activity, target, (switched, reason) -> {
        JSObject result = new JSObject();
        result.put("switched", switched);
        result.put("reason", reason);
        call.resolve(result);
      });
    });
  }

  private MainActivity mainActivity() {
    Activity activity = getActivity();
    return activity instanceof MainActivity ? (MainActivity) activity : null;
  }

  private boolean isFirebaseConfigured(Context context) {
    Resources resources = context.getResources();
    int googleAppIdRes = resources.getIdentifier("google_app_id", "string", context.getPackageName());

    if (googleAppIdRes == 0) {
      return false;
    }

    String googleAppId = resources.getString(googleAppIdRes);
    return googleAppId != null && !googleAppId.trim().isEmpty();
  }
}

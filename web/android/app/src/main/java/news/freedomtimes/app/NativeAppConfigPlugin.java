package news.freedomtimes.app;

import android.content.Context;
import android.content.res.Resources;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeAppConfig")
public class NativeAppConfigPlugin extends Plugin {
  @PluginMethod
  public void getFirebaseStatus(PluginCall call) {
    JSObject result = new JSObject();
    result.put("firebaseConfigured", isFirebaseConfigured(getContext()));
    call.resolve(result);
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

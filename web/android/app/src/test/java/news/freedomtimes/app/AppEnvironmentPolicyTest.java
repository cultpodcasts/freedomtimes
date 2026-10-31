package news.freedomtimes.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AppEnvironmentPolicyTest {
	private static final String PROD = "https://freedomtimes.news";
	private static final String STAGING = "https://staging.freedomtimes.news";

	@Test
	public void defaultsToProductionWhenNothingOrJunkIsStored() {
		assertEquals(AppEnvironment.PRODUCTION, AppEnvironment.fromStoredOrDefault(null));
		assertEquals(AppEnvironment.PRODUCTION, AppEnvironment.fromStoredOrDefault(""));
		assertEquals(AppEnvironment.PRODUCTION, AppEnvironment.fromStoredOrDefault("dev"));
		assertEquals(AppEnvironment.STAGING, AppEnvironment.fromStoredOrDefault(" Staging "));
		assertEquals(AppEnvironment.PRODUCTION, AppEnvironment.fromStoredOrDefault("production"));
	}

	@Test
	public void environmentsMatchExactHttpsHostsOnly() {
		assertEquals(AppEnvironment.PRODUCTION, AppEnvironment.forUrl(PROD + "/posts/x?y=1"));
		assertEquals(AppEnvironment.STAGING, AppEnvironment.forUrl(STAGING + "/_emdash/admin"));
		assertEquals(AppEnvironment.STAGING, AppEnvironment.forUrl("https://STAGING.freedomtimes.news/"));
		assertNull(AppEnvironment.forUrl("http://staging.freedomtimes.news/"));
		assertNull(AppEnvironment.forUrl("https://www.freedomtimes.news/"));
		assertNull(AppEnvironment.forUrl("https://evilstaging.freedomtimes.news.example/"));
		assertNull(AppEnvironment.forUrl("about:blank"));
		assertNull(AppEnvironment.forUrl(null));
		assertNull(AppEnvironment.forUrl("not a url"));
	}

	@Test
	public void serverUrlFollowsTheStoredChoiceOnFreedomTimesBuilds() {
		// The CI APK is synced with staging; it still opens production by default.
		assertEquals(PROD, AppEnvironmentPolicy.resolveServerUrl(STAGING, null));
		assertEquals(PROD, AppEnvironmentPolicy.resolveServerUrl(STAGING, AppEnvironment.PRODUCTION));
		assertEquals(STAGING, AppEnvironmentPolicy.resolveServerUrl(PROD, AppEnvironment.STAGING));
		assertEquals(PROD, AppEnvironmentPolicy.resolveServerUrl(PROD, AppEnvironment.PRODUCTION));
	}

	@Test
	public void localDevBuildsKeepTheirUrlAndCannotSwitch() {
		String local = "http://10.0.2.2:4321";
		assertFalse(AppEnvironmentPolicy.isSwitchableBuild(local));
		assertEquals(local, AppEnvironmentPolicy.resolveServerUrl(local, AppEnvironment.STAGING));
		assertFalse(AppEnvironmentPolicy.isSwitchableBuild(null));
	}

	@Test
	public void stagingIndicatorFollowsThePageOnScreen() {
		AppEnvironment p = AppEnvironment.PRODUCTION;
		AppEnvironment s = AppEnvironment.STAGING;
		assertTrue("staging page, staging app", AppEnvironmentPolicy.shouldShowStagingIndicator(s, STAGING + "/"));
		assertTrue("staging login wall", AppEnvironmentPolicy.shouldShowStagingIndicator(s, STAGING + "/auth/login"));
		assertTrue("staging App Link on a production app", AppEnvironmentPolicy.shouldShowStagingIndicator(p, STAGING + "/posts/a"));
		assertFalse("production page, production app", AppEnvironmentPolicy.shouldShowStagingIndicator(p, PROD + "/"));
		assertFalse("production page on a staging app is not labelled staging", AppEnvironmentPolicy.shouldShowStagingIndicator(s, PROD + "/"));
		assertTrue("before first load on staging", AppEnvironmentPolicy.shouldShowStagingIndicator(s, null));
		assertTrue("error page on staging", AppEnvironmentPolicy.shouldShowStagingIndicator(s, "about:blank"));
		assertFalse("before first load on production", AppEnvironmentPolicy.shouldShowStagingIndicator(p, null));
		assertFalse("custom build", AppEnvironmentPolicy.shouldShowStagingIndicator(null, "http://10.0.2.2:4321/"));
	}

	@Test
	public void switchRequestsOnlyFromTheSwitcherPageOnTheActiveOrigin() {
		AppEnvironment p = AppEnvironment.PRODUCTION;
		AppEnvironment s = AppEnvironment.STAGING;
		assertTrue(AppEnvironmentPolicy.isSwitchRequestAllowed(PROD + "/app-environment", p, s));
		assertTrue(AppEnvironmentPolicy.isSwitchRequestAllowed(PROD + "/app-environment/?x=1", p, s));
		assertTrue(AppEnvironmentPolicy.isSwitchRequestAllowed(STAGING + "/app-environment", s, p));
		assertFalse("reader page", AppEnvironmentPolicy.isSwitchRequestAllowed(PROD + "/", p, s));
		assertFalse("look-alike path", AppEnvironmentPolicy.isSwitchRequestAllowed(PROD + "/app-environment-x", p, s));
		assertFalse("nested path", AppEnvironmentPolicy.isSwitchRequestAllowed(PROD + "/posts/app-environment", p, s));
		assertFalse("other origin than the active one", AppEnvironmentPolicy.isSwitchRequestAllowed(STAGING + "/app-environment", p, s));
		assertFalse("http", AppEnvironmentPolicy.isSwitchRequestAllowed("http://freedomtimes.news/app-environment", p, s));
		assertFalse("no page", AppEnvironmentPolicy.isSwitchRequestAllowed(null, p, s));
		assertFalse("no target", AppEnvironmentPolicy.isSwitchRequestAllowed(PROD + "/app-environment", p, null));
		assertFalse("custom build", AppEnvironmentPolicy.isSwitchRequestAllowed(PROD + "/app-environment", null, s));
	}
}

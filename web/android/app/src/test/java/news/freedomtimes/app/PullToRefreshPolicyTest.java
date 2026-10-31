package news.freedomtimes.app;

import static news.freedomtimes.app.PullToRefreshPolicy.GESTURE_ALLOWED;
import static news.freedomtimes.app.PullToRefreshPolicy.GESTURE_BLOCKED;
import static news.freedomtimes.app.PullToRefreshPolicy.GESTURE_UNKNOWN;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PullToRefreshPolicyTest {
	@Test
	public void pullStartsOnlyAtTopWithTheGuardsApproval() {
		assertFalse("at top + guard allowed: pull may start",
			PullToRefreshPolicy.childCanScrollUp(false, 0, GESTURE_ALLOWED, false));
		assertTrue("guard blocked (scrolled / embedded content): WebView keeps it",
			PullToRefreshPolicy.childCanScrollUp(false, 0, GESTURE_BLOCKED, false));
		assertTrue("no guard report yet (or cross-origin frame): WebView keeps it",
			PullToRefreshPolicy.childCanScrollUp(false, 0, GESTURE_UNKNOWN, false));
	}

	@Test
	public void midPageScrollingNeverStartsAPull() {
		assertTrue(PullToRefreshPolicy.childCanScrollUp(true, 0, GESTURE_ALLOWED, false));
		assertTrue(PullToRefreshPolicy.childCanScrollUp(false, 240, GESTURE_ALLOWED, false));
		assertTrue("scrolled page refuses even the DOWN",
			PullToRefreshPolicy.childCanScrollUp(true, 240, GESTURE_UNKNOWN, true));
	}

	@Test
	public void downAtTopIsNotRefusedSoTheGestureCanStillStart() {
		// SwipeRefreshLayout drops the pointer for the whole gesture if DOWN is refused,
		// and the guard can't have reported during DOWN.
		assertFalse(PullToRefreshPolicy.childCanScrollUp(false, 0, GESTURE_UNKNOWN, true));
	}

	@Test
	public void reloadUsesTheCurrentOrigin() {
		assertEquals(PullToRefreshPolicy.Action.RELOAD, PullToRefreshPolicy.decide(
			true, "https://freedomtimes.news/some-article", "https://staging.freedomtimes.news"));
		assertEquals(PullToRefreshPolicy.Action.RELOAD, PullToRefreshPolicy.decide(
			true, "https://staging.freedomtimes.news/_emdash/admin", "https://freedomtimes.news"));
	}

	@Test
	public void blankDocumentLoadsTheAppUrl() {
		assertEquals(PullToRefreshPolicy.Action.LOAD_APP_URL,
			PullToRefreshPolicy.decide(true, null, "https://staging.freedomtimes.news/"));
		assertEquals(PullToRefreshPolicy.Action.LOAD_APP_URL,
			PullToRefreshPolicy.decide(true, "about:blank", "https://staging.freedomtimes.news/"));
		assertEquals(PullToRefreshPolicy.Action.NONE,
			PullToRefreshPolicy.decide(true, "about:blank", null));
	}

	@Test
	public void offlineKeepsThePage() {
		assertEquals(PullToRefreshPolicy.Action.OFFLINE,
			PullToRefreshPolicy.decide(false, "https://freedomtimes.news/", "https://freedomtimes.news/"));
	}

	@Test
	public void originOfKeepsSchemeHostAndPort() {
		assertEquals("https://staging.freedomtimes.news",
			PullToRefreshPolicy.originOf("https://Staging.FreedomTimes.news/path?q=1#x"));
		assertEquals("http://10.0.2.2:4321", PullToRefreshPolicy.originOf("http://10.0.2.2:4321"));
		assertEquals("https://freedomtimes.news", PullToRefreshPolicy.originOf("https://freedomtimes.news?x"));
		assertNull(PullToRefreshPolicy.originOf("about:blank"));
		assertNull(PullToRefreshPolicy.originOf("https://"));
		assertNull(PullToRefreshPolicy.originOf(null));
	}
}

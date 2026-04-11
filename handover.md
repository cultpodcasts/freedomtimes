Please continue from the current staging investigation and implementation state for Freedom Times.

Goal:
Fix the MCP publishing workflow bug in EmDash so publishing works reliably for posts, and remove temporary workarounds once the root cause is fixed.

Current progress summary:

Homepage and post route behavior were improved and deployed.
Shared layout styling was moved to a global stylesheet and shell centering was removed.
Not-found pages for post routes now render inside the normal site layout.
The post route includes a fallback lookup path to reduce false 404s when direct entry lookup fails.
Content and slug state was adjusted through MCP calls multiple times during troubleshooting.
Critical bug to fix:
MCP publish appears broken for specific entries.

Observed MCP behavior:

content_update succeeds and creates a draft revision.
content_compare shows draft and live diverged correctly.
content_publish often returns generic error text: Failed to publish content.
Item may remain status published or draft, but live revision pointers are inconsistent for some entries.
Some records show published status while liveRevisionId is null, causing route lookup inconsistencies.
A restored trashed post at slug test-post-1-alt still cannot be made live through content_publish in certain flows.
Known affected slugs and IDs:

test-post-1
test-post-1-alt
test-post-1-legacy
Post IDs seen during investigation include:
01KNN0XHXR3KRDT8R9SVQ6MCPB
01KNWVRHXQWN5W2TS0BHSNF0EX
01KNWVPBBMQND0S3M5ZEKFPG3C
What to investigate:

Server-side implementation path for content_publish and repository publish logic.
Why publish can fail with only generic error output and no actionable cause.
Invariant mismatch where status can be published but live revision pointers are missing.
Any schema or revision constraints that make restored or previously trashed items fail publish.
Differences between content_create with status published versus content_update plus content_publish.
Expected deliverables:

Root-cause analysis of MCP publish failure with exact failing condition.
Code fix so content_publish reliably promotes draft to live.
Improved error reporting from publish path with concrete diagnostics.
Cleanup/migration script or repair routine for inconsistent records already in staging.
Removal or simplification of temporary route fallback once publishing is reliable.
Validation steps required:

Publish a draft post via MCP and confirm:
status is published, live revision exists, draft revision cleared.
Confirm homepage link opens post route without fallback dependence.
Confirm test-post-1-alt can be published and resolved directly.
Confirm no regressions for normal published-only display behavior.
Context files to review first:

web/src/pages/posts/[slug].astro
homepage.astro
Layout.astro
global.css
MCP and server publish logic in built/runtime EmDash server chunks used in staging.
Please produce:

A short root-cause summary.
The exact code changes made.
Verification evidence from MCP calls before and after the fix.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { JWTPayload } from 'jose';

import {
	STAGING_READER_ROLE,
	hasAdminRoleInClaims,
	hasEditorialRoleInClaims,
	hasLockedSiteContentRoleInClaims,
	hasStaffLoginRoleInClaims,
	hasStagingReaderRoleInClaims,
	isEmDashAdminUiPath,
	shouldDenyEmDashAdminForSiteSessionInClaims,
} from '../src/lib/auth-roles.ts';

const CLAIMS = ['https://example.test/roles', 'roles'] as const;

function payload(roles: string[], claim: (typeof CLAIMS)[number] = 'roles'): JWTPayload {
	return { [claim]: roles };
}

describe('staging-reader vs staff roles', () => {
	it('treats staging-reader as content access on locked staging only', () => {
		const reader = payload(['staging-reader']);
		assert.equal(hasStagingReaderRoleInClaims(reader, CLAIMS), true);
		assert.equal(hasEditorialRoleInClaims(reader, CLAIMS), false);
		assert.equal(hasAdminRoleInClaims(reader, CLAIMS), false);
		assert.equal(hasLockedSiteContentRoleInClaims(reader, CLAIMS), true);
		assert.equal(hasStaffLoginRoleInClaims(reader, CLAIMS, 'locked'), true);
		assert.equal(hasStaffLoginRoleInClaims(reader, CLAIMS, 'public'), false);
		assert.equal(shouldDenyEmDashAdminForSiteSessionInClaims(reader, CLAIMS), true);
	});

	it('does not grant staging-reader /admin or mix it into editorial chrome', () => {
		assert.equal(STAGING_READER_ROLE, 'staging-reader');
		const editor = payload(['editor']);
		assert.equal(hasStaffLoginRoleInClaims(editor, CLAIMS, 'public'), true);
		assert.equal(shouldDenyEmDashAdminForSiteSessionInClaims(editor, CLAIMS), false);
		assert.equal(shouldDenyEmDashAdminForSiteSessionInClaims(payload(['admin']), CLAIMS), false);
		assert.equal(
			shouldDenyEmDashAdminForSiteSessionInClaims(payload(['editor', 'staging-reader']), CLAIMS),
			false,
		);
	});

	it('reads namespaced role claims the same way as the Worker', () => {
		const reader = payload(['STAGING-READER'], 'https://example.test/roles');
		assert.equal(hasStagingReaderRoleInClaims(reader, CLAIMS), true);
		assert.equal(hasStaffLoginRoleInClaims(reader, CLAIMS, 'locked'), true);
	});

	it('blocks EmDash admin UI paths but not EmDash login or OAuth', () => {
		assert.equal(isEmDashAdminUiPath('/_emdash/admin'), true);
		assert.equal(isEmDashAdminUiPath('/_emdash/admin/'), true);
		assert.equal(isEmDashAdminUiPath('/_emdash/admin/content'), true);
		assert.equal(isEmDashAdminUiPath('/_emdash/admin/login'), false);
		assert.equal(isEmDashAdminUiPath('/_emdash/admin/login/'), false);
		assert.equal(isEmDashAdminUiPath('/_emdash/oauth/authorize'), false);
		assert.equal(isEmDashAdminUiPath('/_emdash/api/mcp'), false);
	});
});

describe('staging-reader wiring', () => {
	it('creates the Auth0 role from staging terraform, not production or auth0-shared', () => {
		const moduleMain = readFileSync(
			fileURLToPath(new URL('../../infra/terraform/modules/auth0_app/main.tf', import.meta.url)),
			'utf8',
		);
		const stagingMain = readFileSync(
			fileURLToPath(new URL('../../infra/terraform/environments/staging/main.tf', import.meta.url)),
			'utf8',
		);
		const productionMain = readFileSync(
			fileURLToPath(
				new URL('../../infra/terraform/environments/production/main.tf', import.meta.url),
			),
			'utf8',
		);
		const sharedMain = readFileSync(
			fileURLToPath(
				new URL('../../infra/terraform/environments/auth0-shared/main.tf', import.meta.url),
			),
			'utf8',
		);

		assert.match(moduleMain, /resource "auth0_role" "staging_reader"/);
		assert.match(moduleMain, /name\s+= "staging-reader"/);
		assert.doesNotMatch(moduleMain, /auth0_role_permissions" "staging_reader/);
		assert.match(stagingMain, /create_staging_reader_role\s+= true/);
		assert.doesNotMatch(productionMain, /create_staging_reader_role\s+= true/);
		assert.doesNotMatch(sharedMain, /create_staging_reader_role\s+= true/);
	});

	it('gates locked content on hasLockedSiteContentRole and keeps /admin on hasAdminRole', () => {
		const editorialSession = readFileSync(
			fileURLToPath(new URL('../src/lib/editorial-session.ts', import.meta.url)),
			'utf8',
		);
		const adminDashboard = readFileSync(
			fileURLToPath(new URL('../src/lib/admin-dashboard-session.ts', import.meta.url)),
			'utf8',
		);
		const middleware = readFileSync(
			fileURLToPath(new URL('../src/middleware.ts', import.meta.url)),
			'utf8',
		);
		const callback = readFileSync(
			fileURLToPath(new URL('../src/pages/auth/callback.ts', import.meta.url)),
			'utf8',
		);
		const adminSession = readFileSync(
			fileURLToPath(new URL('../src/lib/admin-session.ts', import.meta.url)),
			'utf8',
		);

		assert.match(editorialSession, /hasLockedSiteContentRole/);
		assert.match(editorialSession, /roleCheck: hasLockedSiteContentRole/);
		assert.match(adminDashboard, /hasAdminRole/);
		assert.match(callback, /hasStaffLoginRole\(payload, isLockedSiteAccess\(\) \? 'locked' : 'public'\)/);
		assert.match(middleware, /shouldDenyEmDashAdminForSiteSession/);
		assert.match(middleware, /isEmDashAdminUiPath/);
		assert.match(adminSession, /Keep a valid content-page session/);
	});
});

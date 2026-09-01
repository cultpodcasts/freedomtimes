import type { JWTPayload } from 'jose';

/** Auth0 role name. Created by staging Terraform; honored only when the Worker is locked. */
export const STAGING_READER_ROLE = 'staging-reader';

export function payloadHasAnyRole(
	payload: JWTPayload,
	allowed: ReadonlySet<string>,
	roleClaims: readonly string[],
): boolean {
	for (const claim of roleClaims) {
		const value = payload[claim];
		if (Array.isArray(value) && value.some((r) => allowed.has(String(r).toLowerCase()))) {
			return true;
		}
	}

	return false;
}

export function hasAdminRoleInClaims(payload: JWTPayload, roleClaims: readonly string[]): boolean {
	return payloadHasAnyRole(payload, new Set(['admin']), roleClaims);
}

export function hasStagingReaderRoleInClaims(
	payload: JWTPayload,
	roleClaims: readonly string[],
): boolean {
	return payloadHasAnyRole(payload, new Set([STAGING_READER_ROLE]), roleClaims);
}

/** `admin` or `editor` — EmDash CMS and `/admin` hub. Not `staging-reader`. */
export function hasEditorialRoleInClaims(payload: JWTPayload, roleClaims: readonly string[]): boolean {
	return payloadHasAnyRole(payload, new Set(['admin', 'editor']), roleClaims);
}

/** Locked staging content pages: staff or staging-reader. */
export function hasLockedSiteContentRoleInClaims(
	payload: JWTPayload,
	roleClaims: readonly string[],
): boolean {
	return (
		hasEditorialRoleInClaims(payload, roleClaims) || hasStagingReaderRoleInClaims(payload, roleClaims)
	);
}

/**
 * Production login: staff only. Locked staging login: staff or staging-reader.
 */
export function hasStaffLoginRoleInClaims(
	payload: JWTPayload,
	roleClaims: readonly string[],
	siteAccess: 'locked' | 'public',
): boolean {
	if (hasEditorialRoleInClaims(payload, roleClaims)) {
		return true;
	}

	return siteAccess === 'locked' && hasStagingReaderRoleInClaims(payload, roleClaims);
}

export function shouldDenyEmDashAdminForSiteSessionInClaims(
	payload: JWTPayload,
	roleClaims: readonly string[],
): boolean {
	return (
		hasStagingReaderRoleInClaims(payload, roleClaims) && !hasEditorialRoleInClaims(payload, roleClaims)
	);
}

export function isEmDashAdminUiPath(pathname: string): boolean {
	const normalized =
		pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
	if (normalized === '/_emdash/admin/login' || normalized.startsWith('/_emdash/admin/login/')) {
		return false;
	}

	return normalized === '/_emdash/admin' || normalized.startsWith('/_emdash/admin/');
}

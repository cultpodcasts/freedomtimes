import { decodeJwt } from 'jose';

/** Matches `jwt_configuration.lifetime_in_seconds` (`id_token_lifetime_in_seconds`) in `infra/terraform/modules/auth0_app`. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24; // 24 hours
/**
 * Keep the access-token cookie for the same window as `ft_session`.
 * A 30-minute `maxAge` dropped `ft_access_token` while the ID token was still valid,
 * which broke cookie-based APIM calls and felt like a forced re-login.
 */
export const ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS = SESSION_COOKIE_MAX_AGE_SECONDS;
/**
 * Refresh `ft_access_token` this many seconds before the Auth0 API JWT `exp`.
 * Cookie `maxAge` is 24h so the browser keeps the cookie; the JWT inside is
 * often much shorter. Silent refresh must key off this `exp`, not only `ft_session`.
 */
export const ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS = 60;

/**
 * True when `ft_access_token` is missing, not a JWT, has no `exp`, or is at/past
 * `exp` minus leeway. Does not verify the signature — only decides whether to
 * refresh so APIM/editorial cookie calls do not keep sending an expired API JWT.
 */
export function accessTokenNeedsRefresh(
  accessToken: string | undefined,
  nowMs: number = Date.now(),
  leewaySeconds: number = ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS,
): boolean {
  if (!accessToken?.trim()) {
    return true;
  }

  try {
    const claims = decodeJwt(accessToken);
    if (typeof claims.exp !== 'number') {
      return true;
    }
    return claims.exp * 1000 <= nowMs + leewaySeconds * 1000;
  } catch {
    return true;
  }
}

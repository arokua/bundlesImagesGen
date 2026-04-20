import { NextResponse } from "next/server";
import {
  normalizeOAuthRedirectUri,
  oauthRedirectUriForServer,
  publicOriginFromRequest,
  resolveOAuthRedirectUri,
  resolvePublicSiteOrigin,
} from "@/lib/driveAuth";

/** Safe diagnostics for OAuth / env on App Hosting (no secret values). */
export async function GET(request: Request) {
  const effective = resolveOAuthRedirectUri(request);
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const rawExplicit = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || null;
  const normalizedExplicit = rawExplicit
    ? normalizeOAuthRedirectUri(rawExplicit)
    : null;
  let requestUrlOrigin: string | null = null;
  let requestUrlOriginIsInternalBinding = false;
  try {
    const u = new URL(request.url);
    requestUrlOrigin = u.origin;
    const h = u.hostname;
    requestUrlOriginIsInternalBinding =
      h === "0.0.0.0" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    requestUrlOrigin = null;
  }

  return NextResponse.json({
    hasOAuthClientId: !!id,
    clientIdSuffix: id ? `…${id.slice(-12)}` : null,
    hasOAuthClientSecret: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim(),
    explicitRedirectEnvRaw: rawExplicit,
    explicitRedirectEnvNormalized: normalizedExplicit,
    explicitRedirectHasDoubleSlashAfterOrigin:
      !!rawExplicit &&
      !!normalizedExplicit &&
      rawExplicit !== normalizedExplicit,
    redirectUriUsedForNextOAuth: effective,
    redirectUriForDriveApiClient: oauthRedirectUriForServer(),
    publicOriginFromHeaders: publicOriginFromRequest(request),
    siteOriginEffective: resolvePublicSiteOrigin(request),
    requestUrlOrigin,
    /** True when `request.url` is the container bind address (e.g. https://0.0.0.0:8080), not your public URL. */
    requestUrlOriginIsInternalBinding,
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    hostHeader: request.headers.get("host"),
    hint:
      "Authorized redirect URIs in Google Cloud Console must match redirectUriUsedForNextOAuth exactly. " +
      "On Cloud Run / App Hosting, requestUrlOrigin is often https://0.0.0.0:8080 (internal bind) — that is expected. " +
      "Use siteOriginEffective and publicOriginFromHeaders as the public origin; do not use requestUrlOrigin for redirects. " +
      "If explicitRedirectHasDoubleSlashAfterOrigin is true, remove the extra / before api in GOOGLE_OAUTH_REDIRECT_URI (normalized value is what OAuth uses).",
  });
}

import fs from "node:fs/promises";
import path from "node:path";
import { JWT, OAuth2Client } from "google-auth-library";

export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"] as const;

export type DriveAuth = JWT | OAuth2Client;

function serviceAccountPath(): string | undefined {
  return (
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

/**
 * Collapse accidental `//` after the origin (e.g. `...hosted.app/` + `/api/...` in env).
 * Google rejects redirect_uri mismatch for `...app//api/...` vs `...app/api/...`.
 */
export function normalizeOAuthRedirectUri(uri: string): string {
  const t = uri.trim();
  if (!t) return t;
  return t.replace(/(https?:\/\/[^/]+)\/+/g, "$1/");
}

/**
 * Hostname from `Host` / `X-Forwarded-Host` (may include `:port`).
 * Do NOT use `host.split(":")[0]` — for `0.0.0.0:8080` that yields `"0"`, not `"0.0.0.0"`.
 */
function hostnameFromForwardedOrHostHeader(host: string): string {
  const t = host.trim();
  if (!t) return "";
  try {
    return new URL(`http://${t}`).hostname;
  } catch {
    return t;
  }
}

/** Cloud Run / App Hosting may bind `Host: 0.0.0.0:8080` — never treat that as the public site. */
function isUnusablePublicHostHeader(host: string): boolean {
  const h = hostnameFromForwardedOrHostHeader(host).replace(/^\[|\]$/g, "").toLowerCase();
  return h === "0.0.0.0";
}

function isUnusablePublicOrigin(origin: string): boolean {
  try {
    return new URL(origin).hostname === "0.0.0.0";
  } catch {
    return true;
  }
}

/**
 * Public origin for OAuth redirect — Cloud Run / Firebase App Hosting often set
 * `request.url` to an internal http://127.0.0.1 or container URL. Google OAuth
 * then receives the wrong redirect_uri (not listed in Console). Prefer proxy headers.
 * Skips `Host: 0.0.0.0` so callers can fall back to env / request URL.
 */
export function publicOriginFromRequest(request: Request): string | null {
  const xfHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = request.headers.get("host")?.split(",")[0]?.trim();
  const host =
    xfHost && !isUnusablePublicHostHeader(xfHost)
      ? xfHost
      : hostHeader && !isUnusablePublicHostHeader(hostHeader)
        ? hostHeader
        : null;
  if (!host) return null;

  const rawProto = request.headers.get("x-forwarded-proto");
  const firstProto = rawProto?.split(",")[0]?.trim();
  let proto = firstProto || "https";
  const hn = hostnameFromForwardedOrHostHeader(host);
  if (/^127\.|^localhost$/i.test(hn) || hn === "::1") {
    proto = firstProto || "http";
  }

  return `${proto}://${host}`;
}

/**
 * Origin users should land on after OAuth and for absolute links. Never `https://0.0.0.0:8080`.
 */
export function resolvePublicSiteOrigin(request: Request): string {
  const fromHeaders = publicOriginFromRequest(request);
  if (fromHeaders && !isUnusablePublicOrigin(fromHeaders)) {
    return fromHeaders.replace(/\/+$/, "");
  }

  let u: URL;
  try {
    u = new URL(request.url);
  } catch {
    return "http://localhost:3000";
  }
  if (u.hostname !== "0.0.0.0") {
    return u.origin;
  }

  const fromRedirect = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (fromRedirect) {
    try {
      const o = new URL(fromRedirect).origin;
      if (!isUnusablePublicOrigin(o)) return o;
    } catch {
      /* ignore */
    }
  }
  const app = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim().replace(/\/+$/, "");
  if (app && !isUnusablePublicOrigin(app)) return app;

  return "http://localhost:3000";
}

/**
 * OAuth redirect URI must match Google Cloud Console exactly.
 * 1) GOOGLE_OAUTH_REDIRECT_URI when set (must match Console byte-for-byte).
 * 2) Else origin from proxy headers / env / request (avoids 0.0.0.0 container URLs).
 */
export function resolveOAuthRedirectUri(request: Request): string {
  const explicit = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return normalizeOAuthRedirectUri(explicit);

  const base = resolvePublicSiteOrigin(request).replace(/\/+$/, "");
  return normalizeOAuthRedirectUri(
    `${base}/api/auth/google/callback`,
  );
}

/** Same redirect URI string used after login for Drive API (refresh, etc.). */
export function oauthRedirectUriForServer(): string {
  const explicit = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return normalizeOAuthRedirectUri(explicit);
  const rawOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim();
  const appOrigin = rawOrigin?.replace(/\/+$/, "") ?? "";
  if (appOrigin) {
    return normalizeOAuthRedirectUri(
      `${appOrigin}/api/auth/google/callback`,
    );
  }
  return "http://localhost:3000/api/auth/google/callback";
}

export async function getDriveAuth(): Promise<DriveAuth> {
  const saPath = serviceAccountPath();
  if (saPath) {
    const resolved = path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    saPath,
  );
    const raw = await fs.readFile(resolved, "utf8");
    const key = JSON.parse(raw) as {
      client_email: string;
      private_key: string;
    };
    return new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [...DRIVE_SCOPES],
    });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = oauthRedirectUriForServer();
  const tokenPath =
    process.env.GOOGLE_OAUTH_TOKEN_PATH ||
    path.join(
      /* turbopackIgnore: true */ process.cwd(),
      ".tokens",
      "google-oauth.json",
    );

  if (!clientId || !clientSecret) {
    throw new Error(
      "Configure GOOGLE_SERVICE_ACCOUNT_PATH (or GOOGLE_APPLICATION_CREDENTIALS), or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for Drive access.",
    );
  }

  const oauth2 = new OAuth2Client(clientId, clientSecret, redirectUri);
  try {
    const buf = await fs.readFile(tokenPath, "utf8");
    oauth2.setCredentials(JSON.parse(buf) as Record<string, unknown>);
  } catch {
    throw new Error(
      `OAuth token missing at ${tokenPath}. Visit /api/auth/google to authorize.`,
    );
  }
  return oauth2;
}

export function getOAuth2ClientForRedirect(redirectUri: string): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET required.");
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

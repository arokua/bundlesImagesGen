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
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    "http://localhost:3000/api/auth/google/callback";
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

export function getOAuth2ClientForRedirect(): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    "http://localhost:3000/api/auth/google/callback";
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET required.");
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

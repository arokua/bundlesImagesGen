import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getOAuth2ClientForRedirect } from "@/lib/driveAuth";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const err = searchParams.get("error");
  if (err) {
    return NextResponse.json({ error: `Google OAuth error: ${err}` }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: "Missing code parameter." }, { status: 400 });
  }

  try {
    const oauth2 = getOAuth2ClientForRedirect();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    const tokenPath =
      process.env.GOOGLE_OAUTH_TOKEN_PATH ||
      path.join(
        /* turbopackIgnore: true */ process.cwd(),
        ".tokens",
        "google-oauth.json",
      );
    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
    return NextResponse.redirect(new URL("/", request.url));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Token exchange failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

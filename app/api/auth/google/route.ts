import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getOAuth2ClientForRedirect,
  resolveOAuthRedirectUri,
} from "@/lib/driveAuth";

export async function GET(request: Request) {
  try {
    const redirectUri = resolveOAuthRedirectUri(request);
    const oauth2 = getOAuth2ClientForRedirect(redirectUri);
    const tokenDir = path.join(
      /* turbopackIgnore: true */ process.cwd(),
      ".tokens",
    );
    await fs.mkdir(tokenDir, { recursive: true });
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive"],
      prompt: "consent",
    });
    return NextResponse.redirect(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "OAuth setup failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getDriveAuth } from "@/lib/driveAuth";
import { dedupeDuplicateOutputFolders, getDriveClient } from "@/lib/drive";

export const maxDuration = 120;

export async function POST(request: Request) {
  let body: { outputFolderId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const outputFolderId =
    body.outputFolderId?.trim() ||
    process.env.OUTPUT_FOLDER_ID?.trim() ||
    "";

  if (!outputFolderId) {
    return NextResponse.json(
      {
        error:
          "Set outputFolderId in the request body or OUTPUT_FOLDER_ID in the environment.",
      },
      { status: 400 },
    );
  }

  let auth;
  try {
    auth = await getDriveAuth();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Drive auth failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const drive = await getDriveClient(auth);
  const outputDedupe = await dedupeDuplicateOutputFolders(drive, outputFolderId);
  return NextResponse.json(outputDedupe);
}

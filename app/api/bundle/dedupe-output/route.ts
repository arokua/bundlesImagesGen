import { NextResponse } from "next/server";
import { getDriveAuth } from "@/lib/driveAuth";
import { dedupeDuplicateOutputFolders, getDriveClient } from "@/lib/drive";

export const maxDuration = 120;

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const json = (body: unknown, status = 200) =>
    NextResponse.json(body, {
      status,
      headers: { "x-request-id": requestId },
    });

  let body: { outputFolderId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const outputFolderId =
    body.outputFolderId?.trim() ||
    process.env.OUTPUT_FOLDER_ID?.trim() ||
    "";

  if (!outputFolderId) {
    return json(
      {
        error:
          "Set outputFolderId in the request body or OUTPUT_FOLDER_ID in the environment.",
      },
      400,
    );
  }

  let auth;
  try {
    auth = await getDriveAuth();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Drive auth failed.";
    return json({ error: msg }, 500);
  }

  const drive = await getDriveClient(auth);
  const outputDedupe = await dedupeDuplicateOutputFolders(drive, outputFolderId);
  return json(outputDedupe);
}

import { NextResponse } from "next/server";
import { getDriveAuth } from "@/lib/driveAuth";
import { getDriveClient } from "@/lib/drive";
import { driveFolderUrl } from "@/lib/driveLinks";

export const maxDuration = 15;

type FolderInfo = {
  id: string;
  name: string | null;
  url: string;
};

async function resolveFolder(
  folderId: string | undefined,
): Promise<FolderInfo | null> {
  const id = folderId?.trim();
  if (!id) return null;
  const url = driveFolderUrl(id);
  let name: string | null = null;
  try {
    const auth = await getDriveAuth();
    const drive = await getDriveClient(auth);
    const res = await drive.files.get({
      fileId: id,
      fields: "name",
      supportsAllDrives: true,
    });
    name = res.data.name ?? null;
  } catch {
    /* no auth or API error — still return id + url */
  }
  return { id, name, url };
}

export async function GET() {
  const parentFolderId = process.env.PARENT_FOLDER_ID?.trim() || "";
  const outputFolderId = process.env.OUTPUT_FOLDER_ID?.trim() || "";

  const [parent, output] = await Promise.all([
    resolveFolder(parentFolderId || undefined),
    resolveFolder(outputFolderId || undefined),
  ]);

  return NextResponse.json({
    defaults: {
      parentFolderId: parentFolderId || null,
      outputFolderId: outputFolderId || null,
    },
    resolved: {
      parent,
      output,
    },
  });
}

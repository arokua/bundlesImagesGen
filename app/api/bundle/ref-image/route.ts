import { getDriveAuth } from "@/lib/driveAuth";
import { getDriveClient } from "@/lib/drive";

export const maxDuration = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get("fileId")?.trim();
  const hintedMime = searchParams.get("mimeType")?.trim();
  if (!fileId) {
    return new Response("Missing fileId.", { status: 400 });
  }

  try {
    const auth = await getDriveAuth();
    const drive = await getDriveClient(auth);
    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    const contentType =
      (res.headers["content-type"] as string | undefined) ??
      hintedMime ??
      "image/jpeg";
    const bytes = new Uint8Array(res.data as ArrayBuffer);
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to read image.";
    return new Response(msg, { status: 500 });
  }
}


import { getPreviewSessionImage } from "@/lib/previewImageStore";

export const maxDuration = 30;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId")?.trim();
  const imageId = searchParams.get("imageId")?.trim();
  const hintedMime = searchParams.get("mimeType")?.trim();
  if (!sessionId || !imageId) {
    return new Response("Missing sessionId or imageId.", { status: 400 });
  }

  const img = getPreviewSessionImage(sessionId, imageId);
  if (!img) {
    return new Response("Preview image expired or missing.", { status: 404 });
  }
  const bytes = Uint8Array.from(Buffer.from(img.dataBase64, "base64"));
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": img.mimeType || hintedMime || "image/jpeg",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=300",
    },
  });
}


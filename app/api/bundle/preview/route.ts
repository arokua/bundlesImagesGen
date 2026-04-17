import { NextResponse } from "next/server";
import { getDriveAuth } from "@/lib/driveAuth";
import { getDriveClient, listChildFolders } from "@/lib/drive";
import { generateBundlePreview } from "@/lib/bundlePipeline";
import { parseBundleInput } from "@/lib/parseSkus";

export const maxDuration = 300;

const PARENT_FOLDER_FALLBACK_ID =
  process.env.PARENT_FOLDER_FALLBACK_ID?.trim() ||
  "1JJ9RC7rDbbMN3jryfpquem0Xu9DEppMy";

export async function POST(request: Request) {
  let body: {
    text?: string;
    parentFolderId?: string;
    lineIndex?: number;
    seedOffset?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parentFolderId =
    body.parentFolderId?.trim() ||
    process.env.PARENT_FOLDER_ID?.trim() ||
    "";
  const lineIndex = body.lineIndex;
  const seedOffset = Math.max(
    0,
    Number.parseInt(String(body.seedOffset ?? 0), 10) || 0,
  );

  if (!parentFolderId) {
    return NextResponse.json(
      {
        error:
          "Set parentFolderId in the request body or PARENT_FOLDER_ID in the environment.",
      },
      { status: 400 },
    );
  }

  if (lineIndex === undefined || lineIndex < 0) {
    return NextResponse.json(
      { error: "Provide a non-negative lineIndex for the bundle to preview." },
      { status: 400 },
    );
  }

  const text = body.text ?? "";
  const { bundles, errors: parseErrors } = parseBundleInput(text);
  const bundle = bundles.find((b) => b.lineIndex === lineIndex);
  if (!bundle) {
    return NextResponse.json(
      {
        error: `No parsed bundle for lineIndex ${lineIndex}.`,
        parseErrors,
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
  const primaryChildFolders = await listChildFolders(drive, parentFolderId);
  const useFallbackParent =
    PARENT_FOLDER_FALLBACK_ID.length > 0 &&
    PARENT_FOLDER_FALLBACK_ID !== parentFolderId;
  const fallbackChildFolders = useFallbackParent
    ? await listChildFolders(drive, PARENT_FOLDER_FALLBACK_ID)
    : null;

  const result = await generateBundlePreview(
    drive,
    bundle,
    primaryChildFolders,
    fallbackChildFolders,
    seedOffset,
  );

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, lineIndex: result.lineIndex, error: result.error, parseErrors },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    parseErrors,
    preview: result.preview,
  });
}

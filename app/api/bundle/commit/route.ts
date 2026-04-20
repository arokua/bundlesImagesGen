import { NextResponse } from "next/server";
import { getDriveAuth } from "@/lib/driveAuth";
import { getDriveClient } from "@/lib/drive";
import {
  commitBundleToDrive,
  type IsolatedSkuPreview,
  type PreviewImagePayload,
  type ReferenceSourceCopy,
} from "@/lib/bundlePipeline";

export const maxDuration = 120;

export async function POST(request: Request) {
  let body: {
    outputFolderId?: string;
    lineIndex?: number;
    folderName?: string;
    masterSku?: string;
    generated?: PreviewImagePayload[];
    isolatedPerSku?: IsolatedSkuPreview[];
    isolatedBundle?: PreviewImagePayload | null;
    referenceSourceFiles?: ReferenceSourceCopy[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const outputFolderId =
    body.outputFolderId?.trim() ||
    process.env.OUTPUT_FOLDER_ID?.trim() ||
    "";
  const lineIndex = body.lineIndex;
  const folderName = body.folderName?.trim() ?? "";
  const masterSku = body.masterSku?.trim() ?? "";
  const generated = body.generated;

  if (!outputFolderId) {
    return NextResponse.json(
      {
        error:
          "Set outputFolderId in the request body or OUTPUT_FOLDER_ID in the environment.",
      },
      { status: 400 },
    );
  }

  if (lineIndex === undefined || lineIndex < 0) {
    return NextResponse.json({ error: "Provide lineIndex." }, { status: 400 });
  }

  if (!folderName || !masterSku) {
    return NextResponse.json(
      { error: "Provide folderName and masterSku." },
      { status: 400 },
    );
  }

  if (!Array.isArray(generated) || generated.length === 0) {
    return NextResponse.json(
      { error: "Provide generated non-empty image array." },
      { status: 400 },
    );
  }

  const isValidImg = (g: PreviewImagePayload | null | undefined): boolean =>
    !!g &&
    typeof g.dataBase64 === "string" &&
    !!g.dataBase64 &&
    typeof g.mimeType === "string";

  for (const g of generated) {
    if (!isValidImg(g)) {
      return NextResponse.json(
        { error: "Each image needs mimeType and dataBase64." },
        { status: 400 },
      );
    }
  }

  const isolatedPerSku: IsolatedSkuPreview[] = [];
  if (body.isolatedPerSku) {
    if (!Array.isArray(body.isolatedPerSku)) {
      return NextResponse.json(
        { error: "isolatedPerSku must be an array." },
        { status: 400 },
      );
    }
    for (const iso of body.isolatedPerSku) {
      if (
        !iso ||
        typeof iso.sku !== "string" ||
        !iso.sku.trim() ||
        !isValidImg(iso.image)
      ) {
        return NextResponse.json(
          { error: "Each isolatedPerSku entry needs sku and image." },
          { status: 400 },
        );
      }
      isolatedPerSku.push({ sku: iso.sku.trim(), image: iso.image });
    }
  }

  let isolatedBundle: PreviewImagePayload | null = null;
  if (body.isolatedBundle) {
    if (!isValidImg(body.isolatedBundle)) {
      return NextResponse.json(
        { error: "isolatedBundle needs mimeType and dataBase64." },
        { status: 400 },
      );
    }
    isolatedBundle = body.isolatedBundle;
  }

  const referenceSourceFiles: ReferenceSourceCopy[] = [];
  if (body.referenceSourceFiles) {
    if (!Array.isArray(body.referenceSourceFiles)) {
      return NextResponse.json(
        { error: "referenceSourceFiles must be an array." },
        { status: 400 },
      );
    }
    for (const r of body.referenceSourceFiles) {
      if (
        !r ||
        typeof r.fileId !== "string" ||
        !r.fileId.trim() ||
        typeof r.name !== "string" ||
        typeof r.sku !== "string" ||
        !r.sku.trim()
      ) {
        return NextResponse.json(
          {
            error:
              "Each referenceSourceFiles entry needs fileId, name, and sku.",
          },
          { status: 400 },
        );
      }
      referenceSourceFiles.push({
        fileId: r.fileId.trim(),
        name: r.name,
        sku: r.sku.trim(),
      });
    }
  }

  let auth;
  try {
    auth = await getDriveAuth();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Drive auth failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const drive = await getDriveClient(auth);
  const result = await commitBundleToDrive(
    drive,
    lineIndex,
    outputFolderId,
    folderName,
    masterSku,
    generated as PreviewImagePayload[],
    isolatedPerSku,
    isolatedBundle,
    referenceSourceFiles,
  );

  if (!result.ok) {
    return NextResponse.json({ result }, { status: 422 });
  }

  return NextResponse.json({ ok: true, result });
}

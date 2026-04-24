import { NextResponse } from "next/server";
import { getDriveAuth } from "@/lib/driveAuth";
import { getDriveClient } from "@/lib/drive";
import {
  commitBundleToDrive,
  type IsolatedSkuPreview,
  type PreviewImagePayload,
  type ReferenceSourceCopy,
} from "@/lib/bundlePipeline";
import { bundleFilenameStem, skuOrderForFilenames } from "@/lib/bundleFolderName";
import { getPreviewSessionImage } from "@/lib/previewImageStore";

export const maxDuration = 120;

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const json = (body: unknown, status = 200) =>
    NextResponse.json(body, {
      status,
      headers: { "x-request-id": requestId },
    });

  let body: {
    outputFolderId?: string;
    lineIndex?: number;
    folderName?: string;
    masterSku?: string;
    /** All SKUs in the bundle (master first); used for output filenames when set. */
    allSkus?: string[];
    previewSessionId?: string;
    generated?: Array<{
      mimeType?: string;
      dataBase64?: string;
      fileId?: string;
      url?: string;
    }>;
    isolatedPerSku?: Array<{
      sku?: string;
      image?: {
        mimeType?: string;
        dataBase64?: string;
        fileId?: string;
        url?: string;
      };
    }>;
    isolatedBundle?: {
      mimeType?: string;
      dataBase64?: string;
      fileId?: string;
      url?: string;
    } | null;
    referenceSourceFiles?: ReferenceSourceCopy[];
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const outputFolderId =
    body.outputFolderId?.trim() ||
    process.env.OUTPUT_FOLDER_ID?.trim() ||
    "";
  const lineIndex = body.lineIndex;
  const folderName = body.folderName?.trim() ?? "";
  const masterSku = body.masterSku?.trim() ?? "";
  const allSkusFromBody = Array.isArray(body.allSkus)
    ? body.allSkus
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean)
    : [];
  const previewSessionId = body.previewSessionId?.trim() ?? "";
  const generatedRaw = body.generated;

  if (!outputFolderId) {
    return json(
      {
        error:
          "Set outputFolderId in the request body or OUTPUT_FOLDER_ID in the environment.",
      },
      400,
    );
  }

  if (lineIndex === undefined || lineIndex < 0) {
    return json({ error: "Provide lineIndex." }, 400);
  }

  if (
    !folderName ||
    (!masterSku.length && allSkusFromBody.length === 0)
  ) {
    return json(
      { error: "Provide folderName and masterSku (or allSkus)." },
      400,
    );
  }

  if (!Array.isArray(generatedRaw) || generatedRaw.length === 0) {
    return json(
      { error: "Provide generated non-empty image array." },
      400,
    );
  }

  const resolveImage = (
    g:
      | {
          mimeType?: string;
          dataBase64?: string;
          fileId?: string;
          url?: string;
        }
      | null
      | undefined,
  ): PreviewImagePayload | null => {
    if (!g) return null;
    if (typeof g.dataBase64 === "string" && g.dataBase64.trim().length > 0) {
      if (typeof g.mimeType !== "string" || !g.mimeType.trim()) return null;
      return { mimeType: g.mimeType, dataBase64: g.dataBase64 };
    }
    if (!previewSessionId || typeof g.fileId !== "string" || !g.fileId.trim()) {
      return null;
    }
    return getPreviewSessionImage(previewSessionId, g.fileId.trim());
  };

  const generated: PreviewImagePayload[] = [];
  for (const g of generatedRaw) {
    const resolved = resolveImage(g);
    if (!resolved) {
      return json(
        {
          error:
            "Each generated image must include dataBase64, or fileId with a valid previewSessionId.",
        },
        400,
      );
    }
    generated.push(resolved);
  }

  const isolatedPerSku: IsolatedSkuPreview[] = [];
  if (body.isolatedPerSku) {
    if (!Array.isArray(body.isolatedPerSku)) {
      return json(
        { error: "isolatedPerSku must be an array." },
        400,
      );
    }
    for (const iso of body.isolatedPerSku) {
      const sku = iso?.sku;
      const image = resolveImage(iso?.image);
      if (!iso || typeof sku !== "string" || !sku.trim() || !image) {
        return json(
          { error: "Each isolatedPerSku entry needs sku and image." },
          400,
        );
      }
      isolatedPerSku.push({ sku: sku.trim(), image });
    }
  }

  let isolatedBundle: PreviewImagePayload | null = null;
  if (body.isolatedBundle) {
    const image = resolveImage(body.isolatedBundle);
    if (!image) {
      return json(
        {
          error:
            "isolatedBundle needs dataBase64, or fileId with a valid previewSessionId.",
        },
        400,
      );
    }
    isolatedBundle = image;
  }

  const referenceSourceFiles: ReferenceSourceCopy[] = [];
  if (body.referenceSourceFiles) {
    if (!Array.isArray(body.referenceSourceFiles)) {
      return json(
        { error: "referenceSourceFiles must be an array." },
        400,
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
        return json(
          {
            error:
              "Each referenceSourceFiles entry needs fileId, name, and sku.",
          },
          400,
        );
      }
      referenceSourceFiles.push({
        fileId: r.fileId.trim(),
        name: r.name,
        sku: r.sku.trim(),
      });
    }
  }

  // #region agent log
  fetch("http://127.0.0.1:7707/ingest/72fe3a30-af19-4b80-9c22-4286b44eed04", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "b7e4fb",
    },
    body: JSON.stringify({
      sessionId: "b7e4fb",
      runId: "pre-fix",
      hypothesisId: "H3",
      location: "app/api/bundle/commit/route.ts:212",
      message: "commit request sku inputs",
      data: {
        lineIndex,
        masterSku,
        allSkusFromBody,
        allSkusBodyCount: allSkusFromBody.length,
        referenceSkus: [...new Set(referenceSourceFiles.map((r) => r.sku))],
        referenceSkuCount: [...new Set(referenceSourceFiles.map((r) => r.sku))].length,
        generatedRawCount: generatedRaw.length,
        generatedRawInlineCount: generatedRaw.filter((g) => !!g.dataBase64?.trim()).length,
        generatedRawFileIdCount: generatedRaw.filter((g) => !!g.fileId?.trim()).length,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  const skuStemForFiles = bundleFilenameStem(
    skuOrderForFilenames(masterSku, allSkusFromBody, referenceSourceFiles),
  );

  // #region agent log
  fetch("http://127.0.0.1:7707/ingest/72fe3a30-af19-4b80-9c22-4286b44eed04", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "b7e4fb",
    },
    body: JSON.stringify({
      sessionId: "b7e4fb",
      runId: "pre-fix",
      hypothesisId: "H3",
      location: "app/api/bundle/commit/route.ts:233",
      message: "computed sku stem for filenames",
      data: {
        lineIndex,
        skuStemForFiles,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  let auth;
  try {
    auth = await getDriveAuth();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Drive auth failed.";
    return json({ error: msg }, 500);
  }

  const drive = await getDriveClient(auth);
  const result = await commitBundleToDrive(
    drive,
    lineIndex,
    outputFolderId,
    folderName,
    skuStemForFiles,
    generated,
    isolatedPerSku,
    isolatedBundle,
    referenceSourceFiles,
  );

  if (!result.ok) {
    return json({ result }, 422);
  }

  return json({ ok: true, result });
}

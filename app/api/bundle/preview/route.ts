import { NextResponse } from "next/server";
import { getDriveAuth } from "@/lib/driveAuth";
import { getDriveClient, listChildFolders } from "@/lib/drive";
import {
  collectBundleRefsOnly,
  generateBundlePreview,
  type RefSelectionMap,
} from "@/lib/bundlePipeline";
import { parseBundleInput } from "@/lib/parseSkus";
import { createPreviewSession } from "@/lib/previewImageStore";

export const maxDuration = 300;

const PARENT_FOLDER_FALLBACK_ID =
  process.env.PARENT_FOLDER_FALLBACK_ID?.trim() ||
  "1JJ9RC7rDbbMN3jryfpquem0Xu9DEppMy";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const json = (body: unknown, status = 200) =>
    NextResponse.json(body, {
      status,
      headers: { "x-request-id": requestId },
    });

  let body: {
    text?: string;
    parentFolderId?: string;
    lineIndex?: number;
    seedOffset?: number;
    refSelection?: RefSelectionMap;
    /** When true, only list Drive reference thumbnails + notes — no Gemini. */
    refsOnly?: boolean;
    /** When true, refs-only ignores per-folder limit and downloads all refs. */
    refsOnlyForceAll?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
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
    return json(
      {
        error:
          "Set parentFolderId in the request body or PARENT_FOLDER_ID in the environment.",
      },
      400,
    );
  }

  if (lineIndex === undefined || lineIndex < 0) {
    return json(
      { error: "Provide a non-negative lineIndex for the bundle to preview." },
      400,
    );
  }

  const text = body.text ?? "";
  const { bundles, errors: parseErrors } = parseBundleInput(text);
  const bundle = bundles.find((b) => b.lineIndex === lineIndex);
  if (!bundle) {
    return json(
      {
        error: `No parsed bundle for lineIndex ${lineIndex}.`,
        parseErrors,
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
  const primaryChildFolders = await listChildFolders(drive, parentFolderId);
  const useFallbackParent =
    PARENT_FOLDER_FALLBACK_ID.length > 0 &&
    PARENT_FOLDER_FALLBACK_ID !== parentFolderId;
  const fallbackChildFolders = useFallbackParent
    ? await listChildFolders(drive, PARENT_FOLDER_FALLBACK_ID)
    : null;

  const refSelection = body.refSelection;
  const refSel =
    refSelection && typeof refSelection === "object" && !Array.isArray(refSelection)
      ? (refSelection as RefSelectionMap)
      : undefined;

  if (body.refsOnly === true) {
    const refsResult = await collectBundleRefsOnly(
      drive,
      bundle,
      primaryChildFolders,
      fallbackChildFolders,
      refSel,
      body.refsOnlyForceAll === true,
    );
    if (!refsResult.ok) {
      return json(
        {
          ok: false,
          lineIndex: refsResult.lineIndex,
          error: refsResult.error,
          parseErrors,
        },
        422,
      );
    }
    return json({
      ok: true,
      parseErrors,
      previewRefs: refsResult.previewRefs,
    });
  }

  const result = await generateBundlePreview(
    drive,
    bundle,
    primaryChildFolders,
    fallbackChildFolders,
    seedOffset,
    refSel,
  );

  if (!result.ok) {
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
        hypothesisId: "H1",
        location: "app/api/bundle/preview/route.ts:142",
        message: "generateBundlePreview returned not-ok",
        data: {
          lineIndex: result.lineIndex,
          error: result.error,
          parseErrorsCount: parseErrors.length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return json(
      { ok: false, lineIndex: result.lineIndex, error: result.error, parseErrors },
      422,
    );
  }

  const previewSession = createPreviewSession({
    generated: result.preview.generated,
    isolatedPerSku: result.preview.isolatedPerSku,
    isolatedBundle: result.preview.isolatedBundle,
  });

  /** Inline base64 so `<img>` does not rely on `/api/bundle/preview-image` alone (lost on restart / multi-instance). */
  const generatedWithInline = previewSession.generated.map((g, i) => ({
    ...g,
    dataBase64: result.preview.generated[i]?.dataBase64,
  }));

  const isolatedPerSkuWithInline = previewSession.isolatedPerSku.map((iso, i) => ({
    sku: iso.sku,
    image: {
      ...iso.image,
      dataBase64: result.preview.isolatedPerSku[i]?.image.dataBase64,
    },
  }));

  let isolatedBundleWithInline = previewSession.isolatedBundle;
  if (previewSession.isolatedBundle && result.preview.isolatedBundle) {
    isolatedBundleWithInline = {
      ...previewSession.isolatedBundle,
      dataBase64: result.preview.isolatedBundle.dataBase64,
    };
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
      hypothesisId: "H1",
      location: "app/api/bundle/preview/route.ts:177",
      message: "preview payload composition",
      data: {
        lineIndex,
        allSkus: result.preview.allSkus,
        generatedCount: generatedWithInline.length,
        generatedInlineCount: generatedWithInline.filter((g) => !!g.dataBase64?.length).length,
        generatedUrlCount: generatedWithInline.filter((g) => !!g.url?.length).length,
        isolatedCount: isolatedPerSkuWithInline.length,
        isolatedInlineCount: isolatedPerSkuWithInline.filter((i) => !!i.image.dataBase64?.length)
          .length,
        hasIsolatedBundle: !!isolatedBundleWithInline,
        hasIsolatedBundleInline: !!isolatedBundleWithInline?.dataBase64?.length,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  return json({
    ok: true,
    parseErrors,
    preview: {
      ...result.preview,
      previewSessionId: previewSession.previewSessionId,
      generated: generatedWithInline,
      isolatedPerSku: isolatedPerSkuWithInline,
      isolatedBundle: isolatedBundleWithInline,
    },
  });
}

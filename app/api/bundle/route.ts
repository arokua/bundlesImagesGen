import { NextResponse } from "next/server";
import { getDriveAuth } from "@/lib/driveAuth";
import { getDriveClient, listChildFolders } from "@/lib/drive";
import { processOneBundle, type BundleResult } from "@/lib/bundlePipeline";
import { parseBundleInput } from "@/lib/parseSkus";

export const maxDuration = 300;

/** Default Drive parent used when a SKU folder is missing under the request’s primary parent. */
const PARENT_FOLDER_FALLBACK_ID =
  process.env.PARENT_FOLDER_FALLBACK_ID?.trim() ||
  "1JJ9RC7rDbbMN3jryfpquem0Xu9DEppMy";

type NdjsonEvent =
  | {
      type: "meta";
      parseErrors: string[];
      bundlesParsed: number;
    }
  | {
      type: "progress";
      current: number;
      total: number;
      lineIndex: number;
    }
  | { type: "result"; result: BundleResult }
  | { type: "complete" }
  | { type: "error"; message: string };

export async function POST(request: Request) {
  let body: {
    text?: string;
    parentFolderId?: string;
    outputFolderId?: string;
    stream?: boolean;
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
  const outputFolderId =
    body.outputFolderId?.trim() ||
    process.env.OUTPUT_FOLDER_ID?.trim() ||
    "";

  if (!parentFolderId || !outputFolderId) {
    return NextResponse.json(
      {
        error:
          "Set parentFolderId and outputFolderId in the request body or PARENT_FOLDER_ID and OUTPUT_FOLDER_ID in the environment.",
      },
      { status: 400 },
    );
  }

  const text = body.text ?? "";
  const { bundles, errors: parseErrors } = parseBundleInput(text);
  if (parseErrors.length > 0 && bundles.length === 0) {
    return NextResponse.json({ errors: parseErrors, results: [] }, { status: 400 });
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

  const wantStream = body.stream === true;

  if (wantStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (ev: NdjsonEvent) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
        };

        try {
          send({
            type: "meta",
            parseErrors,
            bundlesParsed: bundles.length,
          });

          for (let i = 0; i < bundles.length; i++) {
            const bundle = bundles[i];
            send({
              type: "progress",
              current: i + 1,
              total: bundles.length,
              lineIndex: bundle.lineIndex,
            });
            const result = await processOneBundle(
              drive,
              bundle,
              primaryChildFolders,
              fallbackChildFolders,
              outputFolderId,
            );
            send({ type: "result", result });
          }

          send({ type: "complete" });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          send({ type: "error", message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const results: BundleResult[] = [];
  for (const bundle of bundles) {
    results.push(
      await processOneBundle(
        drive,
        bundle,
        primaryChildFolders,
        fallbackChildFolders,
        outputFolderId,
      ),
    );
  }

  return NextResponse.json({
    parseErrors,
    results,
    bundlesParsed: bundles.length,
  });
}

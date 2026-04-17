"use client";

import { useMemo, useState } from "react";
import { parseBundleInput } from "@/lib/parseSkus";

type BundleRow =
  | {
      lineIndex: number;
      ok: true;
      folderName: string;
      outputFolderId: string;
      fileIds: string[];
    }
  | { lineIndex: number; ok: false; error: string };

type ImagePayload = { mimeType: string; dataBase64: string };

type PreviewPayload = {
  lineIndex: number;
  folderName: string;
  masterSku: string;
  allSkus: string[];
  skuNotes: { sku: string; note: string }[];
  referenceFolders: {
    sku: string;
    folderId: string;
    folderName: string;
    images: ImagePayload[];
  }[];
  generated: ImagePayload[];
  isolatedPerSku: { sku: string; image: ImagePayload }[];
  isolatedBundle: ImagePayload | null;
  isolationWarnings: string[];
};

type ReviewAction = "upload" | "retry" | "skip";

type ReviewModalState = {
  bundleLabel: string;
  bundleIndex: number;
  bundleTotal: number;
  seedOffset: number;
  preview: PreviewPayload;
  onChoose: (action: ReviewAction) => void;
};

type ApiResult = {
  parseErrors?: string[];
  results?: BundleRow[];
  error?: string;
  bundlesParsed?: number;
};

type StreamProgress = { current: number; total: number };

export default function Home() {
  const [text, setText] = useState("");
  const [parentFolderId, setParentFolderId] = useState("");
  const [outputFolderId, setOutputFolderId] = useState("");
  const [loading, setLoading] = useState(false);
  const [apiResult, setApiResult] = useState<ApiResult | null>(null);
  const [streamProgress, setStreamProgress] = useState<StreamProgress | null>(
    null,
  );
  const [streamingResults, setStreamingResults] = useState<BundleRow[]>([]);

  const [dedupeLoading, setDedupeLoading] = useState(false);
  const [dedupeInfo, setDedupeInfo] = useState<{
    trashedFolderIds: string[];
  } | null>(null);
  const [dedupeError, setDedupeError] = useState<string | null>(null);

  const [reviewModal, setReviewModal] = useState<ReviewModalState | null>(null);

  const preview = useMemo(() => parseBundleInput(text), [text]);

  function loadFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const s = typeof reader.result === "string" ? reader.result : "";
      setText(s);
    };
    reader.readAsText(f);
  }

  /** Stream full pipeline without human review (uploads immediately). */
  async function runFullAuto() {
    setLoading(true);
    setApiResult(null);
    setStreamProgress(null);
    setStreamingResults([]);
    setDedupeError(null);
    setReviewModal(null);
    try {
      const res = await fetch("/api/bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          parentFolderId: parentFolderId || undefined,
          outputFolderId: outputFolderId || undefined,
          stream: true,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setApiResult({ error: data.error ?? `HTTP ${res.status}` });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setApiResult({ error: "No response body." });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      const results: BundleRow[] = [];
      let parseErrors: string[] | undefined;
      let bundlesParsed = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line) as {
            type: string;
            parseErrors?: string[];
            bundlesParsed?: number;
            current?: number;
            total?: number;
            result?: BundleRow;
            message?: string;
          };

          if (evt.type === "meta") {
            parseErrors = evt.parseErrors;
            bundlesParsed = evt.bundlesParsed ?? 0;
          } else if (evt.type === "progress") {
            if (
              evt.current !== undefined &&
              evt.total !== undefined
            ) {
              setStreamProgress({ current: evt.current, total: evt.total });
            }
          } else if (evt.type === "result" && evt.result) {
            results.push(evt.result);
            setStreamingResults([...results]);
          } else if (evt.type === "error") {
            setApiResult({ error: evt.message ?? "Stream error." });
            setStreamProgress(null);
            return;
          } else if (evt.type === "complete") {
            setStreamProgress(null);
          }
        }
      }

      if (buffer.trim()) {
        try {
          const evt = JSON.parse(buffer) as { type: string; message?: string };
          if (evt.type === "error") {
            setApiResult({ error: evt.message ?? "Stream error." });
            return;
          }
        } catch {
          /* ignore incomplete */
        }
      }

      setApiResult({
        parseErrors,
        results,
        bundlesParsed,
      });
    } catch (e) {
      setApiResult({
        error: e instanceof Error ? e.message : "Request failed.",
      });
    } finally {
      setLoading(false);
      setStreamProgress(null);
    }
  }

  /** Preview each bundle; user approves before Drive upload. */
  async function runWithReview() {
    const bundles = preview.bundles;
    if (bundles.length === 0) return;

    setLoading(true);
    setApiResult(null);
    setStreamProgress(null);
    setStreamingResults([]);
    setDedupeError(null);
    setReviewModal(null);

    const results: BundleRow[] = [];
    let parseErrorsAcc: string[] | undefined;

    try {
      for (let bi = 0; bi < bundles.length; bi++) {
        const bundle = bundles[bi];
        const label =
          bundle.name?.trim() ||
          `${bundle.master} + ${bundle.components.join(" ")}`;
        let seedOffset = 0;

        setStreamProgress({ current: bi + 1, total: bundles.length });

        let finishedBundle = false;
        while (!finishedBundle) {
          const res = await fetch("/api/bundle/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text,
              parentFolderId: parentFolderId || undefined,
              lineIndex: bundle.lineIndex,
              seedOffset,
            }),
          });

          const data = (await res.json()) as {
            ok?: boolean;
            error?: string;
            parseErrors?: string[];
            preview?: PreviewPayload;
            lineIndex?: number;
          };

          if (parseErrorsAcc === undefined && data.parseErrors?.length) {
            parseErrorsAcc = data.parseErrors;
          }

          if (!res.ok || data.ok === false || !data.preview) {
            results.push({
              lineIndex: data.lineIndex ?? bundle.lineIndex,
              ok: false,
              error: data.error ?? "Preview failed.",
            });
            setStreamingResults([...results]);
            finishedBundle = true;
            continue;
          }

          const action = await new Promise<"upload" | "retry" | "skip">(
            (resolve) => {
              setReviewModal({
                bundleLabel: label,
                bundleIndex: bi,
                bundleTotal: bundles.length,
                seedOffset,
                preview: data.preview!,
                onChoose: resolve,
              });
            },
          );

          setReviewModal(null);

          if (action === "retry") {
            seedOffset += 1;
            continue;
          }

          if (action === "skip") {
            results.push({
              lineIndex: bundle.lineIndex,
              ok: false,
              error: "Skipped after preview.",
            });
            setStreamingResults([...results]);
            finishedBundle = true;
            continue;
          }

          const commitRes = await fetch("/api/bundle/commit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              outputFolderId: outputFolderId || undefined,
              lineIndex: bundle.lineIndex,
              folderName: data.preview.folderName,
              masterSku: data.preview.masterSku,
              generated: data.preview.generated,
              isolatedPerSku: data.preview.isolatedPerSku,
              isolatedBundle: data.preview.isolatedBundle,
            }),
          });

          const commitJson = (await commitRes.json()) as {
            ok?: boolean;
            error?: string;
            result?: BundleRow;
          };

          const cr = commitJson.result;
          if (cr?.ok) {
            results.push(cr);
          } else {
            const err =
              cr && !cr.ok
                ? cr.error
                : commitJson.error ?? "Commit failed.";
            results.push({
              lineIndex: bundle.lineIndex,
              ok: false,
              error: err,
            });
          }
          setStreamingResults([...results]);
          finishedBundle = true;
        }
      }

      setApiResult({
        parseErrors: parseErrorsAcc,
        results,
        bundlesParsed: bundles.length,
      });
    } catch (e) {
      setApiResult({
        error: e instanceof Error ? e.message : "Request failed.",
      });
    } finally {
      setLoading(false);
      setStreamProgress(null);
      setReviewModal(null);
    }
  }

  async function runDedupe() {
    setDedupeLoading(true);
    setDedupeInfo(null);
    setDedupeError(null);
    try {
      const res = await fetch("/api/bundle/dedupe-output", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outputFolderId: outputFolderId || undefined,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        trashedFolderIds?: string[];
      };
      if (!res.ok) {
        setDedupeError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (data.trashedFolderIds) {
        setDedupeInfo({ trashedFolderIds: data.trashedFolderIds });
      }
    } catch (e) {
      setDedupeError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setDedupeLoading(false);
    }
  }

  const displayResults = apiResult?.results ?? streamingResults;

  return (
    <div className="min-h-full bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Bundle Gen</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            <strong>CSV:</strong> header row with <code className="text-xs">name</code>{" "}
            and <code className="text-xs">SKU</code> (optional{" "}
            <code className="text-xs">description</code>).{" "}
            <strong>Text:</strong> one bundle per line —{" "}
            <code className="text-xs">Name | MASTER COMP1</code> or{" "}
            <code className="text-xs">Name: MASTER COMP1</code>, or SKU-only lines.
            Drive: each SKU folder name must start with that SKU as the first word
            (e.g. <code className="text-xs">123 product photos</code> for SKU{" "}
            <code className="text-xs">123</code>); bundle name / description never
            count as SKUs.
          </p>
        </header>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm font-medium" htmlFor="skus">
              Bundle input (text or CSV)
            </label>
            <label className="text-sm text-zinc-600 dark:text-zinc-400">
              <span className="mr-2">Load file</span>
              <input
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="text-xs file:mr-2 file:rounded file:border-0 file:bg-zinc-200 file:px-2 file:py-1 dark:file:bg-zinc-700"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <textarea
            id="skus"
            className="min-h-48 w-full rounded-lg border border-zinc-200 bg-white p-3 font-mono text-sm shadow-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-zinc-600"
            placeholder={`CSV example:\nname,SKU,description\nWinter set,ABC-1 DEF-2,"Cozy layering"\n\nText example:\nSummer Kit | SHIRT-9 HAT-3`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {preview.format === "csv" && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">
              Detected CSV (name + SKU columns). Names and descriptions are sent to Gemini.
            </p>
          )}
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="parent">
              Parent folder ID
            </label>
            <input
              id="parent"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder="or set PARENT_FOLDER_ID in .env"
              value={parentFolderId}
              onChange={(e) => setParentFolderId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="out">
              Output folder ID
            </label>
            <input
              id="out"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder="or set OUTPUT_FOLDER_ID in .env"
              value={outputFolderId}
              onChange={(e) => setOutputFolderId(e.target.value)}
            />
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Parse preview
          </h2>
          {preview.errors.length > 0 && (
            <ul className="mb-2 list-inside list-disc text-sm text-amber-700 dark:text-amber-400">
              {preview.errors.map((e, i) => (
                <li key={`${i}-${e}`}>{e}</li>
              ))}
            </ul>
          )}
          {preview.bundles.length === 0 ? (
            <p className="text-sm text-zinc-500">Add at least one valid line.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {preview.bundles.map((b) => (
                <li key={b.lineIndex} className="rounded border border-zinc-100 p-2 dark:border-zinc-800">
                  {b.name && (
                    <div className="mb-1 font-medium text-zinc-800 dark:text-zinc-200">
                      {b.name}
                    </div>
                  )}
                  {b.description && (
                    <div className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">
                      {b.description}
                    </div>
                  )}
                  <span className="font-mono text-emerald-700 dark:text-emerald-400">
                    {b.master}
                  </span>
                  <span className="text-zinc-500"> + </span>
                  {b.components.map((c) => (
                    <span key={c} className="font-mono text-zinc-700 dark:text-zinc-300">
                      {c}{" "}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runWithReview()}
            disabled={loading || preview.bundles.length === 0}
            className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {loading ? "Running…" : "Generate bundles (preview)"}
          </button>
          <button
            type="button"
            onClick={() => void runFullAuto()}
            disabled={loading || preview.bundles.length === 0}
            className="rounded-full border border-zinc-400 bg-transparent px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-200/60 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            {loading ? "…" : "Generate all (no preview)"}
          </button>
          <button
            type="button"
            onClick={() => void runDedupe()}
            disabled={dedupeLoading}
            className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            {dedupeLoading ? "Cleaning…" : "Clean duplicate output folders"}
          </button>
          <a
            className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400"
            href="/api/auth/google"
          >
            Authorize Google Drive (OAuth)
          </a>
        </div>

        {streamProgress && streamProgress.total > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-zinc-600 dark:text-zinc-400">
              <span>Bundle progress</span>
              <span>
                {streamProgress.current} / {streamProgress.total}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className="h-full rounded-full bg-emerald-600 transition-[width] duration-300 dark:bg-emerald-500"
                style={{
                  width: `${(streamProgress.current / streamProgress.total) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {dedupeError && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {dedupeError}
          </p>
        )}

        {dedupeInfo && (
          <p className="rounded-lg border border-zinc-200 bg-white p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            Duplicate cleanup: moved{" "}
            <strong>{dedupeInfo.trashedFolderIds.length}</strong> folder
            {dedupeInfo.trashedFolderIds.length === 1 ? "" : "s"} to Drive trash.
          </p>
        )}

        {apiResult?.error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {apiResult.error}
          </p>
        )}

        {apiResult?.parseErrors && apiResult.parseErrors.length > 0 && (
          <ul className="list-inside list-disc text-sm text-amber-800 dark:text-amber-300">
            {apiResult.parseErrors.map((e, i) => (
              <li key={`${i}-${e}`}>{e}</li>
            ))}
          </ul>
        )}

        {displayResults.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium">
              Results
              {loading && (
                <span className="ml-2 font-normal text-zinc-500">(updating…)</span>
              )}
            </h2>
            <ul className="space-y-2 text-sm">
              {displayResults.map((r) => (
                <li
                  key={r.lineIndex}
                  className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {r.ok ? (
                    <p>
                      <span className="font-medium">{r.folderName}</span> — folder{" "}
                      <code className="text-xs">{r.outputFolderId}</code>
                    </p>
                  ) : (
                    <p className="text-red-700 dark:text-red-400">
                      Line {r.lineIndex + 1}: {r.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      {reviewModal && <ReviewModal state={reviewModal} />}
    </div>
  );
}

function uniqueOrdered(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

type RefFolderForSku = {
  sku: string;
  folderId: string;
  folderName: string;
  images: ImagePayload[];
};

function SkuReferenceCard({
  sku,
  initialNote,
  folders,
}: {
  sku: string;
  initialNote: string;
  folders: RefFolderForSku[];
}) {
  const [note, setNote] = useState(initialNote);
  const [baseline, setBaseline] = useState(initialNote);
  const [status, setStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const dirty = note.trim() !== baseline.trim();

  async function save() {
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/bundle/sku-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, note }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        note?: string;
      };
      if (!res.ok || !data.ok) {
        setStatus("error");
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const saved = (data.note ?? note).trim();
      setNote(saved);
      setBaseline(saved);
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Save failed.");
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-950/50">
      <p className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
        SKU <span className="font-semibold">{sku}</span>
      </p>

      <div className="mt-2 space-y-1 rounded border border-dashed border-zinc-300 bg-white p-2 dark:border-zinc-600 dark:bg-zinc-900/60">
        <label
          className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300"
          htmlFor={`sku-note-${sku}`}
        >
          Gemini note for SKU {sku} (stays attached to this SKU across all
          bundles)
        </label>
        <textarea
          id={`sku-note-${sku}`}
          className="min-h-14 w-full resize-y rounded border border-zinc-300 bg-white p-2 font-mono text-[11px] dark:border-zinc-600 dark:bg-zinc-900"
          placeholder={`e.g. "Main product is the wooden coin box with sliding lid. Rings in photos are accessories, not the main item."`}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            if (status !== "idle") setStatus("idle");
          }}
          maxLength={1200}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            onClick={() => void save()}
            disabled={status === "saving" || !dirty}
          >
            {status === "saving"
              ? "Saving…"
              : dirty
                ? "Save note"
                : "Saved"}
          </button>
          {status === "saved" && !dirty && (
            <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
              Applied on next generation.
            </span>
          )}
          {status === "error" && error && (
            <span className="text-[11px] text-red-700 dark:text-red-400">
              {error}
            </span>
          )}
          {baseline.trim().length === 0 && status === "idle" && (
            <span className="text-[11px] text-zinc-500">
              No note yet — the model will only follow the reference images.
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {folders.length === 0 ? (
          <p className="text-[11px] text-zinc-500">
            No matching Drive folder found for this SKU.
          </p>
        ) : (
          folders.map((rf) => (
            <div
              key={`${rf.folderId}-${rf.sku}`}
              className="rounded border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900/60"
            >
              <p className="break-words text-[11px] text-zinc-700 dark:text-zinc-300">
                Folder: {rf.folderName}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-zinc-400">
                {rf.folderId}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {rf.images.map((img, ii) => (
                  <img
                    key={`${rf.folderId}-${ii}`}
                    src={`data:${img.mimeType};base64,${img.dataBase64}`}
                    alt={`${rf.folderName} ref ${ii + 1}`}
                    className="h-28 w-28 rounded border border-zinc-200 object-cover dark:border-zinc-600"
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ReviewModal({ state }: { state: ReviewModalState }) {
  const [lesson, setLesson] = useState("");
  const [lessonStatus, setLessonStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [lessonError, setLessonError] = useState<string | null>(null);

  async function saveLessonIfAny(): Promise<boolean> {
    const trimmed = lesson.trim();
    if (!trimmed) return true;
    setLessonStatus("saving");
    setLessonError(null);
    try {
      const res = await fetch("/api/bundle/lesson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lesson: trimmed }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setLessonStatus("error");
        setLessonError(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      setLessonStatus("saved");
      setLesson("");
      return true;
    } catch (e) {
      setLessonStatus("error");
      setLessonError(e instanceof Error ? e.message : "Save failed.");
      return false;
    }
  }

  async function handleChoice(action: ReviewAction) {
    if (lesson.trim()) {
      const ok = await saveLessonIfAny();
      if (!ok) return;
    }
    state.onChoose(action);
  }

  const { preview } = state;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-title"
    >
      <div className="my-8 max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <h2
          id="review-title"
          className="text-lg font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Review bundle {state.bundleIndex + 1} / {state.bundleTotal}
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {state.bundleLabel}
          {state.seedOffset > 0
            ? ` · Regenerate attempt ${state.seedOffset + 1}`
            : ""}
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          Output folder will be{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {preview.folderName}
          </span>
        </p>

        {preview.isolationWarnings.length > 0 && (
          <ul className="mt-3 list-inside list-disc rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            {preview.isolationWarnings.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        )}

        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            References &amp; per-SKU notes
          </h3>
          <p className="text-xs text-zinc-500">
            Each SKU shows the Drive folder(s) used plus an editable note sent
            to Gemini. Use notes for things like{" "}
            <em>
              &ldquo;main product is the wooden box; the rings in some photos
              are accessories&rdquo;
            </em>
            . Saved to <code className="text-[11px]">SKU_NOTES.md</code> and
            applied on the next generation.
          </p>
          <div className="space-y-4">
            {uniqueOrdered(preview.allSkus).map((sku) => {
              const folders = preview.referenceFolders.filter(
                (rf) => rf.sku === sku,
              );
              const initialNote =
                preview.skuNotes.find((n) => n.sku === sku)?.note ?? "";
              return (
                <SkuReferenceCard
                  key={sku}
                  sku={sku}
                  initialNote={initialNote}
                  folders={folders}
                />
              );
            })}
          </div>
        </div>

        <div className="mt-6 space-y-2">
          <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Generated bundle (lifestyle)
          </h3>
          <div className="flex flex-wrap gap-3">
            {preview.generated.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mimeType};base64,${img.dataBase64}`}
                alt={`Generated ${i + 1}`}
                className="max-h-80 max-w-full rounded-lg border border-zinc-200 object-contain dark:border-zinc-600"
              />
            ))}
          </div>
        </div>

        {preview.isolatedPerSku.length > 0 && (
          <div className="mt-6 space-y-2">
            <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Blank-background per SKU
            </h3>
            <p className="text-xs text-zinc-500">
              One clean cutout per product. Uploaded as{" "}
              <code className="text-[11px]">{"{sku}_iso"}</code>.
            </p>
            <div className="flex flex-wrap gap-3">
              {preview.isolatedPerSku.map((iso) => (
                <figure
                  key={iso.sku}
                  className="flex flex-col items-center gap-1"
                >
                  <img
                    src={`data:${iso.image.mimeType};base64,${iso.image.dataBase64}`}
                    alt={`Isolated ${iso.sku}`}
                    className="h-44 w-44 rounded-lg border border-zinc-200 object-contain bg-white dark:border-zinc-600"
                  />
                  <figcaption className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                    {iso.sku}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}

        {preview.isolatedBundle && (
          <div className="mt-6 space-y-2">
            <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Blank-background bundle lineup
            </h3>
            <p className="text-xs text-zinc-500">
              All products on a clean white background. Uploaded as{" "}
              <code className="text-[11px]">{`${preview.masterSku}_bundle_iso`}</code>
              .
            </p>
            <img
              src={`data:${preview.isolatedBundle.mimeType};base64,${preview.isolatedBundle.dataBase64}`}
              alt="Isolated bundle"
              className="max-h-80 max-w-full rounded-lg border border-zinc-200 object-contain bg-white dark:border-zinc-600"
            />
          </div>
        )}

        <div className="mt-6 space-y-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950/40">
          <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Teach the AI (optional)
          </h3>
          <p className="text-xs text-zinc-500">
            If something is wrong (e.g. wrong sizes, invented props), add a
            short rule. It is appended to{" "}
            <code className="text-[11px]">LESSONS.md</code> and injected into
            every future prompt so the model stops repeating it.
          </p>
          <textarea
            className="min-h-16 w-full resize-y rounded border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-600 dark:bg-zinc-900"
            placeholder='e.g. "Marble run is ~40cm tall; never make it smaller than the blocks."'
            value={lesson}
            onChange={(e) => setLesson(e.target.value)}
            maxLength={800}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              disabled={lessonStatus === "saving" || !lesson.trim()}
              onClick={() => void saveLessonIfAny()}
            >
              {lessonStatus === "saving" ? "Saving…" : "Save lesson"}
            </button>
            {lessonStatus === "saved" && (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">
                Saved to LESSONS.md.
              </span>
            )}
            {lessonStatus === "error" && lessonError && (
              <span className="text-xs text-red-700 dark:text-red-400">
                {lessonError}
              </span>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
          <button
            type="button"
            className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            onClick={() => void handleChoice("upload")}
          >
            Yes — upload to Drive
          </button>
          <button
            type="button"
            className="rounded-full border border-amber-500 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"
            onClick={() => void handleChoice("retry")}
          >
            Try again
          </button>
          <button
            type="button"
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={() => void handleChoice("skip")}
          >
            Skip this bundle
          </button>
        </div>
      </div>
    </div>
  );
}

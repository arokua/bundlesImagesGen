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

  const preview = useMemo(() => parseBundleInput(text), [text]);

  function loadFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const s = typeof reader.result === "string" ? reader.result : "";
      setText(s);
    };
    reader.readAsText(f);
  }

  async function run() {
    setLoading(true);
    setApiResult(null);
    setStreamProgress(null);
    setStreamingResults([]);
    setDedupeError(null);
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
            onClick={() => void run()}
            disabled={loading || preview.bundles.length === 0}
            className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {loading ? "Running…" : "Generate bundles"}
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
    </div>
  );
}

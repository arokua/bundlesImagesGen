"use client";

import { useEffect, useMemo, useState } from "react";
import { parseBundleInput } from "@/lib/parseSkus";
import { driveFolderUrl } from "@/lib/driveLinks";

const LS_LIFESTYLE_MULTI = "bundle-lifestyle-prefix-multi";
const LS_LIFESTYLE_SINGLE = "bundle-lifestyle-prefix-single";

function pickStoredLifestyle(
  server: string | null | undefined,
  lsKey: string,
  fallback: string,
): string {
  if (server && server.trim()) return server;
  try {
    const ls = localStorage.getItem(lsKey);
    if (ls && ls.trim()) return ls;
  } catch {
    /* ignore */
  }
  return fallback;
}

type BundleRow =
  | {
      lineIndex: number;
      ok: true;
      folderName: string;
      outputFolderId: string;
      folderUrl: string;
      fileIds: string[];
      fileUrls: string[];
    }
  | { lineIndex: number; ok: false; error: string };

type ImagePayload = { mimeType: string; dataBase64: string };

type RefsOnlyPayload = {
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
  referenceSourceFiles: { fileId: string; name: string; sku: string }[];
};

type RefGateItem = {
  lineIndex: number;
  bundleLabel: string;
  bundleIndex: number;
  bundleTotal: number;
  refs: RefsOnlyPayload;
};

type RefGateOpenState = {
  items: RefGateItem[];
  parseErrors?: string[];
  next: "popup" | "queue";
};

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
  /** Drive ids for chosen reference files — copied into the bundle folder on commit. */
  referenceSourceFiles: { fileId: string; name: string; sku: string }[];
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
  onChoose: (
    action: ReviewAction,
    options?: { refSelection?: Record<string, number> },
  ) => void;
  uploadLabel?: string;
  skipLabel?: string;
};

type ReviewQueueStatus =
  | "queued"
  | "generating"
  | "ready"
  | "approved"
  | "skipped"
  | "committing"
  | "committed"
  | "failed";

type ReviewQueueItem = {
  lineIndex: number;
  bundleLabel: string;
  bundleIndex: number;
  bundleTotal: number;
  seedOffset: number;
  status: ReviewQueueStatus;
  preview?: PreviewPayload;
  /** Last ref image picks per Drive folder (folderId → image index). */
  refSelection?: Record<string, number>;
  error?: string;
  commitResult?: BundleRow;
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
  const [driveFolderHints, setDriveFolderHints] = useState<{
    parent: { id: string; name: string | null; url: string } | null;
    output: { id: string; name: string | null; url: string } | null;
  } | null>(null);
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
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);

  const [globalPromptRules, setGlobalPromptRules] = useState("");
  const [globalPromptStatus, setGlobalPromptStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [globalPromptError, setGlobalPromptError] = useState<string | null>(
    null,
  );
  const [promptRulesLoadError, setPromptRulesLoadError] = useState<
    string | null
  >(null);
  const [defaultLifestylePromptMulti, setDefaultLifestylePromptMulti] =
    useState("");
  const [defaultLifestylePromptSingle, setDefaultLifestylePromptSingle] =
    useState("");
  /** Editable lifestyle prefix (saved + localStorage); used for bundle lifestyle shots. */
  const [lifestylePrefixMulti, setLifestylePrefixMulti] = useState("");
  const [lifestylePrefixSingle, setLifestylePrefixSingle] = useState("");
  const [defaultPromptVariant, setDefaultPromptVariant] = useState<
    "multi" | "single"
  >("multi");
  const [refGateOpen, setRefGateOpen] = useState<RefGateOpenState | null>(null);

  const preview = useMemo(() => parseBundleInput(text), [text]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/bundle/drive-folders-config");
        const data = (await res.json()) as {
          defaults?: {
            parentFolderId?: string | null;
            outputFolderId?: string | null;
          };
          resolved?: {
            parent?: {
              id: string;
              name: string | null;
              url: string;
            } | null;
            output?: {
              id: string;
              name: string | null;
              url: string;
            } | null;
          };
        };
        setDriveFolderHints({
          parent: data.resolved?.parent ?? null,
          output: data.resolved?.output ?? null,
        });
        const dp = data.defaults?.parentFolderId?.trim();
        const dout = data.defaults?.outputFolderId?.trim();
        setParentFolderId((prev) => prev.trim() || dp || "");
        setOutputFolderId((prev) => prev.trim() || dout || "");
      } catch {
        /* ignore */
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setPromptRulesLoadError(null);
        const res = await fetch("/api/bundle/prompt-rules");
        const data = (await res.json()) as {
          ok?: boolean;
          rules?: string;
          defaultLifestylePromptMulti?: string;
          defaultLifestylePromptSingle?: string;
          lifestylePrefixMulti?: string | null;
          lifestylePrefixSingle?: string | null;
        };
        if (typeof data.rules === "string") {
          setGlobalPromptRules(data.rules);
        }
        const dm =
          typeof data.defaultLifestylePromptMulti === "string"
            ? data.defaultLifestylePromptMulti
            : "";
        const ds =
          typeof data.defaultLifestylePromptSingle === "string"
            ? data.defaultLifestylePromptSingle
            : "";
        setDefaultLifestylePromptMulti(dm);
        setDefaultLifestylePromptSingle(ds);
        setLifestylePrefixMulti(
          pickStoredLifestyle(data.lifestylePrefixMulti, LS_LIFESTYLE_MULTI, dm),
        );
        setLifestylePrefixSingle(
          pickStoredLifestyle(data.lifestylePrefixSingle, LS_LIFESTYLE_SINGLE, ds),
        );
      } catch (e) {
        setPromptRulesLoadError(
          e instanceof Error ? e.message : "Failed to load prompt rules.",
        );
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_LIFESTYLE_MULTI, lifestylePrefixMulti);
    } catch {
      /* ignore */
    }
  }, [lifestylePrefixMulti]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_LIFESTYLE_SINGLE, lifestylePrefixSingle);
    } catch {
      /* ignore */
    }
  }, [lifestylePrefixSingle]);

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
    setReviewQueue([]);
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

  /** Load Drive reference thumbnails only; user picks photos before any AI run. */
  async function beginRefGateThen(next: "popup" | "queue") {
    const bundles = preview.bundles;
    if (bundles.length === 0) return;
    if (!parentFolderId.trim()) {
      setApiResult({
        error: "Set Parent folder ID so reference images can be loaded from Drive.",
      });
      return;
    }

    setLoading(true);
    setApiResult(null);
    setStreamProgress(null);
    setDedupeError(null);
    setReviewModal(null);
    setReviewQueue([]);

    const items: RefGateItem[] = [];
    let parseErrorsAcc: string[] | undefined;

    try {
      for (let bi = 0; bi < bundles.length; bi++) {
        const bundle = bundles[bi];
        setStreamProgress({ current: bi + 1, total: bundles.length });
        const res = await fetch("/api/bundle/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            parentFolderId: parentFolderId || undefined,
            lineIndex: bundle.lineIndex,
            seedOffset: 0,
            refsOnly: true,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          parseErrors?: string[];
          previewRefs?: RefsOnlyPayload;
          lineIndex?: number;
        };
        if (parseErrorsAcc === undefined && data.parseErrors?.length) {
          parseErrorsAcc = data.parseErrors;
        }
        if (!res.ok || data.ok === false || !data.previewRefs) {
          setApiResult({
            error: data.error ?? "Failed to load reference images from Drive.",
          });
          return;
        }
        const label =
          bundle.name?.trim() ||
          `${bundle.master} + ${bundle.components.join(" ")}`;
        items.push({
          lineIndex: bundle.lineIndex,
          bundleLabel: label,
          bundleIndex: bi,
          bundleTotal: bundles.length,
          refs: data.previewRefs,
        });
      }
      setRefGateOpen({ items, parseErrors: parseErrorsAcc, next });
    } catch (e) {
      setApiResult({
        error: e instanceof Error ? e.message : "Failed to load references.",
      });
    } finally {
      setLoading(false);
      setStreamProgress(null);
    }
  }

  /** Preview each bundle; user approves before Drive upload. */
  async function runWithReview(
    lockedRefSelections: Record<number, Record<string, number>>,
  ) {
    const bundles = preview.bundles;
    if (bundles.length === 0) return;

    setLoading(true);
    setApiResult(null);
    setStreamProgress(null);
    setStreamingResults([]);
    setDedupeError(null);
    setReviewModal(null);
    setReviewQueue([]);

    const results: BundleRow[] = [];
    let parseErrorsAcc: string[] | undefined;

    try {
      for (let bi = 0; bi < bundles.length; bi++) {
        const bundle = bundles[bi];
        const label =
          bundle.name?.trim() ||
          `${bundle.master} + ${bundle.components.join(" ")}`;
        let seedOffset = 0;
        let refSelectionForRequest: Record<string, number> | undefined =
          lockedRefSelections[bundle.lineIndex];

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
              refSelection: refSelectionForRequest,
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

          const { action, refSelection } = await new Promise<{
            action: ReviewAction;
            refSelection?: Record<string, number>;
          }>((resolve) => {
            setReviewModal({
              bundleLabel: label,
              bundleIndex: bi,
              bundleTotal: bundles.length,
              seedOffset,
              preview: data.preview!,
              onChoose: (a, opts) =>
                resolve({ action: a, refSelection: opts?.refSelection }),
            });
          });

          setReviewModal(null);

          if (action === "retry") {
            refSelectionForRequest = refSelection;
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
              referenceSourceFiles: data.preview.referenceSourceFiles,
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

  function updateQueueItem(
    lineIndex: number,
    updater: (item: ReviewQueueItem) => ReviewQueueItem,
  ) {
    setReviewQueue((prev) =>
      prev.map((item) => (item.lineIndex === lineIndex ? updater(item) : item)),
    );
  }

  async function fetchBundlePreview(
    lineIndex: number,
    seedOffset: number,
    refSelection?: Record<string, number>,
  ): Promise<
    | { ok: true; preview: PreviewPayload; parseErrors?: string[] }
    | { ok: false; lineIndex: number; error: string; parseErrors?: string[] }
  > {
    try {
      const res = await fetch("/api/bundle/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          parentFolderId: parentFolderId || undefined,
          lineIndex,
          seedOffset,
          refSelection,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        parseErrors?: string[];
        preview?: PreviewPayload;
        lineIndex?: number;
      };
      if (!res.ok || data.ok === false || !data.preview) {
        return {
          ok: false,
          lineIndex: data.lineIndex ?? lineIndex,
          error: data.error ?? "Preview failed.",
          parseErrors: data.parseErrors,
        };
      }
      return {
        ok: true,
        preview: data.preview,
        parseErrors: data.parseErrors,
      };
    } catch (e) {
      return {
        ok: false,
        lineIndex,
        error: e instanceof Error ? e.message : "Preview request failed.",
      };
    }
  }

  async function runPreviewQueue(
    lockedRefSelections: Record<number, Record<string, number>>,
  ) {
    const bundles = preview.bundles;
    if (bundles.length === 0) return;

    const queueInit: ReviewQueueItem[] = bundles.map((b, i) => ({
      lineIndex: b.lineIndex,
      bundleLabel: b.name?.trim() || `${b.master} + ${b.components.join(" ")}`,
      bundleIndex: i,
      bundleTotal: bundles.length,
      seedOffset: 0,
      status: "queued",
      refSelection: lockedRefSelections[b.lineIndex],
    }));

    setLoading(true);
    setApiResult(null);
    setStreamProgress(null);
    setStreamingResults([]);
    setDedupeError(null);
    setReviewModal(null);
    setReviewQueue(queueInit);

    let parseErrorsAcc: string[] | undefined;
    try {
      for (let i = 0; i < queueInit.length; i++) {
        const item = queueInit[i];
        setStreamProgress({ current: i + 1, total: queueInit.length });
        updateQueueItem(item.lineIndex, (it) => ({
          ...it,
          status: "generating",
          error: undefined,
        }));

        const p = await fetchBundlePreview(
          item.lineIndex,
          item.seedOffset,
          lockedRefSelections[item.lineIndex],
        );
        if (parseErrorsAcc === undefined && p.parseErrors?.length) {
          parseErrorsAcc = p.parseErrors;
        }

        if (!p.ok) {
          updateQueueItem(item.lineIndex, (it) => ({
            ...it,
            status: "failed",
            error: p.error,
          }));
          continue;
        }

        updateQueueItem(item.lineIndex, (it) => ({
          ...it,
          status: "ready",
          preview: p.preview,
          error: undefined,
        }));
      }

      setApiResult({
        parseErrors: parseErrorsAcc,
        bundlesParsed: queueInit.length,
      });
    } finally {
      setLoading(false);
      setStreamProgress(null);
    }
  }

  async function regenerateQueuePreview(
    item: ReviewQueueItem,
    refSelection?: Record<string, number>,
  ) {
    const nextSeed = item.seedOffset + 1;
    const sel = refSelection ?? item.refSelection;
    setLoading(true);
    updateQueueItem(item.lineIndex, (it) => ({
      ...it,
      status: "generating",
      seedOffset: nextSeed,
      error: undefined,
    }));
    try {
      const p = await fetchBundlePreview(item.lineIndex, nextSeed, sel);
      if (!p.ok) {
        updateQueueItem(item.lineIndex, (it) => ({
          ...it,
          status: "failed",
          error: p.error,
        }));
        return;
      }
      updateQueueItem(item.lineIndex, (it) => ({
        ...it,
        status: "ready",
        preview: p.preview,
        refSelection: sel,
        error: undefined,
      }));
    } finally {
      setLoading(false);
    }
  }

  function openQueueReview(item: ReviewQueueItem) {
    if (!item.preview) return;
    setReviewModal({
      bundleLabel: item.bundleLabel,
      bundleIndex: item.bundleIndex,
      bundleTotal: item.bundleTotal,
      seedOffset: item.seedOffset,
      preview: item.preview,
      uploadLabel: "Approve — include when saving",
      skipLabel: "Skip this bundle",
      onChoose: (action, opts) => {
        setReviewModal(null);
        if (action === "upload") {
          updateQueueItem(item.lineIndex, (it) => ({
            ...it,
            status: "approved",
            refSelection: opts?.refSelection ?? it.refSelection,
            error: undefined,
          }));
          return;
        }
        if (action === "skip") {
          updateQueueItem(item.lineIndex, (it) => ({
            ...it,
            status: "skipped",
          }));
          return;
        }
        void regenerateQueuePreview(item, opts?.refSelection);
      },
    });
  }

  async function commitApprovedQueue() {
    const targets = reviewQueue.filter(
      (it) => it.status === "approved" && it.preview,
    );
    if (targets.length === 0) {
      setApiResult({ error: "No approved previews to commit." });
      return;
    }

    setLoading(true);
    setApiResult(null);
    setStreamProgress(null);

    const results: BundleRow[] = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        const item = targets[i];
        if (!item.preview) continue;
        setStreamProgress({ current: i + 1, total: targets.length });
        updateQueueItem(item.lineIndex, (it) => ({ ...it, status: "committing" }));

        const commitRes = await fetch("/api/bundle/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            outputFolderId: outputFolderId || undefined,
            lineIndex: item.lineIndex,
            folderName: item.preview.folderName,
            masterSku: item.preview.masterSku,
            generated: item.preview.generated,
            isolatedPerSku: item.preview.isolatedPerSku,
            isolatedBundle: item.preview.isolatedBundle,
            referenceSourceFiles: item.preview.referenceSourceFiles,
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
          updateQueueItem(item.lineIndex, (it) => ({
            ...it,
            status: "committed",
            commitResult: cr,
            error: undefined,
          }));
        } else {
          const err =
            cr && !cr.ok ? cr.error : commitJson.error ?? "Commit failed.";
          const row: BundleRow = {
            lineIndex: item.lineIndex,
            ok: false,
            error: err,
          };
          results.push(row);
          updateQueueItem(item.lineIndex, (it) => ({
            ...it,
            status: "failed",
            error: err,
            commitResult: row,
          }));
        }
        setStreamingResults([...results]);
      }

      setApiResult({
        results,
        bundlesParsed: targets.length,
      });
    } finally {
      setLoading(false);
      setStreamProgress(null);
    }
  }

  async function saveGlobalPromptRules() {
    setGlobalPromptStatus("saving");
    setGlobalPromptError(null);
    try {
      const res = await fetch("/api/bundle/prompt-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: globalPromptRules,
          lifestylePrefixMulti,
          lifestylePrefixSingle,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setGlobalPromptStatus("error");
        setGlobalPromptError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setGlobalPromptStatus("saved");
    } catch (e) {
      setGlobalPromptStatus("error");
      setGlobalPromptError(
        e instanceof Error ? e.message : "Failed to save prompt rules.",
      );
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
  const approvedCount = reviewQueue.filter((q) => q.status === "approved").length;
  const committedCount = reviewQueue.filter(
    (q) => q.status === "committed",
  ).length;

  return (
    <div className="min-h-full bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Bundle image creator
          </h1>
          <p className="text-base text-zinc-600 dark:text-zinc-400">
            Pulls product photos from Google Drive, creates new bundle images with AI,
            and saves them where you choose. Follow the numbered steps.
          </p>
          <p className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">
              Plan time:
            </span>{" "}
            Loading photos, AI image creation, and saving back to Drive can take{" "}
            <span className="font-medium">several minutes per bundle</span> — and
            longer for many products or large batches. Don&apos;t close the tab;
            wait for progress to finish.
          </p>
        </header>

        <section
          className="rounded-2xl border-2 border-emerald-200 bg-white p-5 shadow-sm dark:border-emerald-800/80 dark:bg-zinc-900"
          aria-label="What to do"
        >
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            What to do
          </h2>
          <ol className="mt-4 list-none space-y-4 text-sm">
            <li className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white">
                1
              </span>
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  Enter your bundles
                </p>
                <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">
                  Paste your list in the box below or upload a file.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white">
                2
              </span>
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  Connect Google Drive
                </p>
                <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">
                  Authorize Drive first (big blue button in step 2). Then paste the two
                  folder codes. This can take a while — see &quot;Plan time&quot; at
                  the top.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white">
                3
              </span>
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  Check the list below
                </p>
                <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">
                  Section &quot;What we understood&quot; must look right. Optional:
                  expand &quot;Optional — change how…&quot; only if you need different
                  photo wording (most people skip).
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white">
                4
              </span>
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  Create images (black box)
                </p>
                <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">
                  You will pick photos first, then review AI images, then save to
                  Drive when happy. Expect waits while the app talks to Drive and
                  creates images — often several minutes per bundle.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              1. Your bundle list
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              One bundle per line. You can paste text or upload CSV / text file.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="sr-only" htmlFor="skus">
              Bundle list
            </label>
            <label className="text-sm text-zinc-600 dark:text-zinc-400">
              <span className="mr-2">Upload file</span>
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
              We detected a spreadsheet-style file (names and product codes).
            </p>
          )}
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2 rounded-xl border-2 border-amber-400 bg-gradient-to-b from-amber-50 to-amber-100/80 p-5 shadow-lg dark:border-amber-500 dark:from-amber-950/80 dark:to-amber-950/40">
            <p className="text-base font-bold tracking-tight text-amber-950 dark:text-amber-50">
              Step 2 — Authorize Google Drive first (required)
            </p>
            <p className="mt-2 text-sm leading-snug text-amber-950/90 dark:text-amber-100/90">
              The app cannot read your product photos or save finished images until you
              sign in and allow access. Use the Google account that owns these
              folders. You may only need to do this once per browser.
            </p>
            <a
              href="/api/auth/google"
              className="mt-4 flex w-full items-center justify-center rounded-xl bg-[#1a73e8] px-6 py-4 text-center text-base font-bold text-white shadow-xl shadow-blue-600/35 ring-4 ring-blue-400/40 transition hover:bg-[#1557b0] hover:shadow-blue-700/40 hover:ring-blue-300/60 focus:outline-none focus-visible:ring-4 focus-visible:ring-amber-200 active:scale-[0.99] sm:inline-flex sm:w-auto"
            >
              Authorize Google Drive
            </a>
          </div>
          <div className="sm:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              2. Google Drive folders
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              After authorizing, open each folder in Google Drive and copy the long ID
              from the browser address bar into the boxes below.
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="parent">
              Where your product photos are
            </label>
            <p className="text-xs text-zinc-500">
              Folder that holds each product’s photos (one folder per product code).
            </p>
            <input
              id="parent"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder="Paste folder ID from Drive"
              value={parentFolderId}
              onChange={(e) => setParentFolderId(e.target.value)}
            />
            {parentFolderId.trim() !== "" && (
              <div className="space-y-0.5 pt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {driveFolderHints?.parent?.id === parentFolderId.trim() &&
                  driveFolderHints.parent.name && (
                    <p className="break-words font-medium text-zinc-700 dark:text-zinc-300">
                      {driveFolderHints.parent.name}
                    </p>
                  )}
                <a
                  className="inline-block break-all text-emerald-700 underline hover:text-emerald-900 dark:text-emerald-400 dark:hover:text-emerald-300"
                  href={driveFolderUrl(parentFolderId.trim())}
                  target="_blank"
                  rel="noreferrer"
                >
                  {driveFolderUrl(parentFolderId.trim())}
                </a>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="out">
              Where to save new images
            </label>
            <p className="text-xs text-zinc-500">
              Finished bundle images go into new folders inside this folder.
            </p>
            <input
              id="out"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder="Paste folder ID from Drive"
              value={outputFolderId}
              onChange={(e) => setOutputFolderId(e.target.value)}
            />
            {outputFolderId.trim() !== "" && (
              <div className="space-y-0.5 pt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {driveFolderHints?.output?.id === outputFolderId.trim() &&
                  driveFolderHints.output.name && (
                    <p className="break-words font-medium text-zinc-700 dark:text-zinc-300">
                      {driveFolderHints.output.name}
                    </p>
                  )}
                <a
                  className="inline-block break-all text-emerald-700 underline hover:text-emerald-900 dark:text-emerald-400 dark:hover:text-emerald-300"
                  href={driveFolderUrl(outputFolderId.trim())}
                  target="_blank"
                  rel="noreferrer"
                >
                  {driveFolderUrl(outputFolderId.trim())}
                </a>
              </div>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            3. What we understood
          </h2>
          <p className="mb-3 text-xs text-zinc-500">
            Check that each bundle and product code is correct. Fix the list in step 1
            if something looks wrong.
          </p>
          {preview.errors.length > 0 && (
            <ul className="mb-2 list-inside list-disc text-sm text-amber-800 dark:text-amber-300">
              {preview.errors.map((e, i) => (
                <li key={`${i}-${e}`}>{e}</li>
              ))}
            </ul>
          )}
          {preview.bundles.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Nothing to show yet — add at least one bundle in step 1.
            </p>
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

        <details className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <summary className="cursor-pointer list-none p-4 text-sm font-semibold text-zinc-900 marker:content-none dark:text-zinc-100 [&::-webkit-details-marker]:hidden">
            Optional — change how the AI styles photos (click to open)
          </summary>
          <div className="border-t border-zinc-100 p-4 pt-3 dark:border-zinc-800">
            <p className="mb-3 text-xs text-zinc-500">
              Only open this if you want different wording or extra rules. Your team
              can save changes with the button at the bottom of this section.
            </p>
            {promptRulesLoadError && (
              <p className="mb-2 text-xs text-amber-800 dark:text-amber-300">
                Could not load saved rules: {promptRulesLoadError}
              </p>
            )}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label className="text-xs text-zinc-600 dark:text-zinc-400">
                Bundle type
              </label>
              <select
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-900"
                value={defaultPromptVariant}
                onChange={(e) =>
                  setDefaultPromptVariant(
                    e.target.value === "single" ? "single" : "multi",
                  )
                }
              >
                <option value="multi">Several products in one bundle</option>
                <option value="single">One product only</option>
              </select>
            </div>
            <textarea
              aria-label="Main photo instructions for the AI"
              className="min-h-48 w-full resize-y rounded border border-zinc-200 bg-white p-3 font-mono text-xs text-zinc-800 shadow-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:ring-zinc-600"
              value={
                defaultPromptVariant === "single"
                  ? lifestylePrefixSingle
                  : lifestylePrefixMulti
              }
              onChange={(e) => {
                if (defaultPromptVariant === "single") {
                  setLifestylePrefixSingle(e.target.value);
                } else {
                  setLifestylePrefixMulti(e.target.value);
                }
                if (globalPromptStatus !== "idle") setGlobalPromptStatus("idle");
              }}
              maxLength={48000}
            />
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                type="button"
                className="text-[11px] text-emerald-700 underline hover:text-emerald-900 dark:text-emerald-400"
                onClick={() => {
                  if (defaultPromptVariant === "single") {
                    setLifestylePrefixSingle(defaultLifestylePromptSingle);
                  } else {
                    setLifestylePrefixMulti(defaultLifestylePromptMulti);
                  }
                  setGlobalPromptStatus("idle");
                }}
              >
                Reset to default wording
              </button>
            </div>
            <h3 className="mb-1 mt-4 text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Extra rules (optional)
            </h3>
            <textarea
              className="min-h-20 w-full resize-y rounded border border-zinc-200 bg-white p-3 font-mono text-sm shadow-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-zinc-600"
              placeholder="Only if you need more instructions for every run."
              value={globalPromptRules}
              onChange={(e) => {
                setGlobalPromptRules(e.target.value);
                if (globalPromptStatus !== "idle") setGlobalPromptStatus("idle");
              }}
              maxLength={12000}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                disabled={globalPromptStatus === "saving"}
                onClick={() => void saveGlobalPromptRules()}
              >
                {globalPromptStatus === "saving" ? "Saving…" : "Save wording"}
              </button>
              {globalPromptStatus === "saved" && (
                <span className="text-xs text-emerald-700 dark:text-emerald-400">
                  Saved. Used the next time you create images.
                </span>
              )}
              {globalPromptStatus === "error" && globalPromptError && (
                <span className="text-xs text-red-700 dark:text-red-400">
                  {globalPromptError}
                </span>
              )}
            </div>
          </div>
        </details>

        <section className="rounded-2xl border-2 border-zinc-900 bg-zinc-900 p-6 text-white shadow-lg dark:border-zinc-100 dark:bg-zinc-950">
          <h2 className="text-lg font-semibold tracking-tight">
            4. Create images
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-300">
            First you&apos;ll choose which product photos to use. Then the app creates
            new images. You approve before anything is saved to your &quot;finished
            images&quot; folder.{" "}
            <span className="font-medium text-amber-200/95">
              This process is not instant
            </span>
            — loading references and generating each set of images can take several
            minutes; large queues take longer. Keep this tab open until each step
            finishes.
          </p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              onClick={() => void beginRefGateThen("popup")}
              disabled={loading || preview.bundles.length === 0}
              className="rounded-full bg-white px-6 py-3 text-sm font-semibold text-zinc-900 shadow hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading
                ? "Working…"
                : "Start — one bundle at a time (recommended)"}
            </button>
            <button
              type="button"
              onClick={() => void beginRefGateThen("queue")}
              disabled={loading || preview.bundles.length === 0}
              className="rounded-full border-2 border-emerald-400/80 bg-transparent px-5 py-3 text-sm font-semibold text-emerald-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading
                ? "Working…"
                : "Start — all bundles, then review a list"}
            </button>
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            Used the list option? When previews look good, approve each row, then use
            &quot;Save approved to Drive&quot; below.
          </p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void commitApprovedQueue()}
            disabled={loading || approvedCount === 0}
            className="rounded-full border-2 border-emerald-600 bg-emerald-50 px-5 py-2.5 text-sm font-semibold text-emerald-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-100 dark:hover:bg-emerald-900"
          >
            {loading
              ? "…"
              : `Save approved images to Drive (${approvedCount})`}
          </button>
        </div>

        <details className="rounded-lg border border-zinc-200 bg-zinc-50/80 dark:border-zinc-700 dark:bg-zinc-900/80">
          <summary className="cursor-pointer list-none p-3 text-sm font-medium text-zinc-700 marker:content-none dark:text-zinc-300 [&::-webkit-details-marker]:hidden">
            Advanced — for power users
          </summary>
          <div className="flex flex-wrap gap-3 border-t border-zinc-200 p-3 dark:border-zinc-700">
            <button
              type="button"
              onClick={() => void runFullAuto()}
              disabled={loading || preview.bundles.length === 0}
              className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              {loading ? "…" : "Run everything with no review (risky)"}
            </button>
            <button
              type="button"
              onClick={() => void runDedupe()}
              disabled={dedupeLoading}
              className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              {dedupeLoading ? "Cleaning…" : "Remove duplicate output folders"}
            </button>
          </div>
        </details>

        {streamProgress && streamProgress.total > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-zinc-500">
              Working — this can take several minutes. Please wait.
            </p>
            <div className="flex justify-between text-xs text-zinc-600 dark:text-zinc-400">
              <span>Progress</span>
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

        {reviewQueue.length > 0 && (
          <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                List review (after &quot;all bundles&quot;)
              </h2>
              <p className="text-xs text-zinc-500">
                {approvedCount} ready to save · {committedCount} saved ·{" "}
                {
                  reviewQueue.filter((q) => q.status === "failed" || q.status === "skipped")
                    .length
                }{" "}
                skipped or failed
              </p>
            </div>
            <p className="text-xs text-zinc-500">
              Open each row to see the images. Approve the ones you want, then press
              &quot;Save approved images to Drive&quot; above.
            </p>
            <ul className="space-y-2 text-sm">
              {reviewQueue.map((item) => (
                <li
                  key={item.lineIndex}
                  className="rounded border border-zinc-200 p-3 dark:border-zinc-700"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-zinc-800 dark:text-zinc-200">
                        {item.bundleIndex + 1}. {item.bundleLabel}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        Row {item.lineIndex + 1}
                        {item.seedOffset > 0
                          ? ` · remake attempt ${item.seedOffset + 1}`
                          : ""}
                      </p>
                    </div>
                    <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-[11px] font-medium capitalize text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                      {item.status}
                    </span>
                  </div>
                  {item.error && (
                    <p className="mt-2 text-xs text-red-700 dark:text-red-400">
                      {item.error}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      onClick={() => openQueueReview(item)}
                      disabled={!item.preview}
                    >
                      View images
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-amber-400 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-950 dark:text-amber-100"
                      onClick={() => void regenerateQueuePreview(item)}
                      disabled={loading}
                    >
                      Regenerate
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-emerald-500 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-950 dark:text-emerald-100"
                      onClick={() =>
                        updateQueueItem(item.lineIndex, (it) => ({
                          ...it,
                          status: "approved",
                        }))
                      }
                      disabled={!item.preview || loading}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      onClick={() =>
                        updateQueueItem(item.lineIndex, (it) => ({
                          ...it,
                          status: "skipped",
                        }))
                      }
                      disabled={loading}
                    >
                      Skip
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {displayResults.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Saved to Drive
              {loading && (
                <span className="ml-2 font-normal text-zinc-500">(updating…)</span>
              )}
            </h2>
            <p className="text-xs text-zinc-500">
              Links to folders and files in your output folder.
            </p>
            <ul className="space-y-2 text-sm">
              {displayResults.map((r) => (
                <li
                  key={r.lineIndex}
                  className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {r.ok ? (
                    <div className="space-y-1">
                      <p>
                        <span className="font-medium">{r.folderName}</span>
                      </p>
                      <p>
                        <a
                          className="text-emerald-700 underline hover:text-emerald-900 dark:text-emerald-400 dark:hover:text-emerald-300"
                          href={r.folderUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open output folder in Drive
                        </a>
                      </p>
                      <ul className="list-inside list-disc text-xs text-zinc-600 dark:text-zinc-400">
                        {r.fileUrls.map((u, i) => (
                          <li key={`${r.lineIndex}-${i}`}>
                            <a
                              className="underline hover:text-zinc-900 dark:hover:text-zinc-200"
                              href={u}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {u}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
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

      {refGateOpen && (
        <ReferenceGateModal
          state={refGateOpen}
          onConfirm={(sel) => {
            const mode = refGateOpen.next;
            setRefGateOpen(null);
            if (mode === "popup") void runWithReview(sel);
            else void runPreviewQueue(sel);
          }}
          onCancel={() => setRefGateOpen(null)}
        />
      )}
      {reviewModal && (
        <ReviewModal
          key={`${reviewModal.bundleIndex}-${reviewModal.seedOffset}-${reviewModal.preview.lineIndex}`}
          state={reviewModal}
        />
      )}
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

function initRefSelFromRefs(p: {
  referenceFolders: { folderId: string }[];
}): Record<string, number> {
  const m: Record<string, number> = {};
  for (const rf of p.referenceFolders) {
    m[rf.folderId] = 0;
  }
  return m;
}

function initRefSel(p: PreviewPayload): Record<string, number> {
  return initRefSelFromRefs(p);
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
  selectedRefIndexByFolderId,
  onSelectFolderRef,
}: {
  sku: string;
  initialNote: string;
  folders: RefFolderForSku[];
  selectedRefIndexByFolderId: Record<string, number>;
  onSelectFolderRef: (folderId: string, imageIndex: number) => void;
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
      <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
        Product code:{" "}
        <span className="font-mono text-emerald-700 dark:text-emerald-400">
          {sku}
        </span>
      </p>

      <div className="mt-2 space-y-1 rounded border border-dashed border-zinc-300 bg-white p-2 dark:border-zinc-600 dark:bg-zinc-900/60">
        <label
          className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300"
          htmlFor={`sku-note-${sku}`}
        >
          Note for this product (optional)
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
              Saved.
            </span>
          )}
          {status === "error" && error && (
            <span className="text-[11px] text-red-700 dark:text-red-400">
              {error}
            </span>
          )}
          {baseline.trim().length === 0 && status === "idle" && (
            <span className="text-[11px] text-zinc-500">
              Leave blank if the photos are clear on their own.
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {folders.length === 0 ? (
          <p className="text-[11px] text-zinc-500">
            No photo folder found for this product code in Drive.
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
              <p className="mt-1 text-[10px] text-zinc-500">
                Tap one photo. If you change your mind later, use &quot;Make new
                images&quot; in the next screen.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {rf.images.map((img, ii) => {
                  const picked =
                    selectedRefIndexByFolderId[rf.folderId] === ii;
                  return (
                    <label
                      key={`${rf.folderId}-${ii}`}
                      className={`flex cursor-pointer flex-col gap-0.5 rounded border p-1 transition-colors ${
                        picked
                          ? "border-emerald-500 ring-2 ring-emerald-400/80 dark:ring-emerald-600"
                          : "border-zinc-200 dark:border-zinc-600"
                      }`}
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        name={`refpick-${rf.folderId}`}
                        checked={picked}
                        onChange={() => onSelectFolderRef(rf.folderId, ii)}
                      />
                      <img
                        src={`data:${img.mimeType};base64,${img.dataBase64}`}
                        alt={`${rf.folderName} ref ${ii + 1}`}
                        className="h-28 w-28 rounded border border-zinc-200 object-cover dark:border-zinc-600"
                      />
                      <span className="text-center font-mono text-[10px] text-zinc-500">
                        {ii + 1}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ReferenceGateModal({
  state,
  onConfirm,
  onCancel,
}: {
  state: RefGateOpenState;
  onConfirm: (sel: Record<number, Record<string, number>>) => void;
  onCancel: () => void;
}) {
  const [selByLine, setSelByLine] = useState<
    Record<number, Record<string, number>>
  >(() => {
    const m: Record<number, Record<string, number>> = {};
    for (const it of state.items) {
      m[it.lineIndex] = initRefSelFromRefs(it.refs);
    }
    return m;
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ref-gate-title"
    >
      <div className="my-8 max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <h2
          id="ref-gate-title"
          className="text-lg font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Which photos should we use?
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Tap one thumbnail in each group. Nothing is generated until you press the
          green button below. If you add a note for a product, press &quot;Save
          note&quot; on that card first.
        </p>
        {state.parseErrors && state.parseErrors.length > 0 && (
          <ul className="mt-3 list-inside list-disc rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {state.parseErrors.map((e, i) => (
              <li key={`${i}-${e}`}>{e}</li>
            ))}
          </ul>
        )}

        <div className="mt-4 space-y-8">
          {state.items.map((it) => (
            <section
              key={it.lineIndex}
              className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-700 dark:bg-zinc-950/40"
            >
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                Bundle {it.bundleIndex + 1} of {it.bundleTotal}: {it.bundleLabel}
              </h3>
              <p className="mt-0.5 text-xs text-zinc-500">
                Saved images will be named:{" "}
                <span className="font-mono text-zinc-700 dark:text-zinc-300">
                  {it.refs.folderName}
                </span>
              </p>
              <div className="mt-3 space-y-4">
                {uniqueOrdered(it.refs.allSkus).map((sku) => {
                  const folders = it.refs.referenceFolders.filter(
                    (rf) => rf.sku === sku,
                  );
                  const initialNote =
                    it.refs.skuNotes.find((n) => n.sku === sku)?.note ?? "";
                  return (
                    <SkuReferenceCard
                      key={`${it.lineIndex}-${sku}`}
                      sku={sku}
                      initialNote={initialNote}
                      folders={folders}
                      selectedRefIndexByFolderId={
                        selByLine[it.lineIndex] ?? initRefSelFromRefs(it.refs)
                      }
                      onSelectFolderRef={(folderId, imageIndex) =>
                        setSelByLine((prev) => ({
                          ...prev,
                          [it.lineIndex]: {
                            ...(prev[it.lineIndex] ??
                              initRefSelFromRefs(it.refs)),
                            [folderId]: imageIndex,
                          },
                        }))
                      }
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
          <button
            type="button"
            className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            onClick={() => onConfirm(selByLine)}
          >
            Next — create images
          </button>
          <button
            type="button"
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewModal({ state }: { state: ReviewModalState }) {
  const [refSel, setRefSel] = useState<Record<string, number>>(() =>
    initRefSel(state.preview),
  );
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
        body: JSON.stringify({
          lesson: trimmed,
          masterSku: state.preview.masterSku,
        }),
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
    state.onChoose(action, { refSelection: refSel });
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
          Approve these images — bundle {state.bundleIndex + 1} of{" "}
          {state.bundleTotal}
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {state.bundleLabel}
          {state.seedOffset > 0
            ? ` · Remake #${state.seedOffset + 1}`
            : ""}
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          They will be saved in a folder called{" "}
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
            Product photos &amp; short notes
          </h3>
          <p className="text-xs text-zinc-500">
            Each product shows the photos we used. Add a note if the main item
            isn&apos;t obvious (e.g. &ldquo;wooden box is the product; rings in the
            photo are extras&rdquo;). Save each note before continuing.
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
                  selectedRefIndexByFolderId={refSel}
                  onSelectFolderRef={(folderId, imageIndex) =>
                    setRefSel((prev) => ({ ...prev, [folderId]: imageIndex }))
                  }
                />
              );
            })}
          </div>
        </div>

        <div className="mt-6 space-y-2">
          <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            New bundle photos (main shots)
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
              Each product on a white background
            </h3>
            <p className="text-xs text-zinc-500">
              Extra files saved next to the main shots — one per product.
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
              All products together on white
            </h3>
            <p className="text-xs text-zinc-500">
              One extra file with every product in a row.
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
            Remember for next time (optional)
          </h3>
          <p className="text-xs text-zinc-500">
            If sizes or details were wrong, add a short reminder here so future
            runs for this product line do better.
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
              {lessonStatus === "saving" ? "Saving…" : "Save reminder"}
            </button>
            {lessonStatus === "saved" && (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">
                Saved for later runs.
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
            {state.uploadLabel ?? "Yes — save to Drive"}
          </button>
          <button
            type="button"
            className="rounded-full border border-amber-500 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"
            onClick={() => void handleChoice("retry")}
          >
            Make new images
          </button>
          <button
            type="button"
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={() => void handleChoice("skip")}
          >
            {state.skipLabel ?? "Skip this bundle"}
          </button>
        </div>
      </div>
    </div>
  );
}

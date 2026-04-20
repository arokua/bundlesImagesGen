import type { drive_v3 } from "googleapis";
import {
  copyDriveFileToFolder,
  createSubfolder,
  downloadFileBuffer,
  listImageFilesInFolder,
  resolveAllFoldersForSku,
  uploadBufferAsFile,
  type ChildFolder,
} from "@/lib/drive";
import { driveFolderName } from "@/lib/bundleFolderName";
import {
  generateBundleImage,
  generateIsolatedBundleImage,
  generateIsolatedSingleImage,
} from "@/lib/generateImages";
import { readImagePromptExtras } from "@/lib/promptContext";
import {
  formatSkuNotesBlock,
  getSkuNotesFor,
  type SkuNote,
} from "@/lib/skuNotes";
import {
  fetchSkuDimensionsFor,
  formatSkuDimensionsBlock,
  type SkuDimension,
} from "@/lib/skuDimensions";
import type { ParsedBundle } from "@/lib/parseSkus";
import { driveFileUrl, driveFolderUrl } from "@/lib/driveLinks";

type RefImage = { mimeType: string; data: Buffer };

/** Natural refs only (one per Drive folder), in master + component order. */
function flattenNaturalRefs(
  skuOrder: string[],
  bySku: Map<string, RefImage[]>,
): RefImage[] {
  const out: RefImage[] = [];
  for (const sku of skuOrder) {
    const list = bySku.get(sku) ?? [];
    for (const r of list) out.push(r);
  }
  return out;
}

/**
 * Lifestyle bundle refs: for each SKU, all natural folder picks for that SKU, then that SKU’s blank-background image.
 * Capped to maxRef (drops trailing items if over).
 */
function buildBundleLifestyleReferences(
  skuOrder: string[],
  bySku: Map<string, RefImage[]>,
  isolatedBySku: Map<string, RefImage>,
  maxRef: number,
): RefImage[] {
  const out: RefImage[] = [];
  for (const sku of skuOrder) {
    const naturals = bySku.get(sku) ?? [];
    for (const r of naturals) {
      if (out.length >= maxRef) return out;
      out.push(r);
    }
    const iso = isolatedBySku.get(sku);
    if (iso && out.length < maxRef) out.push(iso);
  }
  return out;
}

export type BundleResult =
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

export type PreviewImagePayload = {
  mimeType: string;
  dataBase64: string;
};

/** One Drive folder’s contribution for a SKU (matches what the model will use). */
export type ReferenceFolderPreview = {
  sku: string;
  folderId: string;
  folderName: string;
  images: PreviewImagePayload[];
};

export type IsolatedSkuPreview = {
  sku: string;
  image: PreviewImagePayload;
};

/** Selected reference file in Drive (one per matched folder) — used to copy originals into the bundle output folder on commit. */
export type ReferenceSourceCopy = {
  fileId: string;
  /** Original filename in the source folder */
  name: string;
  sku: string;
};

export type BundlePreviewPayload = {
  lineIndex: number;
  folderName: string;
  masterSku: string;
  /** All unique SKUs in this bundle (master first, then components). */
  allSkus: string[];
  /** Per-SKU guidance that was sent to the model for this generation. */
  skuNotes: SkuNote[];
  /** Per-SKU dimensions fetched from Woo store API and sent to the model. */
  skuDimensions: SkuDimension[];
  /** Each matching Drive folder separately, with the images pulled from that folder. */
  referenceFolders: ReferenceFolderPreview[];
  /** Drive file id + name for each chosen reference (copied into output on commit). */
  referenceSourceFiles: ReferenceSourceCopy[];
  /** Generated bundle lifestyle images (not yet on Drive). */
  generated: PreviewImagePayload[];
  /** Blank-background isolated image per product SKU (master + components). */
  isolatedPerSku: IsolatedSkuPreview[];
  /** Blank-background lineup of the whole bundle. May be null if generation failed. */
  isolatedBundle: PreviewImagePayload | null;
  /** Non-fatal isolation errors surfaced to the UI. */
  isolationWarnings: string[];
};

type FolderRefSource = {
  sku: string;
  folderId: string;
  folderName: string;
  images: RefImage[];
};

const MAX_PREVIEW_IMAGES_PER_FOLDER = 12;

async function collectRefImagesBySku(
  drive: drive_v3.Drive,
  bundle: ParsedBundle,
  primaryChildFolders: ChildFolder[],
  fallbackChildFolders: ChildFolder[] | null,
  refSelection?: Record<string, number>,
): Promise<{
  bySku: Map<string, RefImage[]>;
  folderSources: FolderRefSource[];
  referenceSourceFiles: ReferenceSourceCopy[];
}> {
  const skus = [bundle.master, ...bundle.components];
  const bySku = new Map<string, RefImage[]>();
  const folderSources: FolderRefSource[] = [];
  const referenceSourceFiles: ReferenceSourceCopy[] = [];
  for (const sku of skus) {
    let folders = resolveAllFoldersForSku(
      primaryChildFolders,
      fallbackChildFolders,
      sku,
    );
    folders = [...folders].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    const list: RefImage[] = [];
    for (const folder of folders) {
      const folderId = folder.id;
      if (!folderId) {
        throw new Error(`Missing id for folder "${sku}".`);
      }
      const images = await listImageFilesInFolder(drive, folderId);
      const slice = images.slice(0, MAX_PREVIEW_IMAGES_PER_FOLDER);
      if (slice.length === 0) {
        if (folders.length > 1) continue;
        throw new Error(
          `No image files in folder "${folder.name}" for SKU "${sku}".`,
        );
      }
      const fromThisFolder: RefImage[] = [];
      for (const img of slice) {
        if (!img.id || !img.mimeType) continue;
        const data = await downloadFileBuffer(drive, img.id);
        fromThisFolder.push({ mimeType: img.mimeType, data });
      }
      if (fromThisFolder.length === 0) {
        if (folders.length > 1) continue;
        throw new Error(
          `No downloadable image files in folder "${folder.name}" for SKU "${sku}".`,
        );
      }
      const pick = Math.min(
        Math.max(0, refSelection?.[folderId] ?? 0),
        fromThisFolder.length - 1,
      );
      list.push(fromThisFolder[pick]!);
      const pickedMeta = slice[pick];
      if (pickedMeta?.id) {
        referenceSourceFiles.push({
          fileId: pickedMeta.id,
          name: pickedMeta.name ?? `image-${pick}`,
          sku,
        });
      }
      folderSources.push({
        sku,
        folderId,
        folderName: folder.name,
        images: fromThisFolder,
      });
    }
    if (list.length === 0) {
      throw new Error(`No downloadable image files in folders for SKU "${sku}".`);
    }
    bySku.set(sku, list);
  }
  return { bySku, folderSources, referenceSourceFiles };
}

function toPreviewPayload(
  mimeType: string,
  data: Buffer,
): PreviewImagePayload {
  return {
    mimeType,
    dataBase64: data.toString("base64"),
  };
}

/** Drive refs + notes only — no Gemini (used before user confirms AI generation). */
export type BundleRefsOnlyPayload = {
  lineIndex: number;
  folderName: string;
  masterSku: string;
  allSkus: string[];
  skuNotes: SkuNote[];
  skuDimensions: SkuDimension[];
  referenceFolders: ReferenceFolderPreview[];
  referenceSourceFiles: ReferenceSourceCopy[];
};

export async function collectBundleRefsOnly(
  drive: drive_v3.Drive,
  bundle: ParsedBundle,
  primaryChildFolders: ChildFolder[],
  fallbackChildFolders: ChildFolder[] | null,
  refSelection?: Record<string, number>,
): Promise<
  | { ok: true; previewRefs: BundleRefsOnlyPayload }
  | { ok: false; lineIndex: number; error: string }
> {
  const skus = [bundle.master, ...bundle.components];
  const lineIndex = bundle.lineIndex;
  try {
    const { folderSources, referenceSourceFiles } =
      await collectRefImagesBySku(
        drive,
        bundle,
        primaryChildFolders,
        fallbackChildFolders,
        refSelection,
      );
    const folderName = driveFolderName(bundle, skus);
    const referenceFolders: BundlePreviewPayload["referenceFolders"] =
      folderSources.map((fs) => ({
        sku: fs.sku,
        folderId: fs.folderId,
        folderName: fs.folderName,
        images: fs.images.map((r) => toPreviewPayload(r.mimeType, r.data)),
      }));
    const skuNotes = await getSkuNotesFor(skus);
    const skuDimensions = await fetchSkuDimensionsFor(skus);
    return {
      ok: true,
      previewRefs: {
        lineIndex,
        folderName,
        masterSku: bundle.master,
        allSkus: [...skus],
        skuNotes,
        skuDimensions,
        referenceFolders,
        referenceSourceFiles,
      },
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, lineIndex, error: err };
  }
}

/**
 * Build reference thumbnails per SKU (for UI) + run Gemini. Does not touch Drive output.
 * Per-SKU blank backgrounds are generated first, then lifestyle shots use natural refs plus those studio images.
 */
export async function generateBundlePreview(
  drive: drive_v3.Drive,
  bundle: ParsedBundle,
  primaryChildFolders: ChildFolder[],
  fallbackChildFolders: ChildFolder[] | null,
  seedOffset: number,
  refSelection?: Record<string, number>,
): Promise<
  | { ok: true; preview: BundlePreviewPayload }
  | { ok: false; lineIndex: number; error: string }
> {
  const skus = [bundle.master, ...bundle.components];
  const skuOrder = [bundle.master, ...bundle.components];
  const lineIndex = bundle.lineIndex;
  try {
    const { bySku, folderSources, referenceSourceFiles } =
      await collectRefImagesBySku(
        drive,
        bundle,
        primaryChildFolders,
        fallbackChildFolders,
        refSelection,
      );

    const folderName = driveFolderName(bundle, skus);

    const referenceFolders: BundlePreviewPayload["referenceFolders"] =
      folderSources.map((fs) => ({
        sku: fs.sku,
        folderId: fs.folderId,
        folderName: fs.folderName,
        images: fs.images.map((r) => toPreviewPayload(r.mimeType, r.data)),
      }));

    const maxRef = Math.max(
      1,
      Number.parseInt(process.env.GEMINI_MAX_REFERENCE_IMAGES ?? "12", 10) || 12,
    );

    const imagesPerBundle = Math.min(
      2,
      Math.max(
        1,
        Number.parseInt(process.env.GEMINI_IMAGES_PER_BUNDLE ?? "2", 10) || 2,
      ),
    );
    const gapMs = Math.max(
      0,
      Number.parseInt(process.env.GEMINI_MS_BETWEEN_GENERATIONS ?? "800", 10) ||
        800,
    );

    const {
      lessonsBlock,
      globalRulesBlock,
      lifestylePromptPrefixMulti,
      lifestylePromptPrefixSingle,
    } = await readImagePromptExtras(bundle.master);
    const lifestylePromptPrefixOverride =
      skus.length > 1
        ? lifestylePromptPrefixMulti
        : lifestylePromptPrefixSingle;
    const skuNotes = await getSkuNotesFor(skus);
    const skuNotesBlock = formatSkuNotesBlock(skuNotes);
    const skuDimensions = await fetchSkuDimensionsFor(skus);
    const skuDimensionsBlock = formatSkuDimensionsBlock(skuDimensions);

    const t = Date.now() + seedOffset * 97_171;
    const seeds = [
      (t % 900000) + 1 + seedOffset,
      (t % 900000) + 7919 + seedOffset * 3,
    ];
    const labels = [
      "primary composition",
      "alternate angle and styling",
    ] as const;

    const isolationWarnings: string[] = [];
    const isolatedPerSku: IsolatedSkuPreview[] = [];
    const isolatedBySku = new Map<string, RefImage>();

    const isoMaxRefPerSku = Math.max(
      1,
      Number.parseInt(process.env.GEMINI_ISOLATED_MAX_REFS_PER_SKU ?? "4", 10) ||
        4,
    );

    for (let i = 0; i < skus.length; i++) {
      const sku = skus[i];
      if (gapMs > 0) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      const skuRefs = (bySku.get(sku) ?? []).slice(0, isoMaxRefPerSku);
      if (skuRefs.length === 0) {
        isolationWarnings.push(`No refs to isolate SKU "${sku}".`);
        continue;
      }
      try {
        const seed = (t % 900000) + 13337 + i * 131 + seedOffset * 7;
        const singleNote = skuNotes.find((n) => n.sku === sku);
        const singleNotesBlock = singleNote
          ? formatSkuNotesBlock([singleNote])
          : null;
        const singleDim = skuDimensions.find((d) => d.sku === sku);
        const singleDimensionsBlock = singleDim
          ? formatSkuDimensionsBlock([singleDim])
          : null;
        const iso = await generateIsolatedSingleImage({
          references: skuRefs,
          seed,
          sku,
          lessonsBlock,
          skuNotesBlock: singleNotesBlock,
          skuDimensionsBlock: singleDimensionsBlock,
          globalRulesBlock,
        });
        isolatedPerSku.push({
          sku,
          image: toPreviewPayload(iso.mimeType, iso.buffer),
        });
        isolatedBySku.set(sku, { mimeType: iso.mimeType, data: iso.buffer });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        isolationWarnings.push(`Isolated ${sku} failed: ${msg}`);
      }
    }

    const bundleLifestyleRefs = buildBundleLifestyleReferences(
      skuOrder,
      bySku,
      isolatedBySku,
      maxRef,
    );
    if (bundleLifestyleRefs.length === 0) {
      throw new Error(
        "No reference images for bundle lifestyle generation (increase GEMINI_MAX_REFERENCE_IMAGES or fix isolation failures).",
      );
    }

    const generated: PreviewImagePayload[] = [];
    for (let i = 0; i < imagesPerBundle; i++) {
      if (i > 0 && gapMs > 0) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      const g = await generateBundleImage({
        references: bundleLifestyleRefs,
        seed: seeds[i],
        variationLabel: labels[i],
        bundleName: bundle.name,
        bundleDescription: bundle.description,
        productCount: skus.length,
        lessonsBlock,
        skuNotesBlock,
        skuDimensionsBlock,
        globalRulesBlock,
        lifestylePromptPrefixOverride:
          lifestylePromptPrefixOverride?.trim() || null,
      });
      generated.push(toPreviewPayload(g.mimeType, g.buffer));
    }

    const naturalFlat = flattenNaturalRefs(skuOrder, bySku);
    const isoBundleRefs = naturalFlat.slice(0, maxRef);

    let isolatedBundle: PreviewImagePayload | null = null;
    if (isoBundleRefs.length === 0) {
      isolationWarnings.push("No natural refs for isolated bundle lineup.");
    } else {
      try {
        if (gapMs > 0) {
          await new Promise((r) => setTimeout(r, gapMs));
        }
        const seed = (t % 900000) + 24691 + seedOffset * 11;
        const iso = await generateIsolatedBundleImage({
          references: isoBundleRefs,
          seed,
          productCount: skus.length,
          lessonsBlock,
          skuNotesBlock,
          skuDimensionsBlock,
          globalRulesBlock,
        });
        isolatedBundle = toPreviewPayload(iso.mimeType, iso.buffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        isolationWarnings.push(`Isolated bundle failed: ${msg}`);
      }
    }

    return {
      ok: true,
      preview: {
        lineIndex,
        folderName,
        masterSku: bundle.master,
        allSkus: [...skus],
        skuNotes,
        skuDimensions,
        referenceFolders,
        referenceSourceFiles,
        generated,
        isolatedPerSku,
        isolatedBundle,
        isolationWarnings,
      },
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, lineIndex, error: err };
  }
}

function safeDriveFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").trim() || "ref";
}

function extFor(mimeType: string): string {
  return mimeType.includes("jpeg") ? "jpg" : "png";
}

async function uploadPreviewImage(
  drive: drive_v3.Drive,
  name: string,
  image: PreviewImagePayload,
  bundleFolderId: string,
): Promise<string> {
  const buf = Buffer.from(image.dataBase64, "base64");
  if (buf.length === 0) {
    throw new Error(`Empty image payload for ${name}.`);
  }
  return uploadBufferAsFile(
    drive,
    `${name}.${extFor(image.mimeType)}`,
    buf,
    image.mimeType,
    bundleFolderId,
  );
}

/**
 * Create output folder and upload previously approved preview images (lifestyle + isolated).
 */
export async function commitBundleToDrive(
  drive: drive_v3.Drive,
  lineIndex: number,
  outputFolderId: string,
  folderName: string,
  masterSku: string,
  generated: PreviewImagePayload[],
  isolatedPerSku: IsolatedSkuPreview[] = [],
  isolatedBundle: PreviewImagePayload | null = null,
  referenceSourceFiles: ReferenceSourceCopy[] = [],
): Promise<BundleResult> {
  try {
    const bundleFolderId = await createSubfolder(
      drive,
      folderName,
      outputFolderId,
    );

    const fileIds: string[] = [];
    const fileUrls: string[] = [];

    let refCopyIndex = 0;
    for (const ref of referenceSourceFiles) {
      if (!ref?.fileId?.trim()) continue;
      const base = safeDriveFileName(ref.name);
      const copyName = `ref_${ref.sku}_${refCopyIndex}_${base}`;
      refCopyIndex += 1;
      const id = await copyDriveFileToFolder(
        drive,
        ref.fileId.trim(),
        copyName,
        bundleFolderId,
      );
      fileIds.push(id);
      fileUrls.push(driveFileUrl(id));
    }

    for (let i = 0; i < generated.length; i++) {
      const id = await uploadPreviewImage(
        drive,
        `${masterSku}_${i + 1}`,
        generated[i],
        bundleFolderId,
      );
      fileIds.push(id);
      fileUrls.push(driveFileUrl(id));
    }

    if (isolatedBundle) {
      const id = await uploadPreviewImage(
        drive,
        `${masterSku}_bundle_iso`,
        isolatedBundle,
        bundleFolderId,
      );
      fileIds.push(id);
      fileUrls.push(driveFileUrl(id));
    }

    for (const iso of isolatedPerSku) {
      if (!iso?.sku) continue;
      const id = await uploadPreviewImage(
        drive,
        `${iso.sku}_iso`,
        iso.image,
        bundleFolderId,
      );
      fileIds.push(id);
      fileUrls.push(driveFileUrl(id));
    }

    return {
      lineIndex,
      ok: true,
      folderName,
      outputFolderId: bundleFolderId,
      folderUrl: driveFolderUrl(bundleFolderId),
      fileIds,
      fileUrls,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { lineIndex, ok: false, error: err };
  }
}

export async function processOneBundle(
  drive: drive_v3.Drive,
  bundle: ParsedBundle,
  primaryChildFolders: ChildFolder[],
  fallbackChildFolders: ChildFolder[] | null,
  outputFolderId: string,
): Promise<BundleResult> {
  const lineIndex = bundle.lineIndex;
  const preview = await generateBundlePreview(
    drive,
    bundle,
    primaryChildFolders,
    fallbackChildFolders,
    0,
  );
  if (!preview.ok) {
    return { lineIndex, ok: false, error: preview.error };
  }
  return commitBundleToDrive(
    drive,
    lineIndex,
    outputFolderId,
    preview.preview.folderName,
    preview.preview.masterSku,
    preview.preview.generated,
    preview.preview.isolatedPerSku,
    preview.preview.isolatedBundle,
    preview.preview.referenceSourceFiles,
  );
}

import type { drive_v3 } from "googleapis";
import {
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
  readLessonsBlock,
} from "@/lib/generateImages";
import {
  formatSkuNotesBlock,
  getSkuNotesFor,
  type SkuNote,
} from "@/lib/skuNotes";
import type { ParsedBundle } from "@/lib/parseSkus";

const MAX_IMAGES_PER_SKU_FOLDER = 8;

/** When several Drive folders match one SKU, take this many images from each (merged in name order). */
function imagesPerFolderWhenMultipleMatches(): number {
  const n = Number.parseInt(
    process.env.BUNDLE_IMAGES_PER_DUPLICATE_SKU_FOLDER ?? "2",
    10,
  );
  return Number.isFinite(n) && n >= 1 ? Math.min(8, n) : 2;
}

type RefImage = { mimeType: string; data: Buffer };

function pickReferencesCapped(
  bySku: Map<string, RefImage[]>,
  master: string,
  components: string[],
  maxRef: number,
): RefImage[] {
  if (maxRef < 1) {
    throw new Error("GEMINI_MAX_REFERENCE_IMAGES must be at least 1.");
  }

  const skuOrder = [master, ...components];
  const minNeeded = skuOrder.length;

  if (maxRef < minNeeded) {
    throw new Error(
      `GEMINI_MAX_REFERENCE_IMAGES (${maxRef}) must be at least ${minNeeded} (one reference per product: master + ${components.length} component(s)).`,
    );
  }

  for (const sku of skuOrder) {
    const list = bySku.get(sku);
    if (!list?.length) {
      throw new Error(`No reference images collected for SKU "${sku}".`);
    }
  }

  const nextIndex = new Map<string, number>();
  for (const sku of skuOrder) nextIndex.set(sku, 0);

  const out: RefImage[] = [];
  while (out.length < maxRef) {
    let progressed = false;
    for (const sku of skuOrder) {
      if (out.length >= maxRef) break;
      const list = bySku.get(sku)!;
      const i = nextIndex.get(sku)!;
      if (i < list.length) {
        out.push(list[i]);
        nextIndex.set(sku, i + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  return out;
}

export type BundleResult =
  | {
      lineIndex: number;
      ok: true;
      folderName: string;
      outputFolderId: string;
      fileIds: string[];
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

export type BundlePreviewPayload = {
  lineIndex: number;
  folderName: string;
  masterSku: string;
  /** All unique SKUs in this bundle (master first, then components). */
  allSkus: string[];
  /** Per-SKU guidance that was sent to the model for this generation. */
  skuNotes: SkuNote[];
  /** Each matching Drive folder separately, with the images pulled from that folder. */
  referenceFolders: ReferenceFolderPreview[];
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

async function collectRefImagesBySku(
  drive: drive_v3.Drive,
  bundle: ParsedBundle,
  primaryChildFolders: ChildFolder[],
  fallbackChildFolders: ChildFolder[] | null,
): Promise<{
  bySku: Map<string, RefImage[]>;
  folderSources: FolderRefSource[];
}> {
  const skus = [bundle.master, ...bundle.components];
  const bySku = new Map<string, RefImage[]>();
  const folderSources: FolderRefSource[] = [];
  const multiCap = imagesPerFolderWhenMultipleMatches();
  for (const sku of skus) {
    let folders = resolveAllFoldersForSku(
      primaryChildFolders,
      fallbackChildFolders,
      sku,
    );
    folders = [...folders].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    const perFolderLimit =
      folders.length > 1 ? multiCap : MAX_IMAGES_PER_SKU_FOLDER;
    const list: RefImage[] = [];
    for (const folder of folders) {
      const folderId = folder.id;
      if (!folderId) {
        throw new Error(`Missing id for folder "${sku}".`);
      }
      const images = await listImageFilesInFolder(drive, folderId);
      const slice = images.slice(0, perFolderLimit);
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
        const ref = { mimeType: img.mimeType, data };
        fromThisFolder.push(ref);
        list.push(ref);
      }
      if (fromThisFolder.length > 0) {
        folderSources.push({
          sku,
          folderId,
          folderName: folder.name,
          images: fromThisFolder,
        });
      }
    }
    if (list.length === 0) {
      throw new Error(`No downloadable image files in folders for SKU "${sku}".`);
    }
    bySku.set(sku, list);
  }
  return { bySku, folderSources };
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

/**
 * Build reference thumbnails per SKU (for UI) + run Gemini. Does not touch Drive output.
 */
export async function generateBundlePreview(
  drive: drive_v3.Drive,
  bundle: ParsedBundle,
  primaryChildFolders: ChildFolder[],
  fallbackChildFolders: ChildFolder[] | null,
  seedOffset: number,
): Promise<
  | { ok: true; preview: BundlePreviewPayload }
  | { ok: false; lineIndex: number; error: string }
> {
  const skus = [bundle.master, ...bundle.components];
  const lineIndex = bundle.lineIndex;
  try {
    const { bySku, folderSources } = await collectRefImagesBySku(
      drive,
      bundle,
      primaryChildFolders,
      fallbackChildFolders,
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
    const cappedRefs = pickReferencesCapped(
      bySku,
      bundle.master,
      bundle.components,
      maxRef,
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

    const lessonsBlock = await readLessonsBlock();
    const skuNotes = await getSkuNotesFor(skus);
    const skuNotesBlock = formatSkuNotesBlock(skuNotes);

    const t = Date.now() + seedOffset * 97_171;
    const seeds = [
      (t % 900000) + 1 + seedOffset,
      (t % 900000) + 7919 + seedOffset * 3,
    ];
    const labels = [
      "primary composition",
      "alternate angle and styling",
    ] as const;
    const generated: PreviewImagePayload[] = [];

    for (let i = 0; i < imagesPerBundle; i++) {
      if (i > 0 && gapMs > 0) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      const g = await generateBundleImage({
        references: cappedRefs,
        seed: seeds[i],
        variationLabel: labels[i],
        bundleName: bundle.name,
        bundleDescription: bundle.description,
        productCount: skus.length,
        lessonsBlock,
        skuNotesBlock,
      });
      generated.push(toPreviewPayload(g.mimeType, g.buffer));
    }

    const isolationWarnings: string[] = [];
    const isolatedPerSku: IsolatedSkuPreview[] = [];
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
        const iso = await generateIsolatedSingleImage({
          references: skuRefs,
          seed,
          sku,
          lessonsBlock,
          skuNotesBlock: singleNotesBlock,
        });
        isolatedPerSku.push({
          sku,
          image: toPreviewPayload(iso.mimeType, iso.buffer),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        isolationWarnings.push(`Isolated ${sku} failed: ${msg}`);
      }
    }

    let isolatedBundle: PreviewImagePayload | null = null;
    try {
      if (gapMs > 0) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      const seed = (t % 900000) + 24691 + seedOffset * 11;
      const iso = await generateIsolatedBundleImage({
        references: cappedRefs,
        seed,
        productCount: skus.length,
        lessonsBlock,
        skuNotesBlock,
      });
      isolatedBundle = toPreviewPayload(iso.mimeType, iso.buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      isolationWarnings.push(`Isolated bundle failed: ${msg}`);
    }

    return {
      ok: true,
      preview: {
        lineIndex,
        folderName,
        masterSku: bundle.master,
        allSkus: [...skus],
        skuNotes,
        referenceFolders,
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
): Promise<BundleResult> {
  try {
    const bundleFolderId = await createSubfolder(
      drive,
      folderName,
      outputFolderId,
    );

    const fileIds: string[] = [];
    for (let i = 0; i < generated.length; i++) {
      fileIds.push(
        await uploadPreviewImage(
          drive,
          `${masterSku}_${i + 1}`,
          generated[i],
          bundleFolderId,
        ),
      );
    }

    for (const iso of isolatedPerSku) {
      if (!iso?.sku) continue;
      fileIds.push(
        await uploadPreviewImage(
          drive,
          `${iso.sku}_iso`,
          iso.image,
          bundleFolderId,
        ),
      );
    }

    if (isolatedBundle) {
      fileIds.push(
        await uploadPreviewImage(
          drive,
          `${masterSku}_bundle_iso`,
          isolatedBundle,
          bundleFolderId,
        ),
      );
    }

    return {
      lineIndex,
      ok: true,
      folderName,
      outputFolderId: bundleFolderId,
      fileIds,
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
  );
}

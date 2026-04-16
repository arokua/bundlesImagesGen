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
import { generateBundleImage } from "@/lib/generateImages";
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

export async function processOneBundle(
  drive: drive_v3.Drive,
  bundle: ParsedBundle,
  primaryChildFolders: ChildFolder[],
  fallbackChildFolders: ChildFolder[] | null,
  outputFolderId: string,
): Promise<BundleResult> {
  const skus = [bundle.master, ...bundle.components];
  const lineIndex = bundle.lineIndex;
  try {
    const bySku = new Map<string, RefImage[]>();
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
        for (const img of slice) {
          if (!img.id || !img.mimeType) continue;
          const data = await downloadFileBuffer(drive, img.id);
          list.push({ mimeType: img.mimeType, data });
        }
      }
      if (list.length === 0) {
        throw new Error(`No downloadable image files in folders for SKU "${sku}".`);
      }
      bySku.set(sku, list);
    }

    const folderName = driveFolderName(bundle, skus);
    const bundleFolderId = await createSubfolder(
      drive,
      folderName,
      outputFolderId,
    );

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

    const t = Date.now();
    const seeds = [(t % 900000) + 1, (t % 900000) + 7919];
    const labels = [
      "primary composition",
      "alternate angle and styling",
    ] as const;
    const generated: Awaited<ReturnType<typeof generateBundleImage>>[] = [];

    for (let i = 0; i < imagesPerBundle; i++) {
      if (i > 0 && gapMs > 0) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      generated.push(
        await generateBundleImage({
          references: cappedRefs,
          seed: seeds[i],
          variationLabel: labels[i],
          bundleName: bundle.name,
          bundleDescription: bundle.description,
          productCount: skus.length,
        }),
      );
    }

    const fileIds: string[] = [];
    const sku = bundle.master;
    for (let i = 0; i < generated.length; i++) {
      const g = generated[i];
      const ext = g.mimeType.includes("jpeg") ? "jpg" : "png";
      fileIds.push(
        await uploadBufferAsFile(
          drive,
          `${sku}_${i + 1}.${ext}`,
          g.buffer,
          g.mimeType,
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

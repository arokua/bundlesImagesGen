import crypto from "node:crypto";
import type { IsolatedSkuPreview, PreviewImagePayload } from "@/lib/bundlePipeline";

type StoredImage = {
  mimeType: string;
  dataBase64: string;
};

type Session = {
  createdAt: number;
  images: Record<string, StoredImage>;
};

const TTL_MS = 30 * 60 * 1000;
const store = new Map<string, Session>();

function cleanupExpired(now: number): void {
  for (const [sid, sess] of store.entries()) {
    if (now - sess.createdAt > TTL_MS) store.delete(sid);
  }
}

export function createPreviewSession(args: {
  generated: PreviewImagePayload[];
  isolatedPerSku: IsolatedSkuPreview[];
  isolatedBundle: PreviewImagePayload | null;
}): {
  previewSessionId: string;
  generated: Array<{
    mimeType: string;
    fileId: string;
    url: string;
    /** Optional duplicate for client `<img>` when session GET is unreliable. */
    dataBase64?: string;
  }>;
  isolatedPerSku: Array<{
    sku: string;
    image: {
      mimeType: string;
      fileId: string;
      url: string;
      dataBase64?: string;
    };
  }>;
  isolatedBundle: {
    mimeType: string;
    fileId: string;
    url: string;
    dataBase64?: string;
  } | null;
} {
  const now = Date.now();
  cleanupExpired(now);
  const previewSessionId = crypto.randomUUID();
  const images: Record<string, StoredImage> = {};
  const toUrl = (imageId: string, mimeType: string) =>
    `/api/bundle/preview-image?sessionId=${encodeURIComponent(previewSessionId)}&imageId=${encodeURIComponent(imageId)}&mimeType=${encodeURIComponent(mimeType)}`;

  const generated = args.generated.map((img) => {
    const imageId = crypto.randomUUID();
    images[imageId] = { mimeType: img.mimeType, dataBase64: img.dataBase64 };
    return { mimeType: img.mimeType, fileId: imageId, url: toUrl(imageId, img.mimeType) };
  });

  const isolatedPerSku = args.isolatedPerSku.map((iso) => {
    const imageId = crypto.randomUUID();
    images[imageId] = {
      mimeType: iso.image.mimeType,
      dataBase64: iso.image.dataBase64,
    };
    return {
      sku: iso.sku,
      image: {
        mimeType: iso.image.mimeType,
        fileId: imageId,
        url: toUrl(imageId, iso.image.mimeType),
      },
    };
  });

  const isolatedBundle = (() => {
    if (!args.isolatedBundle) return null;
    const imageId = crypto.randomUUID();
    images[imageId] = {
      mimeType: args.isolatedBundle.mimeType,
      dataBase64: args.isolatedBundle.dataBase64,
    };
    return {
      mimeType: args.isolatedBundle.mimeType,
      fileId: imageId,
      url: toUrl(imageId, args.isolatedBundle.mimeType),
    };
  })();

  store.set(previewSessionId, { createdAt: now, images });

  return {
    previewSessionId,
    generated,
    isolatedPerSku,
    isolatedBundle,
  };
}

export function getPreviewSessionImage(
  previewSessionId: string,
  imageId: string,
): PreviewImagePayload | null {
  const now = Date.now();
  cleanupExpired(now);
  const sess = store.get(previewSessionId);
  if (!sess) return null;
  if (now - sess.createdAt > TTL_MS) {
    store.delete(previewSessionId);
    return null;
  }
  const img = sess.images[imageId];
  if (!img) return null;
  return { mimeType: img.mimeType, dataBase64: img.dataBase64 };
}


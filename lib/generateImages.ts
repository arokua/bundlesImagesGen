import {
  ApiError,
  GoogleGenAI,
  Modality,
  createPartFromBase64,
  createPartFromText,
  createUserContent,
} from "@google/genai";

/** Prefer stable image model; preview / 3.x models often have stricter quotas. Override with GEMINI_IMAGE_MODEL. */
const DEFAULT_MODEL = "gemini-2.5-flash-image";

const FIDELITY_BLOCK = `Strict product fidelity (non-negotiable):
- Depict ONLY the real products shown in the reference images below. Arrange them together in one believable e-commerce scene.
- Do NOT add any extra products, props, toys, packaging, labels, text overlays, or objects that are not clearly the same items as in the references.
- Do NOT invent items to match a title, SKU, or marketing text. If something is not in the references, it must not appear.
- Keep each product’s identity (shape, color, material) consistent with the references.`;

const MULTI_PRODUCT_BLOCK = `Multi-product bundle (references are ordered in round-robin: one image per product per cycle, repeating for extra angles):
- Include EVERY distinct product from the references in the final image. Do not omit any product, hide one behind another without intent, or shrink one to an unreadable speck.
- Integrate all items into ONE coherent photograph: same ground plane (table, floor, or mat), one lighting setup, consistent perspective. Each object must sit on that surface with believable contact shadows — no “pasted” or floating cutouts, no mismatched scale between products.
- Do not let one product dominate while others look like separate overlays. Give each referenced product clear, intentional presence in the composition.
- Avoid broken physics: no intersecting solid wood parts, no duplicated rings in impossible stacks, no hands or limbs clipping through products unless interaction is simple and physically plausible. Prefer a clean product-led shot over a busy scene with bad geometry.`;

const STYLE_BLOCK = `Style: professional e-commerce lifestyle shot, high-end soft lighting, neutral minimalist background, no busy clutter.`;

export type ReferenceImage = {
  mimeType: string;
  data: Buffer;
};

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Set GEMINI_API_KEY (or GOOGLE_API_KEY) for image generation.");
  }
  return new GoogleGenAI({ apiKey });
}

function modelId(): string {
  return process.env.GEMINI_IMAGE_MODEL || DEFAULT_MODEL;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableGenAiError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 429 || e.status === 503);
}

function formatGenAiFailure(e: unknown): Error {
  if (e instanceof ApiError) {
    const hint =
      e.status === 429 || /quota|resource.?exhausted|rate/i.test(e.message)
        ? " Quota / rate limit: use a lighter model (e.g. GEMINI_IMAGE_MODEL=gemini-2.5-flash-image), set GEMINI_IMAGES_PER_BUNDLE=1, lower GEMINI_MAX_REFERENCE_IMAGES, enable billing in Google AI Studio, or retry after a few minutes."
        : "";
    return new Error(`${e.message}${hint}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxRetries = Math.max(
    0,
    Number.parseInt(process.env.GEMINI_MAX_RETRIES ?? "4", 10) || 4,
  );
  const baseMs = Math.max(
    500,
    Number.parseInt(process.env.GEMINI_RETRY_BASE_MS ?? "2000", 10) || 2000,
  );
  let last: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRetryableGenAiError(e) || attempt === maxRetries) {
        throw formatGenAiFailure(e);
      }
      const delay = baseMs * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw formatGenAiFailure(last);
}

function includeNameInImagePrompt(): boolean {
  return process.env.GEMINI_IMAGE_PROMPT_INCLUDE_NAME !== "false";
}

function includeDescriptionInImagePrompt(): boolean {
  return process.env.GEMINI_IMAGE_PROMPT_INCLUDE_DESCRIPTION === "true";
}

function defaultImageTemperature(): number {
  const raw = process.env.GEMINI_IMAGE_TEMPERATURE;
  if (raw === undefined || raw === "") return 0.45;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : 0.45;
}

function buildPrompt(params: {
  variationLabel: string;
  bundleName?: string | null;
  bundleDescription?: string | null;
  productCount?: number;
}): string {
  const lines: string[] = [];

  lines.push(FIDELITY_BLOCK);
  lines.push("");
  if (params.productCount !== undefined && params.productCount > 1) {
    lines.push(MULTI_PRODUCT_BLOCK);
    lines.push("");
  }

  if (includeNameInImagePrompt() && params.bundleName?.trim()) {
    lines.push(
      `Catalog context (mood/composition only — do not add products implied by words): "${params.bundleName.trim()}"`,
    );
    lines.push("");
  }

  if (
    includeDescriptionInImagePrompt() &&
    params.bundleDescription?.trim()
  ) {
    lines.push(
      `Notes (styling only — ignore any product names or items mentioned; only use the reference images for what to show): ${params.bundleDescription.trim()}`,
    );
    lines.push("");
  }

  lines.push(STYLE_BLOCK);
  lines.push("");
  lines.push(
    `Shot variation: ${params.variationLabel}. Keep the same products as above; change camera angle, framing, or light direction only — still no unrelated objects.`,
  );
  return lines.join("\n");
}

/** Returns one PNG/JPEG buffer per call (two calls = two unique images). */
export async function generateBundleImage(params: {
  references: ReferenceImage[];
  seed: number;
  variationLabel: string;
  bundleName?: string | null;
  bundleDescription?: string | null;
  /** Master + components; when >1, adds stronger multi-product integration instructions. */
  productCount?: number;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const {
    references,
    seed,
    variationLabel,
    bundleName,
    bundleDescription,
    productCount,
  } = params;
  if (references.length === 0) {
    throw new Error("Need at least one reference image for generation.");
  }

  const ai = getClient();
  const textPrompt = buildPrompt({
    variationLabel,
    bundleName,
    bundleDescription,
    productCount,
  });
  // Text before images: establish constraints first, then show the only allowed product sources.
  const parts = [
    createPartFromText(textPrompt),
    ...references.map((r) =>
      createPartFromBase64(r.data.toString("base64"), r.mimeType),
    ),
  ];

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: modelId(),
      contents: createUserContent(parts),
      config: {
        responseModalities: [Modality.IMAGE],
        temperature: defaultImageTemperature(),
        seed,
      },
    }),
  );

  const b64 = response.data;
  if (!b64) {
    throw new Error(
      "Model returned no image data. Check GEMINI_IMAGE_MODEL and API access.",
    );
  }
  const buffer = Buffer.from(b64, "base64");
  return { buffer, mimeType: "image/png" };
}

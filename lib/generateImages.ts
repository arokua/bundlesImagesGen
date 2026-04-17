import { promises as fs } from "node:fs";
import path from "node:path";
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
- Keep each product’s identity (shape, color, material) consistent with the references.
- Preserve realistic relative scale: do not invent a new size relationship between items; keep each product’s apparent size believable compared to the references.

Printed logos & brand text (critical — common failure mode):
- Do NOT invent, guess, or substitute brand names, stamps, or logos. Never output **fake or mis-spelled** text where a real brand mark appears (e.g. wrong letters like “LISET” / “LSSET” instead of the real mark in the references).
- If references show a logo or stamp on the product (e.g. burned or printed on wood), match that text **exactly** as in the references — same spelling, same capitalization, same letterforms. If you cannot render it **character-for-character** faithfully, **do not** invent a replacement word: instead show **plain wood grain** in that spot, or a **soft, unreadable** impression with **no legible fake letters**.
- Do NOT use the bundle/catalog name, SKU notes, or marketing copy to “fill in” or rewrite a logo. Logos and printed text may come **only** from what is clearly visible in the reference images.
- Do NOT add new watermarks, corner bugs, or slogan text that are not in the references.`;

const MULTI_PRODUCT_BLOCK = `Multi-product bundle (references are ordered in round-robin: one image per product per cycle, repeating for extra angles):
- Include EVERY distinct product from the references in the final image. Do not omit any product, hide one behind another without intent, or shrink one to an unreadable speck.
- Integrate all items into ONE coherent photograph: same ground plane (table, floor, or mat), one lighting setup, consistent perspective. Each object must sit on that surface with believable contact shadows — no “pasted” or floating cutouts, no arbitrary mismatched scale between products.
- Relative size (critical): keep the products’ sizes **in proportion to each other** as implied by the reference images taken together. If the references show product A clearly larger than product B, the final scene must not reverse that or make one item a tiny speck next to a huge one unless the references collectively justify that relationship. Do not randomly rescale products for composition in a way that contradicts their real relative sizes.
- Do not let one product dominate while others look like separate overlays. Give each referenced product clear, intentional presence in the composition.
- Avoid broken physics: no intersecting solid wood parts, no duplicated rings in impossible stacks, no hands or limbs clipping through products unless interaction is simple and physically plausible. Prefer a clean product-led shot over a busy scene with bad geometry.
- Each product’s existing printed branding (if any in the refs) must stay consistent — no swapped or invented logo text between products.`;

const STYLE_BLOCK = `Style: professional e-commerce lifestyle shot, high-end soft lighting, neutral minimalist background, no busy clutter.
- For small printed branding on products: preserve it from the references only; never hallucinate alternate spellings. Prefer compositions where tiny logos stay natural and readable **only** if copied faithfully from the refs — otherwise keep that area visually simple (wood grain, no fake type).`;

const ISOLATED_SINGLE_BLOCK = `Blank-background product isolation:
- Show ONLY the single real product from the reference images below, alone, as a clean studio product shot.
- Background must be a **plain, empty, near-pure white** (~#FFFFFF to #F7F7F7), completely clear of props, surfaces, environment, text, labels, or other products.
- No other SKUs, no additional items — strictly a single-product cutout-style image with soft, realistic contact shadow directly under the product only.
- Preserve the product’s shape, color, materials, and proportions exactly as in the references. Do not invent details or variants.
- Centered, front-facing or the reference’s most representative angle. Fill a reasonable portion of the frame with comfortable margins.`;

const ISOLATED_BUNDLE_BLOCK = `Blank-background full-bundle lineup:
- Show EVERY distinct product from the references arranged together on a **plain, empty, near-pure white** background (~#FFFFFF to #F7F7F7), like an e-commerce hero lineup.
- No environment, no props, no packaging that isn’t part of the product, no text overlays, no invented items.
- Keep products well-separated and fully visible; each item readable; realistic relative sizes preserved exactly as implied by the references (do not randomly rescale one vs another).
- Soft, consistent studio lighting, one shared subtle ground shadow per item. No pasted-cutout look or floating objects.`;

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

/** Optional global hint for stores with one primary brand (e.g. QToys). Reduces wrong spellings on stamps when refs are ambiguous. */
function brandLogoHintBlock(): string | null {
  const raw =
    process.env.GEMINI_BRAND_LOGO_HINT?.trim() ||
    process.env.GEMINI_BRAND_TEXT_HINT?.trim();
  if (!raw) return null;
  return `Brand / logo spelling (store default — use when a stamp or logo appears on the product in the references):
- If the references show a brand mark on the product, the readable text should match **${raw}** unless the reference image clearly shows different spelling; in that case follow the reference image exactly.
- Still do not invent extra slogans or corner logos; this line only constrains spelling of marks that are already implied by the references.`;
}

function lessonsFilePath(): string {
  const override = process.env.BUNDLE_LESSONS_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "LESSONS.md");
}

/** Read `LESSONS.md` (if present) and return a prompt block. Always fresh — no module-level cache. */
export async function readLessonsBlock(): Promise<string | null> {
  try {
    const raw = await fs.readFile(lessonsFilePath(), "utf8");
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return `Lessons learned from previous generations (follow these to avoid repeating mistakes):\n${trimmed}`;
  } catch {
    return null;
  }
}

/** Append a lesson (with timestamp) to `LESSONS.md`. Creates the file if needed. */
export async function appendLesson(lesson: string): Promise<void> {
  const trimmed = lesson.trim();
  if (!trimmed) {
    throw new Error("Empty lesson.");
  }
  const now = new Date().toISOString();
  const entry = `\n- (${now}) ${trimmed}\n`;
  const file = lessonsFilePath();
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    existing = "# Bundle Gen — Lessons Learned\n\nThese notes are automatically included in the image prompt so the model does not repeat past mistakes. Keep them short, concrete, and product-agnostic.\n";
  }
  const header = existing.trim().length === 0
    ? "# Bundle Gen — Lessons Learned\n\nThese notes are automatically included in the image prompt so the model does not repeat past mistakes. Keep them short, concrete, and product-agnostic.\n"
    : existing;
  await fs.writeFile(file, `${header}${entry}`, "utf8");
}

export type PromptKind = "lifestyle" | "isolated-single" | "isolated-bundle";

function buildPrompt(params: {
  kind: PromptKind;
  variationLabel?: string;
  bundleName?: string | null;
  bundleDescription?: string | null;
  productCount?: number;
  lessonsBlock?: string | null;
  /** Per-SKU authoritative guidance (what each product IS). */
  skuNotesBlock?: string | null;
  /** Per-SKU physical dimensions from product data. */
  skuDimensionsBlock?: string | null;
  /** For isolated-single, the label of the product in question, e.g. SKU. */
  isolatedProductLabel?: string;
}): string {
  const lines: string[] = [];

  if (params.kind === "lifestyle") {
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
    const brandHint = brandLogoHintBlock();
    if (brandHint) {
      lines.push("");
      lines.push(brandHint);
    }
    lines.push("");
    lines.push(
      `Shot variation: ${params.variationLabel ?? "primary composition"}. Keep the same products as above; change camera angle, framing, or light direction only — still no unrelated objects.`,
    );
  } else if (params.kind === "isolated-single") {
    lines.push(FIDELITY_BLOCK);
    lines.push("");
    lines.push(ISOLATED_SINGLE_BLOCK);
    if (params.isolatedProductLabel?.trim()) {
      lines.push("");
      lines.push(
        `This image is for SKU "${params.isolatedProductLabel.trim()}". Only that product’s references are provided.`,
      );
    }
    const brandIso = brandLogoHintBlock();
    if (brandIso) {
      lines.push("");
      lines.push(brandIso);
    }
  } else if (params.kind === "isolated-bundle") {
    lines.push(FIDELITY_BLOCK);
    lines.push("");
    if (params.productCount !== undefined && params.productCount > 1) {
      lines.push(MULTI_PRODUCT_BLOCK);
      lines.push("");
    }
    lines.push(ISOLATED_BUNDLE_BLOCK);
    const brandBundle = brandLogoHintBlock();
    if (brandBundle) {
      lines.push("");
      lines.push(brandBundle);
    }
  }

  if (params.skuNotesBlock?.trim()) {
    lines.push("");
    lines.push(params.skuNotesBlock.trim());
  }

  if (params.skuDimensionsBlock?.trim()) {
    lines.push("");
    lines.push(params.skuDimensionsBlock.trim());
  }

  if (params.lessonsBlock?.trim()) {
    lines.push("");
    lines.push(params.lessonsBlock.trim());
  }

  return lines.join("\n");
}

export type GeneratedImage = { buffer: Buffer; mimeType: string };

async function runImageGeneration(
  ai: GoogleGenAI,
  textPrompt: string,
  references: ReferenceImage[],
  seed: number,
): Promise<GeneratedImage> {
  if (references.length === 0) {
    throw new Error("Need at least one reference image for generation.");
  }
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
  return { buffer: Buffer.from(b64, "base64"), mimeType: "image/png" };
}

/** Lifestyle composite of the whole bundle. */
export async function generateBundleImage(params: {
  references: ReferenceImage[];
  seed: number;
  variationLabel: string;
  bundleName?: string | null;
  bundleDescription?: string | null;
  /** Master + components; when >1, adds stronger multi-product integration instructions. */
  productCount?: number;
  lessonsBlock?: string | null;
  skuNotesBlock?: string | null;
  skuDimensionsBlock?: string | null;
}): Promise<GeneratedImage> {
  const ai = getClient();
  const textPrompt = buildPrompt({
    kind: "lifestyle",
    variationLabel: params.variationLabel,
    bundleName: params.bundleName,
    bundleDescription: params.bundleDescription,
    productCount: params.productCount,
    lessonsBlock: params.lessonsBlock,
    skuNotesBlock: params.skuNotesBlock,
    skuDimensionsBlock: params.skuDimensionsBlock,
  });
  return runImageGeneration(ai, textPrompt, params.references, params.seed);
}

/** Isolated blank-background image of a single SKU. */
export async function generateIsolatedSingleImage(params: {
  references: ReferenceImage[];
  seed: number;
  sku: string;
  lessonsBlock?: string | null;
  skuNotesBlock?: string | null;
  skuDimensionsBlock?: string | null;
}): Promise<GeneratedImage> {
  const ai = getClient();
  const textPrompt = buildPrompt({
    kind: "isolated-single",
    isolatedProductLabel: params.sku,
    lessonsBlock: params.lessonsBlock,
    skuNotesBlock: params.skuNotesBlock,
    skuDimensionsBlock: params.skuDimensionsBlock,
  });
  return runImageGeneration(ai, textPrompt, params.references, params.seed);
}

/** Isolated blank-background lineup of the full bundle. */
export async function generateIsolatedBundleImage(params: {
  references: ReferenceImage[];
  seed: number;
  productCount: number;
  lessonsBlock?: string | null;
  skuNotesBlock?: string | null;
  skuDimensionsBlock?: string | null;
}): Promise<GeneratedImage> {
  const ai = getClient();
  const textPrompt = buildPrompt({
    kind: "isolated-bundle",
    productCount: params.productCount,
    lessonsBlock: params.lessonsBlock,
    skuNotesBlock: params.skuNotesBlock,
    skuDimensionsBlock: params.skuDimensionsBlock,
  });
  return runImageGeneration(ai, textPrompt, params.references, params.seed);
}

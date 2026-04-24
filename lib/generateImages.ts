import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
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

const FIDELITY_BLOCK = `Strict reference lock:
- Show only the real product(s) visible in references.
- No extra props, text overlays, watermarks, fake brands, or invented packaging.
- Keep product identity, material, color, and relative size faithful.
- Match reference lighting, lens feel, and realism.

Printed logos / text:
- Never invent or guess logo words.
- If exact letters are unclear, use plain texture instead of fake readable text.
- Never render standalone corner logos or corner brand text in generated pixels.
- Do not add corner logos or brand bugs unless explicitly requested by render settings.`;

const MULTI_PRODUCT_BLOCK = `Multi-product composition:
- Include every referenced product once, clearly visible.
- Keep one coherent scene and realistic shadows.
- Do not place products on tables covered by cloth/blankets.
- Avoid dominant furniture; product must be the focus.
- Preserve relative size across products.`;

const SINGLE_PRODUCT_BLOCK = `Single-product lifestyle:
- Show one product only, centered and prominent.
- Use a clean, minimal scene with no tablecloth/blanket surfaces.
- Keep background warm-neutral and simple (no busy props).`;

const STYLE_BLOCK = `Style:
- Reference-first product photography.
- Clean e-commerce framing; no clutter, no decorative tables.
- Do not reuse the exact same surface/background style for every variation.
- If uncertain, choose fidelity over creativity.`;

/**
 * Always appended for lifestyle prompts (even when users override the main prompt text),
 * so core style/identity lock never disappears.
 */
const STYLE_LOCK_BLOCK = `Style lock (non-negotiable):
- Treat the reference photos as the style source of truth. Match their lighting character, color tone/white balance, contrast, texture realism, lens feel, and framing style.
- Do NOT restyle into a different visual genre (cartoon, CGI/plastic look, heavy HDR, over-smoothed, painterly, glossy ad look) if that is not present in the references.
- Keep wood grain/material finish faithful to references (no artificial color shifts, no fake varnish sheen, no random saturation boost).
- If uncertain between creativity and fidelity, choose fidelity to references.`;

const ISOLATED_SINGLE_BLOCK = `Cream-background product isolation:
- Show ONLY the single real product from the reference images below, alone, as a clean studio product shot.
- Background must be a plain warm cream tone (~#F7F1E3 to #EFE6D6), with no props/surfaces/text.
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

export type RuntimeRenderSettings = {
  addMetalNameTag: boolean;
  addQsafeIcon: boolean;
  qsafeIconUrl: string | null;
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

function keepFirstChars(s: string | null | undefined, maxChars: number): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (maxChars <= 0 || trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trim()}\n...(truncated)`;
}

function maxCharsFor(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultImageTemperature(): number {
  const raw = process.env.GEMINI_IMAGE_TEMPERATURE;
  if (raw === undefined || raw === "") return 0.25;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : 0.25;
}

function includeSkuDimensionsInPrompt(): boolean {
  return process.env.GEMINI_INCLUDE_SKU_DIMENSIONS !== "false";
}

function includeLessonsInPrompt(): boolean {
  return process.env.GEMINI_INCLUDE_LESSONS !== "false";
}

function includeGlobalRulesInPrompt(): boolean {
  return process.env.GEMINI_INCLUDE_GLOBAL_RULES !== "false";
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
  /** Saved global rules from the UI (data/bundle-prompt-rules.txt). */
  globalRulesBlock?: string | null;
  /**
   * Replaces the built-in lifestyle block (fidelity + multi/single + style + shot line).
   * When set, SKU notes / dimensions / lessons / global rules are still appended after.
   */
  lifestylePromptPrefixOverride?: string | null;
}): string {
  const lines: string[] = [];

  if (params.kind === "lifestyle") {
    const custom = params.lifestylePromptPrefixOverride?.trim();
    if (custom) {
      lines.push(custom);
      lines.push("");
      lines.push(STYLE_LOCK_BLOCK);
      lines.push("");
      lines.push(
        `Variation direction: ${params.variationLabel ?? "primary composition"}. Keep product identity and realism, but allow meaningful environment variation (surface/background/framing) instead of near-duplicate shots.`,
      );
    } else {
      lines.push(FIDELITY_BLOCK);
      lines.push("");
      if (params.productCount !== undefined && params.productCount > 1) {
        lines.push(MULTI_PRODUCT_BLOCK);
        lines.push("");
      } else {
        lines.push(SINGLE_PRODUCT_BLOCK);
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
      lines.push(STYLE_LOCK_BLOCK);
      const brandHint = brandLogoHintBlock();
      if (brandHint) {
        lines.push("");
        lines.push(brandHint);
      }
      lines.push("");
      lines.push(
        `Shot variation: ${params.variationLabel ?? "primary composition"}. Keep the same products, but vary scene setup naturally. At least one variation should avoid a plain tabletop look (e.g. playroom floor, shelf, rug, or toy-room corner).`,
      );
    }
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

  const boundedNotes = keepFirstChars(
    params.skuNotesBlock,
    maxCharsFor("GEMINI_MAX_SKU_NOTES_CHARS", 1200),
  );
  if (boundedNotes) {
    lines.push("");
    lines.push(boundedNotes);
  }

  const boundedDimensions = includeSkuDimensionsInPrompt()
    ? keepFirstChars(
        params.skuDimensionsBlock,
        maxCharsFor("GEMINI_MAX_DIMENSIONS_CHARS", 800),
      )
    : null;
  if (boundedDimensions) {
    lines.push("");
    lines.push(boundedDimensions);
  }

  const boundedLessons = includeLessonsInPrompt()
    ? keepFirstChars(
        params.lessonsBlock,
        maxCharsFor("GEMINI_MAX_LESSONS_CHARS", 1200),
      )
    : null;
  if (boundedLessons) {
    lines.push("");
    lines.push(boundedLessons);
  }

  const boundedRules = includeGlobalRulesInPrompt()
    ? keepFirstChars(
        params.globalRulesBlock,
        maxCharsFor("GEMINI_MAX_GLOBAL_RULES_CHARS", 1200),
      )
    : null;
  if (boundedRules) {
    lines.push("");
    lines.push("User-defined generation rules (apply to this run):");
    lines.push(boundedRules);
  }

  return lines.join("\n");
}

/**
 * Snapshot of the built-in **lifestyle** text prompt (before per-run SKU notes, dimensions,
 * product lessons, and saved global rules). Uses multi-product wording when `productCount > 1`.
 */
export function getDefaultLifestylePromptPreview(
  productCount: number = 2,
): string {
  return buildPrompt({
    kind: "lifestyle",
    variationLabel: "primary composition",
    bundleName: null,
    bundleDescription: null,
    productCount: productCount > 1 ? productCount : 1,
    lessonsBlock: null,
    skuNotesBlock: null,
    skuDimensionsBlock: null,
    globalRulesBlock: null,
    lifestylePromptPrefixOverride: null,
  });
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

const qsafeIconCache = new Map<string, Buffer>();

async function fetchQsafeIcon(url: string): Promise<Buffer | null> {
  const cached = qsafeIconCache.get(url);
  if (cached) return cached;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    if (buf.length === 0) return null;
    qsafeIconCache.set(url, buf);
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function applyBundleDecorations(
  image: GeneratedImage,
  productCount: number | undefined,
  renderSettings: RuntimeRenderSettings | null | undefined,
): Promise<GeneratedImage> {
  if (!renderSettings) return image;
  const base = sharp(image.buffer);
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 16 || height < 16) return image;

  const overlays: sharp.OverlayOptions[] = [];
  const margin = Math.max(12, Math.round(width * 0.02));

  if (
    renderSettings.addQsafeIcon &&
    productCount !== undefined &&
    productCount > 1 &&
    renderSettings.qsafeIconUrl
  ) {
    const icon = await fetchQsafeIcon(renderSettings.qsafeIconUrl);
    if (icon) {
      const maxW = Math.max(24, Math.round(width * 0.19));
      const maxH = Math.max(24, Math.round(height * 0.29));
      const iconBuf = await sharp(icon)
        .resize({ width: maxW, height: maxH, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      const iconMeta = await sharp(iconBuf).metadata();
      const w = iconMeta.width ?? maxW;
      overlays.push({
        input: iconBuf,
        left: Math.max(0, width - w - margin),
        top: margin,
      });
    }
  }

  if (overlays.length === 0) return image;
  const out = await base.composite(overlays).png().toBuffer();
  return { buffer: out, mimeType: "image/png" };
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
  globalRulesBlock?: string | null;
  /** Full lifestyle prefix from UI / data/bundle-lifestyle-prefix.json (optional). */
  lifestylePromptPrefixOverride?: string | null;
  renderSettings?: RuntimeRenderSettings | null;
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
    globalRulesBlock: params.globalRulesBlock,
    lifestylePromptPrefixOverride: params.lifestylePromptPrefixOverride,
  });
  const generated = await runImageGeneration(
    ai,
    textPrompt,
    params.references,
    params.seed,
  );
  return applyBundleDecorations(
    generated,
    params.productCount,
    params.renderSettings,
  );
}

/** Isolated blank-background image of a single SKU. */
export async function generateIsolatedSingleImage(params: {
  references: ReferenceImage[];
  seed: number;
  sku: string;
  lessonsBlock?: string | null;
  skuNotesBlock?: string | null;
  skuDimensionsBlock?: string | null;
  globalRulesBlock?: string | null;
}): Promise<GeneratedImage> {
  const ai = getClient();
  const textPrompt = buildPrompt({
    kind: "isolated-single",
    isolatedProductLabel: params.sku,
    lessonsBlock: params.lessonsBlock,
    skuNotesBlock: params.skuNotesBlock,
    skuDimensionsBlock: params.skuDimensionsBlock,
    globalRulesBlock: params.globalRulesBlock,
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
  globalRulesBlock?: string | null;
}): Promise<GeneratedImage> {
  const ai = getClient();
  const textPrompt = buildPrompt({
    kind: "isolated-bundle",
    productCount: params.productCount,
    lessonsBlock: params.lessonsBlock,
    skuNotesBlock: params.skuNotesBlock,
    skuDimensionsBlock: params.skuDimensionsBlock,
    globalRulesBlock: params.globalRulesBlock,
  });
  return runImageGeneration(ai, textPrompt, params.references, params.seed);
}

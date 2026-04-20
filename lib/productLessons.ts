import { promises as fs } from "node:fs";
import path from "node:path";

type Store = { byMasterSku: Record<string, string[]> };

function storePath(): string {
  const override = process.env.BUNDLE_PRODUCT_LESSONS_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "data", "product-lessons.json");
}

async function readStore(): Promise<Store> {
  const file = storePath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed.byMasterSku || typeof parsed.byMasterSku !== "object") {
      return { byMasterSku: {} };
    }
    return parsed;
  } catch {
    return { byMasterSku: {} };
  }
}

async function writeStore(store: Store): Promise<void> {
  const file = storePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function normalizeSku(sku: string): string {
  return sku.trim();
}

/** Append a timestamped lesson for this master SKU only (keyed storage — only this product’s notes are injected on retry). */
export async function appendProductLesson(
  masterSku: string,
  lesson: string,
): Promise<void> {
  const sku = normalizeSku(masterSku);
  const trimmed = lesson.trim();
  if (!sku) throw new Error("Missing master SKU for product lesson.");
  if (!trimmed) throw new Error("Empty lesson.");

  const now = new Date().toISOString();
  const entry = `(${now}) ${trimmed}`;
  const store = await readStore();
  const prev = store.byMasterSku[sku] ?? [];
  store.byMasterSku[sku] = [...prev, entry];
  await writeStore(store);
}

/** Format lessons for the given master SKU only (token-efficient vs full LESSONS.md). */
export async function formatProductLessonsBlock(
  masterSku: string,
): Promise<string | null> {
  const sku = normalizeSku(masterSku);
  if (!sku) return null;
  const store = await readStore();
  const list = store.byMasterSku[sku];
  if (!list?.length) return null;
  const body = list.map((line) => `- ${line}`).join("\n");
  return `Product-specific lessons for master SKU "${sku}" (apply on every generation for this product line):\n${body}`;
}

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Per-SKU notes — human-editable guidance that travels with a SKU across every bundle.
 * Stored in `SKU_NOTES.md` using simple `## <SKU>` sections. Read fresh on every generation.
 */

const TEMPLATE = `# Bundle Gen — Per-SKU Notes

These notes are injected into the image prompt whenever a bundle contains the matching SKU, so the model knows exactly what that SKU *is* (and what it isn't).

Format: one section per SKU, starting with \`## <SKU>\`, followed by free-form text. Keep it short and concrete. Example:

<!--
## 878
Main product = the wooden coin sorting box with sliding lid. The stacking rings visible in some references are unrelated accessories — do not treat them as the primary item for SKU 878.
-->
`;

export type SkuNote = { sku: string; note: string };

function filePath(): string {
  const override = process.env.BUNDLE_SKU_NOTES_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "SKU_NOTES.md");
}

function parseSkuNotes(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  let currentSku: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentSku !== null) {
      const note = buffer.join("\n").trim();
      if (note.length > 0) map.set(currentSku, note);
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      currentSku = m[1].trim();
      buffer = [];
    } else if (currentSku !== null) {
      buffer.push(line);
    }
  }
  flush();
  return map;
}

async function readRaw(): Promise<string> {
  try {
    return await fs.readFile(filePath(), "utf8");
  } catch {
    return "";
  }
}

export async function readSkuNotesMap(): Promise<Map<string, string>> {
  const raw = await readRaw();
  return parseSkuNotes(raw);
}

export async function getSkuNote(sku: string): Promise<string | null> {
  if (!sku.trim()) return null;
  const map = await readSkuNotesMap();
  return map.get(sku.trim()) ?? null;
}

export async function getSkuNotesFor(skus: string[]): Promise<SkuNote[]> {
  const map = await readSkuNotesMap();
  const seen = new Set<string>();
  const out: SkuNote[] = [];
  for (const s of skus) {
    const key = s.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const note = map.get(key);
    if (note) out.push({ sku: key, note });
  }
  return out;
}

/** Build a prompt block describing per-SKU guidance. Returns null if nothing to add. */
export function formatSkuNotesBlock(notes: SkuNote[] | undefined): string | null {
  if (!notes || notes.length === 0) return null;
  const lines: string[] = [
    "SKU-specific guidance (authoritative — describes what each product actually is; treat these as ground truth, overriding any ambiguous reference image):",
  ];
  for (const { sku, note } of notes) {
    const flat = note.replace(/\s+/g, " ").trim();
    lines.push(`- SKU ${sku}: ${flat}`);
  }
  lines.push(
    "If a reference image for a SKU shows multiple objects, use these notes to decide which object is the main product. Do not feature accessories as the main item.",
  );
  return lines.join("\n");
}

export async function setSkuNote(sku: string, note: string): Promise<void> {
  const trimmedSku = sku.trim();
  if (!trimmedSku) throw new Error("Empty SKU.");
  const trimmedNote = note.trim();

  const raw = await readRaw();
  const map = parseSkuNotes(raw);
  if (trimmedNote.length === 0) {
    map.delete(trimmedSku);
  } else {
    map.set(trimmedSku, trimmedNote);
  }

  const firstHeadingIdx = raw.search(/^##\s+/m);
  const headerSource = raw.trim().length === 0 ? TEMPLATE : raw;
  const header =
    firstHeadingIdx === -1
      ? headerSource.trimEnd()
      : headerSource.slice(0, firstHeadingIdx).trimEnd();

  const sorted = [...map.entries()].sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  const body = sorted.map(([s, n]) => `## ${s}\n${n}`).join("\n\n");
  const out = body.length === 0 ? `${header}\n` : `${header}\n\n${body}\n`;
  await fs.writeFile(filePath(), out, "utf8");
}

import type { ParsedBundle } from "./parseSkus";

function sanitizeSegment(s: string): string {
  return s
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Output folder name: `{SKU1 SKU2 …} {name}` when a display name exists (SKUs first, then name).
 * If there is no name, `{SKU1_SKU2}_Bundle` (legacy).
 */
/** Safe filename stem from bundle SKUs in order (master first): e.g. `123_432`. */
export function bundleFilenameStem(skus: string[]): string {
  const parts = skus
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s
        .replace(/[/\\?%*:|"<>]/g, "_")
        .replace(/\s+/gu, "_")
        .replace(/_+/gu, "_"),
    )
    .filter(Boolean);
  let stem = parts.join("_");
  if (!stem) stem = "bundle";
  if (stem.length > 120) stem = stem.slice(0, 120);
  return stem;
}

/**
 * SKU order for Drive filenames when the client omits or shortens `allSkus`.
 * Prefer explicit `bodySkus` unless reference copies prove more SKUs exist (defensive).
 */
function dedupeSkuPreserveOrder(skus: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of skus) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function skuOrderForFilenames(
  masterSku: string,
  bodySkus: string[],
  referenceSourceFiles: { sku: string }[],
): string[] {
  const body = dedupeSkuPreserveOrder(bodySkus);
  const uniqFromRefs = [
    ...new Set(
      referenceSourceFiles.map((r) => r.sku.trim()).filter(Boolean),
    ),
  ];
  let orderedRefs: string[] = [];
  if (uniqFromRefs.length > 0) {
    const m = masterSku.trim();
    if (m && uniqFromRefs.includes(m)) {
      orderedRefs = [
        m,
        ...uniqFromRefs
          .filter((s) => s !== m)
          .sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
          ),
      ];
    } else {
      orderedRefs = uniqFromRefs.sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
      );
    }
  }

  if (body.length >= orderedRefs.length && body.length > 0) {
    return body;
  }
  if (orderedRefs.length > 0) {
    return orderedRefs;
  }
  if (body.length > 0) {
    return body;
  }
  const mc = masterSku.trim();
  return mc ? [mc] : [];
}

export function driveFolderName(bundle: ParsedBundle, skus: string[]): string {
  const skuSegment = skus.join(" ");
  const raw = bundle.name?.trim();
  if (!raw) {
    return `${skus.join(" ")}_Bundle`;
  }
  const safeName = sanitizeSegment(raw).slice(0, 100);
  if (!safeName) {
    return `${skus.join(" ")}_Bundle`;
  }
  const combined = `${skuSegment} ${safeName}`.trim();
  return combined.slice(0, 200);
}

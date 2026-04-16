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

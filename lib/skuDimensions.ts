type RawStoreProduct = {
  sku?: unknown;
  name?: unknown;
  permalink?: unknown;
  description?: unknown;
  short_description?: unknown;
  dimensions?: unknown;
  dimension?: unknown;
  attributes?: unknown;
  extensions?: unknown;
};

export type SkuDimension = {
  sku: string;
  dimensionsText: string;
  source: "dimensions-field" | "attributes" | "description";
  productName?: string;
  productUrl?: string;
};

const skuDimensionCache = new Map<
  string,
  { value: SkuDimension | null; expiresAt: number }
>();

function endpointBase(): string {
  return (
    process.env.BUNDLE_WC_PRODUCTS_ENDPOINT?.trim() ||
    "https://qtoys.com.au/wp-json/wc/store/v1/products"
  );
}

function timeoutMs(): number {
  const raw = Number.parseInt(
    process.env.BUNDLE_WC_PRODUCTS_TIMEOUT_MS ?? "8000",
    10,
  );
  return Number.isFinite(raw) && raw >= 1000 ? raw : 8000;
}

function cacheTtlMs(): number {
  const raw = Number.parseInt(
    process.env.BUNDLE_WC_PRODUCTS_CACHE_TTL_MS ?? "21600000",
    10,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : 21_600_000;
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").replace(/×/g, "x").trim();
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function buildSkuUrl(sku: string): string {
  const u = new URL(endpointBase());
  u.searchParams.set("sku", sku);
  return u.toString();
}

function parseDimensionsLike(value: unknown): string | null {
  if (typeof value === "string") {
    const t = normalizeText(value);
    if (!t) return null;
    return t;
  }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const length = typeof obj.length === "string" ? obj.length.trim() : "";
  const width = typeof obj.width === "string" ? obj.width.trim() : "";
  const height = typeof obj.height === "string" ? obj.height.trim() : "";
  const unit =
    typeof obj.unit === "string" && obj.unit.trim().length > 0
      ? obj.unit.trim()
      : "cm";
  const nums = [length, width, height].filter(Boolean);
  if (nums.length >= 2) {
    return `${nums.join(" x ")} ${unit}`;
  }
  if (nums.length === 1) {
    return `${nums[0]} ${unit}`;
  }
  return null;
}

function parseDimensionsFromAttributes(attrs: unknown): string | null {
  if (!Array.isArray(attrs)) return null;
  for (const attr of attrs) {
    if (!attr || typeof attr !== "object") continue;
    const a = attr as Record<string, unknown>;
    const name = typeof a.name === "string" ? a.name.toLowerCase() : "";
    if (!/dimension|size/.test(name)) continue;
    if (Array.isArray(a.terms)) {
      const terms = a.terms
        .map((t) => {
          if (!t || typeof t !== "object") return "";
          const n = (t as Record<string, unknown>).name;
          return typeof n === "string" ? n.trim() : "";
        })
        .filter(Boolean);
      if (terms.length > 0) {
        return normalizeText(terms.join(", "));
      }
    }
  }
  return null;
}

function parseDimensionsFromDescription(product: RawStoreProduct): string | null {
  const desc =
    (typeof product.description === "string" ? product.description : "") +
    " " +
    (typeof product.short_description === "string"
      ? product.short_description
      : "");
  const txt = normalizeText(stripHtml(desc));
  if (!txt) return null;
  const explicit =
    /\b(?:approx(?:imate(?:ly)?)?\s*)?(?:dimensions?|size)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?\s*[x]\s*[0-9]+(?:\.[0-9]+)?(?:\s*[x]\s*[0-9]+(?:\.[0-9]+)?)?\s*(?:cm|cms|mm|m|in|inch|inches)?)\b/i.exec(
      txt,
    )?.[1] ?? "";
  if (explicit) return normalizeText(explicit);

  const generic =
    /\b([0-9]+(?:\.[0-9]+)?\s*[x]\s*[0-9]+(?:\.[0-9]+)?(?:\s*[x]\s*[0-9]+(?:\.[0-9]+)?)?\s*(?:cm|cms|mm|m|in|inch|inches))\b/i.exec(
      txt,
    )?.[1] ?? "";
  return generic ? normalizeText(generic) : null;
}

function pickBestProduct(products: RawStoreProduct[], sku: string): RawStoreProduct {
  const exact = products.find(
    (p) => typeof p.sku === "string" && p.sku.trim() === sku,
  );
  return exact ?? products[0];
}

async function fetchStoreProductsBySku(sku: string): Promise<RawStoreProduct[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const res = await fetch(buildSkuUrl(sku), {
      method: "GET",
      signal: ac.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as RawStoreProduct[]) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOneSkuDimension(skuRaw: string): Promise<SkuDimension | null> {
  const sku = skuRaw.trim();
  if (!sku) return null;
  const now = Date.now();
  const cached = skuDimensionCache.get(sku);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const products = await fetchStoreProductsBySku(sku);
  if (products.length === 0) {
    skuDimensionCache.set(sku, { value: null, expiresAt: now + cacheTtlMs() });
    return null;
  }

  const product = pickBestProduct(products, sku);
  const productName = typeof product.name === "string" ? product.name : undefined;
  const productUrl =
    typeof product.permalink === "string" ? product.permalink : undefined;

  const fromField =
    parseDimensionsLike(product.dimensions) ||
    parseDimensionsLike(product.dimension) ||
    parseDimensionsLike(
      (product.extensions as Record<string, unknown> | undefined)?.dimensions,
    );
  if (fromField) {
    const out: SkuDimension = {
      sku,
      dimensionsText: normalizeText(fromField),
      source: "dimensions-field",
      productName,
      productUrl,
    };
    skuDimensionCache.set(sku, { value: out, expiresAt: now + cacheTtlMs() });
    return out;
  }

  const fromAttrs = parseDimensionsFromAttributes(product.attributes);
  if (fromAttrs) {
    const out: SkuDimension = {
      sku,
      dimensionsText: fromAttrs,
      source: "attributes",
      productName,
      productUrl,
    };
    skuDimensionCache.set(sku, { value: out, expiresAt: now + cacheTtlMs() });
    return out;
  }

  const fromDesc = parseDimensionsFromDescription(product);
  if (fromDesc) {
    const out: SkuDimension = {
      sku,
      dimensionsText: fromDesc,
      source: "description",
      productName,
      productUrl,
    };
    skuDimensionCache.set(sku, { value: out, expiresAt: now + cacheTtlMs() });
    return out;
  }

  skuDimensionCache.set(sku, { value: null, expiresAt: now + cacheTtlMs() });
  return null;
}

export async function fetchSkuDimensionsFor(skus: string[]): Promise<SkuDimension[]> {
  const seen = new Set<string>();
  const unique = skus.map((s) => s.trim()).filter((s) => {
    if (!s || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  const resolved = await Promise.all(unique.map((s) => fetchOneSkuDimension(s)));
  return resolved.filter((x): x is SkuDimension => x !== null);
}

export function formatSkuDimensionsBlock(
  dims: SkuDimension[] | undefined,
): string | null {
  if (!dims || dims.length === 0) return null;
  const lines: string[] = [
    "SKU size constraints from qtoys.com.au product data (apply alongside image references):",
  ];
  for (const d of dims) {
    const name = d.productName ? ` (${d.productName})` : "";
    lines.push(`- SKU ${d.sku}${name}: ${d.dimensionsText}.`);
  }
  lines.push(
    "Use these dimensions to preserve realistic relative scale between SKUs. If image perspective is ambiguous, prefer these size constraints over guessing.",
  );
  return lines.join("\n");
}

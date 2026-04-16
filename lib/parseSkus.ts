const SPLIT_RE = /[\s,]+/u;

/** Minimal CSV parser (supports quoted fields and commas inside quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.length > 0) || rows.length === 0) {
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(h: string): string {
  return h.trim().replace(/^\uFEFF/, "").toLowerCase();
}

function findCol(headers: string[], ...names: string[]): number {
  const norm = headers.map(normalizeHeader);
  for (const n of names) {
    const i = norm.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function normalizeSkuCell(skuCell: string): string {
  return skuCell.replace(/\s+/gu, " ").trim();
}

function parseSkuTokens(skuCell: string): string[] {
  const normalized = normalizeSkuCell(skuCell);
  return normalized
    .split(SPLIT_RE)
    .map((t) => t.trim())
    .filter(Boolean);
}

export type ParsedBundle = {
  lineIndex: number;
  /** Display / marketing name when provided (CSV or named text). */
  name: string | null;
  /** Extra copy for the model (CSV column). */
  description: string | null;
  master: string;
  components: string[];
};

function pushBundle(
  bundles: ParsedBundle[],
  errors: string[],
  lineIndex: number,
  name: string | null,
  description: string | null,
  tokens: string[],
) {
  if (tokens.length < 2) {
    errors.push(
      `Line ${lineIndex + 1}: need at least two SKUs (master + one component).`,
    );
    return;
  }
  bundles.push({
    lineIndex,
    name: name?.trim() || null,
    description: description?.trim() || null,
    master: tokens[0],
    components: tokens.slice(1),
  });
}

/**
 * Reads fixed columns from the header row. For wide exports (Name, SKU, Weight, …,
 * Description, …), **SKU is only** `row[skuI]` (e.g. `672 566 021` in one cell).
 *
 * **Description** is `row[descI]`, not the last column (`Publish`, etc.).
 *
 * **Only** for a minimal 3-column sheet `Name, SKU, Description`, if commas split
 * the SKU into extra cells, merge `row.slice(skuI, row.length - 1)` and use the
 * last cell as description.
 */
function extractCsvNameSkuDesc(
  row: string[],
  headerCount: number,
  nameI: number,
  skuI: number,
  descI: number,
): { nameVal: string; skuVal: string; descVal: string } {
  const nameVal = row[nameI]?.trim() ?? "";

  if (descI >= 0) {
    const isMinimalNameSkuDesc =
      headerCount === 3 &&
      nameI === 0 &&
      skuI === 1 &&
      descI === 2;

    if (isMinimalNameSkuDesc && row.length > headerCount) {
      return {
        nameVal,
        skuVal: row.slice(skuI, row.length - 1).join(" ").trim(),
        descVal: row[row.length - 1]?.trim() ?? "",
      };
    }

    return {
      nameVal,
      skuVal: row[skuI]?.trim() ?? "",
      descVal: row[descI]?.trim() ?? "",
    };
  }

  return {
    nameVal,
    skuVal: row[skuI]?.trim() ?? "",
    descVal: "",
  };
}

function parseCsvBundles(
  raw: string,
): { bundles: ParsedBundle[]; errors: string[] } {
  const errors: string[] = [];
  const bundles: ParsedBundle[] = [];
  const rows = parseCsv(raw.trim());
  if (rows.length < 2) {
    errors.push("CSV: need a header row and at least one data row.");
    return { bundles, errors };
  }

  const headers = rows[0].map((h) => h.trim());
  const nameI = findCol(headers, "name", "bundle name", "bundle_name");
  const skuI = findCol(headers, "sku", "skus");
  const descI = findCol(headers, "description", "desc", "notes", "details");

  if (nameI < 0 || skuI < 0) {
    errors.push(
      'CSV: header row must include columns "name" (or bundle name) and "SKU" (or skus).',
    );
    return { bundles, errors };
  }

  const headerCount = headers.length;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((c) => !String(c).trim())) continue;

    const { nameVal, skuVal, descVal } = extractCsvNameSkuDesc(
      row,
      headerCount,
      nameI,
      skuI,
      descI,
    );

    if (!skuVal) {
      errors.push(`CSV row ${r + 1}: SKU column is empty.`);
      continue;
    }
    const tokens = parseSkuTokens(skuVal);
    pushBundle(bundles, errors, r, nameVal || null, descVal || null, tokens);
  }

  return { bundles, errors };
}

function looksLikeNameSkuCsv(firstLine: string): boolean {
  const rows = parseCsv(firstLine);
  const headers = (rows[0] ?? []).map(normalizeHeader);
  const hasName =
    headers.includes("name") ||
    headers.includes("bundle name") ||
    headers.includes("bundle_name");
  const hasSku = headers.includes("sku") || headers.includes("skus");
  return hasName && hasSku;
}

/**
 * Split display name from SKU list. Only the right-hand side is used for Drive folder matching.
 * Supports ASCII `|`, fullwidth `｜` (common paste from docs/sheets), and tab.
 * Colon is a fallback separator (first `:` only).
 */
function splitNamedLine(line: string): { name: string; rest: string } | null {
  const pipeMatch = line.match(/^(.+?)\s*(\||｜)\s*(.+)$/u);
  if (pipeMatch) {
    const name = pipeMatch[1].trim();
    const rest = pipeMatch[3].trim();
    if (name && rest) return { name, rest };
  }

  const tabMatch = line.match(/^(.+?)\t+(.+)$/u);
  if (tabMatch) {
    const name = tabMatch[1].trim();
    const rest = tabMatch[2].trim();
    if (name && rest) return { name, rest };
  }

  const colon = line.indexOf(":");
  if (colon > 0) {
    const name = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (name && rest) return { name, rest };
  }
  return null;
}

function parsePlainLines(
  raw: string,
): { bundles: ParsedBundle[]; errors: string[] } {
  const errors: string[] = [];
  const bundles: ParsedBundle[] = [];
  const lines = raw.split(/\r?\n/u);

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const named = splitNamedLine(trimmed);
    if (named) {
      const tokens = parseSkuTokens(named.rest);
      pushBundle(bundles, errors, lineIndex, named.name, null, tokens);
      return;
    }

    const tokens = parseSkuTokens(trimmed);
    pushBundle(bundles, errors, lineIndex, null, null, tokens);
  });

  return { bundles, errors };
}

/**
 * Accepts:
 * - CSV with headers including **name** and **SKU** (optional **description**).
 * - Plain text: one bundle per line — either `SKUs only`, or `Name: SKU1 SKU2` / `Name | SKU1 SKU2`.
 */
export function parseBundleInput(raw: string): {
  bundles: ParsedBundle[];
  errors: string[];
  format: "csv" | "plain";
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { bundles: [], errors: [], format: "plain" };
  }

  const firstLine = trimmed.split(/\r?\n/u)[0] ?? "";
  if (looksLikeNameSkuCsv(firstLine)) {
    const { bundles, errors } = parseCsvBundles(trimmed);
    return { bundles, errors, format: "csv" };
  }

  const { bundles, errors } = parsePlainLines(trimmed);
  return { bundles, errors, format: "plain" };
}

/** @deprecated Use parseBundleInput — kept for call sites that only need bundles/errors. */
export function parseBundleLines(raw: string): {
  bundles: ParsedBundle[];
  errors: string[];
} {
  const { bundles, errors } = parseBundleInput(raw);
  return { bundles, errors };
}

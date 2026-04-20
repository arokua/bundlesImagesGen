import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_LEN = 48_000;

function filePath(): string {
  const override = process.env.BUNDLE_LIFESTYLE_PREFIX_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "data", "bundle-lifestyle-prefix.json");
}

export type LifestylePrefixOverrides = {
  multi: string | null;
  single: string | null;
};

export async function readLifestylePrefixOverrides(): Promise<LifestylePrefixOverrides> {
  try {
    const raw = await fs.readFile(filePath(), "utf8");
    const j = JSON.parse(raw) as { multi?: unknown; single?: unknown };
    const multi =
      typeof j.multi === "string" && j.multi.trim() ? j.multi.trim() : null;
    const single =
      typeof j.single === "string" && j.single.trim() ? j.single.trim() : null;
    return { multi, single };
  } catch {
    return { multi: null, single: null };
  }
}

export async function writeLifestylePrefixOverrides(
  multi: string,
  single: string,
): Promise<void> {
  const m = multi.trim();
  const s = single.trim();
  if (m.length > MAX_LEN || s.length > MAX_LEN) {
    throw new Error(
      `Keep each lifestyle prefix under ${MAX_LEN} characters.`,
    );
  }
  const file = filePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ multi: m, single: s }, null, 2),
    "utf8",
  );
}

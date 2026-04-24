import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_ICON_URL_LEN = 2048;

export type RenderSettings = {
  addMetalNameTag: boolean;
  addQsafeIcon: boolean;
  qsafeIconUrl: string | null;
};

function filePath(): string {
  const override = process.env.BUNDLE_RENDER_SETTINGS_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "data", "bundle-render-settings.json");
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_ICON_URL_LEN) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function defaultsFromEnv(): RenderSettings {
  return {
    addMetalNameTag: envBool("GEMINI_ADD_METAL_NAME_TAG", false),
    addQsafeIcon: envBool("GEMINI_ADD_QSAFE_ICON", false),
    qsafeIconUrl:
      normalizeUrl(process.env.GEMINI_QSAFE_ICON_URL) ||
      normalizeUrl(process.env.QSAFE_ICON_URL),
  };
}

export async function readRenderSettings(): Promise<RenderSettings> {
  const env = defaultsFromEnv();
  try {
    const raw = await fs.readFile(filePath(), "utf8");
    const j = JSON.parse(raw) as {
      addMetalNameTag?: unknown;
      addQsafeIcon?: unknown;
      qsafeIconUrl?: unknown;
    };
    return {
      addMetalNameTag:
        typeof j.addMetalNameTag === "boolean"
          ? j.addMetalNameTag
          : env.addMetalNameTag,
      addQsafeIcon:
        typeof j.addQsafeIcon === "boolean" ? j.addQsafeIcon : env.addQsafeIcon,
      qsafeIconUrl: normalizeUrl(j.qsafeIconUrl) ?? env.qsafeIconUrl,
    };
  } catch {
    return env;
  }
}

export async function writeRenderSettings(
  input: RenderSettings,
): Promise<RenderSettings> {
  const normalized: RenderSettings = {
    addMetalNameTag: !!input.addMetalNameTag,
    addQsafeIcon: !!input.addQsafeIcon,
    qsafeIconUrl: normalizeUrl(input.qsafeIconUrl),
  };
  const file = filePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}


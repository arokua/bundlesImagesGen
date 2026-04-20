import { promises as fs } from "node:fs";
import path from "node:path";

function rulesPath(): string {
  const override = process.env.BUNDLE_PROMPT_RULES_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "data", "bundle-prompt-rules.txt");
}

/** Editable global rules appended to every image prompt (saved from the UI). */
export async function readGlobalPromptRules(): Promise<string | null> {
  try {
    const raw = await fs.readFile(rulesPath(), "utf8");
    const t = raw.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export async function writeGlobalPromptRules(text: string): Promise<void> {
  const file = rulesPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

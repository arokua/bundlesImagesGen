import { NextResponse } from "next/server";
import { getDefaultLifestylePromptPreview } from "@/lib/generateImages";
import {
  readLifestylePrefixOverrides,
  writeLifestylePrefixOverrides,
} from "@/lib/lifestylePrefixOverrides";
import { readGlobalPromptRules, writeGlobalPromptRules } from "@/lib/promptRules";
import {
  readRenderSettings,
  writeRenderSettings,
  type RenderSettings,
} from "@/lib/renderSettings";

export const maxDuration = 15;

export async function GET() {
  const requestId = crypto.randomUUID();
  const rules = await readGlobalPromptRules();
  const lifestyle = await readLifestylePrefixOverrides();
  const renderSettings = await readRenderSettings();
  return NextResponse.json(
    {
      ok: true,
      rules: rules ?? "",
      defaultLifestylePromptMulti: getDefaultLifestylePromptPreview(2),
      defaultLifestylePromptSingle: getDefaultLifestylePromptPreview(1),
      lifestylePrefixMulti: lifestyle.multi,
      lifestylePrefixSingle: lifestyle.single,
      renderSettings,
    },
    { headers: { "x-request-id": requestId } },
  );
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const json = (body: unknown, status = 200) =>
    NextResponse.json(body, {
      status,
      headers: { "x-request-id": requestId },
    });
  let body: {
    rules?: string;
    lifestylePrefixMulti?: string;
    lifestylePrefixSingle?: string;
    renderSettings?: Partial<RenderSettings>;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const rules = body.rules ?? "";
  if (rules.length > 12000) {
    return json(
      { error: "Keep global prompt rules under 12000 characters." },
      400,
    );
  }

  try {
    await writeGlobalPromptRules(rules);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save rules.";
    return json({ error: msg }, 500);
  }

  const hasLifestyle =
    typeof body.lifestylePrefixMulti === "string" ||
    typeof body.lifestylePrefixSingle === "string";
  if (hasLifestyle) {
    try {
      const cur = await readLifestylePrefixOverrides();
      const multi =
        typeof body.lifestylePrefixMulti === "string"
          ? body.lifestylePrefixMulti
          : (cur.multi ?? "");
      const single =
        typeof body.lifestylePrefixSingle === "string"
          ? body.lifestylePrefixSingle
          : (cur.single ?? "");
      await writeLifestylePrefixOverrides(multi, single);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save lifestyle prefix.";
      return json({ error: msg }, 500);
    }
  }

  if (body.renderSettings && typeof body.renderSettings === "object") {
    const cur = await readRenderSettings();
    try {
      await writeRenderSettings({
        addMetalNameTag:
          typeof body.renderSettings.addMetalNameTag === "boolean"
            ? body.renderSettings.addMetalNameTag
            : cur.addMetalNameTag,
        addQsafeIcon:
          typeof body.renderSettings.addQsafeIcon === "boolean"
            ? body.renderSettings.addQsafeIcon
            : cur.addQsafeIcon,
        qsafeIconUrl:
          typeof body.renderSettings.qsafeIconUrl === "string" ||
          body.renderSettings.qsafeIconUrl === null
            ? body.renderSettings.qsafeIconUrl
            : cur.qsafeIconUrl,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save render settings.";
      return json({ error: msg }, 500);
    }
  }

  return json({ ok: true });
}

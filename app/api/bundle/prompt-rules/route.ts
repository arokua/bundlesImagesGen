import { NextResponse } from "next/server";
import { getDefaultLifestylePromptPreview } from "@/lib/generateImages";
import {
  readLifestylePrefixOverrides,
  writeLifestylePrefixOverrides,
} from "@/lib/lifestylePrefixOverrides";
import { readGlobalPromptRules, writeGlobalPromptRules } from "@/lib/promptRules";

export const maxDuration = 15;

export async function GET() {
  const rules = await readGlobalPromptRules();
  const lifestyle = await readLifestylePrefixOverrides();
  return NextResponse.json({
    ok: true,
    rules: rules ?? "",
    defaultLifestylePromptMulti: getDefaultLifestylePromptPreview(2),
    defaultLifestylePromptSingle: getDefaultLifestylePromptPreview(1),
    lifestylePrefixMulti: lifestyle.multi,
    lifestylePrefixSingle: lifestyle.single,
  });
}

export async function POST(request: Request) {
  let body: {
    rules?: string;
    lifestylePrefixMulti?: string;
    lifestylePrefixSingle?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rules = body.rules ?? "";
  if (rules.length > 12000) {
    return NextResponse.json(
      { error: "Keep global prompt rules under 12000 characters." },
      { status: 400 },
    );
  }

  try {
    await writeGlobalPromptRules(rules);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save rules.";
    return NextResponse.json({ error: msg }, { status: 500 });
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
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

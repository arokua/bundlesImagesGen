import { NextResponse } from "next/server";
import {
  getSkuNote,
  readSkuNotesMap,
  setSkuNote,
} from "@/lib/skuNotes";

export const maxDuration = 15;

const MAX_NOTE_LENGTH = 1200;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sku = url.searchParams.get("sku")?.trim();
  if (sku) {
    const note = await getSkuNote(sku);
    return NextResponse.json({ ok: true, sku, note: note ?? "" });
  }
  const map = await readSkuNotesMap();
  const notes = [...map.entries()]
    .map(([s, n]) => ({ sku: s, note: n }))
    .sort((a, b) =>
      a.sku.localeCompare(b.sku, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  return NextResponse.json({ ok: true, notes });
}

export async function POST(request: Request) {
  let body: { sku?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const sku = body.sku?.trim();
  if (!sku) {
    return NextResponse.json(
      { error: "Provide a non-empty 'sku'." },
      { status: 400 },
    );
  }
  const note = (body.note ?? "").toString();
  if (note.length > MAX_NOTE_LENGTH) {
    return NextResponse.json(
      { error: `Keep note under ${MAX_NOTE_LENGTH} characters.` },
      { status: 400 },
    );
  }

  try {
    await setSkuNote(sku, note);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save note.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sku, note: note.trim() });
}

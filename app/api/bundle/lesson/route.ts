import { NextResponse } from "next/server";
import { appendProductLesson, formatProductLessonsBlock } from "@/lib/productLessons";

export const maxDuration = 15;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const masterSku = url.searchParams.get("masterSku")?.trim() ?? "";
  if (!masterSku) {
    return NextResponse.json(
      { ok: true, lessonsBlock: "", hint: "Pass ?masterSku= to load product-specific lessons." },
    );
  }
  const block = await formatProductLessonsBlock(masterSku);
  return NextResponse.json({ ok: true, lessonsBlock: block ?? "" });
}

export async function POST(request: Request) {
  let body: { lesson?: string; masterSku?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const lesson = body.lesson?.trim() ?? "";
  const masterSku = body.masterSku?.trim() ?? "";
  if (!lesson) {
    return NextResponse.json(
      { error: "Provide a non-empty 'lesson' string." },
      { status: 400 },
    );
  }
  if (!masterSku) {
    return NextResponse.json(
      { error: "Provide 'masterSku' so the lesson is keyed to this product line." },
      { status: 400 },
    );
  }
  if (lesson.length > 800) {
    return NextResponse.json(
      { error: "Keep each lesson under 800 characters." },
      { status: 400 },
    );
  }

  try {
    await appendProductLesson(masterSku, lesson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save lesson.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

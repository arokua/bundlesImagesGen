import { NextResponse } from "next/server";
import { appendLesson, readLessonsBlock } from "@/lib/generateImages";

export const maxDuration = 15;

export async function GET() {
  const block = await readLessonsBlock();
  return NextResponse.json({ ok: true, lessonsBlock: block ?? "" });
}

export async function POST(request: Request) {
  let body: { lesson?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const lesson = body.lesson?.trim() ?? "";
  if (!lesson) {
    return NextResponse.json(
      { error: "Provide a non-empty 'lesson' string." },
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
    await appendLesson(lesson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save lesson.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

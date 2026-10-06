import { NextResponse } from "next/server";
import { translationScopeSchema } from "@repo/contracts";
import { loadTranslationProgress } from "@repo/core";
import { requirePermission } from "@repo/rbac";

// The translation progress readout (ADR-189 #6): per language, interface
// strings and content items done of total, what is queued, what failed, and
// whether a budget or quota pause is holding the work back.
//
// A GET route handler rather than an action because it is a read that the
// Overview and Interface text tabs poll while work is queued, and stop polling
// when it is not, so an idle tab sends nothing (ADR-105's idle timeout).
//
// `requirePermission` runs first and is the boundary (security.md #3); the
// query is parsed through @repo/contracts (security.md #6).
export async function GET(request: Request): Promise<NextResponse> {
  await requirePermission("translations.view");

  const locale = new URL(request.url).searchParams.get("locale") ?? undefined;
  const parsed = translationScopeSchema.safeParse({ locale });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid locale" }, { status: 400 });
  }

  return NextResponse.json(
    { languages: await loadTranslationProgress({ locale: parsed.data.locale }) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

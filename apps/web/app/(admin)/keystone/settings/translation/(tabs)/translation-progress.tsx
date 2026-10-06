"use client";

// The translation progress readout (ADR-189 #6): per language, how much of the
// interface text and how much of the content is translated, and what the
// queue is doing about the rest. Drawn on the Overview (every language) and on
// Interface text (the language being edited).
//
// It polls `GET /keystone/api/translate/progress` every few seconds WHILE
// work is queued and stops when it is not, so an idle tab sends nothing and
// does not keep sliding ADR-105's idle timeout. A Sync or a fill pressed on
// this page announces itself (`announceTranslationWork`), which starts the
// polling at once. When the work finishes the page refreshes once, so the
// tables under the bars agree with them.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { TranslationProgress } from "@repo/core";
import { ProgressBar } from "@repo/ui/components/progress-bar";
import { Spinner } from "@repo/ui/components/spinner";
import { StatusBadge } from "../../../_components/status-badge.tsx";
import { SyncButton } from "./sync-dialog.tsx";
import { TRANSLATION_WORK_EVENT } from "./translation-work.ts";

const POLL_MS = 3_000;
/** On Interface text the table refreshes as strings land, at most this often. */
const TABLE_REFRESH_MS = 10_000;

const isBusy = (languages: readonly TranslationProgress[]) =>
  languages.some((language) => language.queued > 0);

export function TranslationProgressPanel({
  initial,
  locale,
  refreshWhileWorking = false,
  canSync = false,
}: {
  /** The server's reading, so the first paint needs no request. */
  initial: TranslationProgress[];
  /** One language only (Interface text), or every non-default one. */
  locale?: string;
  /** Refresh the page as strings land, not only at the end. */
  refreshWhileWorking?: boolean;
  /** Draw a Sync button on each card (ADR-191): `translations.approve`. */
  canSync?: boolean;
}) {
  const t = useTranslations("admin.translate.progress");
  const tReasons = useTranslations("admin.translate.reasons");
  const router = useRouter();
  const [languages, setLanguages] = useState(initial);
  const [polling, setPolling] = useState(() => isBusy(initial));
  const lastRefresh = useRef(0);
  const lastDone = useRef(new Map(initial.map((l) => [l.code, l.interfaceText.done])));

  // A server refresh brings a newer reading; take it (React's "adjust state
  // when a prop changes" pattern, during render rather than in an effect).
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setLanguages(initial);
    if (isBusy(initial)) setPolling(true);
  }

  const read = useCallback(async () => {
    const query = locale ? `?locale=${encodeURIComponent(locale)}` : "";
    const response = await fetch(`/keystone/api/translate/progress${query}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    return ((await response.json()) as { languages: TranslationProgress[] }).languages;
  }, [locale]);

  useEffect(() => {
    const start = () => setPolling(true);
    window.addEventListener(TRANSLATION_WORK_EVENT, start);
    return () => window.removeEventListener(TRANSLATION_WORK_EVENT, start);
  }, []);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const next = await read().catch(() => null);
      if (cancelled || !next) return;
      setLanguages(next);

      const landed = next.some(
        (l) => l.interfaceText.done !== (lastDone.current.get(l.code) ?? l.interfaceText.done),
      );
      lastDone.current = new Map(next.map((l) => [l.code, l.interfaceText.done]));
      const finished = !isBusy(next);
      if (
        finished ||
        (refreshWhileWorking && landed && Date.now() - lastRefresh.current > TABLE_REFRESH_MS)
      ) {
        lastRefresh.current = Date.now();
        router.refresh();
      }
      if (finished) setPolling(false);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [polling, read, router, refreshWhileWorking]);

  if (languages.length === 0) return null;
  const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0 });
  const share = (done: number, total: number) => percent.format(total === 0 ? 1 : done / total);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-live="polite">
      {languages.map((language) => {
        const reason =
          language.pausedBy && tReasons.has(language.pausedBy)
            ? tReasons(language.pausedBy)
            : language.pausedBy;
        return (
          <section
            key={language.code}
            className="flex flex-col gap-4 rounded-lg border bg-card p-4"
            aria-label={t("cardLabel", { language: language.name })}
          >
            <header className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold">{language.name}</h3>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  {language.queued > 0 && !reason && <Spinner aria-hidden className="size-3.5" />}
                  {reason
                    ? t("paused", { reason })
                    : language.queued > 0
                      ? t("working", { count: language.queued })
                      : t("idle")}
                </p>
              </div>
              <StatusBadge tone={language.isActive ? "success" : "neutral"}>
                {language.isActive ? t("live") : t("notLive")}
              </StatusBadge>
            </header>

            <ProgressBar
              value={language.interfaceText.done}
              total={language.interfaceText.total}
              label={t("barLabel", { language: language.name, part: t("interfaceText") })}
              countLabel={t("count", {
                part: t("interfaceText"),
                done: language.interfaceText.done,
                total: language.interfaceText.total,
              })}
              percentLabel={share(language.interfaceText.done, language.interfaceText.total)}
            />
            <ProgressBar
              value={language.content.done}
              total={language.content.total}
              label={t("barLabel", { language: language.name, part: t("content") })}
              countLabel={t("count", {
                part: t("content"),
                done: language.content.done,
                total: language.content.total,
              })}
              percentLabel={share(language.content.done, language.content.total)}
            />

            {(language.failed > 0 || language.interfaceText.manual > 0) && (
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {language.failed > 0 && (
                  <li className="text-destructive-interactive">
                    {t("failed", { count: language.failed })}
                  </li>
                )}
                {language.interfaceText.manual > 0 && (
                  <li>{t("manual", { count: language.interfaceText.manual })}</li>
                )}
              </ul>
            )}

            {canSync && (
              <div className="mt-auto flex justify-end">
                <SyncButton locale={language.code} language={language.name} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

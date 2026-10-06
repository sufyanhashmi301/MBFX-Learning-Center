import { getTranslations } from "next-intl/server";
import { loadTranslationOverview, loadTranslationProgress } from "@repo/core";
import { can, requirePermission } from "@repo/rbac";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert";
import { MetricCard } from "@repo/ui/components/metric-card";
import { formatDateTime, humanizeKey } from "@repo/utils";
import { AdminSection } from "../../../_components/admin-page.tsx";
import { LiveRefresh } from "../../../_components/live-refresh.tsx";
import {
  FailuresTable,
  LocalesTable,
  TypesTable,
  type FailureRow,
  type LocaleRow,
  type OverviewLabels,
  type TypeRow,
} from "./overview-tables.tsx";
import { TranslationProgressPanel } from "./translation-progress.tsx";

// Settings → Translation → Overview (plan §5, ADR-163): how much of each
// language is done and by whom, what the queue is doing, what failed, and what
// this month has cost. `translations.view`; Sync and Retry are
// `translations.approve`, re-checked by their actions.
//
// Every figure is read uncached. The Progress section polls while work is
// queued (ADR-189 #6); `LiveRefresh` keeps the rest of the page current.
export default async function TranslationOverviewPage() {
  const subject = await requirePermission("translations.view");
  const t = await getTranslations("admin.translate");
  const tAdmin = await getTranslations("admin");
  const [overview, progress] = await Promise.all([
    loadTranslationOverview(),
    loadTranslationProgress(),
  ]);
  const number = new Intl.NumberFormat("en");

  const typeLabel = (type: string) =>
    t.has(`entityTypes.${type}`) ? t(`entityTypes.${type}`) : humanizeKey(type);
  const reasonLabel = (reason: string | null) =>
    reason && t.has(`reasons.${reason}`) ? t(`reasons.${reason}`) : t("overview.reasonUnknown");

  const localeName = new Map(overview.locales.map((l) => [l.code, l.name]));
  const locales: LocaleRow[] = overview.locales.map((locale) => ({
    code: locale.code,
    name: locale.name,
    nativeName: locale.nativeName,
    isActive: locale.isActive,
    total: locale.coverage.total,
    machine: locale.coverage.machine,
    human: locale.coverage.human,
    outdated: locale.coverage.outdated,
    needsReview: locale.coverage.needsReview,
    draft: locale.coverage.draft,
    missing: locale.coverage.missing,
    queued: locale.jobs.pending + locale.jobs.running,
    failed: locale.jobs.failed,
    backfilling:
      locale.backfill !== null &&
      (locale.backfill.status === "PENDING" || locale.backfill.status === "RUNNING"),
  }));
  const typeRows: TypeRow[] = overview.locales.flatMap((locale) =>
    locale.types.map((type) => ({
      key: `${locale.code}:${type.entityType}`,
      locale: locale.code,
      language: locale.name,
      type: typeLabel(type.entityType),
      total: type.coverage.total,
      machine: type.coverage.machine,
      human: type.coverage.human,
      outdated: type.coverage.outdated,
      needsReview: type.coverage.needsReview,
      missing: type.coverage.missing,
    })),
  );
  const failures: FailureRow[] = overview.failed.map((job) => ({
    id: job.id,
    language: localeName.get(job.locale) ?? job.locale,
    locale: job.locale,
    item:
      job.kind === "BACKFILL_LOCALE"
        ? t("overview.backfillItem")
        : `${typeLabel(job.entityType)} · ${job.entityId}`,
    reason: reasonLabel(job.lastError),
    attempts: job.attempts,
    whenLabel: formatDateTime(new Date(job.updatedAt)),
    whenSort: new Date(job.updatedAt).getTime(),
  }));

  const labels: OverviewLabels = {
    table: {
      search: t("overview.searchLanguages"),
      columns: tAdmin("columns"),
      export: tAdmin("export"),
      selectedSuffix: tAdmin("selectedCount"),
      pageWord: tAdmin("pageWord"),
      ofWord: tAdmin("ofWord"),
      previous: tAdmin("previous"),
      next: tAdmin("next"),
      noResults: tAdmin("noResults"),
      actionsCol: tAdmin("actionsCol"),
    },
    languageCol: t("overview.colLanguage"),
    statusCol: t("overview.colStatus"),
    coverageCol: t("overview.colCoverage"),
    machineCol: t("overview.colMachine"),
    humanCol: t("overview.colHuman"),
    outdatedCol: t("overview.colOutdated"),
    needsReviewCol: t("overview.colNeedsReview"),
    missingCol: t("overview.colMissing"),
    queueCol: t("overview.colQueue"),
    live: t("overview.live"),
    notLive: t("overview.notLive"),
    coverageLabel: t("overview.coverageLabel", { language: "{language}" }),
    coverageCount: t("overview.coverageCount", { done: "{done}", total: "{total}" }),
    queueIdle: t("overview.queueIdle"),
    queued: t("overview.queued", { count: "{count}" }),
    failedCount: t("overview.failedCount", { count: "{count}" }),
    backfilling: t("overview.backfilling"),
    sync: t("overview.sync"),
    retryFailed: t("overview.retryFailed"),
    retryAll: t("overview.retryAll"),
    openActions: t("overview.openActions", { language: "{language}" }),
    retryTitle: t("overview.retryTitle"),
    retryBody: t("overview.retryBody"),
    confirm: tAdmin("confirm"),
    cancel: tAdmin("cancel"),
    retryDone: t("overview.retryDone", { count: "{count}" }),
    refusals: {
      unknownLocale: t("overview.refusals.unknownLocale"),
      noLocale: t("overview.refusals.noLocale"),
      providerUnavailable: t("overview.refusals.providerUnavailable"),
    },
    noLocalesTitle: t("overview.noLocalesTitle"),
    noLocalesBody: t("overview.noLocalesBody"),
    failuresSearch: t("overview.searchFailures"),
    itemCol: t("overview.colItem"),
    reasonCol: t("overview.colReason"),
    attemptsCol: t("overview.colAttempts"),
    whenCol: t("overview.colWhen"),
    noFailuresTitle: t("overview.noFailuresTitle"),
    noFailuresBody: t("overview.noFailuresBody"),
  };

  const canApprove = can(subject, "translations.approve");
  const remaining =
    overview.monthlyCharBudget === null
      ? null
      : Math.max(0, overview.monthlyCharBudget - overview.usage.characters);
  const busy = locales.some((l) => l.backfilling || l.queued > 0);

  return (
    <>
      {!overview.enabled && (
        <Alert variant="warning">
          <AlertTitle>{t("overview.offTitle")}</AlertTitle>
          <AlertDescription>{t("overview.offBody")}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label={t("usageCharacters")}
          value={number.format(overview.usage.characters)}
          meta={t("usageTitle")}
        />
        <MetricCard
          label={t("usageRemaining")}
          value={remaining === null ? t("noBudget") : number.format(remaining)}
        />
        <MetricCard
          label={t("usageCost")}
          value={`$${Number(overview.usage.costUsd).toFixed(2)}`}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("overview.costNote")}</p>
        <LiveRefresh
          renderedAt={new Date().toISOString()}
          intervalMs={busy ? 10_000 : 60_000}
          labels={{
            updated: t("liveUpdated", { time: "{time}" }),
            refresh: t("liveRefresh"),
          }}
        />
      </div>

      <AdminSection title={t("progress.title")}>
        <p className="text-sm text-muted-foreground">{t("progress.description")}</p>
        <TranslationProgressPanel initial={progress} canSync={canApprove} />
      </AdminSection>

      <AdminSection title={t("overview.languagesTitle")}>
        <p className="text-sm text-muted-foreground">{t("overview.languagesDescription")}</p>
        <LocalesTable rows={locales} canApprove={canApprove} labels={labels} />
      </AdminSection>

      <AdminSection title={t("overview.typesTitle")}>
        <p className="text-sm text-muted-foreground">{t("overview.typesDescription")}</p>
        <TypesTable
          rows={typeRows}
          // Live languages first: that is where a gap is a reader's problem.
          languages={[...overview.locales]
            .sort((a, b) => Number(b.isActive) - Number(a.isActive))
            .map((l) => ({ value: l.code, label: l.name }))}
          labels={labels}
          typeLabels={{
            search: t("overview.searchTypes"),
            typeCol: t("overview.colType"),
            allLanguages: t("review.allLanguages"),
            languageFilter: t("review.languageFilter"),
          }}
        />
      </AdminSection>

      <AdminSection title={t("overview.failuresTitle")}>
        <p className="text-sm text-muted-foreground">{t("overview.failuresDescription")}</p>
        <FailuresTable rows={failures} canApprove={canApprove} labels={labels} />
      </AdminSection>
    </>
  );
}

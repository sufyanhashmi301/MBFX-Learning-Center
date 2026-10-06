"use client";

// The Overview tab's tables (ADR-163): each language's coverage and queue,
// and the jobs that failed. Both lists are small (a handful of languages, at
// most 25 recent failures), so they load in full and use `useClientTable`.
//
// Sync and Retry are the screen's actions, so the "all" versions sit on the
// title row through `HeaderActions` (ADR-140 §3 — the layout draws the
// heading) and the per-language ones in each row's menu. "Retry all failed"
// appears only while something has failed.
// Both confirm first: Sync can spend characters, and a confirmation is where
// that is said (code-style.md #7's reasoning, applied to money). Sync's
// confirmation is the shared `SyncDialog`, which also asks missing or reset
// (ADR-191).
import { useMemo, useState } from "react";
import { CircleCheck, Languages, MoreHorizontal, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@repo/ui/components/button";
import { ConfirmDialog } from "@repo/ui/components/confirm-dialog";
import { DataTable, type DataTableLabels } from "@repo/ui/components/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@repo/ui/components/empty";
import { FilterBarRow } from "@repo/ui/components/filter-bar";
import { ProgressBar } from "@repo/ui/components/progress-bar";
import { retryFailedTranslationsAction } from "../../../_actions/translate-actions.ts";
import { AdminCombobox } from "../../../_components/combobox.tsx";
import { HeaderActions } from "../../../_components/header-actions.tsx";
import { StatusBadge } from "../../../_components/status-badge.tsx";
import { useClientTable } from "../../../_hooks/use-client-table.ts";
import { useServerAction } from "../../../_hooks/use-server-action.ts";
import { SyncButton, SyncDialog, type SyncTarget } from "./sync-dialog.tsx";
import { announceTranslationWork } from "./translation-work.ts";

export interface LocaleRow {
  code: string;
  name: string;
  nativeName: string;
  isActive: boolean;
  total: number;
  machine: number;
  human: number;
  outdated: number;
  needsReview: number;
  draft: number;
  missing: number;
  queued: number;
  failed: number;
  backfilling: boolean;
}

export interface FailureRow {
  id: string;
  language: string;
  locale: string;
  item: string;
  reason: string;
  attempts: number;
  whenLabel: string;
  whenSort: number;
}

export interface OverviewLabels {
  table: {
    search: string;
    columns: string;
    export: string;
    selectedSuffix: string;
    pageWord: string;
    ofWord: string;
    previous: string;
    next: string;
    noResults: string;
    actionsCol: string;
  };
  languageCol: string;
  statusCol: string;
  coverageCol: string;
  machineCol: string;
  humanCol: string;
  outdatedCol: string;
  needsReviewCol: string;
  missingCol: string;
  queueCol: string;
  live: string;
  notLive: string;
  /** "{language} translated" — the bar's accessible name. */
  coverageLabel: string;
  /** "{done} of {total}". */
  coverageCount: string;
  queueIdle: string;
  queued: string;
  failedCount: string;
  backfilling: string;
  sync: string;
  retryFailed: string;
  retryAll: string;
  openActions: string;
  retryTitle: string;
  retryBody: string;
  confirm: string;
  cancel: string;
  retryDone: string;
  refusals: { unknownLocale: string; noLocale: string; providerUnavailable: string };
  noLocalesTitle: string;
  noLocalesBody: string;
  failuresSearch: string;
  itemCol: string;
  reasonCol: string;
  attemptsCol: string;
  whenCol: string;
  noFailuresTitle: string;
  noFailuresBody: string;
}

/** Fills `{name}` placeholders the server left in a label. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

function tableLabels(labels: OverviewLabels, search: string): DataTableLabels {
  return {
    search,
    columns: labels.table.columns,
    export: labels.table.export,
    selectedCount: (n) => `${n} ${labels.table.selectedSuffix}`,
    page: (p, c) => `${labels.table.pageWord} ${p} ${labels.table.ofWord} ${c}`,
    previous: labels.table.previous,
    next: labels.table.next,
    noResults: labels.table.noResults,
  };
}

/** Pending confirmation: Retry, for one locale or all. Sync has its own dialog. */
type Pending = { locale?: string } | null;

function useScopedActions(labels: OverviewLabels) {
  const { run, pending: busy } = useServerAction();
  const [pending, setPending] = useState<Pending>(null);

  const confirm = () => {
    if (!pending) return;
    const input = pending.locale ? { locale: pending.locale } : {};
    run(async () => {
      const result = await retryFailedTranslationsAction(input);
      if (!result.ok) throw new Error(labels.refusals[result.reason]);
      announceTranslationWork();
      toast.success(fill(labels.retryDone, { count: result.count }));
    });
  };

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={labels.retryTitle}
      description={labels.retryBody}
      confirmLabel={labels.confirm}
      cancelLabel={labels.cancel}
      onConfirm={confirm}
    />
  );

  return { busy, setPending, dialog };
}

export function LocalesTable({
  rows,
  canApprove,
  labels,
}: {
  rows: LocaleRow[];
  canApprove: boolean;
  labels: OverviewLabels;
}) {
  const { busy, setPending, dialog } = useScopedActions(labels);
  const [syncTarget, setSyncTarget] = useState<SyncTarget | null>(null);
  const { tableProps } = useClientTable(rows, {
    searchText: (row) => `${row.name} ${row.nativeName} ${row.code}`,
    sortValues: {
      language: (row) => row.name,
      coverage: (row) => (row.total === 0 ? 0 : (row.total - row.missing) / row.total),
      machine: (row) => row.machine,
      human: (row) => row.human,
      outdated: (row) => row.outdated,
      needsReview: (row) => row.needsReview,
      missing: (row) => row.missing,
    },
  });

  const columns = useMemo<ColumnDef<LocaleRow>[]>(() => {
    const count = (id: keyof LocaleRow & string, header: string): ColumnDef<LocaleRow> => ({
      id,
      header,
      meta: { label: header },
      cell: ({ row }) => <span className="tabular-nums">{row.original[id] as number}</span>,
    });
    return [
      {
        id: "language",
        header: labels.languageCol,
        meta: { label: labels.languageCol },
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">{row.original.nativeName}</span>
          </div>
        ),
      },
      {
        id: "status",
        header: labels.statusCol,
        meta: { label: labels.statusCol },
        cell: ({ row }) => (
          <StatusBadge tone={row.original.isActive ? "success" : "neutral"}>
            {row.original.isActive ? labels.live : labels.notLive}
          </StatusBadge>
        ),
      },
      {
        id: "coverage",
        header: labels.coverageCol,
        meta: { label: labels.coverageCol },
        cell: ({ row }) => {
          const done = row.original.total - row.original.missing;
          const percent =
            row.original.total === 0 ? 0 : Math.round((done / row.original.total) * 100);
          return (
            <ProgressBar
              className="min-w-40"
              value={done}
              total={row.original.total}
              label={fill(labels.coverageLabel, { language: row.original.name })}
              countLabel={fill(labels.coverageCount, { done, total: row.original.total })}
              percentLabel={`${percent}%`}
            />
          );
        },
      },
      count("machine", labels.machineCol),
      count("human", labels.humanCol),
      count("outdated", labels.outdatedCol),
      count("needsReview", labels.needsReviewCol),
      count("missing", labels.missingCol),
      {
        id: "queue",
        header: labels.queueCol,
        meta: { label: labels.queueCol },
        cell: ({ row }) => {
          const { backfilling, queued, failed } = row.original;
          if (!backfilling && queued === 0 && failed === 0) {
            return <span className="text-muted-foreground">{labels.queueIdle}</span>;
          }
          return (
            <div className="flex flex-wrap items-center gap-1">
              {backfilling && <StatusBadge tone="info">{labels.backfilling}</StatusBadge>}
              {queued > 0 && (
                <StatusBadge tone="neutral">{fill(labels.queued, { count: queued })}</StatusBadge>
              )}
              {failed > 0 && (
                <StatusBadge tone="destructive">
                  {fill(labels.failedCount, { count: failed })}
                </StatusBadge>
              )}
            </div>
          );
        },
      },
      ...(canApprove
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{labels.table.actionsCol}</span>,
              meta: { label: labels.table.actionsCol },
              enableHiding: false,
              cell: ({ row }) => (
                <div className="flex justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={fill(labels.openActions, { language: row.original.name })}
                        >
                          <MoreHorizontal aria-hidden />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      {/* Sync works for a language before it is live: that
                          is how one is prepared for go-live (ADR-189 #1). */}
                      <DropdownMenuItem
                        disabled={busy}
                        onClick={() =>
                          setSyncTarget({ locale: row.original.code, language: row.original.name })
                        }
                      >
                        <RefreshCw aria-hidden data-icon="inline-start" />
                        {labels.sync}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={busy || row.original.failed === 0}
                        onClick={() => setPending({ locale: row.original.code })}
                      >
                        <RotateCcw aria-hidden data-icon="inline-start" />
                        {labels.retryFailed}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ),
            } satisfies ColumnDef<LocaleRow>,
          ]
        : []),
    ];
  }, [labels, canApprove, busy, setPending]);

  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyMedia>
          <Languages aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{labels.noLocalesTitle}</EmptyTitle>
        <EmptyDescription>{labels.noLocalesBody}</EmptyDescription>
      </Empty>
    );
  }

  return (
    <>
      {canApprove && (
        <HeaderActions>
          <SyncButton variant="default" />
        </HeaderActions>
      )}
      <DataTable
        {...tableProps}
        columns={columns}
        labels={tableLabels(labels, labels.table.search)}
      />
      {dialog}
      <SyncDialog target={syncTarget} onClose={() => setSyncTarget(null)} />
    </>
  );
}

/** One content type's counts in one language (Phase 5 exit: coverage per module). */
export interface TypeRow {
  key: string;
  locale: string;
  language: string;
  type: string;
  total: number;
  machine: number;
  human: number;
  outdated: number;
  needsReview: number;
  missing: number;
}

export interface TypeLabels {
  search: string;
  typeCol: string;
  allLanguages: string;
  languageFilter: string;
}

/**
 * Coverage per content type and language. Loaded in full (types × languages
 * is a few dozen rows), so the language filter is local state in the toolbar
 * (code-style.md #9).
 */
export function TypesTable({
  rows,
  languages,
  labels,
  typeLabels,
}: {
  rows: TypeRow[];
  languages: { value: string; label: string }[];
  labels: OverviewLabels;
  typeLabels: TypeLabels;
}) {
  const [locale, setLocale] = useState(languages[0]?.value ?? "");
  const visible = useMemo(
    () => (locale === "" ? rows : rows.filter((row) => row.locale === locale)),
    [rows, locale],
  );
  const { tableProps } = useClientTable(visible, {
    searchText: (row) => `${row.type} ${row.language}`,
    sortValues: {
      type: (row) => row.type,
      coverage: (row) => (row.total === 0 ? 1 : (row.total - row.missing) / row.total),
      missing: (row) => row.missing,
    },
    initialPageSize: 50,
  });

  const columns = useMemo<ColumnDef<TypeRow>[]>(() => {
    const count = (id: keyof TypeRow & string, header: string): ColumnDef<TypeRow> => ({
      id,
      header,
      meta: { label: header },
      cell: ({ row }) => <span className="tabular-nums">{row.original[id] as number}</span>,
    });
    return [
      {
        id: "type",
        header: typeLabels.typeCol,
        meta: { label: typeLabels.typeCol },
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{row.original.type}</span>
            <span className="text-xs text-muted-foreground">{row.original.language}</span>
          </div>
        ),
      },
      {
        id: "coverage",
        header: labels.coverageCol,
        meta: { label: labels.coverageCol },
        cell: ({ row }) => {
          const done = row.original.total - row.original.missing;
          const percent =
            row.original.total === 0 ? 100 : Math.round((done / row.original.total) * 100);
          return (
            <ProgressBar
              className="min-w-40"
              value={done}
              total={row.original.total}
              label={fill(labels.coverageLabel, {
                language: `${row.original.type} · ${row.original.language}`,
              })}
              countLabel={fill(labels.coverageCount, { done, total: row.original.total })}
              percentLabel={`${percent}%`}
            />
          );
        },
      },
      count("machine", labels.machineCol),
      count("human", labels.humanCol),
      count("outdated", labels.outdatedCol),
      count("needsReview", labels.needsReviewCol),
      count("missing", labels.missingCol),
    ];
  }, [labels, typeLabels]);

  return (
    <DataTable
      {...tableProps}
      columns={columns}
      labels={tableLabels(labels, typeLabels.search)}
      filters={
        <FilterBarRow>
          <AdminCombobox
            aria-label={typeLabels.languageFilter}
            className="w-40"
            value={locale}
            onValueChange={setLocale}
            options={[{ value: "", label: typeLabels.allLanguages }, ...languages]}
          />
        </FilterBarRow>
      }
    />
  );
}

export function FailuresTable({
  rows,
  canApprove,
  labels,
}: {
  rows: FailureRow[];
  canApprove: boolean;
  labels: OverviewLabels;
}) {
  const { busy, setPending, dialog } = useScopedActions(labels);
  const { tableProps } = useClientTable(rows, {
    searchText: (row) => `${row.language} ${row.item} ${row.reason}`,
    sortValues: {
      language: (row) => row.language,
      attempts: (row) => row.attempts,
      when: (row) => row.whenSort,
    },
  });

  const columns = useMemo<ColumnDef<FailureRow>[]>(
    () => [
      {
        id: "language",
        header: labels.languageCol,
        meta: { label: labels.languageCol },
        cell: ({ row }) => row.original.language,
      },
      {
        id: "item",
        header: labels.itemCol,
        meta: { label: labels.itemCol },
        enableHiding: false,
        cell: ({ row }) => <span className="break-all">{row.original.item}</span>,
      },
      {
        id: "reason",
        header: labels.reasonCol,
        meta: { label: labels.reasonCol },
        cell: ({ row }) => (
          <span className="block max-w-96 text-sm text-muted-foreground">
            {row.original.reason}
          </span>
        ),
      },
      {
        id: "attempts",
        header: labels.attemptsCol,
        meta: { label: labels.attemptsCol },
        cell: ({ row }) => <span className="tabular-nums">{row.original.attempts}</span>,
      },
      {
        id: "when",
        header: labels.whenCol,
        meta: { label: labels.whenCol },
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.whenLabel}</span>,
      },
    ],
    [labels],
  );

  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyMedia>
          <CircleCheck aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{labels.noFailuresTitle}</EmptyTitle>
        <EmptyDescription>{labels.noFailuresBody}</EmptyDescription>
      </Empty>
    );
  }

  return (
    <>
      {canApprove && (
        <HeaderActions>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending({})}>
            <RotateCcw aria-hidden data-icon="inline-start" />
            {labels.retryAll}
          </Button>
        </HeaderActions>
      )}
      <DataTable
        {...tableProps}
        columns={columns}
        labels={tableLabels(labels, labels.failuresSearch)}
      />
      {dialog}
    </>
  );
}

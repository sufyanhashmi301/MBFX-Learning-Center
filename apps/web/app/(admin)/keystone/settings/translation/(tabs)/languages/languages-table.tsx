"use client";

// The Languages table (ADR-163 #2/#3). One row per non-default locale, with
// the switch as a button in the row: on or off, each behind a confirmation
// that says what happens — switching on names the characters and estimated
// cost of the backfill it starts; switching off says nothing is deleted.
//
// Every row has a Live switch (ADR-178 #8). On a language that is not ready
// to go live, turning it on opens a checklist of what is missing, with links
// to the screens that fix it, rather than doing nothing. The action still
// re-checks (the checklist is UX, the service is the rule).
//
// Languages are added, edited and deleted here too (ADR-178 #2): "Add
// language" sits on the title row (ADR-140 §3), Edit on every row, and
// Delete only on a row that is switched off and has nothing written in it.
import { useMemo, useState } from "react";
import { Languages, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@repo/ui/components/button";
import { ConfirmDialog } from "@repo/ui/components/confirm-dialog";
import { DataTable, type DataTableLabels } from "@repo/ui/components/data-table";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@repo/ui/components/empty";
import { Switch } from "@repo/ui/components/switch";
import type { LocaleActivationRefusal } from "@repo/core";
import {
  deleteLocaleAction,
  setLocaleActiveAction,
} from "../../../../_actions/translate-actions.ts";
import { useClientTable } from "../../../../_hooks/use-client-table.ts";
import { HeaderActions } from "../../../../_components/header-actions.tsx";
import { useServerAction } from "../../../../_hooks/use-server-action.ts";
import { StatusBadge } from "../../../../_components/status-badge.tsx";
import { SyncDialog, type SyncTarget } from "../sync-dialog.tsx";
import { GoLiveChecklist } from "./go-live-checklist.tsx";
import { LanguageDialog, type AvailableLanguage, type LanguageDraft } from "./language-dialog.tsx";

export interface LanguageRowView {
  code: string;
  name: string;
  nativeName: string;
  /** Already a label: "Left to right" / "Right to left". */
  direction: string;
  isActive: boolean;
  catalog: string;
  catalogComplete: boolean;
  /** Public interface strings missing; null when the site cannot route it. */
  catalogGaps: number | null;
  /** Why it cannot be switched on, as a sentence; null when it can. */
  refusal: string | null;
  estimate: string;
  /** The switch-on confirmation's description, estimate and budget included. */
  activateBody: string;
  flagEmoji: string | null;
  fallbackCode: string | null;
  sortOrder: number;
  /** Content translations written in it; above zero it cannot be deleted. */
  contentRows: number;
}

export interface LanguagesLabels {
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
  directionCol: string;
  catalogCol: string;
  statusCol: string;
  estimateCol: string;
  live: string;
  notLive: string;
  activate: string;
  deactivate: string;
  activateTitle: string;
  deactivateTitle: string;
  deactivateBody: string;
  activated: string;
  deactivated: string;
  cancel: string;
  refusals: Record<LocaleActivationRefusal, string>;
  emptyTitle: string;
  emptyBody: string;
}

const fill = (template: string, language: string) => template.replace("{language}", language);

export function LanguagesTable({
  rows,
  labels,
  available,
  all,
  defaultCode,
  canEditInterfaceText,
  canSync,
}: {
  rows: LanguageRowView[];
  labels: LanguagesLabels;
  available: AvailableLanguage[];
  all: Array<{ code: string; name: string }>;
  defaultCode: string;
  canEditInterfaceText: boolean;
  /** Sync a language from its row (ADR-191): `translations.approve`. */
  canSync: boolean;
}) {
  const t = useTranslations("admin.translate.languages");
  const { run, pending: busy } = useServerAction();
  const [pending, setPending] = useState<{ row: LanguageRowView; active: boolean } | null>(null);
  const [draft, setDraft] = useState<LanguageDraft | null>(null);
  const [deleting, setDeleting] = useState<LanguageRowView | null>(null);
  const [checklist, setChecklist] = useState<LanguageRowView | null>(null);
  const [syncTarget, setSyncTarget] = useState<SyncTarget | null>(null);

  /** The Live switch: off asks first; on asks first, or explains what is missing. */
  const toggle = (row: LanguageRowView, live: boolean) => {
    if (live && row.refusal) setChecklist(row);
    else setPending({ row, active: live });
  };
  const nextOrder = Math.max(0, ...rows.map((row) => row.sortOrder)) + 1;

  const remove = () => {
    if (!deleting) return;
    const row = deleting;
    run(
      async () => {
        const result = await deleteLocaleAction({ locale: row.code });
        if (!result.ok) throw new Error(t(`deleteRefusals.${result.reason}`));
      },
      { successMessage: t("deleted", { language: row.name }), onDone: () => setDeleting(null) },
    );
  };

  const { tableProps } = useClientTable(rows, {
    searchText: (row) => `${row.name} ${row.nativeName} ${row.code}`,
    sortValues: { language: (row) => row.name, status: (row) => String(row.isActive) },
  });

  const confirm = () => {
    if (!pending) return;
    const { row, active } = pending;
    run(async () => {
      const result = await setLocaleActiveAction({ locale: row.code, active });
      if (!result.ok) throw new Error(labels.refusals[result.reason]);
      toast.success(fill(active ? labels.activated : labels.deactivated, row.name));
    });
  };

  const columns = useMemo<ColumnDef<LanguageRowView>[]>(
    () => [
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
          <div className="flex items-center gap-2">
            <Switch
              checked={row.original.isActive}
              disabled={busy}
              aria-label={`${t("liveSwitch")} ${row.original.name}`}
              onCheckedChange={(live) => toggle(row.original, live)}
            />
            <span
              className={
                row.original.isActive
                  ? "text-sm text-success-interactive"
                  : "text-sm text-muted-foreground"
              }
            >
              {row.original.isActive ? labels.live : t("hidden")}
            </span>
          </div>
        ),
      },
      {
        id: "catalog",
        header: labels.catalogCol,
        meta: { label: labels.catalogCol },
        cell: ({ row }) => (
          <div className="flex max-w-80 flex-col items-start gap-1">
            <StatusBadge tone={row.original.catalogComplete ? "success" : "warning"}>
              {row.original.catalog}
            </StatusBadge>
            {row.original.refusal && !row.original.isActive && (
              <span className="text-xs whitespace-normal text-muted-foreground">
                {row.original.refusal}
              </span>
            )}
          </div>
        ),
      },
      {
        id: "direction",
        header: labels.directionCol,
        meta: { label: labels.directionCol },
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.direction}</span>,
      },
      {
        id: "estimate",
        header: labels.estimateCol,
        meta: { label: labels.estimateCol },
        cell: ({ row }) => (
          <span className="block max-w-56 text-sm whitespace-normal">{row.original.estimate}</span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{labels.table.actionsCol}</span>,
        meta: { label: labels.table.actionsCol },
        enableHiding: false,
        cell: ({ row }) => {
          const language = row.original;
          return (
            <div className="flex items-center justify-end gap-1">
              {canSync && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("syncLanguage", { language: language.name })}
                  disabled={busy}
                  onClick={() => setSyncTarget({ locale: language.code, language: language.name })}
                >
                  <RefreshCw aria-hidden />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("edit")} ${language.name}`}
                disabled={busy}
                onClick={() =>
                  setDraft({
                    mode: "edit",
                    code: language.code,
                    name: language.name,
                    nativeName: language.nativeName,
                    flagEmoji: language.flagEmoji,
                    fallbackCode: language.fallbackCode,
                    sortOrder: language.sortOrder,
                  })
                }
              >
                <Pencil aria-hidden />
              </Button>
              {!language.isActive && language.contentRows === 0 && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t("delete")} ${language.name}`}
                  disabled={busy}
                  onClick={() => setDeleting(language)}
                >
                  <Trash2 aria-hidden className="text-destructive-interactive" />
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [labels, busy, t, canSync],
  );

  const dialogs = (
    <>
      <HeaderActions>
        <Button size="sm" onClick={() => setDraft({ mode: "add" })}>
          <Plus aria-hidden data-icon="inline-start" />
          {t("add")}
        </Button>
      </HeaderActions>
      <GoLiveChecklist
        language={checklist}
        onClose={() => setChecklist(null)}
        canEditInterfaceText={canEditInterfaceText}
      />
      <SyncDialog target={syncTarget} onClose={() => setSyncTarget(null)} />
      <LanguageDialog
        draft={draft}
        onClose={() => setDraft(null)}
        available={available}
        all={all}
        nextOrder={nextOrder}
        defaultCode={defaultCode}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={deleting ? t("deleteTitle", { language: deleting.name }) : ""}
        description={t("deleteBody")}
        confirmLabel={t("delete")}
        cancelLabel={labels.cancel}
        onConfirm={remove}
      />
    </>
  );

  if (rows.length === 0) {
    return (
      <>
        <Empty>
          <EmptyMedia>
            <Languages aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{labels.emptyTitle}</EmptyTitle>
          <EmptyDescription>{labels.emptyBody}</EmptyDescription>
        </Empty>
        {dialogs}
      </>
    );
  }

  const tableLabels: DataTableLabels = {
    search: labels.table.search,
    columns: labels.table.columns,
    export: labels.table.export,
    selectedCount: (n) => `${n} ${labels.table.selectedSuffix}`,
    page: (p, c) => `${labels.table.pageWord} ${p} ${labels.table.ofWord} ${c}`,
    previous: labels.table.previous,
    next: labels.table.next,
    noResults: labels.table.noResults,
  };

  return (
    <>
      <DataTable {...tableProps} columns={columns} labels={tableLabels} />
      {dialogs}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={
          pending
            ? fill(pending.active ? labels.activateTitle : labels.deactivateTitle, pending.row.name)
            : ""
        }
        description={pending?.active ? pending.row.activateBody : labels.deactivateBody}
        confirmLabel={pending?.active ? labels.activate : labels.deactivate}
        cancelLabel={labels.cancel}
        onConfirm={confirm}
      />
    </>
  );
}

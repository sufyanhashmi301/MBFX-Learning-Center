"use client";

// The Interface text table (ADR-178 #4/#5): one section of one language's
// public strings, English beside each. Edit opens a dialog; Reset removes the
// override after a confirmation (code-style.md #7); "Translate missing
// automatically" sits on the title row (ADR-140 §3) and asks first, because it
// spends. It queues the work; the progress panel above the table follows it
// (ADR-189).
//
// The language and the section are the ADDRESS, not client state: changing
// either is a navigation, and the server sends only that section's rows.
// A catalog key is an identifier, so it never renders raw (code-style.md #5):
// the "Where" column humanizes its path inside the section.
import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Languages, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";
import type { InterfaceTextNamespace, InterfaceTextRow, InterfaceTextState } from "@repo/core";
import { interfaceTextSaveSchema } from "@repo/contracts";
import { Button } from "@repo/ui/components/button";
import { ConfirmDialog } from "@repo/ui/components/confirm-dialog";
import { DataTable, type DataTableLabels } from "@repo/ui/components/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@repo/ui/components/field";
import { Textarea } from "@repo/ui/components/textarea";
import { humanizeKey } from "@repo/utils";
import {
  fillInterfaceTextAction,
  resetInterfaceTextAction,
  saveInterfaceTextAction,
} from "../../../../_actions/translate-actions.ts";
import { AdminCombobox } from "../../../../_components/combobox.tsx";
import { HeaderActions } from "../../../../_components/header-actions.tsx";
import { StatusBadge, type StatusTone } from "../../../../_components/status-badge.tsx";
import { useClientTable } from "../../../../_hooks/use-client-table.ts";
import { useFieldErrors } from "../../../../_hooks/use-field-errors.ts";
import { useServerAction } from "../../../../_hooks/use-server-action.ts";
import { announceTranslationWork } from "../translation-work.ts";

const STATE_TONE: Record<InterfaceTextState, StatusTone> = {
  shipped: "neutral",
  edited: "success",
  machine: "info",
  missing: "warning",
};

/** `home.hero.title` inside the `home` section → "Hero › Title". */
function where(key: string): string {
  return key.split(".").slice(1).map(humanizeKey).join(" › ");
}

export function InterfaceTextTable({
  locale,
  direction,
  isDefault,
  languages,
  namespaces,
  namespace,
  rows,
  canFill,
}: {
  locale: string;
  direction: "ltr" | "rtl";
  isDefault: boolean;
  languages: Array<{ value: string; label: string }>;
  namespaces: InterfaceTextNamespace[];
  namespace: string | null;
  rows: InterfaceTextRow[];
  canFill: boolean;
}) {
  const t = useTranslations("admin.translate.interfaceText");
  const tAdmin = useTranslations("admin");
  const router = useRouter();
  const pathname = usePathname();
  const { run, pending } = useServerAction();
  const [editing, setEditing] = useState<InterfaceTextRow | null>(null);
  const [resetting, setResetting] = useState<InterfaceTextRow | null>(null);
  const [filling, setFilling] = useState(false);

  const go = (next: { locale?: string; ns?: string }) => {
    const params = new URLSearchParams({ locale: next.locale ?? locale });
    // A new language starts on its own first incomplete section.
    if (!next.locale && (next.ns ?? namespace)) params.set("ns", next.ns ?? namespace ?? "");
    router.push(`${pathname}?${params.toString()}`);
  };

  const { tableProps } = useClientTable(rows, {
    searchText: (row) => `${row.key} ${row.english} ${row.value ?? ""}`,
    sortValues: { state: (row) => row.state },
    initialPageSize: 50,
  });

  const reset = () => {
    if (!resetting) return;
    const row = resetting;
    run(() => resetInterfaceTextAction({ locale, key: row.key }), {
      successMessage: t("resetDone"),
      onDone: () => setResetting(null),
    });
  };

  const fill = () =>
    run(
      async () => {
        const result = await fillInterfaceTextAction({ locale });
        if (!result.ok) {
          throw new Error(
            result.reason === "providerUnavailable"
              ? tAdmin("translate.reasons.not_configured")
              : t(`refusals.${result.reason}`),
          );
        }
        if (result.remaining > 0) announceTranslationWork();
        const notes = [
          t("fillQueued", { remaining: result.remaining }),
          result.manual > 0 ? t("fillManual", { manual: result.manual }) : null,
        ];
        toast.success(notes.filter(Boolean).join(" "));
      },
      { onDone: () => setFilling(false) },
    );

  const columns = useMemo<ColumnDef<InterfaceTextRow>[]>(
    () => [
      {
        id: "where",
        header: t("colKey"),
        meta: { label: t("colKey") },
        enableHiding: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{where(row.original.key)}</span>
        ),
      },
      {
        id: "english",
        header: t("colEnglish"),
        meta: { label: t("colEnglish") },
        cell: ({ row }) => (
          <p className="max-w-80 text-sm break-words whitespace-pre-line">{row.original.english}</p>
        ),
      },
      ...(isDefault
        ? []
        : [
            {
              id: "value",
              header: t("colTranslation"),
              meta: { label: t("colTranslation") },
              cell: ({ row }) =>
                row.original.value === null ? (
                  <span className="text-sm text-muted-foreground">{t("missingValue")}</span>
                ) : (
                  <p
                    dir={direction}
                    lang={locale}
                    className="max-w-80 text-start text-sm break-words whitespace-pre-line"
                  >
                    {row.original.value}
                  </p>
                ),
            } satisfies ColumnDef<InterfaceTextRow>,
          ]),
      {
        id: "state",
        header: t("colState"),
        meta: { label: t("colState") },
        cell: ({ row }) => (
          <StatusBadge tone={STATE_TONE[row.original.state]}>
            {t(`states.${row.original.state}`)}
          </StatusBadge>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{tAdmin("actionsCol")}</span>,
        meta: { label: tAdmin("actionsCol") },
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${t("edit")}: ${where(row.original.key)}`}
              onClick={() => setEditing(row.original)}
            >
              <Pencil aria-hidden />
            </Button>
            {(row.original.state === "edited" || row.original.state === "machine") && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("reset")}: ${where(row.original.key)}`}
                onClick={() => setResetting(row.original)}
              >
                <RotateCcw aria-hidden />
              </Button>
            )}
          </div>
        ),
      },
    ],
    [t, tAdmin, isDefault, direction, locale],
  );

  const tableLabels: DataTableLabels = {
    search: t("search"),
    columns: tAdmin("columns"),
    export: tAdmin("export"),
    selectedCount: (n) => `${n} ${tAdmin("selectedCount")}`,
    page: (p, c) => `${tAdmin("pageWord")} ${p} ${tAdmin("ofWord")} ${c}`,
    previous: tAdmin("previous"),
    next: tAdmin("next"),
    noResults: tAdmin("noResults"),
  };

  const filters = (
    <>
      <AdminCombobox
        aria-label={t("language")}
        className="w-48"
        value={locale}
        onValueChange={(code) => go({ locale: code })}
        options={languages}
      />
      <AdminCombobox
        aria-label={t("section")}
        className="w-64"
        value={namespace ?? ""}
        onValueChange={(ns) => go({ ns })}
        options={namespaces.map((entry) => ({
          value: entry.name,
          label: t("sectionOption", { name: humanizeKey(entry.name), missing: entry.missing }),
        }))}
      />
    </>
  );

  return (
    <>
      <DataTable {...tableProps} columns={columns} labels={tableLabels} filters={filters} />
      {canFill && (
        <HeaderActions>
          <Button size="sm" disabled={pending} onClick={() => setFilling(true)}>
            <Languages aria-hidden data-icon="inline-start" />
            {t("fill")}
          </Button>
        </HeaderActions>
      )}

      <EditTextDialog
        row={editing}
        locale={locale}
        direction={isDefault ? "ltr" : direction}
        isDefault={isDefault}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={resetting !== null}
        onOpenChange={(open) => {
          if (!open) setResetting(null);
        }}
        title={t("resetTitle")}
        description={t("resetBody")}
        confirmLabel={t("reset")}
        cancelLabel={tAdmin("cancel")}
        onConfirm={reset}
      />
      <ConfirmDialog
        open={filling}
        onOpenChange={setFilling}
        title={t("fillTitle")}
        description={t("fillBody")}
        confirmLabel={t("fill")}
        cancelLabel={tAdmin("cancel")}
        onConfirm={fill}
      />
    </>
  );
}

function EditTextDialog({
  row,
  locale,
  direction,
  isDefault,
  onClose,
}: {
  row: InterfaceTextRow | null;
  locale: string;
  direction: "ltr" | "rtl";
  isDefault: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("admin.translate.interfaceText");
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("editTitle")}</DialogTitle>
          <DialogDescription>{t("editDescription")}</DialogDescription>
        </DialogHeader>
        {row && (
          <EditTextForm
            key={row.key}
            row={row}
            locale={locale}
            direction={direction}
            isDefault={isDefault}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditTextForm({
  row,
  locale,
  direction,
  isDefault,
  onClose,
}: {
  row: InterfaceTextRow;
  locale: string;
  direction: "ltr" | "rtl";
  isDefault: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("admin.translate.interfaceText");
  const { run, pending } = useServerAction();
  const [value, setValue] = useState(row.value ?? (isDefault ? row.english : ""));
  const values = useMemo(() => ({ locale, key: row.key, value }), [locale, row.key, value]);
  const form = useFieldErrors(interfaceTextSaveSchema, values);

  const save = () => {
    if (!form.validate()) return;
    run(
      async () => {
        const result = await saveInterfaceTextAction(values);
        if (!result.ok) throw new Error(t(`refusals.${result.reason}`));
      },
      { successMessage: t("saved"), onDone: onClose },
    );
  };

  return (
    <>
      <FieldGroup>
        <Field>
          <FieldLabel>{t("english")}</FieldLabel>
          <p className="rounded-md border bg-muted/40 p-3 text-sm break-words whitespace-pre-line">
            {row.english}
          </p>
          <FieldDescription>{where(row.key)}</FieldDescription>
        </Field>
        <Field required invalid={form.invalid("value")}>
          <FieldLabel>{t("value")}</FieldLabel>
          <Textarea
            dir={direction}
            lang={locale}
            rows={5}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <FieldDescription>{t("valueHint")}</FieldDescription>
          <FieldError>{form.error("value")}</FieldError>
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" loading={pending} onClick={save}>
          {t("save")}
        </Button>
      </DialogFooter>
    </>
  );
}

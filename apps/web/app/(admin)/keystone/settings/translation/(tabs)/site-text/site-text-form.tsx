"use client";

// Settings → Translation → Site text (ADR-165 #8): one card per translatable
// setting, its English beside the translation, saved one setting at a time.
//
// The form runs the SAME schema the service does (`settingTranslationSchema`,
// built from the English), so a translation that dropped `{year}` is named
// inline before anything is sent. The target field carries the language's
// `lang` and `dir`, so Arabic is typed right to left.
import * as React from "react";
import { Globe } from "lucide-react";
import { settingTranslationSchema, type TranslatableSettingKey } from "@repo/contracts";
import type { SiteTextEntry } from "@repo/core";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { EditorSection, Field } from "../../../../_components/editor/editor-section.tsx";
import { useFieldErrors } from "../../../../_hooks/use-field-errors.ts";
import { useServerAction } from "../../../../_hooks/use-server-action.ts";
import { saveSettingTranslationAction } from "../../../../_actions/translate-actions.ts";

type BadgeVariant = "outline" | "info" | "success" | "warning";

export interface SiteTextLabels {
  english: string;
  translation: string;
  save: string;
  saved: string;
  cleared: string;
  blankHint: string;
  emptyEnglish: string;
  machineHint: string;
  statuses: {
    missing: string;
    MACHINE_TRANSLATED: string;
    TRANSLATED: string;
    OUTDATED: string;
    NEEDS_REVIEW: string;
    DRAFT: string;
  };
  refusals: Record<"unknownLocale" | "isDefault" | "notSeeded", string>;
  /** A field's name, by registry field ("value", "label", …). */
  fields: Record<string, string>;
}

function statusOf(entry: SiteTextEntry): {
  label: keyof SiteTextLabels["statuses"];
  tone: BadgeVariant;
} {
  if (entry.status === null) return { label: "missing", tone: "outline" };
  // A person's row whose English moved on reads as "English changed" even
  // before a sweep has flagged it: the hash says so.
  if (entry.status === "TRANSLATED" && entry.stale) return { label: "OUTDATED", tone: "warning" };
  switch (entry.status) {
    case "MACHINE_TRANSLATED":
      return { label: "MACHINE_TRANSLATED", tone: "info" };
    case "TRANSLATED":
      return { label: "TRANSLATED", tone: "success" };
    default:
      return { label: entry.status, tone: "warning" };
  }
}

function SiteTextCard({
  entry,
  locale,
  direction,
  labels,
}: {
  entry: SiteTextEntry;
  locale: string;
  direction: "ltr" | "rtl";
  labels: SiteTextLabels;
}) {
  const save = useServerAction();
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(entry.fields.map((field) => [field.name, field.translated])),
  );
  const english = React.useMemo(
    () => Object.fromEntries(entry.fields.map((field) => [field.name, field.english])),
    [entry.fields],
  );
  const schema = React.useMemo(
    () => settingTranslationSchema(entry.key as TranslatableSettingKey, english),
    [entry.key, english],
  );
  const form = useFieldErrors(schema, values);
  const status = statusOf(entry);
  const hasEnglish = entry.fields.some((field) => field.english.trim() !== "");

  const onSave = () => {
    if (!form.validate()) return;
    const clearing = Object.values(values).every((text) => text.trim() === "");
    save.run(
      async () => {
        const result = await saveSettingTranslationAction({
          locale,
          key: entry.key,
          fields: values,
        });
        if (!result.ok) throw new Error(labels.refusals[result.reason]);
      },
      { successMessage: clearing ? labels.cleared : labels.saved, onDone: form.reset },
    );
  };

  return (
    <EditorSection
      title={entry.label}
      description={labels.machineHint}
      icon={Globe}
      actions={<Badge variant={status.tone}>{labels.statuses[status.label]}</Badge>}
      footer={
        hasEnglish ? (
          <div className="flex items-center justify-end">
            <Button type="button" loading={save.pending} onClick={onSave}>
              {labels.save}
            </Button>
          </div>
        ) : undefined
      }
    >
      {!hasEnglish ? (
        <p className="text-sm text-muted-foreground">{labels.emptyEnglish}</p>
      ) : (
        entry.fields.map((field) => {
          const name = labels.fields[field.name] ?? field.name;
          const Control = field.multiline ? Textarea : Input;
          return (
            <div key={field.name} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  {name} · {labels.english}
                </span>
                <p
                  lang="en"
                  dir="ltr"
                  className="rounded-md border bg-muted/40 px-3 py-2 text-sm whitespace-pre-line text-muted-foreground"
                >
                  {field.english}
                </p>
              </div>
              <Field
                label={`${name} · ${labels.translation}`}
                hint={labels.blankHint}
                error={form.error(field.name)}
              >
                <Control
                  lang={locale}
                  dir={direction}
                  value={values[field.name] ?? ""}
                  maxLength={field.max}
                  rows={field.multiline ? 6 : undefined}
                  onChange={(event: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                />
              </Field>
            </div>
          );
        })
      )}
    </EditorSection>
  );
}

export function SiteTextForm({
  entries,
  locale,
  direction,
  labels,
}: {
  entries: SiteTextEntry[];
  locale: string;
  direction: "ltr" | "rtl";
  labels: SiteTextLabels;
}) {
  return (
    <div className="flex flex-col gap-6">
      {entries.map((entry) => (
        <SiteTextCard
          key={`${locale}:${entry.key}`}
          entry={entry}
          locale={locale}
          direction={direction}
          labels={labels}
        />
      ))}
    </div>
  );
}

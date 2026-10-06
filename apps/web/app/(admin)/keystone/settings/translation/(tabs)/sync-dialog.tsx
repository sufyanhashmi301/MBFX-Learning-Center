"use client";

// Sync one language, or every one (ADR-189), translating only what is missing
// or resetting the machine's translations (ADR-191). One dialog for every place
// Sync is offered — the Overview cards and table, Interface text, Languages —
// so the choice reads the same everywhere, and the confirmation that this can
// spend characters is never left out (code-style.md #7's reasoning, applied to
// money).
//
// The action re-checks `translations.approve`; a caller draws the button only
// for someone who holds it.
import { useState } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { TRANSLATION_SYNC_MODES, type TranslationSyncMode } from "@repo/contracts";
import { Button } from "@repo/ui/components/button";
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
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  useFieldContext,
} from "@repo/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@repo/ui/components/radio-group";
import { syncTranslationsAction } from "../../../_actions/translate-actions.ts";
import { useServerAction } from "../../../_hooks/use-server-action.ts";
import { announceTranslationWork } from "./translation-work.ts";

/** One language, or — with no locale — every language that is not the default. */
export interface SyncTarget {
  locale?: string;
  language?: string;
}

export function SyncDialog({
  target,
  onClose,
}: {
  target: SyncTarget | null;
  onClose: () => void;
}) {
  const t = useTranslations("admin.translate.sync");
  const { run, pending } = useServerAction();
  const [mode, setMode] = useState<TranslationSyncMode>("missing");

  const close = () => {
    setMode("missing");
    onClose();
  };

  const confirm = () => {
    if (!target) return;
    run(
      async () => {
        const result = await syncTranslationsAction({
          ...(target.locale ? { locale: target.locale } : {}),
          mode,
        });
        if (!result.ok) throw new Error(t(`refusals.${result.reason}`));
        announceTranslationWork();
      },
      { successMessage: t(mode === "reset" ? "resetDone" : "missingDone"), onDone: close },
    );
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {target?.language ? t("title", { language: target.language }) : t("allTitle")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend className="sr-only">{t("modeLegend")}</FieldLegend>
          <RadioGroup value={mode} onValueChange={(value) => setMode(value as TranslationSyncMode)}>
            {TRANSLATION_SYNC_MODES.map((option) => (
              <Field key={option} orientation="horizontal">
                <ModeRadio value={option} />
                <FieldContent>
                  <FieldLabel>{t(`modes.${option}`)}</FieldLabel>
                  <FieldDescription>{t(`modes.${option}Hint`)}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button loading={pending} onClick={confirm}>
            {t(mode === "reset" ? "confirmReset" : "confirmMissing")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One option's radio, named by its own Field. The group is not a Field here
 * (each option is), so the radio takes its Field's wiring itself: the label's
 * `htmlFor` reaches it through `controlId`, and `aria-labelledby` names the
 * element a screen reader actually lands on (Base UI puts the `id` on its
 * hidden input — the reason `useFieldControl` has `labelledBy`).
 */
function ModeRadio({ value }: { value: TranslationSyncMode }) {
  const field = useFieldContext();
  return (
    <RadioGroupItem
      value={value}
      id={field?.controlId}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
    />
  );
}

/** A Sync button for one language (or all), with its own dialog. */
export function SyncButton({
  locale,
  language,
  variant = "outline",
}: SyncTarget & { variant?: "default" | "outline" }) {
  const t = useTranslations("admin.translate.sync");
  const [target, setTarget] = useState<SyncTarget | null>(null);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setTarget({ locale, language })}>
        <RefreshCw aria-hidden data-icon="inline-start" />
        {locale ? t("button") : t("allButton")}
      </Button>
      <SyncDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}

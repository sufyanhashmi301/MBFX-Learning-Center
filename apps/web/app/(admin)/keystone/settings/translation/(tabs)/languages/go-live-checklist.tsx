"use client";

// What a language still needs before it can go live (ADR-178 #8). Opened by
// the Live switch on a row that is not ready, instead of the switch doing
// nothing: each unmet item says how much is missing and links to the screen
// that fixes it. The service still refuses activation on its own (ADR-163
// #2); this dialog only explains the refusal before it happens.
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CircleCheck, CircleDashed } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";

export interface ChecklistLanguage {
  code: string;
  name: string;
  /** Public interface strings missing; null when the site cannot route it. */
  catalogGaps: number | null;
}

const ROOT = "/keystone/settings/translation";

export function GoLiveChecklist({
  language,
  onClose,
  canEditInterfaceText,
}: {
  language: ChecklistLanguage | null;
  onClose: () => void;
  canEditInterfaceText: boolean;
}) {
  const t = useTranslations("admin.translate.languages.checklist");
  const items = language
    ? [
        {
          key: "interfaceText",
          done: language.catalogGaps === 0,
          title: t("interfaceTextTitle"),
          detail:
            language.catalogGaps === 0
              ? t("interfaceTextDone")
              : t("interfaceTextMissing", { count: language.catalogGaps ?? 0 }),
          href: canEditInterfaceText
            ? `${ROOT}/interface-text?locale=${encodeURIComponent(language.code)}`
            : null,
          action: t("interfaceTextAction"),
        },
      ]
    : [];

  return (
    <Dialog open={language !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{language ? t("title", { language: language.name }) : ""}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-3 rounded-lg border p-3">
              {item.done ? (
                <CircleCheck aria-hidden className="mt-0.5 size-5 text-success-interactive" />
              ) : (
                <CircleDashed aria-hidden className="mt-0.5 size-5 text-warning-interactive" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium">{item.title}</span>
                <span className="text-sm text-muted-foreground">{item.detail}</span>
              </div>
              {!item.done && item.href && (
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link href={item.href} />}
                  onClick={onClose}
                >
                  {item.action}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t("googleHint")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

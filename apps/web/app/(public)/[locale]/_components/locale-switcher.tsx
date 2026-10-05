"use client";

import { Check, Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@repo/i18n/navigation";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";

export interface SwitcherLocale {
  code: string;
  nativeName: string;
  flagEmoji: string | null;
}

/** The short code a reader recognises: "EN", "AR". */
function shortCode(code: string): string {
  return code.split("-")[0]!.toUpperCase();
}

/** Only ACTIVE locales are offered (the dynamic half of routing.ts's static/dynamic trade-off) — the server passes them in. */
export function LocaleSwitcher({ locales }: { locales: SwitcherLocale[] }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const current = useLocale();

  if (locales.length < 2) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          // A globe and the two-letter code: short enough to stay at every
          // width (the full name pushed the end cluster off the screen at
          // 1280px, Phase 6 RTL smoke). The accessible name is "Language EN",
          // so the visible code is part of it.
          <Button variant="ghost" size="sm" className="gap-1.5">
            <Globe data-icon="inline-start" aria-hidden />
            <span className="sr-only">{t("chooseLanguage")}</span>
            <span className="text-xs font-semibold tracking-wide">{shortCode(current)}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {locales.map((locale) => {
          const isCurrent = locale.code === current;
          return (
            <DropdownMenuItem
              key={locale.code}
              render={
                <Link
                  href={pathname}
                  locale={locale.code}
                  aria-current={isCurrent ? "true" : undefined}
                  className="gap-2.5"
                >
                  <span lang={locale.code}>{locale.nativeName}</span>
                  <span className="ms-auto ps-4 text-xs text-muted-foreground">
                    {shortCode(locale.code)}
                  </span>
                  <Check
                    aria-hidden
                    className={isCurrent ? "size-4 text-primary" : "invisible size-4"}
                  />
                </Link>
              }
            />
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

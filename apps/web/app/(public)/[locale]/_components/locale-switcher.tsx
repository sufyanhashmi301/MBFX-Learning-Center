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
import { cn } from "@repo/ui/lib/utils";

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
export function LocaleSwitcher({
  locales,
  compactBelowSm = true,
  onNavigate,
}: {
  locales: SwitcherLocale[];
  /**
   * The header's copy drops the visible code below sm, where the bar has no
   * room for it. The mobile sheet's copy has a whole row and keeps it.
   */
  compactBelowSm?: boolean;
  /** Called when a language is picked — the mobile sheet closes itself on it, as on every other row. */
  onNavigate?: () => void;
}) {
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
          // Below sm it is the globe alone in a 36px square: a phone's row
          // also holds the hamburger, the centred logo, search and (signed
          // in) the avatar, and the code was what pushed the cluster under
          // the logo. The code stays in the accessible name there (sr-only),
          // and the menu itself names every language in full. No
          // `data-icon` on the glyph: the Button's `has-data-[icon]` padding
          // outranks a responsive `px-0`, so the padding is stated here.
          <Button
            variant="ghost"
            size="sm"
            className={cn("gap-1.5 ps-2.5", compactBelowSm && "max-sm:w-9 max-sm:px-0")}
          >
            <Globe aria-hidden className="size-4" />
            <span className="sr-only">{t("chooseLanguage")}</span>
            <span
              className={cn(
                "text-xs font-semibold tracking-wide",
                compactBelowSm && "max-sm:sr-only",
              )}
            >
              {shortCode(current)}
            </span>
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
                  onClick={onNavigate}
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

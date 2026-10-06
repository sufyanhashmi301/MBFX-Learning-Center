"use client";

// Mobile companion to the desktop nav (which is hidden below xl — changes-21
// D-1): the same NavItem data, in the shape a phone or tablet can actually use.
// Below sm it also carries the theme toggle as an "Appearance" row, because the
// header row cannot hold it on a 360px phone (changes-21 D-2).
//
// This was a dropdown menu; the mega-menu work (ADR-048) moved it to a
// sheet with accordion sections. A dropdown cannot express what a panel
// says — column headings, one-line descriptions, more than a handful of
// rows — and on a phone it opened a scrolling popover over the page rather
// than a surface you can thumb through. The desktop panel's structure is
// preserved: the same columns, in the same order, from the same registry.
//
// changes-43 gave it the owner's reference shape (mbfx.co's own mobile menu):
// - a full-width panel on a phone with the brand and a close button at the top;
// - one list of top-level rows, each with its glyph, where a section opens in
//   place under a chevron;
// - a divider, then Home and Sign in side by side and Join us full width.
// The account actions sit at the bottom because that is where a thumb is, and
// the header row has no room for them below sm.
import { useId, useState } from "react";
import {
  BookA,
  CalendarDays,
  Calculator,
  Headset,
  LineChart,
  Menu,
  Newspaper,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { ACCOUNT_PATH } from "@repo/contracts";
import { Link } from "@repo/i18n/navigation";
import { Button } from "@repo/ui/components/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@repo/ui/components/accordion";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@repo/ui/components/sheet";
import { cn } from "@repo/ui/lib/utils";
import {
  MEGA_MENU_ICONS,
  panelForHref,
  resolveMegaMenuPanel,
  routeKeyForHref,
  type MegaResolvableItem,
} from "../_nav/mega-menu.ts";
import { LocaleSwitcher, type SwitcherLocale } from "./locale-switcher.tsx";
import { ModeToggle } from "./mode-toggle.tsx";
import { usePublicSession } from "./public-session.tsx";

export interface MobileNavItem extends MegaResolvableItem {
  children: MegaResolvableItem[];
}

type IconComponent = React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

// Top-level rows whose route has no mega-menu glyph. The mega registry names
// the destinations INSIDE a panel; a top-level row is the section itself.
const SECTION_ICONS: Partial<Record<string, LucideIcon>> = {
  glossary: BookA,
  tools: Calculator,
  analysis: LineChart,
  news: Newspaper,
  "economic-calendar": CalendarDays,
  support: Headset,
};

function sectionIcon(href: string): IconComponent | undefined {
  const key = routeKeyForHref(href);
  if (!key) return undefined;
  return MEGA_MENU_ICONS[key] ?? SECTION_ICONS[key];
}

/** A top-level row: glyph + label, the reference's plain list line. */
const TOP_ROW =
  "flex w-full items-center gap-4 rounded-lg px-2.5 py-3 text-base font-semibold text-foreground transition-colors duration-(--duration-base) hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:bg-muted";

/** One destination row inside a section — icon box, label, and its one-line description. */
function NavRow({
  item,
  icon: Icon,
  onNavigate,
}: {
  item: MegaResolvableItem;
  icon?: IconComponent;
  onNavigate: () => void;
}) {
  // Mirrors MegaMenuLink's hover treatment (ADR-051 §6) so the same
  // destination behaves the same way whichever navigation the visitor is in.
  // On touch there is no hover, so :active carries it — a row that gives no
  // feedback until the page changes reads as a dead tap.
  const className =
    "group/row flex items-start gap-3 rounded-xl p-2.5 ring-1 ring-transparent transition duration-(--duration-base) hover:bg-muted hover:ring-primary/25 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:bg-muted";
  const content = (
    <>
      {Icon && (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-primary-interactive transition-colors duration-(--duration-base) group-hover/row:bg-primary-solid group-hover/row:text-primary-solid-foreground group-active/row:bg-primary-solid group-active/row:text-primary-solid-foreground">
          <Icon aria-hidden className="size-4" />
        </span>
      )}
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-foreground transition-colors duration-(--duration-base) group-hover/row:text-primary-interactive">
          {item.label}
        </span>
        {item.title && <span className="text-xs text-muted-foreground">{item.title}</span>}
      </span>
    </>
  );

  return <ItemLink item={item} className={className} onNavigate={onNavigate} content={content} />;
}

function ItemLink({
  item,
  className,
  onNavigate,
  content,
}: {
  item: MegaResolvableItem;
  className: string;
  onNavigate: () => void;
  content: React.ReactNode;
}) {
  const newTab = item.openInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {};
  if (item.isExternal) {
    return (
      <a href={item.href} className={className} onClick={onNavigate} {...newTab}>
        {content}
      </a>
    );
  }
  return (
    <Link href={item.href} className={className} onClick={onNavigate} {...newTab}>
      {content}
    </Link>
  );
}

/** Home + the account entry points, the reference's footer block. */
function AccountActions({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslations("nav");
  const session = usePublicSession();

  // `loading` draws the anonymous pair's boxes so nothing jumps when the
  // session answers, the same choice `AuthSlot` makes in the header.
  const signedIn = session.status === "learner";
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="secondary"
          size="lg"
          className="w-full bg-muted text-foreground hover:bg-accent"
          render={<Link href="/" onClick={onNavigate} />}
        >
          {t("home")}
        </Button>
        {signedIn ? (
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            render={<Link href={ACCOUNT_PATH} onClick={onNavigate} />}
          >
            {t("myAccount")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            render={<Link href="/sign-in" onClick={onNavigate} />}
          >
            {t("signIn")}
          </Button>
        )}
      </div>
      {!signedIn && (
        <Button size="lg" className="w-full" render={<Link href="/sign-up" onClick={onNavigate} />}>
          {t("signUp")}
        </Button>
      )}
    </div>
  );
}

export function MobileNav({
  items,
  menuLabel,
  brand,
  locales = [],
}: {
  items: MobileNavItem[];
  menuLabel: string;
  /** Active locales; with two or more the sheet's top bar carries the language switcher. */
  locales?: SwitcherLocale[];
  /** The header's own logo, so the open menu is visibly the same site. */
  brand?: React.ReactNode;
}) {
  const t = useTranslations("nav");
  const [open, setOpen] = useState(false);
  const appearanceId = useId();
  const close = () => setOpen(false);

  if (items.length === 0) return null;

  return (
    <div className="xl:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          render={
            <Button variant="ghost" size="icon" aria-label={menuLabel}>
              <Menu aria-hidden className="size-5" />
            </Button>
          }
        />
        {/* Full width on a phone, the reference's panel; a drawer from sm. The
            corner close is replaced by one in the brand row, where the
            reference has it and where it cannot sit on top of a row. */}
        <SheetContent side="start" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-sm">
          {/* The logo is CENTRED (changes-49), matching the bar behind the
              sheet. The close button is the hamburger glyph pinned to the
              inline START — the exact spot the trigger occupies in the bar, so
              the same tap opens and closes the menu (owner, changes-51). It is
              absolutely placed so it does not push the logo off-centre. */}
          <SheetHeader className="sticky top-0 z-10 flex-row items-center justify-center gap-4 border-b border-border bg-background/95 px-16 py-4 backdrop-blur-md">
            {/* The title names the dialog for assistive tech; on screen the
                logo already says whose menu this is. */}
            <SheetTitle className="sr-only">{menuLabel}</SheetTitle>
            <Link href="/" onClick={close} className="flex min-w-0 items-center">
              {brand}
            </Link>
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("closeMenu")}
                  className="absolute start-5 top-1/2 -translate-y-1/2"
                >
                  <Menu aria-hidden className="size-5" />
                </Button>
              }
            />
            {/* Language takes the opposite corner from the close button
                (owner): the top inline END, where a reader looks for it on
                the header bar behind the sheet. Absolutely placed for the
                same reason as the close button — the logo stays centred. The
                visible code stays, because the corner has room for it. */}
            {locales.length > 1 && (
              <div className="absolute end-5 top-1/2 -translate-y-1/2">
                <LocaleSwitcher locales={locales} compactBelowSm={false} onNavigate={close} />
              </div>
            )}
          </SheetHeader>

          <nav className="flex flex-col gap-1 px-3 py-4" aria-label={menuLabel}>
            {items.map((item) => {
              const Icon = sectionIcon(item.href);
              const glyph = Icon ? (
                <Icon aria-hidden className="size-5 shrink-0 text-foreground" />
              ) : null;

              if (item.children.length === 0) {
                return (
                  <ItemLink
                    key={item.id}
                    item={item}
                    className={TOP_ROW}
                    onNavigate={close}
                    content={
                      <>
                        {glyph}
                        {item.label}
                      </>
                    }
                  />
                );
              }

              const panel = panelForHref(item.href);
              const resolved = panel ? resolveMegaMenuPanel(panel, item.children) : null;

              return (
                <Accordion key={item.id}>
                  {/* border-b-0: the menu is one list of rows, not a divided
                      FAQ — a rule under the sections and none under the plain
                      links beside them would read as two different lists. */}
                  <AccordionItem value={item.id} className="border-b-0">
                    <AccordionTrigger className={cn(TOP_ROW, "hover:no-underline")}>
                      {/* The label grows, so the trigger's own chevron lands at the
                          inline end and the glyph stays beside the words. */}
                      <span className="flex flex-1 items-center gap-4">
                        {glyph}
                        {item.label}
                      </span>
                    </AccordionTrigger>
                    {/* AccordionContent underlines every descendant link
                        ([&_a]:underline) — right for the FAQ prose it was built
                        for, wrong for a nav row. Overridden with the important
                        marker because the two selectors tie on specificity. */}
                    <AccordionContent className="ps-6 [&_a]:no-underline!">
                      <div className="flex flex-col gap-4 pb-2">
                        {resolved
                          ? resolved.columns.map((column) => (
                              <div key={column.key} className="flex flex-col gap-1">
                                <p className="px-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                                  {t(column.titleKey)}
                                </p>
                                {column.items.map(({ item: child, icon }) => (
                                  <NavRow
                                    key={child.id}
                                    item={child}
                                    icon={icon}
                                    onNavigate={close}
                                  />
                                ))}
                              </div>
                            ))
                          : item.children.map((child) => (
                              <NavRow key={child.id} item={child} onNavigate={close} />
                            ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              );
            })}
          </nav>

          <div className="mt-auto flex flex-col gap-4 border-t border-border px-5 py-5">
            {/* The theme toggle's home below sm (changes-21 D-2): the header
                row hides it there. From sm up the header has room, so this row
                hides instead of showing the same control twice. The group is
                named by its visible label; the button keeps its own
                "Toggle theme" name. */}
            <div
              role="group"
              aria-labelledby={appearanceId}
              className="flex items-center justify-between gap-3 sm:hidden"
            >
              <span id={appearanceId} className="text-sm font-semibold text-foreground">
                {t("appearance")}
              </span>
              <ModeToggle />
            </div>
            <AccountActions onNavigate={close} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

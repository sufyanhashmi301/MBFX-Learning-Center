"use client";

// The home band of live promotions as a SPOTLIGHT (ADR-175, superseding
// ADR-174 #6): one promotion is selected, its picture is raised above its
// neighbours with a few facts under it, and the start column is ITS
// description, changing with the selection.
//
// Semantics are the APG carousel with tabs as the slide picker: the tiles are
// `tab`s, the start column is the `tabpanel`. Only the selected tab is in the
// tab order; the arrow keys move the selection (flipped in RTL), and so does a
// swipe on a touch screen.
//
// The track SLIDES by a transform; nothing scrolls. The selected tile keeps its
// place near the start with the previous one showing before it — whole from
// `lg`, a sliver below — so the page never moves on its own (ADR-121 §4).
//
// Autoplay keeps every ADR-174 #2 guard: never under reduced motion, never
// while the pointer or focus is inside, while the band is under half on screen
// or while the tab is hidden, and a visible pause button. The active dash fills
// over the interval so a reader can see when it will move.
//
// The band is rendered on the server without a session (the home page reads
// none — ADR-094), so the audience rule runs HERE, against the one session read
// the public surface already makes. Until that read lands only everyone-audience
// promotions show, which is exactly what the server rendered.
//
// An impression is the SELECTED promotion while the band is at least half on
// screen (ADR-175 #5), once per promotion per page load. A click is the button.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import {
  CalendarDays,
  Clock,
  ExternalLink,
  Megaphone,
  MonitorPlay,
  Newspaper,
  PlayCircle,
  Tag,
  type LucideIcon,
} from "lucide-react";
import {
  promotionAudienceIncludes,
  promotionCountdown,
  type PromotionKindInput,
} from "@repo/contracts";
import type { PublicPromotion } from "@repo/core";
import { Link } from "@repo/i18n/navigation";
import { Badge } from "@repo/ui/components/badge";
import { Container } from "@repo/ui/components/container";
import { Section } from "@repo/ui/components/section";
import { cn } from "@repo/ui/lib/utils";
import { formatDate, htmlLead } from "@repo/utils";
import { PROMOTION_KIND_TONE } from "../../../_lib/promotion-kind-tone.ts";
import { REDUCED_MOTION_QUERY, useMediaQuery, usePageVisible } from "../_lib/document-state.ts";
import { reportPromotionEvent } from "../_lib/promotion-events.ts";
import {
  formatCountdown,
  hasPromotionCta,
  PromotionCta,
  PromotionEventMeta,
  PROMOTION_PICTURE_CROP,
  useNow,
  usePromotionClock,
} from "./promotion-card.tsx";
import { usePublicSession } from "./public-session.tsx";

/** How long each promotion stays selected before the next (ADR-175 #3). */
const ROTATE_MS = 7000;
/** Half the band on screen is what counts as seen; less is a scroll past. */
const SEEN_RATIO = 0.5;
/** A window closing within this is worth saying first (ADR-175 #4). */
const ENDS_SOON_MS = 3 * 24 * 60 * 60 * 1000;
/** A horizontal drag this long is a swipe; shorter is a tap. */
const SWIPE_PX = 40;
/** Characters of the body the start column shows. */
const LEAD_CHARS = 240;

const KIND_ICON: Record<PromotionKindInput, LucideIcon> = {
  WEBINAR: MonitorPlay,
  EVENT: CalendarDays,
  OFFER: Tag,
  NEWS: Newspaper,
  ANNOUNCEMENT: Megaphone,
};

export function PromotionsBandCards({ promotions }: { promotions: PublicPromotion[] }) {
  const session = usePublicSession();
  const signedIn = session.status === "loading" ? null : session.status === "learner";
  const shown = promotions.filter((p) => promotionAudienceIncludes(p.audience, signedIn));
  if (shown.length === 0) return null;
  return <Spotlight promotions={shown} />;
}

/**
 * Which promotion is selected, and the timer that moves it on. The list can
 * shrink under the index (the audience read lands, a promotion ends), so the
 * index wraps rather than pointing past the end.
 */
function useSpotlight(count: number, region: React.RefObject<HTMLElement | null>) {
  const [index, setIndex] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [inView, setInView] = useState(false);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const pageVisible = usePageVisible();

  // Fail CLOSED: with no observer there is no knowing whether the band is on
  // screen, and motion nobody can see surprises whoever scrolls to it. The
  // same observation decides impressions.
  useEffect(() => {
    const element = region.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView((entry?.intersectionRatio ?? 0) >= SEEN_RATIO),
      { threshold: [0, SEEN_RATIO] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [region]);

  const current = index % count;
  const playing =
    count > 1 && !hovering && !focusWithin && !reducedMotion && inView && pageVisible;

  // A timeout re-armed on every change of selection, not an interval: a reader
  // who picks a promotion by hand gets the full time on it before it moves.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setIndex((current + 1) % count), ROTATE_MS);
    return () => window.clearTimeout(timer);
  }, [playing, current, count]);

  return {
    current,
    playing,
    inView,
    goTo: (next: number) => setIndex(((next % count) + count) % count),
    bind: {
      onPointerEnter: (event: PointerEvent) => {
        // A finger has no hover; a touch "enter" would stop it for good.
        if (event.pointerType === "mouse") setHovering(true);
      },
      onPointerLeave: () => setHovering(false),
      onFocus: () => setFocusWithin(true),
      onBlur: (event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      },
    },
  };
}

function Spotlight({ promotions }: { promotions: PublicPromotion[] }) {
  const t = useTranslations("promotions");
  const locale = useLocale();
  const regionRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const swipeFrom = useRef<number | null>(null);
  const reported = useRef(new Set<string>());
  const baseId = useId();

  const count = promotions.length;
  const multi = count > 1;
  const spot = useSpotlight(count, regionRef);
  const promotion = promotions[spot.current] ?? promotions[0]!;
  const clock = usePromotionClock(promotion);

  useEffect(() => {
    if (!spot.inView || reported.current.has(promotion.id)) return;
    reported.current.add(promotion.id);
    reportPromotionEvent(locale, { id: promotion.id, surface: "BAND", type: "IMPRESSION" });
  }, [spot.inView, promotion.id, locale]);

  const isRtl = () =>
    regionRef.current ? getComputedStyle(regionRef.current).direction === "rtl" : false;

  const select = (next: number, focus = false) => {
    const target = ((next % count) + count) % count;
    spot.goTo(target);
    if (focus) tabRefs.current[target]?.focus();
  };

  const onTabKey = (event: KeyboardEvent) => {
    const forward = isRtl() ? "ArrowLeft" : "ArrowRight";
    const back = isRtl() ? "ArrowRight" : "ArrowLeft";
    const moves: Record<string, number> = {
      [forward]: spot.current + 1,
      [back]: spot.current - 1,
      Home: 0,
      End: count - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
  };

  // Touch and pen only: a mouse drag over a picture is a reader selecting, not
  // paging. `touch-pan-y` on the viewport leaves vertical scrolling native.
  const onSwipeStart = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") swipeFrom.current = event.clientX;
  };
  const onSwipeEnd = (event: PointerEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    if (from === null || !multi) return;
    const dx = event.clientX - from;
    if (Math.abs(dx) < SWIPE_PX) return;
    const towardsStart = isRtl() ? dx > 0 : dx < 0;
    select(spot.current + (towardsStart ? 1 : -1));
  };

  const panelId = `${baseId}-panel`;
  const tabId = (index: number) => `${baseId}-tab-${index}`;
  // `lang` only when the words are NOT the page's language (ADR-167 #6).
  const lang = promotion.lang !== locale ? promotion.lang : undefined;
  const lead =
    (promotion.bodyHtml ? htmlLead(promotion.bodyHtml, LEAD_CHARS) : promotion.summary) ||
    t("bandLead");
  const meta = <PromotionEventMeta promotion={promotion} clock={clock} onEngage={engage} />;
  function engage() {
    reportPromotionEvent(locale, { id: promotion.id, surface: "BAND", type: "CLICK" });
  }

  return (
    <Section spacing="sm">
      <Container>
        <div
          ref={regionRef}
          {...(multi
            ? {
                role: "region",
                "aria-roledescription": "carousel",
                "aria-label": t("bandCarouselLabel"),
              }
            : {})}
          {...spot.bind}
          className="grid grid-cols-1 gap-5 lg:grid-cols-(--grid-intro-main) lg:gap-x-12 lg:gap-y-4"
        >
          {/* The band's own heading. The promotion's title below is an h3. */}
          <div className="flex flex-col gap-1 lg:col-start-1 lg:row-start-1 lg:self-end">
            <p className="text-xs font-semibold tracking-caps text-primary-interactive uppercase">
              {t("bandEyebrow")}
            </p>
            <h2 className="font-display text-xl font-semibold text-foreground">
              {t("bandTitle")}
            </h2>
          </div>

          {/* The tiles. */}
          <div
            className={cn(
              "relative min-w-0 touch-pan-y overflow-hidden py-2 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center",
              // The track's geometry, as custom properties so the transform,
              // the widths and the drop all read one set of numbers. `lead` is
              // how much of the previous tile shows before the selected one,
              // in tiles.
              "[--promo-dir:-1] [--promo-gap:1rem] [--promo-lead:0.3] [--promo-tile-active:58%] [--promo-tile:38%] rtl:[--promo-dir:1]",
              "sm:[--promo-tile-active:40%] sm:[--promo-tile:27%]",
              "lg:[--promo-lead:1] lg:[--promo-tile-active:34%] lg:[--promo-tile:24%] lg:[--promo-gap:1.25rem]",
            )}
            onPointerDown={onSwipeStart}
            onPointerUp={onSwipeEnd}
            onPointerCancel={() => {
              swipeFrom.current = null;
            }}
          >
            <div
              {...(multi
                ? { role: "tablist", "aria-label": t("bandTabsLabel"), onKeyDown: onTabKey }
                : {})}
              className="flex items-start gap-(--promo-gap) transition-transform duration-700 ease-out motion-reduce:transition-none"
              // Slide so the selected tile keeps its place, but never past the
              // point where the LAST tile meets the end: a short row stays put
              // rather than sliding away from its own empty space. Percentages
              // in `translate` resolve against the track, which is the
              // viewport's width, like the tiles' own.
              style={{
                translate: `calc(var(--promo-dir) * max(0px, min((${spot.current} - var(--promo-lead)) * (var(--promo-tile) + var(--promo-gap)), ${count - 1} * (var(--promo-tile) + var(--promo-gap)) + var(--promo-tile-active) - 100%))) 0`,
              }}
            >
              {promotions.map((p, index) => {
                const selected = index === spot.current;
                return (
                  <div
                    key={p.id}
                    className={cn(
                      "flex shrink-0 flex-col gap-2 transition-all duration-700 ease-out motion-reduce:transition-none",
                      selected ? "w-(--promo-tile-active)" : "w-(--promo-tile)",
                    )}
                    // Unselected tiles sit centred on the selected picture's
                    // height: a 4:5 tile's height is 5/4 of its width, so half
                    // the height difference is 5/8 of the width difference
                    // (percent margins resolve against the track's width).
                    style={
                      selected
                        ? undefined
                        : {
                            marginBlockStart:
                              "calc((var(--promo-tile-active) - var(--promo-tile)) * 5 / 8)",
                          }
                    }
                  >
                    <Tile
                      promotion={p}
                      selected={selected}
                      multi={multi}
                      id={tabId(index)}
                      panelId={panelId}
                      buttonRef={(el) => {
                        tabRefs.current[index] = el;
                      }}
                      onSelect={() => select(index)}
                      onEngage={engage}
                    />
                    {selected ? <TileFacts key={p.id} promotion={p} /> : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* The selected promotion's description. */}
          <div className="flex min-w-0 flex-col gap-5 lg:col-start-1 lg:row-start-2 lg:self-start">
            <div
              id={panelId}
              {...(multi
                ? { role: "tabpanel", "aria-labelledby": tabId(spot.current), tabIndex: 0 }
                : {})}
              // A panel that changes on its own is announced only when the
              // reader has stopped it (ADR-174 #2).
              aria-live={multi ? (spot.playing ? "off" : "polite") : undefined}
              {...(lang ? { lang } : {})}
              className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <div key={promotion.id} className="promo-panel-enter flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={PROMOTION_KIND_TONE[promotion.kind]}>
                    {t(`kinds.${promotion.kind}`)}
                  </Badge>
                  {promotion.badge ? <Badge variant="outline">{promotion.badge}</Badge> : null}
                </div>
                <h3 className="font-display text-2xl leading-tight font-medium text-balance text-foreground sm:text-3xl">
                  {promotion.title}
                </h3>
                <span aria-hidden className="h-0.5 w-14 bg-primary" />
                <p className="line-clamp-3 text-base text-muted-foreground">{lead}</p>
                {clock.hydrated && promotion.eventStartsAt && clock.phase ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">{meta}</div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {hasPromotionCta(promotion, clock) ? (
                <PromotionCta promotion={promotion} clock={clock} onEngage={engage} />
              ) : null}
              {multi ? <Pager count={count} current={spot.current} playing={spot.playing} /> : null}
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}

function Tile({
  promotion: p,
  selected,
  multi,
  id,
  panelId,
  buttonRef,
  onSelect,
  onEngage,
}: {
  promotion: PublicPromotion;
  selected: boolean;
  multi: boolean;
  id: string;
  panelId: string;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onEngage: () => void;
}) {
  const Icon = KIND_ICON[p.kind];
  const frame = cn(
    "group relative block aspect-4/5 w-full overflow-hidden rounded-lg bg-muted text-start transition-shadow duration-700",
    selected ? "shadow-xl ring-1 ring-border" : "shadow-sm",
  );
  const picture = (
    <>
      {p.imageUrl ? (
        <Image
          src={p.imageUrl}
          // The tab is named by the title; the picture adds nothing to it.
          alt=""
          fill
          sizes="(min-width: 1024px) 20rem, 60vw"
          className={cn(
            "object-cover transition-transform duration-700 ease-out motion-reduce:transition-none",
            selected ? PROMOTION_PICTURE_CROP : `${PROMOTION_PICTURE_CROP} group-hover:scale-105`,
          )}
        />
      ) : (
        // No picture: a quiet ground in the brand's two colours with the
        // kind's glyph, so the row never has a hole in it.
        <span className="absolute inset-0 flex items-center justify-center bg-linear-to-br from-primary/20 via-muted to-secondary/30">
          <Icon aria-hidden className="size-12 text-muted-foreground" />
        </span>
      )}
      {selected && p.badge ? (
        <span className="absolute end-3 top-3 max-w-4/5 truncate rounded-sm bg-foreground/80 px-2 py-1 text-3xs font-semibold tracking-caps text-background uppercase backdrop-blur-sm">
          {p.badge}
        </span>
      ) : null}
      {selected ? null : (
        <span
          aria-hidden
          className="absolute inset-0 bg-background/10 transition-colors group-hover:bg-transparent"
        />
      )}
    </>
  );

  // The title card is a SIBLING of the tab, laid over it, never inside it: a
  // link nested in a `<button>` is invalid markup and its clicks would select
  // the tab instead of following the link.
  return (
    <div className="relative w-full">
      {multi ? (
        <button
          ref={buttonRef}
          type="button"
          id={id}
          role="tab"
          aria-selected={selected}
          aria-controls={panelId}
          aria-label={p.title}
          tabIndex={selected ? 0 : -1}
          onClick={onSelect}
          className={cn(
            frame,
            "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
        >
          {picture}
        </button>
      ) : (
        <div className={frame}>{picture}</div>
      )}
      {selected ? <TileTitle promotion={p} onEngage={onEngage} /> : null}
    </div>
  );
}

/**
 * The selected tile's title card. It follows the same destination as the
 * panel's button — the recording after an event, otherwise the promotion's
 * own link — and is plain text when there is neither.
 */
function TileTitle({
  promotion: p,
  onEngage,
}: {
  promotion: PublicPromotion;
  onEngage: () => void;
}) {
  const t = useTranslations("promotions");
  const clock = usePromotionClock(p);
  const Icon = KIND_ICON[p.kind];
  const href = clock.recording ?? p.href;
  const className = cn(
    "absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-md bg-background/90 p-2 pe-3 shadow-sm backdrop-blur-sm",
    href &&
      "transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  );
  const body = (
    <>
      {/* A glyph disc: its geometry is a circle (ADR-107). */}
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold text-foreground">{p.title}</span>
        <span className="truncate text-xs text-muted-foreground">{t(`kinds.${p.kind}`)}</span>
      </span>
      {href && p.external && !clock.recording ? (
        <>
          <ExternalLink aria-hidden className="ms-auto size-4 shrink-0 text-muted-foreground" />
          <span className="sr-only"> — {t("opensInNewTab")}</span>
        </>
      ) : null}
    </>
  );

  if (!href) return <span className={className}>{body}</span>;
  if (p.external && !clock.recording) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onEngage}
        className={className}
      >
        {body}
      </a>
    );
  }
  return (
    <Link href={href} onClick={onEngage} className={className}>
      {body}
    </Link>
  );
}

/**
 * The facts under the selected picture (ADR-175 #4). The first line is the
 * most urgent true thing; the second is small icon facts. Clock-derived words
 * wait for hydration, like every other time on a promotion.
 */
function TileFacts({ promotion: p }: { promotion: PublicPromotion }) {
  const t = useTranslations("promotions");
  const locale = useLocale();
  const clock = usePromotionClock(p);
  const now = useNow(true);
  const Icon = KIND_ICON[p.kind];

  // Before hydration the kind stands in: it is true, and it needs no clock.
  // The admin's badge is already on the picture, so it is never repeated here.
  let headline: { text: string; live?: boolean } = { text: t(`kinds.${p.kind}`) };
  let showUntil = true;
  if (clock.hydrated && now) {
    const endsIn = promotionCountdown(p.endsAt, now);
    const endsSoon = new Date(p.endsAt).getTime() - now.getTime() <= ENDS_SOON_MS;
    if (clock.phase === "LIVE") headline = { text: t("liveNow"), live: true };
    else if (clock.countdown)
      headline = { text: t("startsIn", { time: formatCountdown(clock.countdown, locale) }) };
    else if (endsIn && endsSoon)
      headline = { text: t("endsIn", { time: formatCountdown(endsIn, locale) }) };
    else {
      headline = { text: t("until", { date: formatDate(p.endsAt, locale) }) };
      showUntil = false;
    }
  }

  const facts: Array<{ icon: LucideIcon; text: string }> = [
    { icon: Icon, text: t(`kinds.${p.kind}`) },
  ];
  if (clock.hydrated && showUntil) {
    facts.push({ icon: Clock, text: t("until", { date: formatDate(p.endsAt, locale) }) });
  }
  // Only once there is one to watch: before the event it is a promise.
  if (clock.recording) facts.push({ icon: PlayCircle, text: t("recording") });
  if (p.external) facts.push({ icon: ExternalLink, text: t("external") });

  return (
    <div className="promo-panel-enter flex min-w-0 flex-col gap-1 px-1">
      <p className="inline-flex items-center gap-2 text-base font-semibold text-primary-interactive tabular-nums">
        {headline.live ? (
          // A status dot: its geometry is a circle (ADR-107).
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
        ) : null}
        <span className="truncate">{headline.text}</span>
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {facts.map(({ icon: FactIcon, text }) => (
          <li key={text} className="inline-flex items-center gap-1.5">
            <FactIcon aria-hidden className="size-3.5" />
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The position row: one dash per promotion, the selected one longer and
// filling over the interval while it plays, then "2 of 5". The dashes are a
// picture of the position — the tabs are the controls — so they are hidden
// from assistive tech. No pause button (changes-56, as on the banners and the
// carousels): hovering or focusing the band stops it.
function Pager({ count, current, playing }: { count: number; current: number; playing: boolean }) {
  const t = useTranslations("promotions");
  return (
    <div className="flex items-center gap-4">
      <div aria-hidden className="flex items-center gap-1.5">
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            className={cn(
              // A capped track: its geometry is a pill (ADR-107).
              "relative h-1 overflow-hidden rounded-full bg-border transition-all duration-500",
              index === current ? "w-10" : "w-4",
            )}
          >
            {index === current ? (
              <span
                // Remounted on every slide and every resume, so the fill
                // restarts with the timer. Full when it is not playing.
                key={`${current}-${playing}`}
                className={cn(
                  "absolute inset-0 bg-primary rtl:[--promo-progress-origin:right]",
                  playing && "promo-progress",
                )}
                style={{ ["--promo-interval" as string]: `${ROTATE_MS}ms` }}
              />
            ) : null}
          </span>
        ))}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {t("position", { current: current + 1, total: count })}
      </span>
    </div>
  );
}

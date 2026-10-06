"use client";

// The A–Z browse surface (changes-11 PR 4.5, D26).
//
// **Anchors, not routes, and not search params.** D26 settles this: the chips
// jump within one fully-cached page, work without JavaScript, and cost no
// cache entry. Letter ROUTES (`/glossary/letter/[letter]`, 27 static pages)
// become worth their weight only once one page gets heavy — the plan puts that
// threshold at roughly 300 published terms, and crossing it is the trigger to
// revisit, not a judgement call to make now.
//
// The SEARCH is client-side for the same reason: the whole set is already in
// the payload, so filtering is instant and costs no request. Nothing here
// touches the URL.
//
// The full alphabet renders whether or not a letter has terms, with the empty
// ones disabled (D26). A row that grows as the glossary fills would reflow the
// page under the reader every time a term is published.
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Link } from "@repo/i18n/navigation";
import { SearchInput } from "@repo/ui/components/search-input";
import { Empty, EmptyDescription, EmptyTitle } from "@repo/ui/components/empty";
import { cn } from "@repo/ui/lib/utils";

export interface GlossaryBrowserEntry {
  termId: string;
  term: string;
  slug: string;
  simpleExplanation: string;
}

/**
 * `#` first, then A–Z. Latin-only on purpose: the bar indexes the LATIN
 * initial of a term, and every term the glossary holds today is a
 * Latin-script trading term. A locale whose terms start outside this set
 * groups them all under `#`, which is honest — a per-locale alphabet is a
 * real feature and should be asked for, not guessed at here.
 */
const ALPHABET = ["#", ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))];

function initialOf(term: string, locale: string): string {
  const first = term[0]?.toLocaleUpperCase(locale) ?? "#";
  return /^[A-Z]$/.test(first) ? first : "#";
}

export function GlossaryBrowser({
  entries,
  locale,
}: {
  entries: GlossaryBrowserEntry[];
  locale: string;
}) {
  // Strings resolve HERE rather than arriving as props, following
  // `announcement-bar.tsx` and the admin's `media-picker-dialog.tsx`. The
  // reason is `resultCount`: it is a PLURAL over a number that changes on
  // every keystroke, so it cannot be pre-resolved on the server and handed
  // down — and a function prop cannot cross the RSC boundary at all ("Functions
  // cannot be passed directly to Client Components"). Once one string has to
  // resolve here, threading the other seven past it would be noise.
  const t = useTranslations("glossary");
  const [query, setQuery] = useState("");
  // The list can be several hundred rows; deferring keeps typing responsive
  // by letting React render the input ahead of the filtered list.
  const deferredQuery = useDeferredValue(query);
  const searching = deferredQuery.trim() !== "";

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase(locale);
    if (needle === "") return entries;
    // The explanation is searched too: a reader who half-remembers what a term
    // MEANS but not what it is called is exactly who needs a glossary search.
    return entries.filter(
      (entry) =>
        entry.term.toLocaleLowerCase(locale).includes(needle) ||
        entry.simpleExplanation.toLocaleLowerCase(locale).includes(needle),
    );
  }, [entries, deferredQuery, locale]);

  const byLetter = useMemo(() => {
    const map = new Map<string, GlossaryBrowserEntry[]>();
    for (const entry of filtered) {
      const letter = initialOf(entry.term, locale);
      map.set(letter, [...(map.get(letter) ?? []), entry]);
    }
    return map;
  }, [filtered, locale]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <label htmlFor="glossary-search" className="sr-only">
          {t("searchLabel")}
        </label>
        <div className="relative max-w-md">
          {/* SearchInput owns the glyph and its inset; pe-9 leaves room for
              the clear button, a sibling in this same positioned box. */}
          <SearchInput
            id="glossary-search"
            value={query}
            placeholder={t("searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            className="pe-9"
          />
          {query !== "" && (
            <button
              type="button"
              aria-label={t("clearSearch")}
              onClick={() => setQuery("")}
              className="absolute end-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground"
            >
              <X aria-hidden className="size-4" />
            </button>
          )}
        </div>

        {/* Announced politely so a screen-reader user hears the result count
            change as they type, without the list being read out each time. */}
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {t("resultCount", { count: filtered.length })}
        </p>
      </div>

      {/* The chip bar is hidden while searching: its anchors point at letter
          headings that the filter may have removed, and a jump link to a
          heading that is not on the page is a broken control. */}
      {!searching && (
        <nav
          aria-label={t("alphabetLabel")}
          className="sticky top-(--height-header) z-10 -mx-1 flex flex-wrap gap-1 bg-background/90 px-1 py-2 backdrop-blur-sm"
        >
          {ALPHABET.map((letter) => {
            const has = byLetter.has(letter);
            return has ? (
              <a
                key={letter}
                href={`#glossary-${letter === "#" ? "hash" : letter}`}
                className="flex size-7 items-center justify-center rounded-md text-sm font-medium text-muted-foreground transition duration-(--duration-fast) hover:scale-110 hover:bg-primary/10 hover:text-primary-interactive"
              >
                {letter}
              </a>
            ) : (
              <span
                key={letter}
                aria-disabled
                title={t("emptyLetter")}
                className="flex size-7 cursor-default items-center justify-center rounded-md text-sm font-medium text-muted-foreground/35"
              >
                {letter}
              </span>
            );
          })}
        </nav>
      )}

      {filtered.length === 0 ? (
        <Empty>
          <EmptyTitle>{t("noResultsTitle")}</EmptyTitle>
          <EmptyDescription>{t("noResultsBody")}</EmptyDescription>
        </Empty>
      ) : (
        <div className="flex flex-col gap-8">
          {ALPHABET.filter((letter) => byLetter.has(letter)).map((letter) => (
            <section
              key={letter}
              id={`glossary-${letter === "#" ? "hash" : letter}`}
              // The sticky chip bar would otherwise cover the heading a chip
              // just jumped to.
              className="flex scroll-mt-32 flex-col gap-3"
            >
              <h2 className="border-b pb-1 text-xl font-semibold">{letter}</h2>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(byLetter.get(letter) ?? []).map((entry) => (
                  <li key={entry.termId} className="flex flex-col gap-0.5">
                    <Link
                      href={`/glossary/${entry.slug}`}
                      className="link-underline w-fit font-medium text-primary-interactive transition-colors duration-(--duration-fast)"
                    >
                      {entry.term}
                    </Link>
                    {/* §9.5: the short definition inline is why the page is
                        useful without a click. */}
                    <p
                      className={cn("text-sm text-muted-foreground", !searching && "line-clamp-2")}
                    >
                      {entry.simpleExplanation}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// How the homepage OPENS (changes-31).
//
// The hero is the first thing a visitor meets and the first place a
// performance regression shows up. Four properties hold, and none of the four
// is visible in a type or a lint:
//
//   1. The band is STATIC. No query, no feature flag, no published rows — it
//      is composition in the ADR-042 sense. (The homepage's video content is
//      the `strip` band further down, changes-51 — never the opening.)
//   2. The footage never reaches the critical path: `preload="metadata"`, no
//      `autoPlay` attribute, and playback started only after hydration and
//      only when motion is wanted. Its POSTER is what paints.
//   3. The band carries no `Reveal`. ADR-104 §6: an element holding the page's
//      largest paint, behind an animation that starts at `opacity: 0`, reports
//      that paint when the animation ends.
//   4. `/learn`'s video rail is untouched. The same component still renders it
//      with `variant="grid"`, which is the surface the published rows were
//      always really for.
//
// Read as source, like `public-chrome.test.ts` beside it: these are async
// server components and apps/web's vitest config carries no JSX transform.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd(), "app/(public)/[locale]");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/**
 * The same source with every comment removed.
 *
 * A source guard that greps for a word finds it in the comment explaining why
 * the word is not there — which is how the first draft of this file reported
 * the hero as claiming `priority`, on the strength of the line saying it does
 * not. Assertions about what the code DOES read this; assertions about what it
 * SAYS read `read`.
 */
const code = (path: string) =>
  read(path)
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "");

const HERO = "_sections/hero.tsx";
const VIDEO = "_components/hero-video.tsx";
const RAIL = "_sections/video-showcase.tsx";

// ADR-140 §2: the opening band is a slider of published ARTICLES (owner,
// changes-43), where it had been one static band over footage.
describe("the opening band is a slider of published articles", () => {
  it("reads the article module's own published set, never the database", () => {
    const src = code(HERO);
    // The /news spotlight rule, composed rather than rewritten (ADR-108's
    // lesson: a band with its own idea of "public" surfaces drafts).
    expect(src).toContain("getSpotlightArticles");
    expect(src).not.toMatch(/@repo\/db/);
    // Both sections' flags gate their kinds.
    expect(src).toMatch(/isFeatureVisible\("news"/);
    expect(src).toMatch(/isFeatureVisible\("analysis"/);
    // `site.description` still leads the static fallback — in the reader's
    // language since ADR-165.
    expect(src).toContain('getLocalizedSetting("site.description", locale)');
  });

  it("falls back to the static band when nothing is published", () => {
    const src = code(HERO);
    expect(src).toMatch(/total === 0 \?/);
    expect(src).toContain('t("heroTitle")');
  });

  it("no longer plays the footage", () => {
    expect(code(HERO)).not.toContain("HeroVideo");
    expect(code(HERO)).not.toContain("heroVideo");
  });

  it("stops moving for reduced motion, hover and focus", () => {
    const slider = code("_components/hero-slider.tsx");
    expect(slider).toContain("prefers-reduced-motion: reduce");
    expect(slider).toContain("onPointerEnter");
    expect(slider).toContain("onFocus");
    // changes-43: the pause button is gone; hover and focus are the stop.
    expect(slider).not.toContain("aria-pressed");
    // The controls share the buttons' row from `lg`: the slide is
    // bottom-aligned at `lg:pb-28` and the controls row is `h-12` (Button
    // size `xl`) at `lg:bottom-28`. Change one offset and the row splits.
    expect(code(HERO)).toContain("items-end");
    expect(code(HERO)).toContain("lg:pb-28");
    expect(slider).toContain("lg:bottom-28");
    expect(slider).toContain("h-12");
    // A hidden slide can be neither tabbed into nor read.
    expect(slider).toContain("inert={!isActive}");
  });

  it("the homepage's video band is the `strip`, and nothing else", () => {
    // changes-51 (owner) brought the videos back as a slider of small cards.
    // Any other stale variant still renders nothing: a database seeded before
    // this change may hold one, and there is no screen to fix it (ADR-038).
    expect(code(RAIL)).toContain('if (variant !== "grid" && variant !== "strip") return null;');
    expect(code(RAIL)).toContain("<VideoStripCard");
    expect(code(RAIL)).toContain("lg:w-(--width-slide-5)");
  });

  it("its cards arrive alternately from below and above, and it hands its bottom edge on", () => {
    const src = code(RAIL);
    expect(src).toContain('index % 2 === 0 ? "rise" : "drop"');
    expect(src).toContain("section-flush-end");
    const css = readFileSync(
      resolve(process.cwd(), "../../packages/ui/src/styles/globals.css"),
      "utf8",
    );
    // Before `.is-visible`, or the hidden state would outrank the arrived one.
    expect(css.indexOf(".reveal-drop:not")).toBeLessThan(css.indexOf(".reveal.is-visible"));
  });

  it("that check happens before any I/O", () => {
    const src = code(RAIL);
    const guard = src.indexOf('if (variant !== "grid" && variant !== "strip") return null;');
    const firstAwait = src.indexOf("await ");
    expect(guard).toBeGreaterThan(-1);
    // A band that is not going to render should not cost a query to find out.
    expect(guard).toBeLessThan(firstAwait);
  });
});

// `HeroVideo` no longer opens the page, but `in_practice` still plays its own
// footage through it, so the guarantees below still hold for that band.
describe("footage is never on the critical path", () => {
  // changes-33 removed the `poster`. It was `/hero-app-mockup.jpg` — a
  // picture of the app, not a still from this footage — so the band painted
  // one image and then swapped it for a different one, which reads as a bug
  // and is what the owner reported. The band carries a solid `--secondary`
  // fill instead. The guarantee this suite exists for is unchanged and is
  // asserted below: the 8.8 MB is still never on the critical path, and that
  // was always `preload="metadata"` plus a post-hydration `play()`, never the
  // poster.
  // changes-62 #2: `preload="metadata"` plus an unconditional play() still
  // downloaded the whole clip on every home page view. Now nothing is fetched
  // until the band nears the viewport.
  it("fetches nothing up front, and never a poster image", () => {
    const src = code(VIDEO);
    expect(src).toContain('preload="none"');
    expect(src).not.toContain('preload="auto"');
    expect(src).not.toContain('preload="metadata"');
    // The inverse of the assertion this replaces, and it is here for the
    // revert: `poster` is the obvious thing to reach for the next time
    // somebody looks at a dark band and wants an image in it.
    expect(src).not.toContain("poster");
  });

  it("plays only while it is near the viewport", () => {
    const src = code(VIDEO);
    expect(src).toContain("new IntersectionObserver(");
    expect(src).toMatch(/isIntersecting[\s\S]*?play\(\)[\s\S]*?pause\(\)/);
  });

  it("has no autoPlay attribute", () => {
    // With one, the browser starts the footage from the server HTML — before
    // this component has hydrated and before anyone has asked whether motion
    // is welcome. A reduced-motion visitor would watch it play, then stop.
    expect(code(VIDEO)).not.toMatch(/\bautoPlay\b/);
  });

  it("starts playback itself, and only when motion is wanted", () => {
    const src = code(VIDEO);
    expect(src).toContain("prefers-reduced-motion: no-preference");
    expect(src).toContain(".play()");
  });

  it("keeps the two attributes that let it play inline at all", () => {
    // Remove either and iOS refuses — silently, which is the whole problem.
    const src = code(VIDEO);
    expect(src).toMatch(/\bmuted\b/);
    expect(src).toMatch(/\bplaysInline\b/);
  });

  it("is decorative: hidden from assistive tech, and offers no controls", () => {
    const src = code(VIDEO);
    expect(src).toMatch(/\baria-hidden\b/);
    // A control a screen reader cannot reach is worse than no control.
    expect(src).not.toMatch(/\bcontrols\b/);
  });

  it("only the hero's FIRST slide claims next/image `priority`", () => {
    // The first slide's cover is the page's largest first paint (ADR-140 §2).
    // A cover marked `priority` anywhere else would be a second claim on one
    // budget, and so would every slide claiming it.
    const sections = readFileSync(join(ROOT, "_sections/registry.ts"), "utf8");
    const files = [...sections.matchAll(/from "\.\/([a-z-]+)\.tsx"/g)].map((m) => m[1]!);
    const claimants = files.filter((name) => /\bpriority\b/.test(code(`_sections/${name}.tsx`)));
    expect(claimants).toEqual(["hero"]);
    expect(code(HERO)).toContain("priority={index === 0}");
  });
});

describe("the opening band is not animated (ADR-104 §6)", () => {
  it("the hero renders no Reveal", () => {
    expect(read(HERO)).not.toContain("<Reveal");
  });
});

describe("one full-bleed band, and its copy is legible over it", () => {
  it("the hero is sized by the one hero-height token", () => {
    expect(code(HERO)).toContain("min-h-(--height-hero)");
  });

  it("its copy sits inside an OPAQUE scrim, not on the footage", () => {
    // A slide's cover is whatever an editor uploaded, so nothing can assume what
    // is behind the words. The gradient starts fully opaque and the copy sits
    // in that zone — ADR-072 §1, we do not copy a pairing we cannot guarantee.
    const src = code(HERO);
    expect(src).toContain("from-secondary");
    expect(src).toContain("text-secondary-foreground");
  });
});

describe("the floating panel", () => {
  it("is pulled up into the band, not positioned over it", () => {
    const src = code(HERO);
    expect(src).toMatch(/-mt-\d+/);
    // `absolute` would take it out of the flow and let the next section slide
    // underneath it.
    expect(src).toContain("<QuickStartBanner");
  });

  it("the band reserves the room it overlaps into", () => {
    // changes-43: pb-28 clears the panel; pb-40 below `lg` also fits the
    // slider controls' own row under the wrapped buttons.
    expect(code(HERO)).toContain("pb-40 lg:pb-28");
  });

  it("every cell is a link, not a select", () => {
    // The reference's four fields compose into one query, so they are form
    // controls. Ours are four different pages, and a dropdown that navigates
    // on change cannot be opened with a keyboard without going somewhere.
    const src = code("_components/quick-start-banner.tsx");
    expect(src).not.toMatch(/<select|AdminCombobox|components\/select/);
    expect(src).toContain("<Link");
  });
});

describe("/learn's rail is untouched", () => {
  it("the learn index still asks for the grid", () => {
    expect(read("learn/page.tsx")).toContain('variant="grid"');
  });

  it("and the grid path still renders the tiles", () => {
    const src = read(RAIL);
    expect(src).toContain("<VideoTile");
    expect(src).toContain("sm:grid-cols-2 lg:grid-cols-3");
  });

  it("`grid` and the homepage's `strip` are the only variants it accepts", () => {
    expect(
      readFileSync(resolve(process.cwd(), "../../packages/contracts/src/settings.ts"), "utf8"),
    ).toContain('learning_videos: ["grid", "strip"]');
  });
});

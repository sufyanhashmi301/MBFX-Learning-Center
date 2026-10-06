// ADR-166 — the Arabic seed files say the same thing, structurally, as the
// English they translate.
//
// A translation can be wrong in ways no test sees. What a test CAN see is the
// part a translator must not change: the `{{variables}}` an email renders (a
// typo reaches an inbox as literal braces — `check:email-templates` reads only
// the English defaults), the links and the heading outline of a body, the
// count of FAQ items, and whether every key still names something the English
// seed writes. And for the demo courses, COVERAGE: Arabic has no fallback, so
// a lesson missing from the map is a hole in the curriculum.
//
// The course corpus is read as SOURCE, like `footer-sitemap.test.ts` beside
// it, because it is a literal inside the seed script rather than an export.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SEED_ARTICLES } from "../prisma/seed-articles.ts";
import {
  ARTICLE_CATEGORY_NAMES_AR,
  ARTICLE_TAG_NAMES_AR,
  SAMPLE_ARTICLE_AR,
  SEED_ARTICLES_AR,
} from "../prisma/seed-articles-ar.ts";
import { EMAIL_TEMPLATES_AR } from "../prisma/seed-email-ar.ts";
import { DEMO_COURSES_AR, DEMO_LESSONS_AR, DEMO_SECTIONS_AR } from "../prisma/seed-learn-ar.ts";
import { GLOSSARY_TERMS, GLOSSARY_TOPICS } from "../prisma/seed-glossary.ts";
import { GLOSSARY_TERMS_AR, GLOSSARY_TOPICS_AR } from "../prisma/seed-glossary-ar.ts";
import { SEED_PROMOTIONS } from "../prisma/seed-promotions.ts";
import { SEED_PROMOTIONS_AR } from "../prisma/seed-promotions-ar.ts";
import { DEMO_QUIZ, DEMO_QUIZ_CRYPTO } from "../prisma/seed-quizzes.ts";
import { DEMO_QUIZZES_AR } from "../prisma/seed-quizzes-ar.ts";
import { SETTINGS_AR } from "../prisma/seed-settings-ar.ts";
import { TOOL_HIGHLIGHTS } from "../prisma/seed-tool-highlights.ts";
import { TOOLS_AR } from "../prisma/seed-tools-ar.ts";
import { VIDEO_CATEGORIES, VIDEO_TOPICS } from "../prisma/seed-videos.ts";
import { VIDEO_CATEGORIES_AR, VIDEO_TOPICS_AR } from "../prisma/seed-videos-ar.ts";
import { EMAIL_TEMPLATE_DEFAULTS } from "./email-template-defaults.ts";

const variables = (text: string) => [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const outline = (html: string) =>
  [...html.matchAll(/<(h[1-6]|p|em|strong|a|img)\b/g)].map((m) => m[1]);
const sorted = (list: (string | undefined)[]) => [...new Set(list)].sort();

describe("Arabic email templates", () => {
  for (const [key, arabic] of Object.entries(EMAIL_TEMPLATES_AR)) {
    const english = EMAIL_TEMPLATE_DEFAULTS.find((template) => template.key === key);

    it(`${key} translates a seeded template`, () => {
      expect(english).toBeDefined();
    });
    if (!english) continue;

    it(`${key} uses the same variables, links and markup`, () => {
      expect(sorted(variables(arabic.subject))).toEqual(sorted(variables(english.subject)));
      expect(sorted(variables(arabic.preheader))).toEqual(sorted(variables(english.preheader)));
      expect(sorted(variables(arabic.bodyHtml))).toEqual(sorted(variables(english.bodyHtml)));
      expect(hrefs(arabic.bodyHtml)).toEqual(hrefs(english.bodyHtml));
      expect(outline(arabic.bodyHtml)).toEqual(outline(english.bodyHtml));
    });
  }

  it("leaves the staff-bound support template in English (ADR-113)", () => {
    expect(EMAIL_TEMPLATES_AR["support.request"]).toBeUndefined();
  });
});

describe("Arabic article corpus", () => {
  for (const arabic of SEED_ARTICLES_AR) {
    const english = SEED_ARTICLES.find((article) => article.slug === arabic.slug);

    it(`${arabic.slug} translates a seeded article`, () => {
      expect(english).toBeDefined();
    });
    if (!english) continue;

    it(`${arabic.slug} keeps the links, outline and FAQ count`, () => {
      const arBody = arabic.body.join("");
      const enBody = english.body.join("");
      expect(hrefs(arBody)).toEqual(hrefs(enBody));
      expect(outline(arBody)).toEqual(outline(enBody));
      expect(arabic.faq?.length ?? 0).toBe(english.faq?.length ?? 0);
    });

    it(`${arabic.slug} fits the SEO columns`, () => {
      expect(arabic.seoTitle.length).toBeLessThanOrEqual(70);
      expect(arabic.seoDescription.length).toBeLessThanOrEqual(180);
      expect(arabic.excerpt.length).toBeLessThanOrEqual(500);
    });
  }

  it("translates every corpus article, in the corpus order", () => {
    expect(SEED_ARTICLES_AR.map((a) => a.slug)).toEqual(SEED_ARTICLES.map((a) => a.slug));
  });

  it("translates the featured sample seed.ts writes on its own", () => {
    const seed = readFileSync(new URL("../prisma/seed.ts", import.meta.url), "utf8");
    expect(seed).toContain(`const SAMPLE_SLUG = "${SAMPLE_ARTICLE_AR.slug}";`);
    expect(SAMPLE_ARTICLE_AR.faq?.length).toBe(2);
    expect(hrefs(SAMPLE_ARTICLE_AR.body.join(""))).toEqual(["/glossary"]);
    expect(SAMPLE_ARTICLE_AR.seoTitle.length).toBeLessThanOrEqual(70);
    expect(SAMPLE_ARTICLE_AR.seoDescription.length).toBeLessThanOrEqual(180);
  });

  it("names only seeded taxonomy", () => {
    const seed = readFileSync(new URL("../prisma/seed.ts", import.meta.url), "utf8");
    for (const slug of [
      ...Object.keys(ARTICLE_CATEGORY_NAMES_AR),
      ...Object.keys(ARTICLE_TAG_NAMES_AR),
    ]) {
      expect(seed).toContain(`slug: "${slug}"`);
    }
  });
});

describe("Arabic demo courses", () => {
  const seed = readFileSync(new URL("../prisma/seed.ts", import.meta.url), "utf8");
  const block = seed.match(/const DEMO_COURSES = \[([\s\S]*?)\n {2}\] as const;/)?.[1] ?? "";
  // Indentation is the structure: courses at 6, section titles at 10, lessons at 14.
  const courseSlugs = [...block.matchAll(/^ {6}slug: "([\w-]+)"/gm)].map((m) => m[1]);
  const sectionTitles = [...block.matchAll(/^ {10}title: "(.+)",$/gm)].map((m) => m[1]);
  const lessonSlugs = [...block.matchAll(/^ {14}slug: "([\w-]+)"/gm)].map((m) => m[1]);

  it("reads the demo corpus", () => {
    expect(courseSlugs.length).toBeGreaterThan(0);
    expect(sectionTitles.length).toBeGreaterThan(0);
    expect(lessonSlugs.length).toBeGreaterThan(0);
  });

  it("translates every demo course, section and lesson, and nothing else", () => {
    expect(sorted(Object.keys(DEMO_COURSES_AR))).toEqual(sorted(courseSlugs));
    expect(sorted(Object.keys(DEMO_SECTIONS_AR))).toEqual(sorted(sectionTitles));
    expect(sorted(Object.keys(DEMO_LESSONS_AR))).toEqual(sorted(lessonSlugs));
  });
});

// ─── Completing the Arabic site (2026-10-02) ──────────────────────────────
//
// Arabic has no fallback, so every map below must cover its English source
// exactly — a missing key is a hole on an `/ar` page, an extra one translates
// nothing. The structure (markup, links, option counts) must match too.

describe("Arabic glossary", () => {
  it("translates every topic and term, and nothing else", () => {
    expect(Object.keys(GLOSSARY_TOPICS_AR)).toEqual(GLOSSARY_TOPICS.map((t) => t.slug));
    expect(Object.keys(GLOSSARY_TERMS_AR)).toEqual(GLOSSARY_TERMS.map((t) => t.slug));
  });

  for (const english of GLOSSARY_TERMS) {
    const arabic = GLOSSARY_TERMS_AR[english.slug];
    if (!arabic) continue;
    it(`${english.slug} has the English fields, markup and FAQ count`, () => {
      for (const field of ["simple", "detailed", "advanced", "example"] as const) {
        expect(arabic[field] === undefined).toBe(english[field] === undefined);
        expect(outline(arabic[field] ?? "")).toEqual(outline(english[field] ?? ""));
        expect(hrefs(arabic[field] ?? "")).toEqual(hrefs(english[field] ?? ""));
      }
      expect(arabic.faq?.length ?? 0).toBe(english.faq?.length ?? 0);
      expect(arabic.term.length).toBeLessThanOrEqual(150);
    });
  }
});

describe("Arabic quizzes", () => {
  for (const english of [DEMO_QUIZ, DEMO_QUIZ_CRYPTO]) {
    it(`${english.slug} keeps every question's option and explanation count`, () => {
      const arabic = DEMO_QUIZZES_AR[english.slug];
      expect(arabic).toBeDefined();
      expect(arabic?.questions.length).toBe(english.questions.length);
      english.questions.forEach((question, index) => {
        expect(arabic?.questions[index]?.options.length).toBe(question.options.length);
        expect(arabic?.questions[index]?.explanations.length).toBe(question.explanations.length);
        // An empty English explanation stays empty: it means "nothing to add".
        question.explanations.forEach((text, i) => {
          expect(arabic?.questions[index]?.explanations[i] === "").toBe(text === "");
        });
      });
    });
  }

  it("translates only the seeded quizzes", () => {
    expect(sorted(Object.keys(DEMO_QUIZZES_AR))).toEqual(
      sorted([DEMO_QUIZ.slug, DEMO_QUIZ_CRYPTO.slug]),
    );
  });
});

describe("Arabic videos", () => {
  it("translates every category and topic, and nothing else", () => {
    expect(Object.keys(VIDEO_CATEGORIES_AR)).toEqual(VIDEO_CATEGORIES.map((c) => c.slug));
    expect(Object.keys(VIDEO_TOPICS_AR)).toEqual(VIDEO_TOPICS.map((t) => t.slug));
  });

  for (const english of VIDEO_TOPICS) {
    const arabic = VIDEO_TOPICS_AR[english.slug];
    if (!arabic) continue;
    it(`${english.slug} keeps the markup and labels every link`, () => {
      expect(outline(arabic.content)).toEqual(outline(english.content));
      expect(hrefs(arabic.content)).toEqual(hrefs(english.content));
      expect(sorted(Object.keys(arabic.linkLabels ?? {}))).toEqual(
        sorted((english.links ?? []).map((link) => link.label)),
      );
    });
  }
});

describe("Arabic promotions", () => {
  it("translates every seeded promotion, with the same markup", () => {
    expect(sorted(Object.keys(SEED_PROMOTIONS_AR))).toEqual(
      sorted(SEED_PROMOTIONS.map((p) => p.id)),
    );
    for (const english of SEED_PROMOTIONS) {
      const arabic = SEED_PROMOTIONS_AR[english.id];
      expect(outline(arabic?.body ?? "")).toEqual(outline(english.words.body));
      expect([...(arabic?.body ?? "").matchAll(/<li>/g)].length).toBe(
        [...english.words.body.matchAll(/<li>/g)].length,
      );
      expect(arabic?.badge.length ?? 0).toBeLessThanOrEqual(40);
      expect(arabic?.ctaLabel.length ?? 0).toBeLessThanOrEqual(60);
      expect(arabic?.title.length ?? 0).toBeLessThanOrEqual(160);
    }
  });
});

describe("Arabic settings", () => {
  const seed = readFileSync(new URL("../prisma/seed.ts", import.meta.url), "utf8");

  it("covers both legal keys, so Arabic's are a person's words rather than a machine's", () => {
    expect(SETTINGS_AR["legal.riskDisclaimer"]?.fields.value).toBeTruthy();
    expect(SETTINGS_AR["legal.copyrightNotice"]?.fields.value).toBeTruthy();
  });

  it("keeps the {year} token", () => {
    expect(SETTINGS_AR["legal.copyrightNotice"]?.fields.value).toContain("{year}");
  });

  it("names only seeded settings", () => {
    for (const key of Object.keys(SETTINGS_AR)) expect(seed).toContain(`"${key}",`);
  });
});

describe("Arabic tools", () => {
  it("translates every tool", () => {
    expect(sorted(Object.keys(TOOLS_AR))).toEqual(sorted(Object.keys(TOOL_HIGHLIGHTS)));
  });

  for (const [key, english] of Object.entries(TOOL_HIGHLIGHTS)) {
    const arabic = TOOLS_AR[key];
    if (!arabic) continue;
    it(`${key} keeps the highlight glyphs, opens on a heading, and fits the SEO columns`, () => {
      expect(arabic.highlights.map((h) => h.icon)).toEqual(english.map((h) => h.icon));
      for (const card of arabic.highlights) expect(`${card.title}${card.text}`).not.toMatch(/[<>]/);
      expect(arabic.intro.startsWith("<h2>")).toBe(true);
      expect(arabic.body.startsWith("<h2>")).toBe(true);
      expect(arabic.title.length).toBeLessThanOrEqual(70);
      expect(arabic.tagline.length).toBeLessThanOrEqual(180);
    });
  }
});

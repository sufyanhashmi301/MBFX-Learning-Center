// Phase 5, the learning area end to end on a real MariaDB with Google faked at
// the network edge (MSW): a course, its section and a lesson are translated by
// the engine; the public pages serve the machine words `noindex` and keep them
// out of the sitemap until a person saves; attachment labels, objectives and
// the FAQ travel with their parents; and an English edit refreshes a machine
// row while only flagging a person's.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MariaDbContainer, type StartedMariaDbContainer } from "@testcontainers/mariadb";
import { ContentStatus, type db as DbClient } from "@repo/db";
import type { Subject } from "@repo/rbac";
import { generateSecretKey } from "@repo/secrets";
import { fakeGoogleTranslate } from "@repo/translate/testing";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as CoursesModule from "./courses.ts";
import type * as SectionsModule from "./course-sections.ts";
import type * as LessonsModule from "./lessons.ts";
import type * as PublicCoursesModule from "./public-courses.ts";
import type * as RunnerModule from "./translation-runner.ts";
import type * as AdminModule from "./translation-admin.ts";
import type * as TranslateModule from "@repo/translate";

const dbPackageRoot = fileURLToPath(new URL("../../db", import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const KEY = "AIza-test";

let container: StartedMariaDbContainer;
let db: typeof DbClient;
let courses: typeof CoursesModule;
let sections: typeof SectionsModule;
let lessons: typeof LessonsModule;
let publicCourses: typeof PublicCoursesModule;
let runner: typeof RunnerModule;
let admin: typeof AdminModule;
let translate: typeof TranslateModule;
let editor: Subject;
let assetId: string;
const server = setupServer();

beforeAll(async () => {
  container = await new MariaDbContainer("mariadb:11.4")
    .withDatabase("mbfx_learn_translation")
    .withUsername("test")
    .withUserPassword("test")
    .start();
  const url = container.getConnectionUri().replace(/^mariadb:/, "mysql:");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: dbPackageRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  process.env.DATABASE_URL = url;
  process.env.TRANSLATE_SECRET_KEY = generateSecretKey();
  db = (await import("@repo/db")).db;
  courses = await import("./courses.ts");
  sections = await import("./course-sections.ts");
  lessons = await import("./lessons.ts");
  publicCourses = await import("./public-courses.ts");
  runner = await import("./translation-runner.ts");
  admin = await import("./translation-admin.ts");
  translate = await import("@repo/translate");
  server.listen({ onUnhandledRequest: "error" });

  const user = await db.user.create({
    data: {
      id: crypto.randomUUID(),
      email: "learn-translator@x.com",
      name: "Editor",
      status: "ACTIVE",
      userType: "STAFF",
    },
  });
  editor = {
    id: user.id,
    userType: "STAFF",
    roleKeys: [],
    maxRoleLevel: 60,
    allowed: new Set([
      "courses.create",
      "courses.update",
      "courses.publish",
      "lessons.create",
      "lessons.update",
      "lessons.publish",
    ]),
    denied: new Set(),
  };
  await db.locale.createMany({
    data: [
      {
        code: "en",
        name: "English",
        nativeName: "English",
        isDefault: true,
        isActive: true,
        sortOrder: 1,
      },
      {
        code: "es",
        name: "Spanish",
        nativeName: "Español",
        isActive: true,
        sortOrder: 2,
        fallbackCode: "en",
      },
    ],
  });
  const asset = await db.mediaAsset.create({
    data: {
      key: "docs/guide.pdf",
      url: "/uploads/docs/guide.pdf",
      fileName: "guide.pdf",
      mimeType: "application/pdf",
      size: 100,
      purpose: "content",
      kind: "DOCUMENT",
    },
  });
  assetId = asset.id;

  server.use(fakeGoogleTranslate({ validKey: KEY }).handler);
  expect(
    await translate.saveTranslateSettings(user.id, {
      kind: "GOOGLE",
      enabled: true,
      apiKey: KEY,
      pricePerMillionChars: 20,
      monthlyCharBudget: null,
    }),
  ).toEqual({ ok: true });
  server.resetHandlers();
}, 180_000);

afterAll(async () => {
  server.close();
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(() => {
  server.use(fakeGoogleTranslate({ validKey: KEY }).handler);
});
afterEach(() => server.resetHandlers());

let seq = 0;

/** A published course with a FAQ, one section, and one lesson with an attachment. */
async function makeCourse() {
  seq += 1;
  const courseId = await courses.createCourse(editor, { track: "forex", title: `Course ${seq}` });
  await courses.saveCourse(editor, {
    courseId,
    meta: {},
    translation: {
      locale: "en",
      title: `Course ${seq}`,
      summary: "Learn to read a chart.",
      description: "<p>Leverage of 1:100 multiplies risk.</p>",
      faq: [{ question: "How long is it?", answer: "About 3 hours." }],
    },
  });
  const sectionId = await sections.createSection(editor, courseId, `Section ${seq}`);
  const lessonId = await lessons.createLesson(editor, { sectionId, title: `Lesson ${seq}` });
  await lessons.saveLesson(editor, {
    lessonId,
    meta: {},
    translation: {
      locale: "en",
      title: `Lesson ${seq}`,
      content: "<p>A pip is the smallest move.</p>",
      learningObjectives: ["Read a quote", "Size a position"],
    },
    attachments: [{ assetId, label: "Cheat sheet" }],
  });
  await db.course.update({
    where: { id: courseId },
    data: { status: ContentStatus.PUBLISHED, publishedAt: new Date() },
  });
  await db.lesson.update({
    where: { id: lessonId },
    data: { status: ContentStatus.PUBLISHED, publishedAt: new Date() },
  });
  await db.$transaction((tx) => courses.recomputeLessonCount(tx, courseId));
  const en = await db.courseTranslation.findFirstOrThrow({ where: { courseId, locale: "en" } });
  const lessonEn = await db.lessonTranslation.findFirstOrThrow({
    where: { lessonId, locale: "en" },
  });
  return { courseId, sectionId, lessonId, slug: en.slug, lessonSlug: lessonEn.slug };
}

describe("the learning area is translated by the engine", () => {
  it("enqueues on save and translates course, section and lesson, children included", async () => {
    const { courseId, sectionId, lessonId, slug, lessonSlug } = await makeCourse();
    const queued = await db.translationJob.findMany({
      where: { entityId: { in: [courseId, sectionId, lessonId] }, locale: "es" },
      select: { entityType: true },
    });
    expect(queued.map((j) => j.entityType).sort()).toEqual(["course", "course_section", "lesson"]);

    const drained = await runner.drainTranslationQueue();
    expect(drained.failed).toBe(0);

    const course = await db.courseTranslation.findFirstOrThrow({
      where: { courseId, locale: "es" },
    });
    expect(course).toMatchObject({
      title: `[es] Course ${seq}`,
      slug,
      summary: "[es] Learn to read a chart.",
      translationStatus: "MACHINE_TRANSLATED",
    });
    expect(course.description).toContain("[es]");
    expect(course.faq).toEqual([
      { question: "[es] How long is it?", answer: "[es] About 3 hours." },
    ]);

    const section = await db.courseSectionTranslation.findFirstOrThrow({
      where: { sectionId, locale: "es" },
    });
    expect(section).toMatchObject({
      title: `[es] Section ${seq}`,
      translationStatus: "MACHINE_TRANSLATED",
    });

    const lesson = await db.lessonTranslation.findFirstOrThrow({
      where: { lessonId, locale: "es" },
    });
    expect(lesson).toMatchObject({
      slug: lessonSlug,
      translationStatus: "MACHINE_TRANSLATED",
      learningObjectives: ["[es] Read a quote", "[es] Size a position"],
      attachmentLabels: { "Cheat sheet": "[es] Cheat sheet" },
    });
  });

  it("serves machine words noindex, with the attachment label translated, and lists them only once a person saves", async () => {
    const { courseId, slug, lessonSlug } = await makeCourse();
    await runner.drainTranslationQueue();

    const courseView = await publicCourses.loadCourseBySlug("es", slug);
    expect(courseView).toMatchObject({ title: `[es] Course ${seq}`, noIndex: true });
    const lessonView = await publicCourses.loadLessonBySlug("es", slug, lessonSlug);
    expect(lessonView?.noIndex).toBe(true);
    expect(lessonView?.attachments.map((a) => a.label)).toEqual(["[es] Cheat sheet"]);
    const englishLesson = await publicCourses.loadLessonBySlug("en", slug, lessonSlug);
    expect(englishLesson?.attachments.map((a) => a.label)).toEqual(["Cheat sheet"]);

    let sitemap = await publicCourses.loadLearnSitemapEntries();
    expect(sitemap.filter((e) => e.path.includes(slug)).map((e) => e.locale)).toEqual(["en", "en"]);

    await courses.saveCourse(editor, {
      courseId,
      meta: {},
      translation: { locale: "es", title: "Curso revisado", slug },
    });
    expect((await publicCourses.loadCourseBySlug("es", slug))?.noIndex).toBe(false);
    sitemap = await publicCourses.loadLearnSitemapEntries();
    expect(
      sitemap
        .filter((e) => e.path === `/learn/forex/${slug}`)
        .map((e) => e.locale)
        .sort(),
    ).toEqual(["en", "es"]);
  });

  it("an English edit refreshes a machine row and flags a person's", async () => {
    const { courseId, sectionId, lessonId } = await makeCourse();
    await runner.drainTranslationQueue();
    // A person reviews the Spanish section; the lesson stays machine-written.
    await sections.saveSection(editor, {
      sectionId,
      translation: { locale: "es", title: "Sección revisada" },
    });
    expect(
      (await db.courseSectionTranslation.findFirstOrThrow({ where: { sectionId, locale: "es" } }))
        .translationStatus,
    ).toBe("TRANSLATED");

    await sections.saveSection(editor, {
      sectionId,
      translation: { locale: "en", title: "Section renamed" },
    });
    await lessons.saveLesson(editor, {
      lessonId,
      meta: {},
      translation: {
        locale: "en",
        title: "Lesson renamed",
        content: "<p>A pip is the smallest move.</p>",
        learningObjectives: ["Read a quote", "Size a position"],
      },
      attachments: [{ assetId, label: "Cheat sheet" }],
    });
    await runner.drainTranslationQueue();

    const section = await db.courseSectionTranslation.findFirstOrThrow({
      where: { sectionId, locale: "es" },
    });
    expect(section).toMatchObject({ title: "Sección revisada", translationStatus: "OUTDATED" });
    const lesson = await db.lessonTranslation.findFirstOrThrow({
      where: { lessonId, locale: "es" },
    });
    expect(lesson).toMatchObject({
      title: "[es] Lesson renamed",
      translationStatus: "MACHINE_TRANSLATED",
    });
    expect(
      (await db.courseTranslation.findFirstOrThrow({ where: { courseId, locale: "es" } }))
        .translationStatus,
    ).toBe("MACHINE_TRANSLATED");
  });

  it("an attachment-only change re-translates the labels", async () => {
    const { lessonId } = await makeCourse();
    await runner.drainTranslationQueue();
    await lessons.setLessonAttachments(editor, lessonId, [{ assetId, label: "Formula sheet" }]);
    await runner.drainTranslationQueue();
    const lesson = await db.lessonTranslation.findFirstOrThrow({
      where: { lessonId, locale: "es" },
    });
    expect(lesson.attachmentLabels).toEqual({ "Formula sheet": "[es] Formula sheet" });
  });

  it("a figure changed in translation is written NEEDS_REVIEW and queued for review", async () => {
    server.resetHandlers();
    server.use(
      fakeGoogleTranslate({
        validKey: KEY,
        translate: (segment, target) => `[${target}] ${segment.replace("1:100", "1:10")}`,
      }).handler,
    );
    const { courseId } = await makeCourse();
    await runner.drainTranslationQueue();
    const course = await db.courseTranslation.findFirstOrThrow({
      where: { courseId, locale: "es" },
    });
    expect(course.translationStatus).toBe("NEEDS_REVIEW");
    const queue = await admin.loadTranslationReviewQueue({ locale: "es" });
    expect(queue).toContainEqual(
      expect.objectContaining({ entityType: "course", entityId: courseId, status: "NEEDS_REVIEW" }),
    );
  });

  it("counts coverage per type and backfills every learning type", async () => {
    await db.translationJob.deleteMany();
    await translate.enqueueLocaleBackfill("es");
    await runner.drainTranslationQueue();
    const overview = await admin.loadTranslationOverview();
    const es = overview.locales.find((l) => l.code === "es")!;
    const byType = Object.fromEntries(es.types.map((t) => [t.entityType, t.coverage]));
    for (const type of ["course", "course_section", "lesson"]) {
      expect(byType[type]!.total).toBeGreaterThan(0);
      expect(byType[type]!.missing).toBe(0);
    }
  });
});

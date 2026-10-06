// Arabic words for the translatable settings that seed with English text
// (ADR-165, ADR-166). `header.announcementBar` and `header.topBar` seed
// empty, so there is nothing of theirs to translate.
//
// The two `legal` keys were written in the development session, not by a
// provider — the same footing as the Arabic catalog (ADR-166) — but a legal
// statement still needs its owner's sign-off, so they are seeded NEEDS_REVIEW:
// they are served, and they sit in Settings → Translation → Review until a
// person saves them. Everything else here is TRANSLATED. (They were human-only
// and gated going live until ADR-190; the machine now translates them too, but
// never over a row that is already here.)
//
// Stored the way `SettingTranslation.value` always is: the field map, with a
// whole-value key's text under `value` (WHOLE_VALUE_FIELD). `{year}` is a
// rendering-time token and must survive (`missingSettingTokens`).
// `create`-only: an existing Arabic row is somebody's and is left alone.
import type { PrismaClient } from "../src/generated/client/client.ts";

export interface ArabicSettingText {
  /** The stored field map, e.g. `{ value: "…" }` or `{ label: "…" }`. */
  fields: Readonly<Record<string, string>>;
  status: "TRANSLATED" | "NEEDS_REVIEW";
}

export const SETTINGS_AR: Readonly<Record<string, ArabicSettingText>> = {
  "site.description": {
    fields: { value: "تعليم مجاني في الفوركس والتداول، وأدوات للسوق، وتحليلات." },
    status: "TRANSLATED",
  },
  "legal.riskDisclaimer": {
    fields: {
      value:
        'ينطوي تداول عقود الفروقات (CFDs) والمراهنة على فروق الأسعار على درجة عالية من المخاطرة بسبب استخدام الرافعة المالية. وقد لا تكون هذه الأدوات مناسبة لجميع المستثمرين، إذ يمكن أن تؤدي إلى خسائر سريعة إلى جانب الأرباح المحتملة. قبل التداول مع MBFX Global Limited ("MBFX")، يُرجى التأكد من أنك تفهم تمامًا كيفية عمل عقود الفروقات والمراهنة على فروق الأسعار، وأن تفكر مليًّا فيما إذا كنت تستطيع تحمّل المخاطرة العالية بخسارة أموالك.\n\n' +
        "تأسست MBFX Global Limited في سانت لوسيا برقم التسجيل 2023-00532. وانسجامًا مع التزامها بالامتثال التنظيمي والعناية الواجبة، تلتزم MBFX بالمعايير الدولية لمبدأ «اعرف عميلك» (KYC)، وقد لا تتمكن من تقديم بعض الخدمات في الولايات القضائية التي تقيّد فيها اللوائح المحلية مثل هذه الأنشطة. وتشمل هذه المناطق حاليًا أستراليا، والولايات المتحدة، والبرازيل، وكوراساو، وإندونيسيا، وسينت أوستاتيوس، وتاهيتي، وسايبان، وتركيا، وغينيا بيساو، واليابان، وبونير، وتيمور الشرقية، وليبيريا، وميكرونيزيا، وجزر ماريانا الشمالية، ويان ماين، وجنوب السودان، وسفالبارد، والإمارات العربية المتحدة، وغيرها من المناطق ذات القيود المماثلة. لمزيد من التفاصيل، يُرجى مراجعة سياسة الخصوصية الخاصة بنا.",
    },
    status: "NEEDS_REVIEW",
  },
  "legal.copyrightNotice": {
    fields: { value: "© {year} MBFX Global Limited. جميع الحقوق محفوظة." },
    status: "NEEDS_REVIEW",
  },
  "header.cta": {
    fields: { label: "ابدأ الآن" },
    status: "TRANSLATED",
  },
};

/** Writes the Arabic setting rows that are missing. Returns how many it created. */
export async function seedArabicSettings(db: PrismaClient): Promise<number> {
  let created = 0;
  for (const [key, text] of Object.entries(SETTINGS_AR)) {
    const setting = await db.setting.findUnique({
      where: { key },
      select: { id: true, translations: { where: { locale: "ar" }, select: { id: true } } },
    });
    if (!setting || setting.translations.length > 0) continue;
    await db.settingTranslation.create({
      data: {
        settingId: setting.id,
        locale: "ar",
        value: text.fields,
        translationStatus: text.status,
      },
    });
    created += 1;
  }
  return created;
}

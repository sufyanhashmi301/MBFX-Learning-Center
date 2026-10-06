import { getTranslations } from "next-intl/server";
import { loadInterfaceText, loadTranslationProgress } from "@repo/core";
import { loadAuthoringLocales } from "@repo/i18n";
import { can, requirePermission } from "@repo/rbac";
import { isAutoTranslateAvailable } from "@repo/translate";
import { TranslationProgressPanel } from "../translation-progress.tsx";
import { InterfaceTextTable } from "./interface-text-table.tsx";

// Settings → Translation → Interface text (ADR-178 #3–#5): the site's fixed
// public strings, one language and one section at a time, with the English
// beside each. Both choices are the ADDRESS (`?locale=&ns=`), like Site text,
// so a reload or a shared link keeps them.
//
// `translations.update` to open and edit; "Translate missing automatically"
// also needs `translations.approve` and a configured provider, and runs in the
// background with its progress drawn above the table (ADR-189). Every action
// re-checks its own key.
export default async function InterfaceTextPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string | string[]; ns?: string | string[] }>;
}) {
  const subject = await requirePermission("translations.update");
  const t = await getTranslations("admin.translate.interfaceText");

  const languages = await loadAuthoringLocales();
  if (languages.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noLanguages")}</p>;
  }
  const { locale: requested, ns } = await searchParams;
  // An unknown or absent `?locale=` opens the first language that is not the
  // default — the one an admin most likely came to translate.
  const current =
    languages.find((language) => language.code === requested) ??
    languages.find((language) => !language.isDefault) ??
    languages[0]!;
  const view = await loadInterfaceText(current.code, typeof ns === "string" ? ns : undefined);
  const canFill =
    !view.isDefault && can(subject, "translations.approve") && (await isAutoTranslateAvailable());
  // The bar is a `translations.view` read, like the endpoint it polls.
  const progress =
    !view.isDefault && can(subject, "translations.view")
      ? await loadTranslationProgress({ locale: current.code })
      : [];

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {view.isDefault ? t("englishIntro") : t("intro")}
      </p>
      {progress.length > 0 && (
        <TranslationProgressPanel
          key={current.code}
          initial={progress}
          locale={current.code}
          refreshWhileWorking
          canSync={canFill}
        />
      )}
      <InterfaceTextTable
        locale={current.code}
        direction={current.direction === "RTL" ? "rtl" : "ltr"}
        isDefault={view.isDefault}
        languages={languages.map((language) => ({ value: language.code, label: language.name }))}
        namespaces={view.namespaces}
        namespace={view.namespace}
        rows={view.rows}
        canFill={canFill}
      />
    </>
  );
}

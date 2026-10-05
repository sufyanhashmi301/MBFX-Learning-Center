"use client";

// Settings → Translation (ADR-160, ADR-186): switch automatic translation on
// or off, choose the provider (Google Cloud Translation or DeepL), enter its
// key, and set the price and the monthly character budget.
//
// The saved key belongs to the saved provider. Choosing the other one asks
// for its key in the same save, and the server refuses the save without it.
//
// The reCAPTCHA tab's three properties, applied to this key:
//
//   1. **The key is write-only.** It arrives as `hasApiKey`, never as a
//      value, and a blank field means "keep the saved one".
//   2. **Switching on is proved.** The server runs a test translation with
//      the key being saved and refuses to switch on if it fails.
//   3. **A refusal says why**, from the reason taxonomy, never the
//      provider's own message.
import * as React from "react";
import { Languages } from "lucide-react";
import {
  TRANSLATE_PROVIDER_KINDS,
  TRANSLATE_PROVIDER_LIST_PRICE,
  translateSettingsSaveSchema,
  type TranslateProviderKindName,
} from "@repo/contracts";
import type { TranslateSettingsRefusal, TranslateSettingsView } from "@repo/translate";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import {
  Field as SwitchRow,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { PasswordInput } from "@repo/ui/components/password-input";
import { Switch } from "@repo/ui/components/switch";
import { formatDateTime } from "@repo/utils";
import { AdminCombobox } from "../../../../_components/combobox.tsx";
import { EditorSection, Field } from "../../../../_components/editor/editor-section.tsx";
import { useFieldErrors } from "../../../../_hooks/use-field-errors.ts";
import { useServerAction } from "../../../../_hooks/use-server-action.ts";
import {
  saveTranslateSettingsAction,
  testTranslateConnectionAction,
} from "../../../../_actions/translate-actions.ts";

export interface TranslateSettingsLabels {
  section: string;
  sectionDescription: string;
  enabled: string;
  enabledHint: string;
  provider: string;
  providerHint: string;
  providerOptions: Record<TranslateProviderKindName, string>;
  apiKey: Record<TranslateProviderKindName, string>;
  apiKeyHint: Record<TranslateProviderKindName, string>;
  /** Shown when the chosen provider is not the one the saved key belongs to. */
  keyForOtherProvider: string;
  apiKeySaved: string;
  showKey: string;
  hideKey: string;
  price: string;
  priceHint: Record<TranslateProviderKindName, string>;
  budget: string;
  budgetHint: string;
  save: string;
  saved: string;
  test: string;
  testOk: string;
  lastTested: string;
  never: string;
  usageTitle: string;
  usageDescription: string;
  usageCharacters: string;
  usageCost: string;
  usageRequests: string;
  usageRemaining: string;
  noBudget: string;
  sealKeyMissingTitle: string;
  sealKeyMissingBody: string;
  refusals: Record<TranslateSettingsRefusal, string>;
  /** A stored test result ("ok" or a reason) as words. */
  results: Record<string, string>;
}

/** A number field's text as the schema's value: blank is null, junk is NaN. */
function numberOrNull(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Number(trimmed);
}

export function TranslateSettingsForm({
  settings,
  labels,
}: {
  settings: TranslateSettingsView;
  labels: TranslateSettingsLabels;
}) {
  const save = useServerAction();
  const test = useServerAction();
  const [enabled, setEnabled] = React.useState(settings.enabled);
  const [kind, setKind] = React.useState<TranslateProviderKindName>(settings.kind);
  const [apiKey, setApiKey] = React.useState("");
  const [price, setPrice] = React.useState(String(settings.pricePerMillionChars));
  const [budget, setBudget] = React.useState(
    settings.monthlyCharBudget === null ? "" : String(settings.monthlyCharBudget),
  );

  const values = React.useMemo(
    () => ({
      enabled,
      kind,
      apiKey: apiKey || undefined,
      pricePerMillionChars: numberOrNull(price) ?? Number.NaN,
      monthlyCharBudget: numberOrNull(budget),
    }),
    [enabled, kind, apiKey, price, budget],
  );
  // The saved key is usable only while the saved provider is chosen.
  const keySavedForKind = settings.hasApiKey && kind === settings.kind;

  const onKindChange = (next: string) => {
    const value = TRANSLATE_PROVIDER_KINDS.find((k) => k === next);
    if (!value) return;
    setKind(value);
    // A suggestion only: the provider's list price, which the admin can change.
    setPrice(String(TRANSLATE_PROVIDER_LIST_PRICE[value]));
  };
  const form = useFieldErrors(translateSettingsSaveSchema, values);

  const refusal = (reason: TranslateSettingsRefusal) =>
    labels.refusals[reason] ?? labels.refusals.network_error;

  const onSave = () => {
    if (!form.validate()) return;
    save.run(
      async () => {
        const result = await saveTranslateSettingsAction(values);
        if (!result.ok) throw new Error(refusal(result.reason));
      },
      {
        successMessage: labels.saved,
        onDone: () => {
          setApiKey("");
          form.reset();
        },
      },
    );
  };

  const onTest = () => {
    test.run(
      async () => {
        const result = await testTranslateConnectionAction({
          kind,
          apiKey: apiKey || undefined,
        });
        if (!result.ok) throw new Error(refusal(result.reason));
      },
      { successMessage: labels.testOk },
    );
  };

  const remaining =
    settings.monthlyCharBudget === null
      ? labels.noBudget
      : Math.max(0, settings.monthlyCharBudget - settings.usage.characters).toLocaleString();

  return (
    <div className="flex flex-col gap-6">
      <EditorSection
        title={labels.section}
        description={labels.sectionDescription}
        icon={Languages}
        accent="warning"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" loading={test.pending} onClick={onTest}>
              {labels.test}
            </Button>
            <Button type="button" loading={save.pending} onClick={onSave}>
              {labels.save}
            </Button>
          </div>
        }
      >
        {/* The key is sealed under an env-only key (security.md #10). Without
            it a key cannot be saved, so translation cannot be switched on. */}
        {!settings.sealKeyPresent && (
          <Alert variant="warning">
            <AlertTitle>{labels.sealKeyMissingTitle}</AlertTitle>
            <AlertDescription>{labels.sealKeyMissingBody}</AlertDescription>
          </Alert>
        )}

        <SwitchRow orientation="horizontal">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
          <FieldContent>
            <FieldLabel>{labels.enabled}</FieldLabel>
            <FieldDescription>{labels.enabledHint}</FieldDescription>
          </FieldContent>
        </SwitchRow>

        <Field label={labels.provider} hint={labels.providerHint} required>
          <AdminCombobox
            value={kind}
            onValueChange={onKindChange}
            options={TRANSLATE_PROVIDER_KINDS.map((value) => ({
              value,
              label: labels.providerOptions[value],
            }))}
          />
        </Field>

        <Field
          label={labels.apiKey[kind]}
          hint={
            keySavedForKind
              ? labels.apiKeySaved
              : settings.hasApiKey
                ? `${labels.keyForOtherProvider} ${labels.apiKeyHint[kind]}`
                : labels.apiKeyHint[kind]
          }
          required={(enabled || kind !== settings.kind) && !keySavedForKind}
          error={form.error("apiKey")}
        >
          <PasswordInput
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            // Never the browser's saved credential: this is the provider's key.
            autoComplete="new-password"
            spellCheck={false}
            showLabel={labels.showKey}
            hideLabel={labels.hideKey}
          />
        </Field>

        <Field
          label={labels.price}
          hint={labels.priceHint[kind]}
          required
          error={form.error("pricePerMillionChars")}
        >
          <Input
            inputMode="decimal"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        </Field>

        <Field
          label={labels.budget}
          hint={labels.budgetHint}
          error={form.error("monthlyCharBudget")}
        >
          <Input
            inputMode="numeric"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </Field>

        <dl className="flex gap-1.5 text-xs text-muted-foreground">
          <dt>{labels.lastTested}</dt>
          <dd className="text-foreground">
            {settings.lastTestedAt
              ? `${formatDateTime(settings.lastTestedAt)} · ${
                  labels.results[settings.lastTestResult ?? ""] ?? settings.lastTestResult
                }`
              : labels.never}
          </dd>
        </dl>
      </EditorSection>

      <EditorSection title={labels.usageTitle} description={labels.usageDescription}>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{labels.usageCharacters}</dt>
            <dd className="font-medium">{settings.usage.characters.toLocaleString()}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{labels.usageCost}</dt>
            <dd className="font-medium">${Number(settings.usage.costUsd).toFixed(2)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{labels.usageRequests}</dt>
            <dd className="font-medium">{settings.usage.requests.toLocaleString()}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{labels.usageRemaining}</dt>
            <dd className="font-medium">{remaining}</dd>
          </div>
        </dl>
      </EditorSection>
    </div>
  );
}

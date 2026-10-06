// The translatable SOURCE of a setting (ADR-165): its words, by field, read
// from `settings.value`. Shared by the job, the editor's save and the English
// save's sweep, so all three hash the same thing.
//
// The hash covers the WORDS only. A setting's switch or URL is never
// translated (ADR-165 #1), so turning the announcement bar on, or repointing
// the header button, must not flag a person's translation as stale.
import {
  SETTING_GROUPS,
  TRANSLATABLE_SETTINGS,
  isTranslatableSettingKey,
  settingTextFields,
  type SettingTextFields,
  type TranslatableSetting,
  type TranslatableSettingKey,
} from "@repo/contracts";
import type { Prisma } from "@repo/db";
import { computeSourceHash } from "@repo/i18n";

export interface SettingSource {
  id: string;
  key: TranslatableSettingKey;
  group: string;
  label: string;
  fields: SettingTextFields;
}

export function hashSettingSource(source: Pick<SettingSource, "key" | "fields">): string {
  const entry: TranslatableSetting = TRANSLATABLE_SETTINGS[source.key];
  return computeSourceHash(
    JSON.stringify(Object.keys(entry.fields).map((field) => source.fields[field] ?? "")),
  );
}

/** Whether a source has any words at all — an empty bar has none to translate. */
export function hasSettingText(source: Pick<SettingSource, "fields">): boolean {
  return Object.values(source.fields).some((text) => text.trim() !== "");
}

type SettingRow = { id: string; key: string; label: string; value: Prisma.JsonValue };

function toSource(row: SettingRow): SettingSource | null {
  if (!isTranslatableSettingKey(row.key)) return null;
  return {
    id: row.id,
    key: row.key,
    group: SETTING_GROUPS[row.key],
    label: row.label,
    fields: settingTextFields(row.key, row.value),
  };
}

const SELECT = { id: true, key: true, label: true, value: true } as const;

export async function loadSettingSource(
  client: Pick<Prisma.TransactionClient, "setting">,
  settingId: string,
): Promise<SettingSource | null> {
  const row = await client.setting.findUnique({ where: { id: settingId }, select: SELECT });
  return row ? toSource(row) : null;
}

export async function loadSettingSourceByKey(
  client: Pick<Prisma.TransactionClient, "setting">,
  key: TranslatableSettingKey,
): Promise<SettingSource | null> {
  const row = await client.setting.findUnique({ where: { key }, select: SELECT });
  return row ? toSource(row) : null;
}

/** Every registry key that is seeded, in registry (editor) order. */
export async function loadSettingSources(
  client: Pick<Prisma.TransactionClient, "setting">,
): Promise<SettingSource[]> {
  const keys = Object.keys(TRANSLATABLE_SETTINGS);
  const rows = await client.setting.findMany({ where: { key: { in: keys } }, select: SELECT });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return keys.flatMap((key) => {
    const row = byKey.get(key);
    const source = row ? toSource(row) : null;
    return source ? [source] : [];
  });
}
